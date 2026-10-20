import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

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
    'app/main/lidClosedMode.test.ts',
    'app/native/lid-closed/native.test.ts',
    'app/native/lid-closed/powerObservation.test.ts',
  ],
  analytics: [
    'app/main/usageStatsRunner.test.ts',
    'app/sidecar/usageStatsWorker.probe.test.ts',
    'app/sidecar/usageSummary.integration.test.ts',
  ],
  runtime: [
    'app/main/idleParkLifecycle.probe.test.ts',
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

if (import.meta.main) {
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
  const [suite = 'fast', ...args] = process.argv.slice(2)
  try {
    const command = desktopTestArgs(suite, args)
    for (const path of Object.values(slowDesktopTests).flat()) {
      if (!existsSync(resolve(repoRoot, path))) throw new Error(`Slow desktop test moved or missing: ${path}. Update desktopTests.ts.`)
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
