/**
 * Engine-session resume for the sidecar (REGISTRY.md R3 / D1 §4 step 4).
 *
 * When the supervisor spawns a sidecar with `CATCODE_SIDECAR_RESUME_SESSION_ID`,
 * session construction must resume THAT engine session rather than mint a fresh
 * one. This composes the engine's REAL resume machinery, exactly as the TUI's
 * `--resume` flow does (`src/main.tsx:3784-3797`):
 *
 *   1. `loadConversationForResume(id, undefined)` — deserialize messages +
 *      interruption state + metadata from the transcript keyed by the engine
 *      session id (`src/utils/conversationRecovery.ts:465`).
 *   2. `processResumedConversation(result, …)` — rebuild session state around
 *      them (`src/utils/sessionRestore.ts:493`). Internally this calls
 *      `switchSession(asSessionId(id), …)` (`src/bootstrap/state.ts:474`), which
 *      is the id-ADOPTION step — NOT a resume by itself (D1 R3). Running it here
 *      is what makes `getSessionId()` return the resumed id, so the ready frame's
 *      `engineSessionId` (P3-0) echoes the requested id.
 *
 * Failure posture (D6 anti-Potemkin clause): an unresumable id — transcript
 * missing or corrupt so `loadConversationForResume` returns null — throws. The
 * caller (index.ts) exits loudly (non-zero + distinguishable stderr). A silent
 * fresh session would fake a restore, which is exactly what the anti-Potemkin
 * clause exists to catch.
 */

import { getSessionId } from '../../src/bootstrap/state.js'
import { loadConversationForResume } from '../../src/utils/conversationRecovery.js'
import { processResumedConversation } from '../../src/utils/sessionRestore.js'
import { getSessionQueueOperations } from '../../src/utils/sessionStorage.js'
import { getDefaultAppState } from '../../src/state/AppStateStore.js'
import type { Message } from '../../src/types/message.js'

/** A resume that could not be performed — the id has no usable transcript. */
export class SidecarResumeError extends Error {
  readonly resumeEngineSessionId: string

  constructor(resumeEngineSessionId: string, detail: string) {
    super(
      `cannot resume engine session ${resumeEngineSessionId}: ${detail}`,
    )
    this.name = 'SidecarResumeError'
    this.resumeEngineSessionId = resumeEngineSessionId
  }
}

export type SidecarResumeResult = {
  /** `getSessionId()` after resume — MUST equal the requested id. */
  engineSessionId: string
  /**
   * The deserialized prior transcript — the engine-side resumed state. In the
   * TUI these become the REPL's `initialMessages`; headless, they are the
   * assertion surface proving history was actually loaded (not re-read JSONL).
   */
  messages: Message[]
  turnInterrupted: boolean
  undeliveredPrompts: Array<{
    uuid: string
    content: string
    timestamp: string
  }>
}

/**
 * Resume `resumeEngineSessionId` through the engine's real machinery. Assumes
 * the engine runtime is already initialized (`init()` has run) and the process
 * is rooted in the session's cwd (the transcript lives under that project dir).
 *
 * @throws {SidecarResumeError} if the id has no loadable transcript, or if the
 *   resumed id somehow fails to become the active session id.
 */
export async function resumeEngineSession(
  resumeEngineSessionId: string,
  cwd: string,
): Promise<SidecarResumeResult> {
  const loaded = await loadConversationForResume(
    resumeEngineSessionId,
    undefined,
  )
  if (!loaded) {
    // Missing/corrupt transcript — never fall through to a fresh session.
    throw new SidecarResumeError(
      resumeEngineSessionId,
      'no conversation found (transcript missing or unreadable)',
    )
  }

  const queueState = await getSessionQueueOperations(resumeEngineSessionId)
  const undeliveredByUuid = new Map<
    string,
    SidecarResumeResult['undeliveredPrompts'][number]
  >()
  for (const operation of queueState.operations) {
    if (
      operation.operation !== 'enqueue' ||
      operation.mode !== 'prompt' ||
      operation.uuid === undefined ||
      operation.content === undefined ||
      queueState.messageUuids.has(operation.uuid)
    ) {
      continue
    }
    undeliveredByUuid.set(operation.uuid, {
      uuid: operation.uuid,
      content: operation.content,
      timestamp: operation.timestamp,
    })
  }

  const processed = await processResumedConversation(
    loaded,
    {
      forkSession: false,
      // Pin the adopted id to the requested one, not merely what the log walk
      // inferred — the registry addressed us by this exact engine session id.
      sessionIdOverride: resumeEngineSessionId,
    },
    {
      // Headless resume context. Agent restoration degrades to default behavior
      // with an empty agent set (restoreAgentFromSession clears state when the
      // session had no agent, and logs-then-defaults if the agent is gone);
      // message + session-id restore — the P3-1 contract — does not depend on it.
      modeApi: null,
      mainThreadAgentDefinition: undefined,
      agentDefinitions: { activeAgents: [], allAgents: [] },
      currentCwd: cwd,
      cliAgents: [],
      initialState: getDefaultAppState(),
    },
  )

  const engineSessionId = getSessionId()
  if (engineSessionId !== resumeEngineSessionId) {
    // switchSession should have adopted the id; if not, fail rather than
    // silently write to the wrong transcript.
    throw new SidecarResumeError(
      resumeEngineSessionId,
      `active engine session id is ${engineSessionId} after resume`,
    )
  }

  return {
    engineSessionId,
    messages: processed.messages,
    turnInterrupted: loaded.turnInterruptionState.kind === 'interrupted_prompt',
    undeliveredPrompts: [...undeliveredByUuid.values()],
  }
}
