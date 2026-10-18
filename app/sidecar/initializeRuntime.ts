import { getSessionId, onSessionSwitch } from '../../src/bootstrap/state.js'
import { init } from '../../src/entrypoints/init.js'
import { setCodexPromptCacheKey } from '../../src/services/api/codex-fetch-adapter.js'
import { ensureEngineMacro } from './engineMetadata.js'
export { ensureEngineMacro } from './engineMetadata.js'

/**
 * Run the same engine bootstrap as the CLI before constructing a live desktop
 * session. The first controller construction is intentionally side-effect
 * light; the first submit is not, and requires configs plus account pools.
 */
export async function initializeSidecarRuntime(): Promise<void> {
  ensureEngineMacro()
  await init()

  // Mirror src/setup.ts:90+97-99: pin the Codex prompt_cache_key to the
  // engine session id so a sidecar respawn (idle-park, crash restart,
  // window reopen) reuses the same server cache prefix instead of the
  // per-process random UUID that codex-fetch-adapter.ts falls back to.
  // index.ts calls this BEFORE resumeEngineSession(), so on a fresh spawn
  // getSessionId() is the freshly-minted bootstrap id (becomes the durable
  // id going forward); on a resumed spawn, resumeEngineSession() ->
  // processResumedConversation() -> switchSession() later adopts the
  // durable resumed id and fires this rebind, correcting the pin exactly
  // as --resume does for the CLI (src/setup.ts:91-96).
  setCodexPromptCacheKey(getSessionId())
  onSessionSwitch(id => {
    setCodexPromptCacheKey(id)
  })
}
