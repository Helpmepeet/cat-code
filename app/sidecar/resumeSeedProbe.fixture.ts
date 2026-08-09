/**
 * Test fixture — proves the F1 fix (host-plane review 2026-07-05): a resumed
 * sidecar session doesn't just echo the engine session id, it actually holds the
 * restored transcript as its live turn context.
 *
 * Runs in its own Bun process (the house pattern — resume mutates global engine
 * STATE, which must never leak into the shared test-runner process), rooted in
 * the session cwd with the probe's config home, exactly like a real sidecar:
 *
 *   1. `init()` + `resumeEngineSession(id, cwd)` — the REAL resume machinery.
 *   2. `createSidecarSessionController({ probe:false, cwd, initialMessages })` —
 *      the exact production construction `index.ts` performs with the seed.
 *   3. Capture the REAL `QueryEngine` through the same assembly
 *      `createRuntimeBackedWebAppSession` performs (its `createEngine` seam,
 *      constructing the same `new QueryEngine(config)` the default expression
 *      does) and read the engine's LIVE `mutableMessages` — the exact state
 *      `submit` copies into the model context (`QueryEngine.ts:454`). Asserting
 *      on it is the strongest hermetic proof available: "the loader returned
 *      messages" (the old camouflage) proves nothing about the served engine;
 *      this proves the served engine's turn context IS the restored transcript,
 *      message-for-message by uuid. The final step — a live model answer built
 *      from that context — needs a credentialed turn and is P3-8's
 *      anti-Potemkin gate by design.
 *
 * Run:
 *   CLAUDE_CONFIG_DIR=… bun run app/sidecar/resumeSeedProbe.fixture.ts <engineSessionId> <marker>
 *
 * Prints one JSON line `SEED_RESULT={…}` on stdout and exits 0; any failure
 * throws and exits non-zero (loud, never a silent empty result).
 */

import { init } from '../../src/entrypoints/init.js'
import { QueryEngine } from '../../src/QueryEngine.js'
import { createQueryEngineAppSession } from '../../src/app-runtime/createQueryEngineAppSession.js'
import type { Message } from '../../src/types/message.js'
import { isInternalNoResponseSentinel } from '../../src/utils/messages.js'
import { projectResumedHistory } from './historyProjection.js'
import { resumeEngineSession } from './sessionResume.js'
import {
  createNormalSidecarQueryEngineConfig,
  createSidecarSessionController,
  loadAgentDefinitionsForRuntime,
} from './sessionController.js'

async function main(): Promise<void> {
  const engineSessionId = process.argv[2]
  const marker = process.argv[3] ?? ''
  if (!engineSessionId) {
    throw new Error('usage: resumeSeedProbe.fixture.ts <engineSessionId> [marker]')
  }
  const cwd = process.cwd()

  await init()
  const agentDefinitions = await loadAgentDefinitionsForRuntime(cwd)
  const resumed = await resumeEngineSession(
    engineSessionId,
    cwd,
    agentDefinitions,
  )

  // (2) The production path, seed included — proves index.ts's exact
  // construction accepts and threads the resumed messages.
  const session = await createSidecarSessionController({
    probe: false,
    cwd,
    initialMessages: resumed.messages,
    agentDefinitions,
    resumedInitialState: resumed.initialState,
  })

  // (3) The same assembly createRuntimeBackedWebAppSession performs, with the
  // REAL QueryEngine captured via the createEngine seam so its live message
  // state is observable.
  const { queryEngineConfig } = await createNormalSidecarQueryEngineConfig(
    cwd,
    resumed.messages,
    { agentDefinitions, resumedInitialState: resumed.initialState },
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

  // F2 tail proof: the visible seed projection is byte-for-byte the tail that
  // index.ts appends after any archival prefix. Internal no-response records
  // remain engine-only, including legacy API-error-shaped fallbacks.
  const replayUuids = projectResumedHistory(resumed.messages).map(m => m.uuid)
  const visibleHeld = held.filter(
    message => !isInternalNoResponseSentinel(message),
  )

  const payload = {
    engineSessionId: resumed.engineSessionId,
    seededCount: resumed.messages.length,
    controllerBuilt: Boolean(session.controller),
    engineHeldCount: held.length,
    engineHasMarker: JSON.stringify(held).includes(marker),
    // The engine's turn context is the restored transcript itself, not a
    // lookalike: same messages, same order, matched by uuid.
    engineHeldUuidsMatchResumed:
      held.length === resumed.messages.length &&
      held.every((m, i) => m.uuid === resumed.messages[i]?.uuid),
    replayMatchesVisibleEngineSeed:
      replayUuids.length === visibleHeld.length &&
      replayUuids.every((uuid, i) => uuid === visibleHeld[i]?.uuid),
  }
  process.stdout.write(`SEED_RESULT=${JSON.stringify(payload)}\n`)
  await new Promise<void>(resolve => {
    if (process.stdout.write('')) resolve()
    else process.stdout.once('drain', () => resolve())
  })
  process.exit(0)
}

void main().catch(error => {
  process.stderr.write(
    `resume-seed-probe failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  )
  process.exit(1)
})
