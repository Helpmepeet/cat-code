/**
 * Test fixture — runs the sidecar's REAL boot sequence
 * (`initializeSidecarRuntime`, `app/sidecar/index.ts:217`) in its own Bun
 * process, optionally adopts a given durable session id via `switchSession`
 * (the exact call resume's `processResumedConversation` makes internally to
 * adopt the resumed id, see `app/sidecar/sessionResume.ts:14`), then prints
 * the resulting engine session id and the Codex conversation id derived
 * for it.
 *
 * Used by codexCacheKeyResume.probe.test.ts to prove the prompt_cache_key
 * rebind added to `initializeRuntime.ts` survives a sidecar respawn: two
 * separate processes that both adopt the SAME durable session id must
 * derive the SAME Codex conversation id. Isolating the id-adoption call
 * (`switchSession`) from a full `resumeEngineSession` avoids taking the
 * per-session transcript lease twice in a row across two real processes,
 * which is unrelated machinery this fixture doesn't need to exercise.
 *
 * Run (spawned with an isolated CLAUDE_CONFIG_DIR, matching the other
 * app/sidecar/*.fixture.ts probes, so it never touches the real
 * ~/.cat-code config or account pool):
 *
 *   CLAUDE_CONFIG_DIR=… bun run app/sidecar/codexCacheKeyBind.fixture.ts \
 *     <accountId> <model> [adoptSessionId]
 */

import { getSessionId, switchSession } from '../../src/bootstrap/state.js'
import { _getConversationIdForRequestForTest } from '../../src/services/api/codex-fetch-adapter.js'
import { asSessionId } from '../../src/types/ids.js'
import { initializeSidecarRuntime } from './initializeRuntime.js'

async function main(): Promise<void> {
  const accountId = process.argv[2]
  const model = process.argv[3]
  const adoptSessionId = process.argv[4]
  if (!accountId || !model) {
    throw new Error(
      'usage: codexCacheKeyBind.fixture.ts <accountId> <model> [adoptSessionId]',
    )
  }

  // Mirrors app/sidecar/index.ts:217 — binds the prompt_cache_key to this
  // process's freshly-minted bootstrap session id before anything else runs.
  await initializeSidecarRuntime()

  if (adoptSessionId) {
    // The exact call resume's processResumedConversation makes internally to
    // adopt a durable id (app/sidecar/sessionResume.ts:14). Calling it
    // directly here isolates the id-adoption signal from transcript
    // loading/lease machinery, which is unrelated to the cache-key rebind
    // under test and already covered by sessionResume.probe.test.ts.
    switchSession(asSessionId(adoptSessionId))
  }

  process.stdout.write(`BOUND_SESSION_ID=${getSessionId()}\n`)
  process.stdout.write(
    `CONV_ID=${_getConversationIdForRequestForTest(accountId, model)}\n`,
  )
  // Flush stdout before exit so the parent reliably reads both lines.
  await new Promise<void>(resolve => {
    if (process.stdout.write('')) resolve()
    else process.stdout.once('drain', () => resolve())
  })
  process.exit(0)
}

void main().catch(error => {
  process.stderr.write(
    `codex-cache-bind fixture failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  )
  process.exit(1)
})
