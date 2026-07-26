/**
 * P3-1 acceptance probe (Bun test).
 *
 * Proves the supervisor spawn-config half of REGISTRY.md §7 item 2 end-to-end,
 * through REAL Bun sidecar processes over REAL Unix-domain sockets:
 *
 *   (a) A sidecar spawned with a distinct cwd boots the engine rooted there, and
 *       two sidecars with different cwds do NOT cross (the P0-4 stomp is the
 *       ancestral bug). Proven via resume: a transcript minted in cwd-A is
 *       resumable ONLY from cwd-A — the engine derives its project (and thus its
 *       transcript catalog) from process.cwd(), so cwd-B cannot see it.
 *   (b) A sidecar spawned with `resumeEngineSessionId` reports the SAME
 *       engineSessionId in its ready frame (P3-0), AND the resumed session's
 *       state actually contains the prior messages — asserted via the engine's
 *       own resume machinery (`resumeEngineSession().messages`), not by
 *       re-reading the JSONL.
 *   (c) A bogus resume id fails LOUDLY — a distinguishable stderr line + a
 *       dedicated non-zero exit — never a silent fresh session (D6 anti-Potemkin).
 *
 * The fixture transcript is minted through the engine's OWN persistence
 * (`mintTranscript.fixture.ts` → `recordTranscript`), never hand-written JSONL.
 * No live credentialed turn is required (that anti-Potemkin live proof is P3-8).
 *
 * TEST EVIDENCE (F5 real-process complement)
 * - Claim: independently spawned production sidecars isolate their OS-process
 *   lifecycles: killing one leaves the other live and reachable over its own
 *   production Unix-domain socket.
 * - Exact pre-fix failure: a shared/reused sidecar process, or a supervisor
 *   kill path that tears down sibling sessions, would give both sessions one PID
 *   or make the survivor's ping fail after the first child is SIGKILLed.
 * - Production entry point: `SidecarSupervisor.spawnSession()` / its Node
 *   `child_process.spawn` sidecar boundary, then `SidecarSupervisor.send()`.
 * - Proof layer: process. Higher GUI and credentialed-live layers are
 *   UNVERIFIED; this sends only a protocol ping and never makes a model call.
 * - Red/mutation evidence: the focused test was intentionally perturbed to
 *   signal the survivor PID; its `ready` assertion observed `exited`, then the
 *   original kill target was restored before the recorded green run.
 *
 * Run: `bun test app/sidecar/spawnConfig.probe.test.ts`
 */

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

import { SidecarSupervisor, type SupervisorEvent } from '../supervisor/supervisor.js'
import type { ServerFrame } from '../shared/protocol.js'

const here = dirname(fileURLToPath(import.meta.url))
const sidecarEntry = join(here, 'index.ts')
const minter = join(here, 'mintTranscript.fixture.ts')
const resumeProbe = join(here, 'resumeProbe.fixture.ts')

// A real sidecar boots the full engine graph + runs init() (and, here, resume)
// before its ready frame — well past Bun's 5s default per-test timeout on a cold
// module cache. Mint steps spawn additional Bun processes. Give each test ample
// headroom so the suite is not flaky on a cold run.
const TEST_TIMEOUT_MS = 120_000

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

/** A fresh isolated config home so tests never touch the real ~/.cat-code. */
function freshConfigHome(): string {
  return tmp('catcode-p31-cfg-')
}

/**
 * Mint a real transcript for `engineSessionId`, rooted in `cwd`, using the given
 * config home — through the engine's own persistence. Returns once the file
 * exists on disk.
 */
