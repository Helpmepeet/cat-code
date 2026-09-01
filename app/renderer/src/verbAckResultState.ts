/**
 * Renderer consumer for the four verb-ack `.result` frames that had NO renderer
 * consumer before decision #5 (audit `docs/migration/reviews/2026-07-21-app-cutlist-ram-audit.md`
 * §I.4): `agent-mode.set.result`, `task-control.result`, `run-control.result`,
 * and `settings.result`. Each verb's SUCCESS mutates the sidecar's store and
 * re-broadcasts a snapshot (so the UI already updates); a FAILURE mutates
 * nothing → no re-broadcast → the failed verb was previously SILENT to the user.
 *
 * This is a standalone result-only reducer following `sessionActionRuntimeState.ts`
 * (there is no snapshot half here — these verbs' live read-seams already live in
 * their own domain modules: `runControlsState` / `tasksState` / `settingsState` /
 * `orchestratorState`). It records the most recent ack per session (T5a-analog
 * `requestId`) so `App.tsx` can toast the sidecar's REAL, redacted `message` on
 * failure — never an optimistic guess, never token material.
 */

import type {
  AgentModeSetResultFrame,
  ErrorFrame,
  PromptForceResultFrame,
  PromptRecallResultFrame,
  RunControlResultFrame,
  ServerFrame,
  SessionId,
  SettingsResultFrame,
  TaskControlResultFrame,
} from '../../shared/protocol.js'
import type { ToastTone } from './toastModel.js'

/**
 * The four previously-unconsumed verb-ack results. Every member shares the
 * `ok` + `message` + `requestId` fields the failure surface needs.
 */
export type VerbAckResultFrame =
  | AgentModeSetResultFrame
  | TaskControlResultFrame
  | RunControlResultFrame
  | SettingsResultFrame
  | PromptForceResultFrame
  /**
   * D1b. Its `ok:false` is not a failed verb: the recall ran, and the engine
   * simply had already taken one of the messages. It joins this union because
   * that outcome is the one thing about a recall the user has to be told, and
   * it is otherwise as silent as the four above.
   */
  | PromptRecallResultFrame
  /** A boundary rejection can be correlated only when the renderer-minted id survived. */
  | (ErrorFrame & { code: 'bad_request'; requestId: string })

export type VerbAckResultState = {
  /** Most recent verb-ack per session (null after a lifecycle reset). */
  lastBySession: Record<SessionId, VerbAckResultFrame | null>
}

function isCorrelatedBadRequest(
  frame: ServerFrame,
): frame is ErrorFrame & { code: 'bad_request'; requestId: string } {
  return (
    frame.kind === 'error' &&
    frame.code === 'bad_request' &&
    typeof frame.requestId === 'string' &&
    frame.requestId.length > 0
  )
}

export const RECALL_UNDELIVERABLE_MESSAGE = 'Nothing was taken back.'

/**
 * D1b — what an error frame answering a recall has to SAY.
 *
 * TWO producers, not one. Electron main synthesizes `session_not_found` /
 * `session_not_ready` when it cannot reach the session at all, copying the
 * renderer's own `requestId` onto it. The SIDECAR also answers a recall with an
 * error: `session_disconnected` when it is parking, and a `bad_request` for a
 * malformed verb. This returns for every one of those except `bad_request`,
 * where the verb-ack toast already carries the sidecar's own reason and saying
 * it twice would be noise.
 *
 * It says only what the renderer actually knows: nothing came back. The claim it
 * used to add, that the messages are still waiting, is not the renderer's to
 * make for any of these codes: main's two mean the session could not be reached,
 * so its queue is unobservable from here, and the sidecar's parking refusal means
 * the process is on its way out. What the messages are doing is already on screen
 * anyway, in the rows above the composer, so the notice does not need to guess.
 *
 * Call it only for a frame whose `requestId` this page minted for a recall.
 * Null for anything that is not an error at all.
 */
export function recallDeliveryFailureNotice(frame: ServerFrame): string | null {
  if (frame.kind !== 'error') return null
  if (isCorrelatedBadRequest(frame)) return null
  return RECALL_UNDELIVERABLE_MESSAGE
}

/**
 * D1b — the recalls this page is waiting on, and the ones it has answered but may
 * still owe the user a CORRECTION for. `answered` is the whole difference between
 * the two, and the reason this is not a one-shot consume.
 *
 * A recall can legitimately be answered twice. The first answer says what came
 * back; then a message it took off the queue turns out to have reached the model
 * anyway, and the sidecar corrects itself from the delivery signal
 * (`commitStagedPrompt`). A one-shot `delete` on the first answer threw that
 * correction away, so the user was told their message was theirs again while the
 * model answered it, and they resent it.
 *
 * Exactly ONE correction is accepted per recall, and then the id is gone — the
 * frames are request-scoped and live in an evictable replay ring, so an id that
 * stayed forever would let a replay re-announce an outcome the user already read.
 */
export type RecallRequest = { sessionId: SessionId; answered: boolean }
export type RecallRequests = Map<string, RecallRequest>

/**
 * How many recall ids one page tracks. Each is two small fields, so this is not
 * about bytes: it bounds a map whose entries are otherwise removed only by an
 * answer, and a session that never answers one would grow it for the life of the
 * page. Oldest out, and a recall is one deliberate click, so reaching this at all
 * means every earlier one went unanswered.
 */
export const RECALL_REQUEST_CAP = 8

export function createRecallRequests(): RecallRequests {
  return new Map()
}

/**
 * Start waiting on a recall. Mutates in place: the caller holds this across
 * renders in a ref, not in React state (nothing renders it).
 */
