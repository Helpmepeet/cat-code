import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

// Explicit files, not suffix-wide exclusions: new tests enter the routine run
// until their cost and regression responsibilities have been reviewed.
export const slowDesktopTests = {
  workspace: [
    'app/host/chatRelocation.feasibility.probe.test.ts',
    'app/host/projectRouting.process.test.ts',
    'app/shared/sessionRelocationRepeat.storage.test.ts',
    'app/sidecar/workspaceHandoffRestore.process.test.ts',
    'app/sidecar/workspaceJumpBaseline.process.test.ts',
    'app/sidecar/workspaceJumpStartup.process.test.ts',
  ],
  native: [
    'app/main/previewDocumentRunner.test.ts',
    'app/main/lidClosedMode.test.ts',
    'app/native/lid-closed/native.test.ts',
    'app/native/lid-closed/powerObservation.test.ts',
    'app/scripts/transcriptScrollNative.test.ts',
    'app/scripts/composer-undo-native.test.ts',
    'app/scripts/idle-rendering-native.test.ts',
  ],
  analytics: [
    'app/main/usageStatsRunner.test.ts',
    'app/sidecar/usageStatsWorker.probe.test.ts',
    'app/sidecar/usageSummary.integration.test.ts',
  ],
  runtime: [
    'app/main/parkLifecycle.probe.test.ts',
    'app/main/scheduledTaskRunner.process.test.ts',
    'app/sidecar/accountsPoolWorker.probe.test.ts',
    'app/sidecar/diagnosticsDomain.test.ts',
    'app/sidecar/forceSendBackground.integration.test.ts',
    'app/sidecar/idleTtl.probe.test.ts',
    'app/sidecar/permissionDomain.test.ts',
    'app/sidecar/resumeSeed.probe.test.ts',
    'app/sidecar/sessionsCatalogWorker.probe.test.ts',
    'app/sidecar/sidecarCleanup.test.ts',
    'app/sidecar/spawnConfig.probe.test.ts',
    'app/sidecar/transcriptBackfillWorker.probe.test.ts',
  ],
  tooling: [
    'app/main/editorLauncher.test.ts',
    'app/scripts/harnessLifetime.test.ts',
    'app/scripts/nativeCaptureRunners.test.ts',
  ],
} as const

export function desktopTestArgs(suite = 'fast', args: string[] = []): string[] {
  const slowFiles = Object.values(slowDesktopTests).flat()
  if (suite === 'all') return ['test', './app', ...args]
  if (suite === 'fast') {
    return ['test', './app', ...slowFiles.flatMap(path => ['--path-ignore-patterns', path]), ...args]
  }
  if (suite !== 'slow') throw new Error(`Unknown desktop suite: ${suite}. Use fast, slow, or all.`)
  const [group, ...rest] = args
  if (group && !group.startsWith('-')) {
    if (!Object.hasOwn(slowDesktopTests, group)) {
      throw new Error(`Unknown slow desktop group: ${group}. Use ${Object.keys(slowDesktopTests).join(', ')}.`)
    }
    const files = slowDesktopTests[group as keyof typeof slowDesktopTests]
    return ['test', ...files.map(path => `./${path}`), ...rest]
  }
  return ['test', ...slowFiles.map(path => `./${path}`), ...args]
}

export type FullSuiteLane = { name: string; args: string[]; after?: string }

// The full suite gates every local install and took ~11 minutes one file at a
// time. Routine files share worker processes. Workspace files start real
// sidecars, so they run one at a time beside the workers. Native files measure
// real layout and input timing, so they wait for the workers to finish; under
// load a scroll check saw transient 2px shifts. ~4 minutes on a 12-core Mac.
export function fullSuiteLanes(workers = fullSuiteWorkers()): FullSuiteLane[] {
  const workspace = [...slowDesktopTests.workspace], native = [...slowDesktopTests.native]
  return [
    { name: 'routine', args: ['test', './app', `--parallel=${workers}`, ...[...workspace, ...native].flatMap(path => ['--path-ignore-patterns', path])] },
    { name: 'workspace', args: ['test', ...workspace.map(path => `./${path}`)] },
    { name: 'native', args: ['test', ...native.map(path => `./${path}`)], after: 'routine' },
  ]
}

