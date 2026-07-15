/** Test-only positive control for the PL-B hook-suppression probe. */

import { init } from '../../src/entrypoints/init.js'
import { captureHooksConfigSnapshot } from '../../src/utils/hooks/hooksConfigSnapshot.js'
import { processSessionStartHooks } from '../../src/utils/sessionStart.js'

async function main(): Promise<void> {
  await init()
  captureHooksConfigSnapshot()
  await processSessionStartHooks('resume', {
    sessionId: process.argv[2],
    forceSyncExecution: true,
  })
  process.exit(0)
}

void main().catch(error => {
  process.stderr.write(
    `hook control failed: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exit(1)
})
