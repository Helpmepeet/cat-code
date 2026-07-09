/**
 * Workspace-trust domain state — PROGRAM-PLAN §5 layer 3 (per-domain
 * selector), the renderer half of the P4-14 `workspace-trust.snapshot` read
 * seam. A reducer over the read-only frame plus a read-time selector; stays
 * OUT of `transcriptProjector.ts`, matching `settingsState.ts` (the recipe
 * this copies — the seam is spawn-frozen, same lifecycle as settings).
 */

import type {
  ServerFrame,
  SessionId,
  WorkspaceTrustSnapshot,
} from '../../shared/protocol.js'

export type WorkspaceTrustState = {
  /** Latest snapshot per session; null once seen-then-reset (lifecycle). */
  sessions: Record<SessionId, WorkspaceTrustSnapshot | null>
}

export type WorkspaceTrustAction = { type: 'frame'; frame: ServerFrame }

export function createWorkspaceTrustState(): WorkspaceTrustState {
  return { sessions: {} }
}

export function reduceWorkspaceTrustState(
  state: WorkspaceTrustState,
  action: WorkspaceTrustAction,
): WorkspaceTrustState {
  const { frame } = action

  if (frame.kind === 'workspace-trust.snapshot') {
    return {
      ...state,
      sessions: { ...state.sessions, [frame.sessionId]: frame.workspaceTrust },
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

/** The latest engine workspace-trust snapshot for a session (null before the first frame). */
export function selectWorkspaceTrustSnapshot(
  state: WorkspaceTrustState,
  sessionId: SessionId | null,
): WorkspaceTrustSnapshot | null {
  const snapshot = sessionId ? state.sessions[sessionId] : undefined
  return snapshot ?? null
}
