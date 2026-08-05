/**
 * IDLE-PARK end-to-end lifecycle probe — a REAL sidecar parked and unparked, with
 * the renderer's own connection reducer folded over the REAL frame stream.
 *
 * Every hop of park was unit-tested in isolation before this
 * (`idleParkDriver.test.ts`: victim selection; `sidecarServer.test.ts`: the gate +
 * latch + exit; `host.test.ts`: exit-code classification; `connectionState.test.ts`:
 * how a park frame reads). What was NOT tested is the CHAIN — and the defect this
 * file exists to pin lived entirely in the chain:
 *
 *   the park exit carried the classifying code, the renderer knew how to read it,
 *   and the session STILL displayed "This session stopped unexpectedly. Restart it
 *   to keep working." — because a SECOND, code-less `exited` frame followed the
 *   first into a last-write-wins reducer.
 *
 * No single-layer test could see that: each layer was individually right. So this
 * probe asserts the composed result the user actually gets, over the real event
 * ORDER a real process death produces, which is the one thing a hand-built frame
 * sequence cannot vouch for.
 *
 * What is real here: the engine's own transcript persistence (`mintTranscript`),
 * the real `SessionRegistry`, `SidecarSupervisor`, `Host`, a real Bun sidecar
 * process, the real `createIdleParkDriver` policy, the real `app.park` frame over
 * the real socket, the real `supervisorEventToServerFrame` main uses, and the real
 * `reduceConnectionState` / `selectComposerGate` / `resolvePendingSubmit` the
 * renderer uses. Nothing is stubbed but `validateCwd` (a `realpathSync` on a temp
 * dir) and the registry's transcript-existence predicate.
 *
 * Run: `bun test app/main/idleParkLifecycle.probe.test.ts`
 */

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

import { Host } from '../host/host.js'
import { SessionRegistry } from '../host/registry.js'
import { SidecarSupervisor, type SupervisorEvent } from '../supervisor/supervisor.js'
import { PARKED_EXIT_CODE } from '../shared/limits.js'
import type { ServerFrame } from '../shared/protocol.js'
import {
  createConnectionState,
  connectionRecoveryMessage,
  connectionTone,
  isTerminalConnectionStatus,
  reduceConnectionState,
  selectConnection,
  type ConnectionState,
} from '../renderer/src/connectionState.js'
import {
  resolvePendingSubmit,
  selectComposerGate,
} from '../renderer/src/composerState.js'
import { createIdleParkDriver } from './idleParkDriver.js'
import { supervisorEventToServerFrame } from './mainDecisions.js'

const here = dirname(fileURLToPath(import.meta.url))
const sidecarEntry = join(here, '..', 'sidecar', 'index.ts')
const minter = join(here, '..', 'sidecar', 'mintTranscript.fixture.ts')

/** A real sidecar boots the whole engine graph before its ready frame, twice here
 * (park then restore), plus a mint process. Ample headroom on a cold cache. */
const TEST_TIMEOUT_MS = 180_000

const supervisors: SidecarSupervisor[] = []
const tempDirs: string[] = []

afterEach(() => {
  for (const s of supervisors.splice(0)) s.shutdown()
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function mintTranscript(opts: {
  configHome: string
  cwd: string
  engineSessionId: string
  marker: string
}): Promise<void> {
  const proc = Bun.spawn(['bun', 'run', minter, opts.engineSessionId, opts.marker], {
    cwd: opts.cwd,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: opts.configHome,
      TEST_ENABLE_SESSION_PERSISTENCE: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, , stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (code !== 0) throw new Error(`mint failed (exit ${code}): ${stderr}`)
}

function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 60_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = (): void => {
      if (predicate()) return resolve()
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`timed out waiting for ${what}`))
      }
      setTimeout(tick, 25)
    }
    tick()
  })
}

