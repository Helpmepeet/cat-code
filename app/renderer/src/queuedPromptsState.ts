import { MAX_QUEUED_PROMPT_PREVIEW_CHARS } from '../../shared/limits.js'
/**
 * Messages waiting for the running response — the renderer half of the
 * `queued-prompts.snapshot` read seam (D1a). A reducer over the read-only frame
 * plus a read-time selector, in the shape `slashCatalogState.ts` established.
 *
 * Deliberately OUTSIDE `transcriptProjector.ts`: a message that has not reached
 * the model is not transcript history, and a transcript row is never rewritten
 * after the fact. These rows render at the END of the transcript's scroller
 * (`App.tsx`, D1a) and disappear when the message is delivered, at which point
 * the engine's own user event puts a real row in their place. Rendering next to
 * the rows is not the same as being one: nothing here ever reaches the
 * projector, and the pane's scroll memory never anchors on them.
 *
 * The sidecar publishes the WHOLE list on every change, so each snapshot
 * replaces the previous one; an empty list is the signal that nothing is
 * waiting.
 */

import type {
  QueuedPromptItem,
  ServerFrame,
  SessionId,
} from '../../shared/protocol.js'

export type QueuedPromptsState = {
  sessions: Record<SessionId, readonly QueuedPromptItem[]>
  optimistic: Record<SessionId, readonly QueuedPromptItem[]>
}

export type QueuedPromptsAction =
  | { type: 'submitted'; sessionId: SessionId; submitId: string; text: string }
  | { type: 'submit-failed'; sessionId: SessionId; submitId: string }
  | { type: 'frame'; frame: ServerFrame }
  /**
   * The session left the roster. A `lifecycle` frame empties the list but keeps
   * the key, which is right while the row still exists; a removed session has
   * no row to publish into, so its entry is dropped outright.
   */
  | { type: 'session-removed'; sessionId: SessionId }

const EMPTY: readonly QueuedPromptItem[] = []

export function createQueuedPromptsState(): QueuedPromptsState {
  return { sessions: {}, optimistic: {} }
}

export function reduceQueuedPromptsState(
  state: QueuedPromptsState,
  action: QueuedPromptsAction,
): QueuedPromptsState {
  if (action.type === 'submitted') return { ...state, optimistic: { ...state.optimistic, [action.sessionId]: [...(state.optimistic[action.sessionId] ?? []), { id: action.submitId, submitId: action.submitId, text: action.text.slice(0, MAX_QUEUED_PROMPT_PREVIEW_CHARS) }] } }
  if (action.type === 'submit-failed') return { ...state, optimistic: { ...state.optimistic, [action.sessionId]: (state.optimistic[action.sessionId] ?? []).filter(item => item.submitId !== action.submitId) } }
  if (action.type === 'session-removed') {
    if (!(action.sessionId in state.sessions) && !(action.sessionId in state.optimistic)) return state
    const { [action.sessionId]: _removed, ...rest } = state.sessions
    const { [action.sessionId]: _pending, ...optimistic } = state.optimistic
    return { ...state, sessions: rest, optimistic }
  }

  const { frame } = action
  if (frame.kind === 'submit.result' && (!frame.accepted || frame.queued === false)) return reduceQueuedPromptsState(state, { type: 'submit-failed', sessionId: frame.sessionId, submitId: frame.submitId })

  if (frame.kind === 'queued-prompts.snapshot') {
    return {
      ...state,
      sessions: { ...state.sessions, [frame.sessionId]: frame.prompts },
      optimistic: { ...state.optimistic, [frame.sessionId]: (state.optimistic[frame.sessionId] ?? []).filter(item => !frame.prompts.some(prompt => prompt.submitId === item.submitId)) },
    }
  }

  // The engine that held the queue is gone, so what it was holding is gone with
  // it; a fresh one publishes its own list. Untracked sessions are left alone
  // (mirrors slashCatalogState / runControlsState).
  if (frame.kind === 'lifecycle') {
    if (!(frame.sessionId in state.sessions) && !(frame.sessionId in state.optimistic)) return state
    return {
      ...state,
      sessions: { ...state.sessions, [frame.sessionId]: EMPTY },
      optimistic: { ...state.optimistic, [frame.sessionId]: EMPTY },
    }
  }

  return state
}

/** What this session has waiting, oldest first (empty before any snapshot). */
export function selectQueuedPrompts(
  state: QueuedPromptsState,
  sessionId: SessionId | null,
  instant = false,
): readonly QueuedPromptItem[] {
  const prompts = sessionId ? state.sessions[sessionId] : undefined
  const pending = instant && sessionId ? state.optimistic[sessionId] ?? EMPTY : EMPTY
  return pending.length ? [...(prompts ?? EMPTY), ...pending] : prompts ?? EMPTY
}
