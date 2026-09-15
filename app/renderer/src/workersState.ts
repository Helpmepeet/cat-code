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
 * The docked roster is a live-work and open-business indicator. The Workers tab
 * keeps every worker available for inspection until the engine evicts it.
 */
export function selectDockedWorkers(
  workers: readonly LiveWorkerItem[],
): LiveWorkerItem[] {
  return workers.filter(worker => {
    const state = workerState(worker)
    return state !== 'completed' && state !== 'stopped'
  })
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
   * Running without the turn. Counted apart from `working` so the Workers list
   * and the docked roster tell the same story; folding it in made one surface
   * say "2 working" while the other said "1 working, 1 in background".
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

export type WorkerPill = {
  label: string
} | null

/**
 * Footer/summary pill. Always neutral: no worker state on this seam puts the next
 * action on the human, so nothing here alerts (D2 C2, and the module header).
 */
export function workersPill(
  workers: readonly LiveWorkerItem[],
): WorkerPill {
  if (workers.length === 0) return null
  const summary = summarizeWorkers(workers)
  // Background workers are in flight, so they belong in "N subagents active"
  // even though the two counts are reported separately elsewhere.
  const busy = summary.working + summary.background + summary.assistant
  if (busy > 0) {
    return { label: `${busy} subagent${busy > 1 ? 's' : ''} active` }
  }
  return null
}

/**
 * News priority for the roster one-liner (the "whisper" model): a failure (2)
 * outranks a ready result (1). Working / waiting / reviewed carry no news (0) —
 * they stay a neutral count.
 */
export function workerEventPriority(worker: LiveWorkerItem): number {
  return priorityForState(workerState(worker))
}

/** Its state-only half, so a caller holding the state need not re-derive it. */
function priorityForState(state: AgentStateKey): number {
  if (state === 'failed') return 2
  return 0
}

/** The single worker promoted to the roster one-liner, or null when the swarm is quiet. */
export function selectPromotedWorker(
  workers: readonly LiveWorkerItem[],
): { worker: LiveWorkerItem; priority: number } | null {
  let lead: { worker: LiveWorkerItem; priority: number } | null = null
  for (const worker of workers) {
    const priority = workerEventPriority(worker)
    if (priority > 0 && (!lead || priority > lead.priority)) {
      lead = { worker, priority }
    }
  }
  return lead
}

/* ── roster line model (the docked "whisper" one-liner above the composer) ──── */

/**
 * One neutral count in the roster's tail, matching the prototype's count-tail
 * treatment.
 * `tone` is a KEY, not a colour: the host maps it to a literal Tailwind class, so
 * no interpolated arbitrary value can silently no-op (the P4-9 bug).
 */
export type RosterCount = {
  text: string
  tone: 'working' | 'waiting' | 'done'
}

export type WorkerRosterLine = {
  /** The single news-bearing worker promoted onto the line, or null at rest. */
  lead: { worker: LiveWorkerItem; priority: number } | null
  /** Honest tally of every worker carrying no news, in prototype order. */
  tail: RosterCount[]
  /** Any worker actually running — drives the pulsing rest-state dot. */
  anyWorking: boolean
}

/**
 * The multi-worker roster line: promote at most ONE worker with news, and stay
 * honest about the rest as neutral counts, matching the prototype's roster line.
 *
 * The prototype also treats a promoted `working` lead as "any working". That
 * branch is unreachable in this derivation and in the prototype's own: a priority
 * above 0 requires state `failed` or `result-ready`, and neither is `running`.
 * So `anyWorking` reads only the counted workers.
 */
export function selectWorkerRosterLine(
  workers: readonly LiveWorkerItem[],
): WorkerRosterLine {
  let working = 0
  let background = 0
  let waiting = 0
  let done = 0
  let news = 0
  for (const worker of workers) {
    const state = workerState(worker)
    if (priorityForState(state) > 0) {
      news += 1
      continue
    }
    if (state === 'running') working += 1
    else if (state === 'background') background += 1
    else if (state === 'waiting') waiting += 1
    else done += 1
  }
  const tail: RosterCount[] = []
  if (working > 0) tail.push({ text: `${working} working`, tone: 'working' })
  // Its own count, not folded into `working`: a background worker keeps going
  // without the turn, which is the distinction the roster previously hid.
  if (background > 0) tail.push({ text: `${background} in background`, tone: 'working' })
  // Same words the Workers tab's counts strip uses for the same state. "N needs
  // input" read as an unattributed ask on the surface closest to the composer,
  // which is the reading this whole state exists to avoid.
  if (waiting > 0) tail.push({ text: `${waiting} on the assistant`, tone: 'waiting' })
  if (done > 0) tail.push({ text: `${done} done`, tone: 'done' })
  // Every news-bearing worker beyond the promoted lead stays visible as a count.
  if (news > 1) tail.push({ text: `+${news - 1} more`, tone: 'done' })
  return {
    lead: selectPromotedWorker(workers),
    tail,
    anyWorking: working > 0 || background > 0,
  }
}

/** Strip a leading `@` from a handle for display; null-safe. */
export function displayHandle(handle: string | null): string | null {
  if (!handle) return null
  return handle.replace(/^@/, '')
}

/**
 * The one display-name selector shared by the docked roster, Workers list, and
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
