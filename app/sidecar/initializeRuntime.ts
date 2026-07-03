import { init } from '../../src/entrypoints/init.js'

/**
 * Run the same engine bootstrap as the CLI before constructing a live desktop
 * session. The first controller construction is intentionally side-effect
 * light; the first submit is not, and requires configs plus account pools.
 */
export async function initializeSidecarRuntime(): Promise<void> {
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

  await init()
}
