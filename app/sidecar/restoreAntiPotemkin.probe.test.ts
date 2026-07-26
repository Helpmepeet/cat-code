/**
 * F2 durable restore regression probe (real processes, no model replay).
 *
 * Mints TWO independent transcripts through `recordTranscript`, each with the
 * P3-8 failure shape: a sidechain plus a later dangling system diagnostic. It
 * then restores both through real sidecar processes twice. The second restore
 * must retain the same engine ids, replay each session's own marker, and run
 * under fresh OS PIDs. This is deliberately a process proof: a unit fixture or
 * a renderer cache could not establish that composition.
 *
 * The credentialed-live layer remains intentionally unproven here. A model
 * answer from restored context is the operator-run P3-8 gate; replay frames
 * are never substituted for that evidence.
 *
 * TEST EVIDENCE
 * - Claim: two independently persisted realistic transcripts restore through
 *   fresh sidecars with stable engine ids, fresh PIDs, and no marker crossover.
 * - Exact pre-fix failure: the old non-sidechain-only leaf selector chose a
 *   trailing system diagnostic and resumed one message without prior context.
 * - Production entry point: sidecar `index.ts` → `resumeEngineSession()` →
 *   `loadConversationForResume` / `getLastSessionLog`.
 * - Test path: `app/sidecar/restoreAntiPotemkin.probe.test.ts`.
 * - Proof layer: process.
 * - Red/mutation evidence: restoring the old leaf predicate made both sidecars
 *   seed one message and fail marker replay; production source was restored.
 * - Pairwise/adversarial cases: two cwd/id/marker pairs, realistic
 *   sidechain+diagnostic tails, old PID death, fresh PID restore, no crossover.
 * - UNVERIFIED: credentialed answer-from-context and GUI operator acceptance.
 * - Commands and outcomes: focused restore probes passed; primary desktop
 *   battery passed 1426/0, typechecks clean, hardening 19/19.
 *
 * Run: `bun test app/sidecar/restoreAntiPotemkin.probe.test.ts`
 */

import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SidecarSupervisor, type SupervisorEvent } from '../supervisor/supervisor.js'
import type { ServerFrame } from '../shared/protocol.js'

const here = dirname(fileURLToPath(import.meta.url))
const sidecarEntry = join(here, 'index.ts')
const minter = join(here, 'mintTranscript.fixture.ts')
const TEST_TIMEOUT_MS = 120_000

const supervisors: SidecarSupervisor[] = []
const tempDirs: string[] = []

afterEach(() => {
  for (const supervisor of supervisors.splice(0)) supervisor.shutdown()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeSupervisor(configHome: string): SidecarSupervisor {
  const supervisor = new SidecarSupervisor({
    sidecarCommand: 'bun',
    sidecarArgs: ['run', sidecarEntry],
    sidecarEnv: { CLAUDE_CONFIG_DIR: configHome },
  })
  supervisors.push(supervisor)
  return supervisor
}

async function mintRealisticTranscript(opts: {
  configHome: string
  cwd: string
  engineSessionId: string
  marker: string
}): Promise<{ transcriptPath: string; sidechainPath: string }> {
  const child = Bun.spawn(
    ['bun', 'run', minter, opts.engineSessionId, opts.marker, '--realistic-tail'],
    {
      cwd: opts.cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: opts.configHome,
        // Bun's test environment suppresses persistence. This is the engine's
        // test-only escape hatch used by the existing real-process probes.
        TEST_ENABLE_SESSION_PERSISTENCE: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(`mint failed (exit ${code}): ${stderr}`)
  expect(stdout).toContain('MINTED_TRANSCRIPT_SHAPE=realistic-tail')
  const transcriptLine = stdout.split('\n').find(line => line.startsWith('MINTED_TRANSCRIPT_PATH='))
  const sidechainLine = stdout.split('\n').find(line => line.startsWith('MINTED_SIDECHAIN_PATH='))
  if (!transcriptLine || !sidechainLine) {
    throw new Error(`mint produced incomplete paths: ${stdout}`)
  }
  return {
    transcriptPath: transcriptLine.slice('MINTED_TRANSCRIPT_PATH='.length),
    sidechainPath: sidechainLine.slice('MINTED_SIDECHAIN_PATH='.length),
  }
}

function waitForFrame(
  supervisor: SidecarSupervisor,
  predicate: (frame: ServerFrame) => boolean,
  timeoutMs = 45_000,
): Promise<ServerFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error('timed out waiting for sidecar frame'))
    }, timeoutMs)
    const unsubscribe = supervisor.subscribe((event: SupervisorEvent) => {
      if (event.type === 'frame' && predicate(event.frame)) {
        clearTimeout(timer)
        unsubscribe()
        resolve(event.frame)
      }
    })
  })
}

async function waitForPidExit(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      throw error
    }
    await Bun.sleep(25)
  }
  throw new Error(`sidecar pid ${pid} survived shutdown`)
}

