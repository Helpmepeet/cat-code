/**
 * P1-0 acceptance probe (Bun test).
 *
 * Spawns a REAL Bun sidecar via the Electron-free supervisor, over a REAL
 * Unix-domain socket, and asserts the hand-injected `tool_use` `SDKMessage`
 * round-trips sidecar → supervisor INTACT — the P1-0 gate. This is the
 * supervisor+sidecar half of the walking skeleton (the renderer/main IPC hop is
 * the same JSON frame model, verified visually by `electron .`).
 *
 * Run: `bun test app/sidecar/roundtrip.probe.test.ts`
 */

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SidecarSupervisor, type SupervisorEvent } from '../supervisor/supervisor.js'
import type { ServerFrame } from '../shared/protocol.js'

const here = dirname(fileURLToPath(import.meta.url))
const sidecarEntry = join(here, 'index.ts')
const TEST_TIMEOUT_MS = 120_000

let supervisor: SidecarSupervisor | null = null
const configHomes: string[] = []

afterEach(() => {
  supervisor?.shutdown()
  supervisor = null
  for (const configHome of configHomes.splice(0)) {
    rmSync(configHome, { recursive: true, force: true })
  }
})

function freshConfigHome(): string {
  const configHome = mkdtempSync(join(tmpdir(), 'catcode-roundtrip-config-'))
  configHomes.push(configHome)
  return configHome
}

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

test('normal sidecar starts a real engine session and emits app.ready without a fixture event', async () => {
  supervisor = new SidecarSupervisor({
    sidecarCommand: 'bun',
    sidecarArgs: ['run', sidecarEntry],
    // A non-probe session boots the real engine, which now requires a session
    // root (P3-1: cwd is caller-supplied, no P1_1_CWD hardcode).
    sidecarCwd: process.cwd(),
    sidecarEnv: {
      CLAUDE_CONFIG_DIR: freshConfigHome(),
      CATCODE_SIDECAR_RESUME_SESSION_ID: '',
    },
  })
  const sessionId = supervisor.spawnSession('p1-1-real-ready')
  const events: ServerFrame[] = []
  const unsubscribe = supervisor.subscribe(event => {
    if (event.type === 'frame' && event.frame.kind === 'event') {
      events.push(event.frame)
    }
  })

  const ready = await waitForFrame(supervisor, frame => frame.kind === 'ready')
  expect(ready).toMatchObject({
    kind: 'ready',
    protocolVersion: 2,
    sessionId,
    payload: {
      type: 'app.ready',
      protocolVersion: 1,
      inputEnabled: true,
      activeTurn: false,
      abort: { status: 'idle' },
      goalSnapshot: null,
      pendingPermissionRequests: [],
    },
  })
  expect(ready.kind).toBe('ready')
  if (ready.kind === 'ready') {
    expect(typeof ready.engineSessionId).toBe('string')
    expect(ready.engineSessionId.length).toBeGreaterThan(0)
  }

  await Bun.sleep(200)
  unsubscribe()
  expect(events).toEqual([])
}, TEST_TIMEOUT_MS)

test('hand-injected tool_use SDKMessage round-trips sidecar→supervisor INTACT', async () => {
  supervisor = new SidecarSupervisor({
    sidecarCommand: 'bun',
    sidecarArgs: ['run', sidecarEntry],
    sidecarEnv: {
      CATCODE_SIDECAR_PROBE: '1',
      CLAUDE_CONFIG_DIR: freshConfigHome(),
    },
  })
  const sessionId = supervisor.spawnSession('p1-0-test-tooluse')

  const messageFrame = await waitForFrame(
    supervisor,
    frame => frame.kind === 'event' && frame.event.type === 'message',
  )

  expect(messageFrame.kind).toBe('event')
  if (messageFrame.kind !== 'event' || messageFrame.event.type !== 'message') {
    throw new Error('expected a message event frame')
  }
  expect(messageFrame.sessionId).toBe(sessionId)

  // The payload must be the RAW SDKMessage — the tool_use block survives.
  const sdkMessage = messageFrame.event.message as {
    type?: string
    message?: { content?: unknown }
  }
  expect(sdkMessage.type).toBe('assistant')

  const content = sdkMessage.message?.content
  expect(Array.isArray(content)).toBe(true)

  const blocks = content as Array<{ type?: string; name?: string; input?: unknown }>
  const toolUse = blocks.find(block => block.type === 'tool_use')
  expect(toolUse).toBeDefined()
  // Intact, not flattened: name + structured input preserved.
  expect(toolUse?.name).toBe('Read')
  expect(toolUse?.input).toEqual({ file_path: '/etc/hosts' })

  // The text block is preserved alongside it.
  const textBlock = blocks.find(block => block.type === 'text')
  expect(textBlock).toBeDefined()
})

