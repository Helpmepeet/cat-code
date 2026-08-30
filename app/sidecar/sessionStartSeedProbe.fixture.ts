/**
 * Test fixture — the fresh-session twin of `resumeSeedProbe.fixture.ts`. Proves
 * that what a SessionStart hook emits on a NEW desktop session ends up in the
 * live turn context of the QueryEngine the sidecar serves, not merely in a
 * return value nobody reads.
 *
 * Runs in its own Bun process (the house pattern — engine startup mutates global
 * engine STATE, which must never leak into the shared test-runner process),
 * rooted in the session cwd with the probe's config home:
 *
 *   1. `init()` + `processSessionStartHooks('startup')` — the REAL hook
 *      machinery against the REAL hook on disk, the same call `index.ts` makes.
 *   2. `createSidecarSessionController({ probe:false, cwd, initialMessages })` —
 *      the production construction, seeded exactly as `index.ts` seeds it.
 *   3. Capture the REAL `QueryEngine` through the same assembly
 *      `createRuntimeBackedAppSession` performs (its `createEngine` seam) and
 *      read the engine's LIVE `mutableMessages` — the exact state `submit`
 *      copies into the model context.
 *
 * Run:
 *   CLAUDE_CONFIG_DIR=… bun run app/sidecar/sessionStartSeedProbe.fixture.ts <marker>
 *
 * Prints one JSON line `START_SEED_RESULT={…}` on stdout and exits 0; any failure
 * throws and exits non-zero (loud, never a silent empty result).
 */

import { init } from '../../src/entrypoints/init.js'
import { QueryEngine } from '../../src/QueryEngine.js'
import { createQueryEngineAppSession } from '../../src/app-runtime/createQueryEngineAppSession.js'
import type { Message } from '../../src/types/message.js'
import { hasProviderBoundHistory } from '../../src/utils/model/providers.js'
import { processSessionStartHooks } from '../../src/utils/sessionStart.js'
import { releaseActiveTranscriptLease } from '../../src/utils/transcriptLease.js'
import {
  createNormalSidecarQueryEngineConfig,
  createSidecarSessionController,
  loadAgentDefinitionsForRuntime,
} from './sessionController.js'

async function main(): Promise<void> {
  const marker = process.argv[2] ?? ''
  const cwd = process.cwd()

  await init()
  const agentDefinitions = await loadAgentDefinitionsForRuntime(cwd)
  const hookMessages = await processSessionStartHooks('startup')

  const session = await createSidecarSessionController({
    probe: false,
    cwd,
    initialMessages: hookMessages,
    agentDefinitions,
  })

  const { queryEngineConfig } = await createNormalSidecarQueryEngineConfig(
    cwd,
    hookMessages,
    { agentDefinitions },
  )
  let captured: QueryEngine | null = null
  createQueryEngineAppSession({
    ...queryEngineConfig,
    includePartialMessages: true,
    createEngine: config => {
      captured = new QueryEngine(config)
      return captured
    },
  })
  if (!captured) {
    throw new Error('createEngine seam was not invoked — no engine captured')
  }
  // TS `private` is compile-time only; the live field is the assertion surface.
  const held = (captured as unknown as { mutableMessages: Message[] })
    .mutableMessages

  const payload = {
    hookMessageCount: hookMessages.length,
    controllerBuilt: Boolean(session.controller),
    engineHeldCount: held.length,
    engineHasMarker: marker.length > 0 && JSON.stringify(held).includes(marker),
    // `initialMessages` is read twice more by the production construction, and a
    // fresh session must answer both exactly as an unseeded one did: no resumed
    // model to adopt (`sessionController.ts:297`) and no provider lock
    // (`sessionController.ts:622` → `setProviderSwitchLocked`). Hook output is
    // system/attachment records, so both stay inert.
    providerBoundHistory: hasProviderBoundHistory(hookMessages),
    messageTypes: [...new Set(hookMessages.map(message => message.type))].sort(),
  }
  process.stdout.write(`START_SEED_RESULT=${JSON.stringify(payload)}\n`)
  await new Promise<void>(resolve => {
    if (process.stdout.write('')) resolve()
    else process.stdout.once('drain', () => resolve())
  })
  await releaseActiveTranscriptLease()
  process.exit(0)
}

void main().catch(error => {
  process.stderr.write(
    `session-start-seed-probe failed: ${
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    }\n`,
  )
  process.exit(1)
})