export function trackRecallRequest(
  requests: RecallRequests,
  requestId: string,
  sessionId: SessionId,
): void {
  requests.set(requestId, { sessionId, answered: false })
  while (requests.size > RECALL_REQUEST_CAP) {
    const oldest = requests.keys().next()
    if (oldest.done) break
    requests.delete(oldest.value)
  }
}

export function releaseRecallRequest(
  requests: RecallRequests,
  requestId: string,
): void {
  requests.delete(requestId)
}

/**
 * What to do with a `prompt-recall.result`.
 *  - `first`      — the answer this page was waiting for: restore what came back
 *                   and say whatever the frame says.
 *  - `correction` — the sidecar taking back its own answer, because a message it
 *                   reported as recalled reached the model after all. Tell the
 *                   user; restore NOTHING, because the first answer already put
 *                   the recalled text in the composer and the corrected message
 *                   is the one that stayed with the model.
 *  - `ignore`     — not this page's recall, or already corrected. A replayed
 *                   result out of the ring lands here after a reload, which is
 *                   what keeps the ring safe.
 *
 * Mutates the map, like `forgetRecallRequests`.
 */
export type RecallAnswerDisposition = 'first' | 'correction' | 'ignore'

export function classifyRecallAnswer(
  requests: RecallRequests,
  frame: PromptRecallResultFrame,
): RecallAnswerDisposition {
  const request = requests.get(frame.requestId)
  if (!request) return 'ignore'
  if (!request.answered) {
    requests.set(frame.requestId, { ...request, answered: true })
    return 'first'
  }
  // Only a self-correction may follow an answer, and only once.
  if (!frame.ok && frame.alreadyDelivered > 0) {
    requests.delete(frame.requestId)
    return 'correction'
  }
  return 'ignore'
}

/**
 * Whether an error frame is answering a recall this page is still WAITING on, and
 * release it if so. An already-answered recall is left alone: the answer arrived,
 * so telling the user nothing came back would contradict what they just read.
 */
export function takeRecallErrorRequest(
  requests: RecallRequests,
  requestId: string,
): boolean {
  const request = requests.get(requestId)
  if (!request) return false
  requests.delete(requestId)
  return !request.answered
}

/**
 * D1b — release the recall requests belonging to a session that is going away.
 * A tracked id is otherwise removed only by its answer (or the correction that
 * follows it), and a session whose engine is gone never sends one, so the id
 * would be held for the life of the page. Mutates in place.
 */
export function forgetRecallRequests(
  requests: RecallRequests,
  sessionId: SessionId,
): void {
  for (const [requestId, request] of requests) {
    if (request.sessionId === sessionId) requests.delete(requestId)
  }
}

export type VerbAckResultAction = { type: 'frame'; frame: ServerFrame }

export function createVerbAckResultState(): VerbAckResultState {
  return { lastBySession: {} }
}

export function reduceVerbAckResultState(
  state: VerbAckResultState,
  action: VerbAckResultAction,
): VerbAckResultState {
  const { frame } = action

  // Explicit union check (not a Set.has) so TS narrows `frame` to
  // `VerbAckResultFrame` with no `as` cast — the projector-style rule.
  if (
    frame.kind === 'agent-mode.set.result' ||
    frame.kind === 'task-control.result' ||
    frame.kind === 'run-control.result' ||
    frame.kind === 'settings.result' ||
    frame.kind === 'prompt-force.result' ||
    frame.kind === 'prompt-recall.result' ||
    isCorrelatedBadRequest(frame)
  ) {
    return {
      ...state,
      lastBySession: { ...state.lastBySession, [frame.sessionId]: frame },
    }
  }

  // A process/transport reset drops the stale ack; a fresh one arrives on the
  // next verb. Untracked sessions are left alone (mirrors the other domains).
  if (frame.kind === 'lifecycle') {
    if (!(frame.sessionId in state.lastBySession)) return state
    return {
      ...state,
      lastBySession: { ...state.lastBySession, [frame.sessionId]: null },
    }
  }

  return state
}

/** The latest verb-ack for a session (null before any verb / after reset). */
export function selectLatestVerbAckResult(
  state: VerbAckResultState,
  sessionId: SessionId | null,
): VerbAckResultFrame | null {
  const result = sessionId ? state.lastBySession[sessionId] : undefined
  return result ?? null
}

/**
 * The failure toast for a verb-ack result, or null when it succeeded. Pure so the
 * surfacing decision is unit-testable despite the SSR-only renderer harness (the
 * `resultToastTone` / `stoppableTaskId` idiom). SUCCESS returns null: the verb's
 * own snapshot re-broadcast already updated the UI (decision #5) — only a FAILURE,
 * which mutates nothing, needs surfacing. `message` is the sidecar's real, redacted
 * outcome (e.g. a validation error); never invented copy, never token material.
 */
export function verbAckErrorToast(
  frame: VerbAckResultFrame,
): { message: string; tone: ToastTone } | null {
  // D1b — a recall the engine beat to one of the messages is a report about the
  // world, not a fault: the message is on its way to the model and the user is
  // being told before they retype it. Danger red would be a lie about what
  // happened, so it takes the softer tone. A full recall says nothing at all;
  // the text landing back in the composer is the whole story (the D5 precedent).
  if (frame.kind === 'prompt-recall.result') {
    return frame.ok ? null : { message: frame.message, tone: 'warn' }
  }
  if (
    frame.kind === 'task-control.result' &&
    frame.verb === 'task.background' &&
    !frame.ok
  ) {
    return { message: frame.message, tone: 'warn' }
  }
  if (frame.kind !== 'error' && frame.ok) return null
  return { message: frame.message, tone: 'danger' }
}
