/**
 * Renderer consumer for the four verb-ack `.result` frames that had NO renderer
 * consumer before decision #5 (audit `docs/migration/reviews/2026-07-21-app-cutlist-ram-audit.md`
 * §I.4): `agent-mode.set.result`, `task-control.result`, `run-control.result`,
 * and `settings.result`. Each verb's SUCCESS mutates the sidecar's store and
 * re-broadcasts a snapshot (so the UI already updates); a FAILURE mutates
 * nothing → no re-broadcast → the failed verb was previously SILENT to the user.
 *
 * This is a standalone result-only reducer following `sessionActionRuntimeState.ts`
 * (there is no snapshot half here — these verbs' live read-seams already live in
 * their own domain modules: `runControlsState` / `tasksState` / `settingsState` /
 * `orchestratorState`). It records the most recent ack per session (T5a-analog
 * `requestId`) so `App.tsx` can toast the sidecar's REAL, redacted `message` on
 * failure — never an optimistic guess, never token material.
 */

import type {
  AgentModeSetResultFrame,
  ErrorFrame,
  RunControlResultFrame,
  ServerFrame,
  SessionId,
  SettingsResultFrame,
  TaskControlResultFrame,
} from '../../shared/protocol.js'
import type { ToastTone } from './toastModel.js'

/**
 * The four previously-unconsumed verb-ack results. Every member shares the
 * `ok` + `message` + `requestId` fields the failure surface needs.
 */
export type VerbAckResultFrame =
  | AgentModeSetResultFrame
  | TaskControlResultFrame
  | RunControlResultFrame
  | SettingsResultFrame
  /** A boundary rejection can be correlated only when the renderer-minted id survived. */
  | (ErrorFrame & { code: 'bad_request'; requestId: string })

export type VerbAckResultState = {
  /** Most recent verb-ack per session (null after a lifecycle reset). */
  lastBySession: Record<SessionId, VerbAckResultFrame | null>
}

function isCorrelatedBadRequest(
  frame: ServerFrame,
): frame is ErrorFrame & { code: 'bad_request'; requestId: string } {
  return (
    frame.kind === 'error' &&
    frame.code === 'bad_request' &&
    typeof frame.requestId === 'string' &&
    frame.requestId.length > 0
  )
}

export type VerbAckResultAction = { type: 'frame'; frame: ServerFrame }

export function createVerbAckResultState(): VerbAckResultState {
  return { lastBySession: {} }
}

export function reduceVerbAckResultState(
  state: VerbAckResultState,
  action: VerbAckResultAction,
): VerbAckResultState {
  const { frame } = action

  // Explicit union check (not a Set.has) so TS narrows `frame` to
  // `VerbAckResultFrame` with no `as` cast — the projector-style rule.
  if (
    frame.kind === 'agent-mode.set.result' ||
    frame.kind === 'task-control.result' ||
    frame.kind === 'run-control.result' ||
    frame.kind === 'settings.result' ||
    isCorrelatedBadRequest(frame)
  ) {
    return {
      ...state,
      lastBySession: { ...state.lastBySession, [frame.sessionId]: frame },
    }
  }

  // A process/transport reset drops the stale ack; a fresh one arrives on the
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

/** The latest verb-ack for a session (null before any verb / after reset). */
export function selectLatestVerbAckResult(
  state: VerbAckResultState,
  sessionId: SessionId | null,
): VerbAckResultFrame | null {
  const result = sessionId ? state.lastBySession[sessionId] : undefined
  return result ?? null
}

/**
 * The failure toast for a verb-ack result, or null when it succeeded. Pure so the
 * surfacing decision is unit-testable despite the SSR-only renderer harness (the
 * `resultToastTone` / `stoppableTaskIdAt` idiom). SUCCESS returns null: the verb's
 * own snapshot re-broadcast already updated the UI (decision #5) — only a FAILURE,
 * which mutates nothing, needs surfacing. `message` is the sidecar's real, redacted
 * outcome (e.g. a validation error); never invented copy, never token material.
 */
export function verbAckErrorToast(
  frame: VerbAckResultFrame,
): { message: string; tone: ToastTone } | null {
  if (frame.kind !== 'error' && frame.ok) return null
  return { message: frame.message, tone: 'danger' }
}
