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
  /**
   * What each session last reported, KEPT after its engine goes away.
   *
   * `sessions` going null is the interactivity gate — no engine, no picker — and
   * that is correct. It was also, accidentally, the only record of what the
   * session ran on, so a disconnect or a park blanked the composer rail's model,
   * effort and fast faces (and, through `model.provider`, the account face) for
   * a session whose answer had not changed. Nothing about losing the process
   * makes the last-known facts untrue, so they are retained here and read by the
   * DISPLAY selector only.
   */
  last: Record<SessionId, RunControlsSnapshot>
}

export type RunControlsAction = { type: 'frame'; frame: ServerFrame }

export function createRunControlsState(): RunControlsState {
  return { sessions: {}, last: {} }
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
      last: { ...state.last, [frame.sessionId]: frame.runControls },
    }
  }

  // A process/transport reset drops the LIVE snapshot, so every control that
  // needs an engine goes inert; a fresh one arrives on re-attach. The same
  // values stay in `last` for display. Untracked sessions are left alone
  // (mirrors diagnosticsState).
  if (frame.kind === 'lifecycle') {
    if (!(frame.sessionId in state.sessions)) return state
    return {
      ...state,
      sessions: { ...state.sessions, [frame.sessionId]: null },
    }
  }

  return state
}

/**
 * The LIVE run-controls snapshot for a session (null before the first frame,
 * and again once its engine goes away).
 *
 * This is the capability answer: a caller holding it may arm a picker, because
 * there is a sidecar to receive the verb. For "what did this session run on",
 * which outlives the process, use {@link selectLastRunControlsSnapshot}.
 */
export function selectRunControlsSnapshot(
  state: RunControlsState,
  sessionId: SessionId | null,
): RunControlsSnapshot | null {
  const snapshot = sessionId ? state.sessions[sessionId] : undefined
  return snapshot ?? null
}

/**
 * What a session is running on, or last ran on — the DISPLAY answer.
 *
 * Never gate an action on this: it answers for a session with no process behind
 * it, which is the whole point. Read it for a face, a label or a denominator,
 * and read {@link selectRunControlsSnapshot} to decide whether that face may be
 * clicked.
 */
export function selectLastRunControlsSnapshot(
  state: RunControlsState,
  sessionId: SessionId | null,
): RunControlsSnapshot | null {
  if (!sessionId) return null
  return state.sessions[sessionId] ?? state.last[sessionId] ?? null
}
