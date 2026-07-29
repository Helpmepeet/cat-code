/**
 * Renderer projection of the P4-6b session-action verbs (Rename / Export / Branch).
 * The WRITE half of the Sessions `⋯` menu: a reducer over the outbound
 * `session-action.result` frame plus a read-time selector, following the
 * `remoteSettingsState` / `runControlsState` recipe (per-domain state OUT of
 * `transcriptProjector.ts`). There is no snapshot — a session-action verb has no
 * live read-seam; the reducer only records the most recent RESULT per session so a
 * consumer can correlate the outcome by `requestId` (T5a-analog) and act on it:
 * toast the `message`, show the `exportText` in the Export dialog (P4-30 — the
 * clipboard is its only sink; there is no file-write path in `app/`), or surface
 * the `branchEngineSessionId` of a freshly-forked session — never an optimistic
 * guess, always the sidecar's real outcome.
 *
 * LATEST-ONLY, deliberately: a consumer that must survive a later unrelated
 * result holds its own latch keyed by `requestId` (`selectLatchedExportPreview`),
 * rather than this reducer growing per-request history.
 */

import type {
  ServerFrame,
  SessionActionResultFrame,
  SessionId,
} from '../../shared/protocol.js'

export type SessionActionRuntimeState = {
  /** Most recent `session-action.result` per session (null after a lifecycle reset). */
  lastBySession: Record<SessionId, SessionActionResultFrame | null>
}

export type SessionActionRuntimeAction = { type: 'frame'; frame: ServerFrame }

export function createSessionActionRuntimeState(): SessionActionRuntimeState {
  return { lastBySession: {} }
}

export function reduceSessionActionRuntimeState(
  state: SessionActionRuntimeState,
  action: SessionActionRuntimeAction,
): SessionActionRuntimeState {
  const { frame } = action

  if (frame.kind === 'session-action.result') {
    return {
      ...state,
      lastBySession: { ...state.lastBySession, [frame.sessionId]: frame },
    }
  }

  // A process/transport reset drops the stale result; a fresh one arrives on the
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

/** The latest session-action result for a session (null before any verb / after reset). */
export function selectLatestSessionActionResult(
  state: SessionActionRuntimeState,
  sessionId: SessionId | null,
): SessionActionResultFrame | null {
  const result = sessionId ? state.lastBySession[sessionId] : undefined
  return result ?? null
}
