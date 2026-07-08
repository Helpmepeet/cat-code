/**
 * Resume dialog + hydration-overlay UI state (P4-16, `ResumeStates.jsx`
 * adaptation). This is presentation state ONLY — it sequences confirm →
 * hydrating → done/failed around the REAL restore path
 * (`bridge.restoreSession` → `host.restoreSession`, RESTORE-HISTORY.md). No new
 * resume machinery: nothing here reads a transcript, spawns a process, or
 * talks to the host — App.tsx still owns the one `bridge.restoreSession` call,
 * this module only tracks which UI to show around it.
 */
import type { SessionId } from '../../shared/protocol.js'

export type ResumeUiState =
  | { kind: 'idle' }
  | { kind: 'confirm'; sessionId: SessionId }
  | { kind: 'hydrating'; sessionId: SessionId; attached: boolean }
  | { kind: 'failed'; sessionId: SessionId; message: string }

export function createResumeUiState(): ResumeUiState {
  return { kind: 'idle' }
}

export type ResumeUiAction =
  /** A restorable row was picked (Sidebar restore-offer / palette) — open the confirm dialog. */
  | { type: 'requested'; sessionId: SessionId }
  /** "Resume here" (from confirm) or "Retry" (from failed) — invoke the real restore. */
  | { type: 'confirmed' }
  /** The restored sidecar's ready frame reached the renderer. */
  | { type: 'attached'; sessionId: SessionId }
  /** A RESTORE-HISTORY replay frame reached the renderer. */
  | { type: 'replayed'; sessionId: SessionId }
  /** No replay-complete marker exists; clear after ready if no replay frame arrives. */
  | { type: 'replaySettled'; sessionId: SessionId }
  /** Esc / Cancel / backdrop click on the confirm dialog — no restore attempted. */
  | { type: 'cancelled' }
  /** `bridge.restoreSession` resolved not-ok, or threw. */
  | { type: 'failed'; message: string }
  /** "Start fresh" on the failed overlay — abandon the restore attempt. */
  | { type: 'dismissed' }

export function reduceResumeUiState(
  state: ResumeUiState,
  action: ResumeUiAction,
): ResumeUiState {
  switch (action.type) {
    case 'requested':
      return state.kind === 'hydrating'
        ? state
        : { kind: 'confirm', sessionId: action.sessionId }
    case 'confirmed':
      // Reachable from 'confirm' (first attempt) and 'failed' (Retry) — both
      // re-invoke the same real restore call for the same target session.
      return state.kind === 'confirm' || state.kind === 'failed'
        ? { kind: 'hydrating', sessionId: state.sessionId, attached: false }
        : state
    case 'attached':
      return state.kind === 'hydrating' && state.sessionId === action.sessionId
        ? { ...state, attached: true }
        : state
    case 'replayed':
      return state.kind === 'hydrating' && state.sessionId === action.sessionId
        ? { kind: 'idle' }
        : state
    case 'replaySettled':
      return state.kind === 'hydrating' &&
        state.sessionId === action.sessionId &&
        state.attached
        ? { kind: 'idle' }
        : state
    case 'cancelled':
      return state.kind === 'confirm' ? { kind: 'idle' } : state
    case 'failed':
      return state.kind === 'hydrating'
        ? { kind: 'failed', sessionId: state.sessionId, message: action.message }
        : state
    case 'dismissed':
      return state.kind === 'failed' || state.kind === 'hydrating'
        ? { kind: 'idle' }
        : state
  }
}
