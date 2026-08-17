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

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { getSessionId } from '../../src/bootstrap/state.js'
import { loadConversationForResume } from '../../src/utils/conversationRecovery.js'
import { processResumedConversation } from '../../src/utils/sessionRestore.js'
import {
  getSessionQueueOperations,
  type SessionQueueOperation,
} from '../../src/utils/sessionStorage.js'
import { getDefaultAppState } from '../../src/state/AppStateStore.js'
import type { Message } from '../../src/types/message.js'
import type { AppState } from '../../src/state/AppStateStore.js'
import type { AgentDefinitionsResult } from '../../src/tools/AgentTool/loadAgentsDir.js'

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

/**
 * A message that was still on the mid-turn queue when the process died: the
 * user watched it leave the composer, and nothing ever delivered it.
 *
 * These become ordinary `user` rows in the restored history (`index.ts`), which
 * reads against D1a — the model never received them. It stays that way on
 * purpose: the queue itself does not survive the process, so the message can
 * never be delivered now, and the two D1a-shaped alternatives are both worse.
 * Dropping it loses text the user wrote and watched be accepted, which is the
 * bug CC-54 exists to fix. Restoring it as still-waiting either re-arms
 * delivery (a restore that starts a turn and spends tokens, which restore must
 * not do) or shows a message as waiting for a turn that will never come. The
 * row is a record of what was written, not a claim about what the model saw.
 * What is still missing is that the row does not SAY so: nothing renders
 * `isReplay`, so it is indistinguishable from a delivered message.
 */
export type UndeliveredPrompt = {
  uuid: string
  /** Verbatim, so an image-bearing message restores as what was sent. */
  content: string | ContentBlockParam[]
  timestamp: string
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
  /**
   * The engine-restored state that must seed the sidecar's runtime store. This
   * carries durable resume data such as the active goal and restored agent;
   * retaining messages alone would make the transcript and desktop read seams
   * disagree after a restart.
   */
  initialState: AppState
  turnInterrupted: boolean
  undeliveredPrompts: UndeliveredPrompt[]
}

/**
 * Rebuild the mid-turn queue as it stood when the process died, from the
 * durable queue-operation log (`src/utils/messageQueueManager.ts` logOperation).
 *
 * The log is a ledger, not a list: an `enqueue` says a message started waiting
 * and every other operation says one stopped. So a prompt is undelivered only
 * if NOTHING later took it off the queue and it never became a persisted user
 * message. Reading the enqueues alone is what resurrected a message the user
 * had taken back (D1b) on every later restore, including a routine idle-park
 * one: its `enqueue` outlived the session, and the recall that answered it left
 * no record the filter looked at.
 *
 * Retractions are matched by uuid and NOTHING else. Two records with the same
 * text are two different messages; a resend after a Take back is a new uuid,
 * which is exactly why the resent copy is still recovered while the recalled
 * one is not.
 *
 * `content` is runtime-narrowed rather than trusted: these records come off
 * disk, and a row that cannot be represented faithfully is dropped instead of
 * being restored as something the user did not send.
 */
export function selectUndeliveredPrompts(queueState: {
  operations: readonly SessionQueueOperation[]
  messageUuids: ReadonlySet<string>
}): UndeliveredPrompt[] {
  const retracted = new Set<string>()
  for (const operation of queueState.operations) {
    if (operation.operation === 'enqueue' || operation.uuid === undefined) {
      continue
    }
    retracted.add(operation.uuid)
  }

  const undeliveredByUuid = new Map<string, UndeliveredPrompt>()
  for (const operation of queueState.operations) {
    if (
      operation.operation !== 'enqueue' ||
      operation.mode !== 'prompt' ||
      operation.uuid === undefined ||
      retracted.has(operation.uuid) ||
      queueState.messageUuids.has(operation.uuid)
    ) {
      continue
    }
    const content = operation.content
    if (typeof content !== 'string' && !Array.isArray(content)) continue
    undeliveredByUuid.set(operation.uuid, {
      uuid: operation.uuid,
      content,
      timestamp: operation.timestamp,
    })
  }
  return [...undeliveredByUuid.values()]
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
  agentDefinitions: AgentDefinitionsResult,
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
  const undeliveredPrompts = selectUndeliveredPrompts(queueState)

  const processed = await processResumedConversation(
    loaded,
    {
      forkSession: false,
      // Pin the adopted id to the requested one, not merely what the log walk
      // inferred — the registry addressed us by this exact engine session id.
      sessionIdOverride: resumeEngineSessionId,
    },
    {
      // Use the same real definitions that configure the subsequent
      // QueryEngine. restoreAgentFromSession needs this catalog to preserve a
      // recorded custom agent (and its model) instead of silently defaulting.
      modeApi: null,
      mainThreadAgentDefinition: undefined,
      agentDefinitions,
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
    initialState: processed.initialState,
    turnInterrupted: loaded.turnInterruptionState.kind === 'interrupted_prompt',
    undeliveredPrompts,
  }
}