test('a connected session responds to a valid ping (happy-path liveness)', async () => {
  supervisor = new SidecarSupervisor({
    sidecarCommand: 'bun',
    sidecarArgs: ['run', sidecarEntry],
    sidecarEnv: {
      CATCODE_SIDECAR_PROBE: '0',
      CLAUDE_CONFIG_DIR: freshConfigHome(),
      CATCODE_SIDECAR_RESUME_SESSION_ID: '',
    },
    // Non-probe session → real engine → session root required (P3-1).
    sidecarCwd: process.cwd(),
  })
  const sessionId = supervisor.spawnSession('p1-0-test-forge')

  // Wait until ready, then send a well-formed ping and assert the pong comes
  // back for the correct session to confirm liveness.
  // Note: The actual forged/mismatched envelope sessionId rejection is
  // unit-tested separately in sidecarServer.test.ts ("rejects a frame addressed
  // to a different sessionId").
  await waitForFrame(supervisor, frame => frame.kind === 'ready')
  supervisor.send(sessionId, { type: 'app.ping', nonce: 'live-1' })

  const pong = await waitForFrame(supervisor, frame => frame.kind === 'pong')
  expect(pong.kind).toBe('pong')
  if (pong.kind === 'pong') {
    expect(pong.nonce).toBe('live-1')
  }
}, TEST_TIMEOUT_MS)

test('a real sidecar process delivers the projected slash catalog (SLASH-2: index.ts join, not a stub)', async () => {
  // sessionController.test.ts proves the catalog is BUILT (real getCommands
  // path); sidecarServer.test.ts proves the server DELIVERS a hand-injected
  // stub catalog. Neither exercises index.ts:179-198 threading
  // createSidecarSessionController(...).slashCatalog into
  // `new SidecarServer({ slashCatalog })` — the actual production join. This
  // spawns the REAL sidecar entrypoint (like every other test in this file)
  // and asserts the delivered snapshot is the real projected catalog.
  //
  // getCommands(cwd) needs an Anthropic credential present only to pass a
  // NODE_ENV=test-only guard in the eager login() command factory
  // (sessionController.test.ts) — no live model call is made. Without it the
  // catalog fails closed to `[]` and index.ts never sends this frame at all
  // (`...(slashCatalog.length > 0 ? { slashCatalog } : {})`), which would
  // make this test indistinguishable from a broken join — so the dummy key is
  // required for the assertion to mean anything.
  supervisor = new SidecarSupervisor({
    sidecarCommand: 'bun',
    sidecarArgs: ['run', sidecarEntry],
    sidecarEnv: {
      ANTHROPIC_API_KEY: 'sk-ant-slash-catalog-join-probe',
      CLAUDE_CONFIG_DIR: freshConfigHome(),
      CATCODE_SIDECAR_RESUME_SESSION_ID: '',
    },
    sidecarCwd: process.cwd(),
  })
  const sessionId = supervisor.spawnSession('slash-catalog-join-probe')

  const snapshot = await waitForFrame(
    supervisor,
    frame => frame.kind === 'slash-catalog.snapshot',
  )
  expect(snapshot.kind).toBe('slash-catalog.snapshot')
  if (snapshot.kind !== 'slash-catalog.snapshot') return
  expect(snapshot.sessionId).toBe(sessionId)
  expect(snapshot.commands.length).toBeGreaterThan(0)
  // `/compact` is `type: 'local'` with `supportsNonInteractive: true`, so it
  // survives the catalog's headless-safety filter and carries a description.
  const compact = snapshot.commands.find(command => command.name === 'compact')
  expect(compact).toBeDefined()
  expect(typeof compact?.description).toBe('string')
  expect(compact && compact.description.length).toBeGreaterThan(0)
  // `/help` is `local-jsx`: it renders an Ink component and resolves to nothing
  // in a non-interactive sidecar session, so the delivered catalog must not
  // offer it. Asserted through the real process join, not just the builder.
  expect(snapshot.commands.some(command => command.name === 'help')).toBe(false)
}, TEST_TIMEOUT_MS)

