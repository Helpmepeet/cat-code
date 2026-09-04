/**
 * Host-request-plane live-path probe (HOST-REQUEST-PLANE.md §6).
 *
 * Every other test of this plane hands `handleRequest` a frame the TEST built,
 * and that is exactly the blind spot this file exists to close. In production a
 * `host.request` does not arrive as the sidecar authored it: the sidecar's
 * single outbound send path wraps it in the metadata-only delivery envelope
 * (`sidecar/index.ts` `wrapOutboundFrame`), and the supervisor unwraps it by
 * merging `deliveryTrace` back on as a TOP-LEVEL key
 * (`supervisor/unwrapServerFrame`). Main's strict key allowlist never saw that
 * key, so every peer verb that crossed a real socket was refused
 * `unexpected key "deliveryTrace"` while every unit test stayed green.
 *
 * So this spawns a REAL sidecar over a REAL Unix-domain socket, makes it emit a
 * REAL `host.request`, and feeds main's plane the frame the supervisor actually
 * produced. Nothing here constructs a frame, which is the point: a field added
 * to the wire the same way fails this test too, without anyone remembering to
 * name it.
 *
 * The `peer.ack` verb is the trigger because it is the one request a sidecar
 * emits without a model turn: routing it a `peer.deliver` makes it ack.
 *
 * Run: `bun test app/main/peerRequestPlane.probe.test.ts`
 */

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SidecarSupervisor, type SupervisorEvent } from '../supervisor/supervisor.js'
import {
  createPeerRequestPlane,
  type PeerRegistryRow,
} from './peerRequestPlane.js'
import type { ServerFrame, SessionId, SidecarClientMessage } from '../shared/protocol.js'

const here = dirname(fileURLToPath(import.meta.url))
const sidecarEntry = join(here, '..', 'sidecar', 'index.ts')
const TEST_TIMEOUT_MS = 120_000
const SENDER = 'aaaaaaaa-0000-4000-8000-000000000001'
const WORKSPACE = '/w/one'

let supervisor: SidecarSupervisor | null = null
const configHomes: string[] = []

afterEach(() => {
  supervisor?.shutdown()
  supervisor = null
  for (const configHome of configHomes.splice(0)) {
    rmSync(configHome, { recursive: true, force: true })
  }
})

function waitForFrame(
  sup: SidecarSupervisor,
  predicate: (frame: ServerFrame) => boolean,
  timeoutMs = 45_000,
): Promise<ServerFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error('timed out waiting for frame'))
    }, timeoutMs)
    const unsubscribe = sup.subscribe((event: SupervisorEvent) => {
      if (event.type === 'frame' && predicate(event.frame)) {
        clearTimeout(timer)
        unsubscribe()
        resolve(event.frame)
      }
    })
  })
}

function row(appSessionId: string, name: string): PeerRegistryRow {
  return {
    appSessionId,
    engineSessionId: `engine-${name.toLowerCase()}`,
    cwd: WORKSPACE,
    name,
    lastAttachedAt: 1_000,
    lastMessageSentAt: null,
    shutdown: null,
  }
}

test('a host.request that crossed the real socket is accepted by the plane', async () => {
  const configHome = mkdtempSync(join(tmpdir(), 'catcode-peer-plane-config-'))
  configHomes.push(configHome)
  supervisor = new SidecarSupervisor({
    sidecarCommand: 'bun',
    sidecarArgs: ['run', sidecarEntry],
    // The transport fixture: a real process on a real socket with no engine
    // session and no credential, which is all this path needs.
    sidecarEnv: {
      CATCODE_SIDECAR_PROBE: '1',
      CLAUDE_CONFIG_DIR: configHome,
    },
  })
  const sessionId = supervisor.spawnSession('peer-plane-envelope-probe')
  await waitForFrame(supervisor, frame => frame.kind === 'ready')

  const pending = waitForFrame(
    supervisor,
    frame => frame.kind === 'host.request' && frame.verb === 'peer.ack',
  )
  const delivery: SidecarClientMessage = {
    type: 'peer.deliver',
    messageId: 'm-envelope-probe',
    from: 'Alex',
    fromSessionId: SENDER as SessionId,
    text: 'ping',
  }
  supervisor.send(sessionId, delivery)
  const frame = await pending

  // The fact the unit tests cannot see: what arrives carries the envelope's
  // metadata as a top-level key beside the request's own fields. Asserted from
  // the wire, never asserted into it.
  expect(frame).toHaveProperty('deliveryTrace')

  // Now the plane, wired as main wires it, is handed that exact frame.
  const answers: SidecarClientMessage[] = []
  const plane = createPeerRequestPlane({
    rows: () => [row(sessionId, 'Bear'), row(SENDER, 'Alex')],
    isLive: () => true,
    isReady: () => true,
    createSessionInWorkspace: async () => ({
      ok: false,
      error: { code: 'internal_error', message: 'not used by this probe' },
    }),
    restoreSession: async () => ({ ok: true }),
    forward: (_appSessionId, message) => {
      answers.push(message)
      return null
    },
    logRouted: () => {},
  })
  await plane.handleRequest(sessionId, frame)

  // One `host.result`, and it is an ANSWER rather than a refusal. Before the
  // allowlist admitted `deliveryTrace` this was
  // `{ ok: false, error: { code: 'bad_request', message: 'unexpected key "deliveryTrace"' } }`,
  // which is what the operator saw as "That request was not accepted."
  expect(answers).toHaveLength(1)
  expect(answers[0]).toMatchObject({
    type: 'host.result',
    ok: true,
    value: { messageId: 'm-envelope-probe' },
  })
}, TEST_TIMEOUT_MS)
