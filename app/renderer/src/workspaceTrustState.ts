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
  WorkspaceTrustResultFrame,
  WorkspaceTrustSnapshot,
} from '../../shared/protocol.js'

export type WorkspaceTrustState = {
  /** Latest snapshot per session; null once seen-then-reset (lifecycle). */
  sessions: Record<SessionId, WorkspaceTrustSnapshot | null>
  /**
   * The most recent `workspace.trust.result` (P4-15 accept outcome). Mirrors
   * `accountsState.lastResult`: on a successful accept the re-broadcast snapshot
   * flips `trusted:true` and the gate unmounts, so this matters only for the
   * `ok:false` case (write did not persist) — the gate surfaces the message
   * instead of silently absorbing the click.
   */
  lastResult: WorkspaceTrustResultFrame | null
}

export type WorkspaceTrustAction = { type: 'frame'; frame: ServerFrame }

export function createWorkspaceTrustState(): WorkspaceTrustState {
  return { sessions: {}, lastResult: null }
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

  if (frame.kind === 'workspace.trust.result') {
    return { ...state, lastResult: frame }
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

/**
 * The failure message from the most recent trust-accept for `sessionId`, or null
 * when the last result was success/absent or belonged to another session. Drives
 * the trust gate's inline error so an `ok:false` accept isn't a silent no-op.
 */
export function selectWorkspaceTrustError(
  state: WorkspaceTrustState,
  sessionId: SessionId | null,
): string | null {
  const result = state.lastResult
  if (!result || result.ok || !sessionId || result.sessionId !== sessionId) {
    return null
  }
  return result.message
}