test('turn.status crosses the real socket and brackets the turn', async () => {
  // The live-path proof for the turn boundary. It has to be a REAL spawn: the
  // renderer suite renders `SessionPane` from hand-fed props, so it happily
  // passed for months while NOTHING on the wire ever flipped `inputEnabled`
  // after the `ready` handshake — the whole in-turn activity surface (the
  // indicator, Stop, Esc, the mid-turn composer queue) was dead in the app and
  // green in CI.
  supervisor = new SidecarSupervisor({
    sidecarCommand: 'bun',
    sidecarArgs: ['run', sidecarEntry],
    sidecarEnv: {
      CATCODE_SIDECAR_PROBE: '1',
      CLAUDE_CONFIG_DIR: freshConfigHome(),
    },
  })
  const sessionId = supervisor.spawnSession('p1-0-test-turnstatus')

  const seen: Array<{ kind: string; activeTurn?: boolean }> = []
  const unsubscribe = supervisor.subscribe((event: SupervisorEvent) => {
    if (event.type !== 'frame') return
    const frame = event.frame
    if (frame.kind === 'ready') {
      seen.push({ kind: 'ready' })
      return
    }
    if (frame.kind !== 'event') return
    if (frame.event.type === 'turn.status') {
      seen.push({ kind: 'turn.status', activeTurn: frame.event.activeTurn })
      return
    }
    if (frame.event.type === 'message') seen.push({ kind: 'message' })
  })

  // Wait for the turn to finish, not just to start.
  const closing = await waitForFrame(
    supervisor,
    frame =>
      frame.kind === 'event' &&
      frame.event.type === 'turn.status' &&
      frame.event.activeTurn === false,
  )
  unsubscribe()

  expect(closing.sessionId).toBe(sessionId)

  const turns = seen.filter(entry => entry.kind === 'turn.status')
  expect(turns.map(entry => entry.activeTurn)).toEqual([true, false])

  // SCOPE: probe mode submits straight to the controller (`index.ts:287`), so
  // this ordering is the CONTROLLER's, not the production submit path's. The
  // production path echoes the user message first, putting the open one frame
  // AFTER it — pinned separately by the `production app.submit order` test in
  // `sidecarServer.test.ts`. What this test uniquely proves is that the event
  // crosses a real Unix-domain socket at all.
  const openIndex = seen.findIndex(e => e.kind === 'turn.status' && e.activeTurn)
  const closeIndex = seen.findIndex(e => e.kind === 'turn.status' && !e.activeTurn)
  const messageIndexes = seen
    .map((entry, index) => (entry.kind === 'message' ? index : -1))
    .filter(index => index >= 0)
  expect(messageIndexes.length).toBeGreaterThan(0)
  expect(Math.min(...messageIndexes)).toBeGreaterThan(openIndex)
  expect(Math.max(...messageIndexes)).toBeLessThan(closeIndex)

  // `ready` still precedes everything, so a client can never see a turn
  // boundary for a session it has not been handed yet.
  expect(seen[0]?.kind).toBe('ready')
})
