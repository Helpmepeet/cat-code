/**
 * Composer run-controls domain state — PROGRAM-PLAN §5 layer 3 (per-domain
 * selector), the renderer half of the P4-24c `run-controls.snapshot` read seam. A
 * reducer over the read-only frame plus a read-time selector; stays OUT of
 * `transcriptProjector.ts`, matching `diagnosticsState.ts` (the recipe this
 * copies). Unlike diagnostics, this seam is LIVE — the sidecar re-broadcasts on
 * every model/effort/fast change — so the composer's Model/Reasoning/Fast pickers
 * reflect the current session state without a respawn.
 */

import type {
  RunControlsSnapshot,
  ServerFrame,
  SessionId,
} from '../../shared/protocol.js'

export type RunControlsState = {
  /** Latest snapshot per session; null once seen-then-reset (lifecycle). */
  sessions: Record<SessionId, RunControlsSnapshot | null>
}

export type RunControlsAction = { type: 'frame'; frame: ServerFrame }

export function createRunControlsState(): RunControlsState {
  return { sessions: {} }
}

export function reduceRunControlsState(
  state: RunControlsState,
  action: RunControlsAction,
): RunControlsState {
  const { frame } = action

  if (frame.kind === 'run-controls.snapshot') {
    return {
      ...state,
      sessions: { ...state.sessions, [frame.sessionId]: frame.runControls },
    }
  }

  // A process/transport reset drops the stale snapshot; a fresh one arrives on
  // re-attach. Untracked sessions are left alone (mirrors diagnosticsState).
  if (frame.kind === 'lifecycle') {
    if (!(frame.sessionId in state.sessions)) return state
    return {
      ...state,
      sessions: { ...state.sessions, [frame.sessionId]: null },
    }
  }

  return state
}

/** The latest run-controls snapshot for a session (null before the first frame). */
export function selectRunControlsSnapshot(
  state: RunControlsState,
  sessionId: SessionId | null,
): RunControlsSnapshot | null {
  const snapshot = sessionId ? state.sessions[sessionId] : undefined
  return snapshot ?? null
}