test('F2: two realistic transcripts restore through new real sidecar processes without cross-session context loss', async () => {
  const configHome = tmp('catcode-f2-cfg-')
  const cwdA = tmp('catcode-f2-cwd-a-')
  const cwdB = tmp('catcode-f2-cwd-b-')
  const engineSessionIdA = randomUUID()
  const engineSessionIdB = randomUUID()
  const markerA = `f2-a-${randomUUID()}`
  const markerB = `f2-b-${randomUUID()}`

  const [transcriptA, transcriptB] = await Promise.all([
    mintRealisticTranscript({ configHome, cwd: cwdA, engineSessionId: engineSessionIdA, marker: markerA }),
    mintRealisticTranscript({ configHome, cwd: cwdB, engineSessionId: engineSessionIdB, marker: markerB }),
  ])

  // Fixture construction is production persistence, not a handwritten JSONL:
  // pin the historical trap shape before exercising the production resolver.
  for (const [{ transcriptPath, sidechainPath }, marker] of [[transcriptA, markerA], [transcriptB, markerB]] as const) {
    expect(existsSync(transcriptPath)).toBe(true)
    expect(existsSync(sidechainPath)).toBe(true)
    const text = readFileSync(transcriptPath, 'utf8')
    const sidechain = readFileSync(sidechainPath, 'utf8')
    expect(sidechain).toContain(`sidechain for ${marker}`)
    expect(text).toContain(`diagnostic after ${marker}`)
    expect(sidechain).toContain('"isSidechain":true')
  }

  const appSessionA = 'f2-restore-a'
  const appSessionB = 'f2-restore-b'
  const first = makeSupervisor(configHome)
  const firstReadyAPromise = waitForFrame(first, frame => frame.kind === 'ready' && frame.sessionId === appSessionA)
  const firstReadyBPromise = waitForFrame(first, frame => frame.kind === 'ready' && frame.sessionId === appSessionB)
  first.spawnSession(appSessionA, { cwd: cwdA, resumeEngineSessionId: engineSessionIdA })
  first.spawnSession(appSessionB, { cwd: cwdB, resumeEngineSessionId: engineSessionIdB })
  const [firstReadyA, firstReadyB] = await Promise.all([firstReadyAPromise, firstReadyBPromise])
  expect(firstReadyA.kind === 'ready' && firstReadyA.engineSessionId).toBe(engineSessionIdA)
  expect(firstReadyB.kind === 'ready' && firstReadyB.engineSessionId).toBe(engineSessionIdB)
  const firstPidA = first.getSessionProcessId(appSessionA)
  const firstPidB = first.getSessionProcessId(appSessionB)
  expect(firstPidA).toBeNumber()
  expect(firstPidB).toBeNumber()

  first.shutdown()
  await Promise.all([waitForPidExit(firstPidA!), waitForPidExit(firstPidB!)])

  // Fresh supervisor = a restore after the old process pair has died. The
  // production resolver is invoked by `resumeEngineSession` inside index.ts.
  const restored = makeSupervisor(configHome)
  const restoredFrames: ServerFrame[] = []
  restored.subscribe(event => {
    if (event.type === 'frame') restoredFrames.push(event.frame)
  })
  const restoredReadyAPromise = waitForFrame(restored, frame => frame.kind === 'ready' && frame.sessionId === appSessionA)
  const restoredReadyBPromise = waitForFrame(restored, frame => frame.kind === 'ready' && frame.sessionId === appSessionB)
  const replayMarkerA = waitForFrame(restored, frame => frame.kind === 'event' && frame.sessionId === appSessionA && frame.replay === true && JSON.stringify(frame).includes(markerA))
  const replayMarkerB = waitForFrame(restored, frame => frame.kind === 'event' && frame.sessionId === appSessionB && frame.replay === true && JSON.stringify(frame).includes(markerB))
  restored.spawnSession(appSessionA, { cwd: cwdA, resumeEngineSessionId: engineSessionIdA })
  restored.spawnSession(appSessionB, { cwd: cwdB, resumeEngineSessionId: engineSessionIdB })
  const [restoredReadyA, restoredReadyB] = await Promise.all([restoredReadyAPromise, restoredReadyBPromise])
  expect(restoredReadyA.kind === 'ready' && restoredReadyA.engineSessionId).toBe(engineSessionIdA)
  expect(restoredReadyB.kind === 'ready' && restoredReadyB.engineSessionId).toBe(engineSessionIdB)
  expect(restored.getSessionProcessId(appSessionA)).not.toBe(firstPidA)
  expect(restored.getSessionProcessId(appSessionB)).not.toBe(firstPidB)

  await Promise.all([replayMarkerA, replayMarkerB])

  const replayA = restoredFrames.filter(frame => frame.kind === 'event' && frame.sessionId === appSessionA && frame.replay === true)
  const replayB = restoredFrames.filter(frame => frame.kind === 'event' && frame.sessionId === appSessionB && frame.replay === true)
  expect(JSON.stringify(replayA)).toContain(markerA)
  expect(JSON.stringify(replayA)).not.toContain(markerB)
  expect(JSON.stringify(replayB)).toContain(markerB)
  expect(JSON.stringify(replayB)).not.toContain(markerA)
}, TEST_TIMEOUT_MS)
