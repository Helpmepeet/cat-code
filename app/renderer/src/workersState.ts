/**
 * Per-session live worker state from `workers.snapshot`, with lifecycle and
 * attention derived at read time over the shared worker vocabulary.
 */
import {
  agentStateMeta,
  agentTypeMeta,
  deriveWorkerState,
  type AgentStateKey,
} from './agentIdentity.js'
import type {
  LiveWorkersSnapshot,
  LiveWorkerItem,
  ServerFrame,
  SessionId,
} from '../../shared/protocol.js'

export type WorkersState = {
  bySession: Record<SessionId, LiveWorkersSnapshot>
}

export type WorkersAction =
  | { type: 'frame'; frame: ServerFrame }
  | { type: 'session-removed'; sessionId: SessionId }

export function createWorkersState(): WorkersState {
  return { bySession: {} }
}

export function reduceWorkersState(
  state: WorkersState,
  action: WorkersAction,
): WorkersState {
  if (action.type === 'session-removed') {
    return removeWorkersSession(state, action.sessionId)
  }
  const { frame } = action

  if (frame.kind === 'workers.snapshot') {
    return {
      bySession: { ...state.bySession, [frame.sessionId]: frame.workers },
    }
  }

  if (frame.kind === 'lifecycle') {
    return removeWorkersSession(state, frame.sessionId)
  }

  return state
}

function removeWorkersSession(
  state: WorkersState,
  sessionId: SessionId,
): WorkersState {
  if (!(sessionId in state.bySession)) return state
  const bySession = { ...state.bySession }
  delete bySession[sessionId]
  return { bySession }
}

export function selectLiveWorkersSnapshot(
  state: WorkersState,
  sessionId: SessionId | null,
): LiveWorkersSnapshot | null {
  const snapshot = sessionId ? state.bySession[sessionId] : undefined
  return snapshot ?? null
}

/* ── two-axis worker model (read-time derivation over real shapes) ─────────── */

/** Who must act next on a worker. Never the user: see the module header. */
export type WorkerOwner = 'none' | 'assistant'

/**
 * Lifecycle display state (`AgentStateKey`) for one live worker.
 * A blocked handoff is waiting on the assistant that delegated it.
 */
export function workerState(
  worker: LiveWorkerItem,
): AgentStateKey {
  if (worker.handoffStatus === 'blocked') {
    return 'waiting'
  }
  const state = deriveWorkerState({
    status: worker.status,
    isBackgrounded: worker.isBackgrounded,
    handoffStatus: worker.handoffStatus,
    role: worker.role ?? '',
    description: worker.description ?? '',
  })
  return state
}

/**
 * Attention owner (the baton). Blocked workers are always assistant-owned:
 * `handoffStatus` is read out of the finished worker's result text by the
 * engine and lands in the delegating conversation's own queue. A failed worker
 * likewise awaits the assistant.
 * A stopped worker is settled and needs nobody.
 */
export function deriveWorkerOwner(worker: LiveWorkerItem): WorkerOwner {
  return ownerForState(workerState(worker))
}

/**
 * The owner axis reads purely off the lifecycle state now that no worker can be
 * user-owned, which lets every caller derive the state once and branch on it.
 * `waiting` is the blocked handoff and `failed` is a worker that died.
 */
function ownerForState(state: AgentStateKey): WorkerOwner {
  return state === 'waiting' || state === 'failed'
    ? 'assistant'
    : 'none'
}

export type WorkerSummary = {
  /** Actively running in the foreground, nobody owns the next action. */
  working: number
  /**
   * Running without the turn, reported separately in the Workers list.
   */
  background: number
  /** Awaiting the assistant (blocked or failed). */
  assistant: number
  /** Reviewed / settled — no news. */
  done: number
}

export function summarizeWorkers(
  workers: readonly LiveWorkerItem[],
): WorkerSummary {
  const summary: WorkerSummary = {
    working: 0,
    background: 0,
    assistant: 0,
    done: 0,
  }
  // One derivation per worker: with the user bucket gone, the owner axis is a
  // function of the state alone, so asking `deriveWorkerOwner` first (which
  // derives the state internally) and then deriving it again was pure rework.
  for (const worker of workers) {
    const state = workerState(worker)
    if (ownerForState(state) === 'assistant') summary.assistant += 1
    else if (state === 'running') summary.working += 1
    else if (state === 'background') summary.background += 1
    else summary.done += 1
  }
  return summary
}

/** Strip a leading `@` from a handle for display; null-safe. */
export function displayHandle(handle: string | null): string | null {
  if (!handle) return null
  return handle.replace(/^@/, '')
}

/**
 * The one display-name selector shared by the subagent dock, Workers list, and
 * worker detail header. A persisted handle equal to the engine's stable id is
 * the legacy unnamed fallback, not a user-facing name, so it must disappear.
 */
export function selectWorkerDisplayName(
  worker: Pick<LiveWorkerItem, 'agentId' | 'handle'>,
): string | null {
  const name = displayHandle(worker.handle)?.trim() ?? ''
  if (!name || name === worker.agentId) return null
  return name
}

/**
 * Accessible compact-row label: the visible row stays concise, while its
 * lifecycle and normalized type remain available to assistive technology.
 */
export function workerAccessibleLabel(worker: LiveWorkerItem): string {
  const name = selectWorkerDisplayName(worker)
  const type = agentTypeMeta(worker.role)?.label
  const status = agentStateMeta(workerState(worker)).label
  return [
    name ?? (worker.description?.trim() || 'Unnamed worker'),
    type ? `type ${type}` : null,
    `status ${status}`,
  ]
    .filter((part): part is string => part !== null)
    .join(', ')
}

/**
 * Look up one worker by its stable `agentId` in a snapshot (P4-8b drilldown /
 * focus swap). Returns null when the snapshot is absent or the worker is gone —
 * the caller's cue to degrade out of the detail/focus view rather than render a
 * stale worker (the snapshot re-broadcasts as the swarm changes; a focused
 * worker that vanishes must fall back to the roster, never a fabricated row).
 */
export function selectWorkerById(
  snapshot: LiveWorkersSnapshot | null,
  agentId: string | null,
): LiveWorkerItem | null {
  if (!snapshot || !agentId) return null
  return snapshot.workers.find(worker => worker.agentId === agentId) ?? null
}