async function mintTranscript(opts: {
  configHome: string
  cwd: string
  engineSessionId: string
  marker: string
}): Promise<void> {
  const proc = Bun.spawn(
    ['bun', 'run', minter, opts.engineSessionId, opts.marker],
    {
      cwd: opts.cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: opts.configHome,
        // The bun-test runner sets NODE_ENV=test, which makes the engine's
        // transcript persistence a no-op (shouldSkipPersistence). Opt the mint
        // subprocess back into real persistence so the fixture actually lands
        // on disk (the engine's own purpose-built test escape hatch).
        TEST_ENABLE_SESSION_PERSISTENCE: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [code, , stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (code !== 0) {
    throw new Error(`mint failed (exit ${code}): ${stderr}`)
  }
}

function waitForFrame(
  sup: SidecarSupervisor,
  predicate: (frame: ServerFrame) => boolean,
  timeoutMs = 45_000,
): Promise<ServerFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub()
      reject(new Error('timed out waiting for frame'))
    }, timeoutMs)
    const unsub = sup.subscribe((event: SupervisorEvent) => {
      if (event.type === 'frame' && predicate(event.frame)) {
        clearTimeout(timer)
        unsub()
        resolve(event.frame)
      }
    })
  })
}

function waitForEvent(
  sup: SidecarSupervisor,
  predicate: (event: SupervisorEvent) => boolean,
  timeoutMs = 45_000,
): Promise<SupervisorEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub()
      reject(new Error('timed out waiting for supervisor event'))
    }, timeoutMs)
    const unsub = sup.subscribe(event => {
      if (predicate(event)) {
        clearTimeout(timer)
        unsub()
        resolve(event)
      }
    })
  })
}

function makeSupervisor(configHome: string): SidecarSupervisor {
  const sup = new SidecarSupervisor({
    sidecarCommand: 'bun',
    sidecarArgs: ['run', sidecarEntry],
    sidecarEnv: { CLAUDE_CONFIG_DIR: configHome },
  })
  supervisors.push(sup)
  return sup
}

test('(b) a resumed sidecar echoes the id in ready AND replays the restored history as replay:true event frames', async () => {
  const configHome = freshConfigHome()
  const cwd = tmp('catcode-p31-wd-')
  const engineSessionId = randomUUID()
  const marker = `nonce-${randomUUID()}`
  await mintTranscript({
    configHome,
    cwd,
    engineSessionId,
    marker,
  })

  const sup = makeSupervisor(configHome)
  // Collect every frame from the start so the history replay (sent right after
  // ready) cannot be missed between two waits.
  const frames: ServerFrame[] = []
  sup.subscribe(event => {
    if (event.type === 'frame') frames.push(event.frame)
  })
  sup.spawnSession('p31-resume-echo', { cwd, resumeEngineSessionId: engineSessionId })

  const ready = await waitForFrame(sup, frame => frame.kind === 'ready')
  expect(ready.kind).toBe('ready')
  if (ready.kind === 'ready') {
    // P3-0 field: the ready frame carries the app-owned engineSessionId, and it
    // MUST equal the requested resume id — a re-minted fresh id would fail here.
    expect(ready.engineSessionId).toBe(engineSessionId)
  }

  // F2 (RESTORE-HISTORY): the REAL wiring — resume → toSDKMessages → server →
  // socket → supervisor decode — delivers the minted transcript (2 messages)
  // as replay-flagged event frames, in order, before any live event.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('timed out waiting for history replay frames')),
      45_000,
    )
    const check = () => {
      if (
        frames.filter(f => f.kind === 'event' && f.replay === true).length >= 2
      ) {
        clearTimeout(timer)
        resolve()
      } else {
        setTimeout(check, 25)
      }
    }
    check()
  })
  const replayFrames = frames.filter(
    (f): f is Extract<ServerFrame, { kind: 'event' }> =>
      f.kind === 'event' && f.replay === true,
  )
  expect(replayFrames.length).toBe(2)
  for (const frame of replayFrames) {
    expect(frame.event.type).toBe('message')
    expect(frame.sessionId).toBe('p31-resume-echo')
  }
  // The replay carries what the ENGINE resumed (one source): the user nonce
  // prompt verbatim, then an assistant message. NOTE the assistant is the
  // engine's own API-validity sentinel, not the minted ack — recovery filters
  // the hand-minted trailing assistant and appends "No response requested."
  // (conversationRecovery.ts:243). The renderer history matching the ENGINE's
  // restored state — sentinel included — is exactly the F2 same-source
  // contract; uuid-level equality with the seeded engine state is asserted in
  // resumeSeedProbe.fixture.ts.
  expect(JSON.stringify(replayFrames[0])).toContain(`remember this nonce: ${marker}`)
  const second = replayFrames[1]!
  if (second.event.type === 'message') {
    expect(second.event.message.type).toBe('assistant')
  } else {
    throw new Error('second replay frame is not a message event')
  }
}, TEST_TIMEOUT_MS)

