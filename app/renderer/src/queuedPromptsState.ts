/**
 * Messages waiting for the running response — the renderer half of the
 * `queued-prompts.snapshot` read seam (D1a). A reducer over the read-only frame
 * plus a read-time selector, in the shape `slashCatalogState.ts` established.
 *
 * Deliberately OUTSIDE `transcriptProjector.ts`: a message that has not reached
 * the model is not transcript history, and a transcript row is never rewritten
 * after the fact. These rows live above the composer and disappear when the
 * message is delivered, at which point the engine's own user event puts it in
 * the transcript.
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
}

export type QueuedPromptsAction = { type: 'frame'; frame: ServerFrame }

const EMPTY: readonly QueuedPromptItem[] = []

export function createQueuedPromptsState(): QueuedPromptsState {
  return { sessions: {} }
}

export function reduceQueuedPromptsState(
  state: QueuedPromptsState,
  action: QueuedPromptsAction,
): QueuedPromptsState {
  const { frame } = action

  if (frame.kind === 'queued-prompts.snapshot') {
    return {
      ...state,
      sessions: { ...state.sessions, [frame.sessionId]: frame.prompts },
    }
  }

  // The engine that held the queue is gone, so what it was holding is gone with
  // it; a fresh one publishes its own list. Untracked sessions are left alone
  // (mirrors slashCatalogState / runControlsState).
  if (frame.kind === 'lifecycle') {
    if (!(frame.sessionId in state.sessions)) return state
    return {
      ...state,
      sessions: { ...state.sessions, [frame.sessionId]: EMPTY },
    }
  }

  return state
}

/** What this session has waiting, oldest first (empty before any snapshot). */
export function selectQueuedPrompts(
  state: QueuedPromptsState,
  sessionId: SessionId | null,
): readonly QueuedPromptItem[] {
  const prompts = sessionId ? state.sessions[sessionId] : undefined
  return prompts ?? EMPTY
}
