/**
 * Diagnostics domain state — PROGRAM-PLAN §5 layer 3 (per-domain selector),
 * the renderer half of the P4-14 `diagnostics.snapshot` read seam. A reducer
 * over the read-only frame plus a read-time selector; stays OUT of
 * `transcriptProjector.ts`, matching `settingsState.ts` (the recipe this
 * copies — the seam is spawn-frozen, same lifecycle as settings).
 */

import type {
  DiagnosticsSnapshot,
  ServerFrame,
  SessionId,
} from '../../shared/protocol.js'

export type DiagnosticsState = {
  /** Latest snapshot per session; null once seen-then-reset (lifecycle). */
  sessions: Record<SessionId, DiagnosticsSnapshot | null>
}

export type DiagnosticsAction = { type: 'frame'; frame: ServerFrame }

export function createDiagnosticsState(): DiagnosticsState {
  return { sessions: {} }
}

export function reduceDiagnosticsState(
  state: DiagnosticsState,
  action: DiagnosticsAction,
): DiagnosticsState {
  const { frame } = action

  if (frame.kind === 'diagnostics.snapshot') {
    return {
      ...state,
      sessions: { ...state.sessions, [frame.sessionId]: frame.diagnostics },
    }
  }

  // A process/transport reset drops the stale snapshot; a fresh one arrives on
  // re-attach. Untracked sessions are left alone (mirrors settingsState).
  if (frame.kind === 'lifecycle') {
    if (!(frame.sessionId in state.sessions)) return state
    return {
      ...state,
      sessions: { ...state.sessions, [frame.sessionId]: null },
    }
  }

  return state
}

/** The latest engine diagnostics snapshot for a session (null before the first frame). */
export function selectDiagnosticsSnapshot(
  state: DiagnosticsState,
  sessionId: SessionId | null,
): DiagnosticsSnapshot | null {
  const snapshot = sessionId ? state.sessions[sessionId] : undefined
  return snapshot ?? null
}