test('(b) the resumed session state actually contains the prior messages (engine-side, not JSONL)', async () => {
  const configHome = freshConfigHome()
  const cwd = tmp('catcode-p31-wd-')
  const engineSessionId = randomUUID()
  const marker = `nonce-${randomUUID()}`
  await mintTranscript({ configHome, cwd, engineSessionId, marker })

  // Drive the SAME resume machinery the sidecar runs (resumeEngineSession) in a
  // process rooted at the same cwd + config, and assert on the engine-returned
  // Message[] — this is the engine's deserialized state, not a JSONL re-read.
  const proc = Bun.spawn(
    ['bun', 'run', resumeProbe, engineSessionId, marker],
    {
      cwd,
      env: { ...process.env, CLAUDE_CONFIG_DIR: configHome },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (code !== 0) {
    throw new Error(`resume probe failed (exit ${code}): ${stderr}\nstdout: ${stdout}`)
  }
  const line = stdout.split('\n').find(l => l.startsWith('RESUME_RESULT='))
  if (!line) {
    throw new Error(`resume probe produced no result line.\nstdout: ${stdout}\nstderr: ${stderr}`)
  }
  const result = JSON.parse(line.slice('RESUME_RESULT='.length)) as {
    engineSessionId: string
    count: number
    hasMarker: boolean
  }
  expect(result.engineSessionId).toBe(engineSessionId)
  expect(result.count).toBe(2)
  expect(result.hasMarker).toBe(true)
}, TEST_TIMEOUT_MS)

test('(a) two sidecars with different cwds do not cross — a transcript is resumable only from its own cwd', async () => {
  const configHome = freshConfigHome()
  const cwdA = tmp('catcode-p31-wdA-')
  const cwdB = tmp('catcode-p31-wdB-')
  const engineSessionId = randomUUID()
  // Mint ONLY in cwd-A.
  await mintTranscript({
    configHome,
    cwd: cwdA,
    engineSessionId,
    marker: 'nonce-cwd-A',
  })

  // A sidecar rooted in cwd-A resumes it: ready frame echoes the id.
  const supA = makeSupervisor(configHome)
  supA.spawnSession('p31-cwdA', { cwd: cwdA, resumeEngineSessionId: engineSessionId })
  const readyA = await waitForFrame(supA, frame => frame.kind === 'ready')
  expect(readyA.kind).toBe('ready')
  if (readyA.kind === 'ready') {
    expect(readyA.engineSessionId).toBe(engineSessionId)
  }

  // The SAME id from cwd-B must NOT resume — the engine roots its project (and
  // transcript catalog) on process.cwd(), so cwd-B never sees cwd-A's transcript.
  // No cross: the sidecar exits loudly instead of silently minting a fresh one.
  const supB = makeSupervisor(configHome)
  supB.spawnSession('p31-cwdB', { cwd: cwdB, resumeEngineSessionId: engineSessionId })
  const exitB = await new Promise<{ code: number | null }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cwd-B never exited')), 45_000)
    supB.subscribe((event: SupervisorEvent) => {
      if (event.type === 'exit') {
        clearTimeout(timer)
        resolve({ code: event.code })
      }
      if (event.type === 'frame' && event.frame.kind === 'ready') {
        clearTimeout(timer)
        reject(new Error('cwd-B silently produced a ready frame — cross/Potemkin restore'))
      }
    })
  })
  // Dedicated resume-failed exit code (index.ts RESUME_FAILED_EXIT_CODE).
  expect(exitB.code).toBe(4)
}, TEST_TIMEOUT_MS)

