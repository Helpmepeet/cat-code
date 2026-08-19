/**
 * What a pane knows about its own request to read further back
 * (`docs/migration/decisions/HISTORY-LOAD-EARLIER.md`).
 *
 * The recovered MESSAGES are not here. They arrive ahead of the answer as
 * ordinary replay events and land in the transcript store like any other row;
 * what this holds is the part the transcript cannot show — that a read is
 * running, and that the last one did not work.
 *
 * It lives above the panes, like `transcriptScrollMemory`, because a pane is
 * unmounted whenever its session leaves the screen and a request outlives that.
 *
 * WHY EVERY ANSWER IS GATED ON A REQUEST ID THIS PAGE MINTED. The result is a
 * retained frame, so a reload replays the answer to a request the previous page
 * made. Without the gate a reloaded window would open with a failure standing
 * over a transcript nobody had asked it to touch. The D1b recall path takes the
 * same precaution for the same reason.
 */

import type {
  HistoryLoadEarlierResultFrame,
  SessionId,
} from '../../shared/protocol.js'

/**
 * When the ask never left the window. A refusal from the session carries its own
 * sentence, written for a reader, and that one is shown instead; this covers the
 * case where there is no sentence to show. What the throw itself said is for the
 * log, not for the row: it names our own machinery, and the reader's only move
 * is the same either way.
 */
export const HISTORY_LOAD_EARLIER_UNREACHABLE =
  "Couldn't load earlier messages. Try again."

export type HistoryLoadEarlierRequest = {
  /** The request this session is waiting on; null when nothing is in flight. */
  pendingRequestId: string | null
  /** What to say about the last attempt that did not work; null when there is nothing to say. */
  failure: string | null
}

export type HistoryLoadEarlierState = {
  bySession: Record<SessionId, HistoryLoadEarlierRequest>
}

export type HistoryLoadEarlierAction =
  /** The verb was sent. */
  | { type: 'requested'; sessionId: SessionId; requestId: string }
  /** The verb never left the window. */
  | { type: 'unreachable'; sessionId: SessionId; requestId: string }
  /** The session answered. */
  | { type: 'result'; frame: HistoryLoadEarlierResultFrame }
  /** The session lost its engine, so no answer is coming. */
  | { type: 'engine-gone'; sessionId: SessionId }

export function createHistoryLoadEarlierState(): HistoryLoadEarlierState {
  return { bySession: {} }
}

export function reduceHistoryLoadEarlierState(
  state: HistoryLoadEarlierState,
  action: HistoryLoadEarlierAction,
): HistoryLoadEarlierState {
  switch (action.type) {
    case 'requested':
      return withRequest(state, action.sessionId, {
        pendingRequestId: action.requestId,
        // A new attempt clears what the last one said: the control is about to
        // report on itself again, and two outcomes on one row read as one.
        failure: null,
      })

    case 'unreachable': {
      const current = state.bySession[action.sessionId]
      if (current?.pendingRequestId !== action.requestId) return state
      return withRequest(state, action.sessionId, {
        pendingRequestId: null,
        failure: HISTORY_LOAD_EARLIER_UNREACHABLE,
      })
    }

    case 'result': {
      const { frame } = action
      const current = state.bySession[frame.sessionId]
      if (!current || current.pendingRequestId !== frame.requestId) return state
      return withRequest(state, frame.sessionId, {
        pendingRequestId: null,
        // The refusal's own words. They are written for a reader and carry no
        // path and no token material, so passing them through says more than
        // any sentence this side could invent.
        failure: frame.ok ? null : frame.message,
      })
    }

    case 'engine-gone': {
      if (!(action.sessionId in state.bySession)) return state
      return withRequest(state, action.sessionId, {
        pendingRequestId: null,
        failure: null,
      })
    }

    default: {
      const exhaustive: never = action
      void exhaustive
      return state
    }
  }
}

/** Whether this session is waiting on a read it asked for. */
export function selectHistoryLoadEarlierPending(
  state: HistoryLoadEarlierState,
  sessionId: SessionId | null,
): boolean {
  const request = sessionId ? state.bySession[sessionId] : undefined
  return request?.pendingRequestId != null
}

/** What to say about this session's last attempt, or null when there is nothing to say. */
export function selectHistoryLoadEarlierFailure(
  state: HistoryLoadEarlierState,
  sessionId: SessionId | null,
): string | null {
  const request = sessionId ? state.bySession[sessionId] : undefined
  return request?.failure ?? null
}

function withRequest(
  state: HistoryLoadEarlierState,
  sessionId: SessionId,
  request: HistoryLoadEarlierRequest,
): HistoryLoadEarlierState {
  return { ...state, bySession: { ...state.bySession, [sessionId]: request } }
}
