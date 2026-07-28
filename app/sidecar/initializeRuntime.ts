import { init } from '../../src/entrypoints/init.js'

/**
 * Define the engine's build-metadata global when it is absent, WITHOUT running
 * the CLI bootstrap. Split out of `initializeSidecarRuntime` so an
 * observation-only worker can satisfy engine modules that read version/build
 * metadata without also inheriting `init()`'s live side-effects — notably its
 * fire-and-forget `initAccountPool()` (`src/entrypoints/init.ts:90`), which
 * starts periodic token refresh, quarantine probes, and a startup `touchAll()`.
 * A short-lived worker on a timer must never drive real credential rotation.
 */
export function ensureEngineMacro(): void {
  // The compiled sidecar receives MACRO through Bun's build defines. Dev runs
  // this TypeScript entrypoint directly, so mirror entrypoints/cli.tsx before
  // any first-turn code reads version/build metadata.
  if (typeof MACRO === 'undefined') {
    ;(
      globalThis as {
        MACRO?: {
          VERSION: string
          BUILD_TIME: string
          PACKAGE_URL?: string
          FEEDBACK_CHANNEL?: string
        }
      }
    ).MACRO = {
      VERSION: '2.1.87-dev',
      BUILD_TIME: new Date().toISOString(),
      PACKAGE_URL: 'claude-code-source-snapshot',
      FEEDBACK_CHANNEL: 'github',
    }
  }
}

/**
 * Run the same engine bootstrap as the CLI before constructing a live desktop
 * session. The first controller construction is intentionally side-effect
 * light; the first submit is not, and requires configs plus account pools.
 */
export async function initializeSidecarRuntime(): Promise<void> {
  ensureEngineMacro()
  await init()
}