test('(a/F5) SIGKILLing one real sidecar leaves its independently spawned sibling live and responsive', async () => {
  const configHome = freshConfigHome()
  const cwdA = tmp('catcode-f5-wdA-')
  const cwdB = tmp('catcode-f5-wdB-')
  const sup = makeSupervisor(configHome)
  const sessionA = 'f5-killed-sidecar'
  const sessionB = 'f5-survivor-sidecar'

  // Subscribe before spawning so readiness is our deterministic barrier: both
  // children have independently completed the real sidecar boot/socket join
  // before we send the external kill signal.
  const readyA = waitForFrame(
    sup,
    frame => frame.kind === 'ready' && frame.sessionId === sessionA,
  )
  const readyB = waitForFrame(
    sup,
    frame => frame.kind === 'ready' && frame.sessionId === sessionB,
  )
  sup.spawnSession(sessionA, { cwd: cwdA })
  sup.spawnSession(sessionB, { cwd: cwdB })
  await Promise.all([readyA, readyB])

  const pidA = sup.getSessionProcessId(sessionA)
  const pidB = sup.getSessionProcessId(sessionB)
  expect(pidA).toBeDefined()
  expect(pidB).toBeDefined()
  expect(pidA).not.toBe(pidB)
  if (pidA === undefined || pidB === undefined) {
    throw new Error('ready sidecar was missing its production child PID')
  }

  // This is deliberately an OS-level crash, not `killSession()`: the external
  // signal exercises the real child-process boundary and the supervisor's exit
  // listener. The pending listener is installed before SIGKILL to avoid a
  // timing race with the fast child exit.
  const exitedA = waitForEvent(
    sup,
    (event): boolean => event.type === 'exit' && event.sessionId === sessionA,
  )
  process.kill(pidA, 'SIGKILL')
  const exit = await exitedA
  expect(exit.type).toBe('exit')
  if (exit.type === 'exit') {
    expect(exit.signal).toBe('SIGKILL')
  }

  // A sibling process has a separate PID, socket, and supervisor record. It
  // remains ready and can answer a real framed ping after A dies. A shared
  // process, shared teardown, or cross-session supervision bug fails here.
  expect(sup.getSessionProcessId(sessionB)).toBe(pidB)
  expect(sup.listSessions()).toContainEqual({ sessionId: sessionB, status: 'ready' })
  const pong = waitForFrame(
    sup,
    frame => frame.kind === 'pong' && frame.sessionId === sessionB,
  )
  sup.send(sessionB, { type: 'app.ping', nonce: 'f5-survivor-still-live' })
  const survivorPong = await pong
  expect(survivorPong.kind).toBe('pong')
  if (survivorPong.kind === 'pong') {
    expect(survivorPong.nonce).toBe('f5-survivor-still-live')
  }
}, TEST_TIMEOUT_MS)

test('(c) a bogus resume id fails loudly — non-zero exit + distinguishable stderr, no ready frame', async () => {
  const configHome = freshConfigHome()
  const cwd = tmp('catcode-p31-wd-')
  const bogusId = randomUUID() // never minted

  // Run the sidecar directly so we can read its stderr + exit code (the
  // supervisor also surfaces the exit, exercised in test (a)).
  const socketPath = join(cwd, 'bogus.sock')
  const proc = Bun.spawn(['bun', 'run', sidecarEntry], {
    cwd,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: configHome,
      CATCODE_SIDECAR_SOCKET: socketPath,
      CATCODE_SIDECAR_SESSION_ID: 'p31-bogus-app',
      CATCODE_SIDECAR_CWD: cwd,
      CATCODE_SIDECAR_RESUME_SESSION_ID: bogusId,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, , stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  expect(code).toBe(4) // dedicated resume-failed code, non-zero
  expect(stderr).toContain('resume-failed')
  expect(stderr).toContain(bogusId)
  // It never bound its socket / booted a session (no silent fresh session).
  expect(existsSync(socketPath)).toBe(false)
}, TEST_TIMEOUT_MS)
