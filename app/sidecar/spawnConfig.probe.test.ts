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

function makeSupervisor(configHome: string): SidecarSupervisor {
  const sup = new SidecarSupervisor({
    sidecarCommand: 'bun',
    sidecarArgs: ['run', sidecarEntry],
    sidecarEnv: { CLAUDE_CONFIG_DIR: configHome },
  })
  supervisors.push(sup)
  return sup
}

test('(b) a sidecar spawned with resumeEngineSessionId echoes it in the ready frame', async () => {
  const configHome = freshConfigHome()
  const cwd = tmp('catcode-p31-wd-')
  const engineSessionId = randomUUID()
  await mintTranscript({
    configHome,
    cwd,
    engineSessionId,
    marker: 'nonce-ready-echo',
  })

  const sup = makeSupervisor(configHome)
  sup.spawnSession('p31-resume-echo', { cwd, resumeEngineSessionId: engineSessionId })

  const ready = await waitForFrame(sup, frame => frame.kind === 'ready')
  expect(ready.kind).toBe('ready')
  if (ready.kind === 'ready') {
    // P3-0 field: the ready frame carries the app-owned engineSessionId, and it
    // MUST equal the requested resume id — a re-minted fresh id would fail here.
    expect(ready.engineSessionId).toBe(engineSessionId)
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