export function fullSuiteWorkers(cores = availableParallelism()): number {
  return Math.max(1, Math.min(5, Math.floor(cores / 2) - 1))
}

/**
 * Runs lanes concurrently. Each lane streams to its own log, so a stalled lane
 * shows which files finished, and its output prints whole when it ends. Lanes
 * run in their own process group: Bun's test workers outlive a killed
 * coordinator, so stopping a lane stops the group.
 */
export async function runFullSuite(cwd: string, lanes: FullSuiteLane[], write: (text: string) => void, laneTimeoutMs = 20 * 60_000): Promise<number> {
  const started = performance.now()
  const logs = mkdtempSync(join(tmpdir(), 'desktop-tests-'))
  const finished = new Map<string, Promise<number>>()
  const groups = new Set<number>()
  const stopGroup = (pid: number) => { try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ } }
  const stop = () => { for (const pid of groups) stopGroup(pid); process.exit(130) }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  const run = async (lane: FullSuiteLane): Promise<number> => {
    if (lane.after) await finished.get(lane.after)
    const log = join(logs, `${lane.name}.log`)
    writeFileSync(log, '')
    write(`[desktop tests] ${lane.name}: started, log ${log}\n`)
    const child = spawn(process.execPath, lane.args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    groups.add(child.pid!)
    for (const stream of [child.stdout!, child.stderr!]) stream.on('data', (chunk: Buffer) => appendFileSync(log, chunk))
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; stopGroup(child.pid!) }, laneTimeoutMs)
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
    const code = await new Promise<number>(resolve => child.once('exit', (status: number | null) => resolve(status ?? 1)))
    clearTimeout(timer)
    // Leftover workers or leaked children can hold the output pipes open.
    groups.delete(child.pid!)
    stopGroup(child.pid!)
    await Promise.race([closed, Bun.sleep(5_000)])
    const seconds = Math.round((performance.now() - started) / 1000)
    const status = timedOut ? `stopped without a result after ${Math.round(laneTimeoutMs / 1000)}s` : code === 0 ? 'passed' : 'failed'
    write(`\n===== ${lane.name}: ${status} at ${seconds}s =====\n${readFileSync(log, 'utf8')}\n`)
    return timedOut ? 1 : code
  }
  for (const lane of lanes) finished.set(lane.name, run(lane))
  const codes = await Promise.all(lanes.map(lane => finished.get(lane.name)!))
  process.off('SIGINT', stop); process.off('SIGTERM', stop)
  const failed = lanes.filter((_, index) => codes[index] !== 0).map(lane => lane.name)
  write(`[desktop tests] ${failed.length ? `failed: ${failed.join(', ')}` : 'all lanes passed'} in ${Math.round((performance.now() - started) / 1000)}s\n`)
  return failed.length ? 1 : 0
}

if (import.meta.main) {
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
  const [suite = 'fast', ...args] = process.argv.slice(2)
  try {
    const command = desktopTestArgs(suite, args)
    for (const path of Object.values(slowDesktopTests).flat()) {
      if (!existsSync(resolve(repoRoot, path))) throw new Error(`Slow desktop test moved or missing: ${path}. Update desktopTests.ts.`)
    }
    // Any extra argument (CI's --shard, a reporter, a worker count) keeps the
    // caller's single invocation.
    if (suite === 'all' && args.length === 0) {
      process.exit(await runFullSuite(repoRoot, fullSuiteLanes(), text => process.stdout.write(text)))
    }
    const child = Bun.spawn([process.execPath, ...command], {
      cwd: repoRoot,
      stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
    })
    process.exit(await child.exited)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
