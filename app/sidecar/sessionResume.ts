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
 * What is still missing is that the row does not SAY so. `isReplay` is set on
 * the projected frame and IS consumed, but only for turn state:
 * `app/renderer/src/transcriptProjector.ts:1232` reads it so a restored prompt
 * does not clear `turnInterrupted`. Nothing marks the row visually, which is the
 * real gap. The flag is load-bearing, so do not delete it as unused.
 */
export type UndeliveredPrompt = {
  uuid: string
  /** Verbatim, so an image-bearing message restores as what was sent. */
  content: string | ContentBlockParam[]
  timestamp: string
}

/**
 * The reconstructed queue, plus how many enqueue records it had to discard. A
 * restore that recovered less than the log held is countable rather than silent
 * (`session.restore.completed` in `index.ts`).
 */
export type UndeliveredPromptSelection = {
  prompts: UndeliveredPrompt[]
  droppedRecords: number
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
  /** See `UndeliveredPromptSelection.droppedRecords`. */
  droppedQueueRecords: number
}

/**
 * Block kinds a queued prompt can actually carry, so a record that holds
 * anything else is not restored as if the user had typed it.
 *
 * A queued prompt's value comes from a composer submit: the terminal's is a
 * string (`src/utils/handlePromptSubmit.ts:414`), and the desktop and bridge
 * paths can send `text` and `image` blocks. A `tool_use`, `tool_result` or
 * `document` block in a `type:'user'` frame would be a shape no composer can
 * produce, so it is a corrupt or hand-edited record rather than lost input.
 */
function restorableContent(
  content: SessionQueueOperation['content'],
): string | ContentBlockParam[] | null {
  if (typeof content === 'string') return content.length > 0 ? content : null
  if (!Array.isArray(content) || content.length === 0) return null
  for (const block of content) {
    if (block === null || typeof block !== 'object') return null
    const candidate = block as { type?: unknown; text?: unknown; source?: unknown }
    if (candidate.type === 'text') {
      if (typeof candidate.text !== 'string') return null
      continue
    }
    if (candidate.type === 'image') {
      if (candidate.source === null || typeof candidate.source !== 'object') {
        return null
      }
      continue
    }
    return null
  }
  return content
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
 * The walk is IN ORDER, over a live map, because a uuid can stop waiting and
 * start again: `drainOneQueuedPrompt` re-enqueues the same command object after
 * a turn that rejected before `onInputPersisted`, and again when `startTurn`
 * refuses outright (`app/sidecar/sidecarServer.ts`). The log then reads
 * enqueue-dequeue-enqueue for a message that is genuinely still queued.
 * Collecting the retracted uuids as an order-independent set destroyed exactly
 * that message, silently. Order is safe to rely on: `logOperation` writes
 * through `recordQueueOperation` to one per-file queue that drains in push
 * order (`src/utils/sessionStorage.ts` enqueueWrite / drainWriteQueue), and the
 * reader appends in file order (`loadTranscriptFile`). If it ever were in
 * doubt, the fix is a stable sort on `timestamp`, never discarding order:
 * same-tick records share a millisecond, so only file order separates them.
 *
 * `content` is runtime-narrowed rather than trusted: these records come off
 * disk, and a row that cannot be represented faithfully is dropped instead of
 * being restored as something the user did not send.
 */
export function selectUndeliveredPrompts(queueState: {
  operations: readonly SessionQueueOperation[]
  messageUuids: ReadonlySet<string>
}): UndeliveredPromptSelection {
  const waiting = new Map<string, UndeliveredPrompt>()
  let droppedRecords = 0
  for (const operation of queueState.operations) {
    if (operation.operation !== 'enqueue') {
      // A retraction written before the verbs recorded their command cannot say
      // WHICH message stopped waiting, and matching by text would take back the
      // wrong one. Replaying one stale row is the lesser harm.
      if (operation.uuid !== undefined) waiting.delete(operation.uuid)
      continue
    }
    if (operation.mode !== 'prompt') continue
    const content = restorableContent(operation.content)
    if (operation.uuid === undefined || content === null) {
      droppedRecords++
      continue
    }
    // Re-inserting on a requeue also moves it to the back of the map, matching
    // the real queue: `drainOneQueuedPrompt`'s put-back appends.
    waiting.set(operation.uuid, {
      uuid: operation.uuid,
      content,
      timestamp: operation.timestamp,
    })
  }
  return {
    prompts: [...waiting.values()].filter(
      prompt => !queueState.messageUuids.has(prompt.uuid),
    ),
    droppedRecords,
  }
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
  const undelivered = selectUndeliveredPrompts(queueState)

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
    undeliveredPrompts: undelivered.prompts,
    droppedQueueRecords: undelivered.droppedRecords,
  }
}