test(
  'a real idle-park reads as parked (not as an unexpected stop), holds the queued prompt, and unparks on it',
  async () => {
    const configHome = tmp('catcode-park-cfg-')
    const cwd = tmp('catcode-park-cwd-')
    const registryDir = tmp('catcode-park-reg-')
    const engineSessionId = randomUUID()

    // ── A real transcript through the engine's own persistence, so the parked row
    // is genuinely restorable and the unpark below is a genuine resume.
    await mintTranscript({
      configHome,
      cwd,
      engineSessionId,
      marker: `park-nonce-${randomUUID().slice(0, 8)}`,
    })
    const transcriptDir = join(registryDir, 'transcripts')
    mkdirSync(transcriptDir, { recursive: true })
    writeFileSync(join(transcriptDir, `${engineSessionId}.jsonl`), '{"type":"summary"}\n')

    const registry = new SessionRegistry({
      storageDir: registryDir,
      transcriptPathFor: (_cwd: string, id: string) =>
        join(transcriptDir, `${id}.jsonl`),
      log: () => {},
    })
    await registry.launch()

    const supervisor = new SidecarSupervisor({
      sidecarCommand: 'bun',
      sidecarArgs: ['run', sidecarEntry],
      sidecarEnv: { CLAUDE_CONFIG_DIR: configHome },
    })
    supervisors.push(supervisor)

    const host = new Host({
      supervisor,
      registry,
      validateCwd: (path: string) => ({ ok: true as const, realpath: path }),
      log: () => {},
    })

    // ── The renderer's half, driven by exactly what main forwards. Every
    // supervisor event goes through main's real translation and, when it produces
    // a frame, through the renderer's real reducer — so `connection` below is what
    // the composer and the connection bar would actually be reading.
    let connection: ConnectionState = createConnectionState()
    const framesSeen: ServerFrame[] = []
    let exitCode: number | null | undefined
    let exits = 0
    supervisor.subscribe((event: SupervisorEvent) => {
      if (event.type === 'exit') {
        exits += 1
        exitCode = event.code
      }
      const frame = supervisorEventToServerFrame(event)
      if (!frame) return
      framesSeen.push(frame)
      connection = reduceConnectionState(connection, frame)
    })

    const created = await host.createSession({
      cwd,
      resumeEngineSessionId: engineSessionId,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const appSessionId = created.value.appSessionId

    await waitFor(
      () => selectConnection(connection, appSessionId).status === 'ready',
      'the sidecar to go ready',
    )

    // ── The real policy driver, with the TTL wide open so this idle session is a
    // victim on the first sweep. `visible` is the renderer's visible-pane hint.
    let visible = new Set<string>([appSessionId])
    const driver = createIdleParkDriver({
      listSessions: () => host.listSessions(),
      park: id => {
        supervisor.send(id, { type: 'app.park', requestId: randomUUID() })
      },
      protectedSessions: () => visible,
      idleTtlMs: 0,
      now: () => Date.now() + 1_000,
      log: () => {},
    })

    // ── Requirement 2: a session the user is looking at is not parked under them.
    // The driver is asked to sweep repeatedly against a REAL live engine, and the
    // engine is still there afterwards.
    driver.evaluate()
    driver.evaluate()
    await Bun.sleep(750)
    expect(exits).toBe(0)
    expect(selectConnection(connection, appSessionId).status).toBe('ready')
    expect(
      host.listSessions().find(s => s.appSessionId === appSessionId)?.status,
    ).toBe('ready')

    // ── The user moves on; the pane is no longer visible, so the same sweep now
    // reclaims the engine for real.
    visible = new Set()
    driver.evaluate()
    await waitFor(() => exits > 0, 'the sidecar to self-exit')
    expect(exitCode).toBe(PARKED_EXIT_CODE)

    // Let any trailing socket-close/status event land before judging the result:
    // the frame that used to overwrite the classification arrived AFTER the exit.
    await Bun.sleep(500)

    // ── Requirement 1: what the user sees. This is the composed assertion the
    // per-layer tests could not make.
    const parked = selectConnection(connection, appSessionId)
    expect(parked.status).toBe('parked')
    expect(isTerminalConnectionStatus(parked.status)).toBe(false)
    expect(connectionTone(parked.status)).toBe('neutral')
    expect(connectionRecoveryMessage(parked.status)).toBeNull()
    // Stated positively as well as structurally: the reported sentence is gone.
    expect(connectionRecoveryMessage(parked.status)).not.toBe(
      'This session stopped unexpectedly. Restart it to keep working.',
    )
    // The FULL lifecycle sequence this death produced, not just its tail. The
    // first version of this probe asserted only what came AFTER the park frame
    // and was therefore blind to the other half of the same defect: the sidecar
    // closes its socket before `process.exit`, so the supervisor used to mint a
    // transport `disconnected` ~7ms AHEAD of the exit, and the renderer committed
    // a full danger presentation (banner + Restart + read-only composer) for one
    // render before the code-5 frame corrected it. Both a leading and a trailing
    // terminal frame re-open the reported bug, so the assertion is that this
    // death produced EXACTLY ONE lifecycle frame and that it is the classified
    // one.
    const lifecycleFrames = framesSeen.filter(frame => frame.kind === 'lifecycle')
    expect(lifecycleFrames.length).toBe(1)
    expect(lifecycleFrames[0]?.exit?.code).toBe(PARKED_EXIT_CODE)

    // ── The tab is kept and the row is restorable: the host's own view, unchanged
    // by any of this (IDLE-PARK §1 — park projects as the crash descriptor).
    const descriptor = host
      .listSessions()
      .find(s => s.appSessionId === appSessionId)
    expect(descriptor?.status).toBe('disconnected')
    expect(descriptor?.restorable).toBe(true)

    // ── Requirement 3: the composer is still usable and a submit is HELD, not
    // refused, and it asks for the engine back rather than waiting forever.
    const gate = selectComposerGate({
      hasSession: true,
      preview: false,
      connectionStatus: parked.status,
      connectionInputEnabled: parked.inputEnabled,
      logInputEnabled: false,
    })
    expect(gate.editable).toBe(true)
    expect(gate.connectPending).toBe(true)
    expect(resolvePendingSubmit(parked)).toBe('restore')

    // ── The unpark the drain performs: the SAME host restore path a click uses.
    const restored = await host.restoreSession(appSessionId)
    expect(restored.ok).toBe(true)
    await waitFor(
      () => selectConnection(connection, appSessionId).status === 'ready',
      'the unparked sidecar to go ready',
    )

    // The held prompt now drains through the ordinary `app.submit` path, and the
    // engine it drains into is the SAME conversation: a ready frame echoing the
    // requested engineSessionId is the resume machinery's own proof (a blank
    // session would announce a new id).
    const live = selectConnection(connection, appSessionId)
    expect(resolvePendingSubmit(live)).toBe('send')
    const readyFrames = framesSeen.filter(frame => frame.kind === 'ready')
    expect(readyFrames.length).toBe(2)
    for (const frame of readyFrames) {
      if (frame.kind === 'ready') expect(frame.engineSessionId).toBe(engineSessionId)
    }

    driver.stop()
  },
  TEST_TIMEOUT_MS,
)
