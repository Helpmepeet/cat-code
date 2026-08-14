/**
 * Orchestrator state (P4-8, D2 `decisions/AGENT-CHROME.md`) — per-session
 * `agent-mode.snapshot` frames from the read-seam, plus the two-axis worker
 * derivation (lifecycle × attention owner) ported from the prototype's
 * `deriveWorker`/`summarizeWorkers`/`bgTaskPill` (OrchestratorMode.jsx) but
 * computed at READ time over the REAL `AgentModeWorkerItem` shape and the shared
 * P4-2 `agentIdentity` vocabulary — never stored, never a mock worker.
 *
 * The two axes are independent (D2 §1): a worker has a LIFECYCLE state (what it is
 * doing) AND an attention OWNER (who must act next). A blocked worker always waits
 * on the assistant that delegated it, never on the user.
 *
 * That last point is a 2026-08-09 correction of the drift `OrchestratorRoster.tsx`
 * had flagged for a ruling. The escalation used to key on `AgentModeSnapshot.active`
 * (`isAgentMode()`), which answers "which persona is the parent running", not "is
 * there a parent to receive this". A blocked worker's handoff is queued to its
 * parent conversation unconditionally and drained into a fresh turn with no human
 * action (`src/tasks/LocalAgentTask/LocalAgentTask.tsx:273`,
 * `app/sidecar/sidecarServer.ts:1209`, `src/hooks/useQueueProcessor.ts:48`), so an
 * ordinary delegating session was reading every blocked worker as user-owned while
 * the assistant on that thread already owned it.
 */
import {
  agentStateMeta,
  agentTypeMeta,
  deriveAgentModeWorkerState,
  type AgentStateKey,
} from './agentIdentity.js'
import type {
  AgentModeSnapshot,
  AgentModeWorkerItem,
  ServerFrame,
  SessionId,
} from '../../shared/protocol.js'

export type OrchestratorState = {
  bySession: Record<SessionId, AgentModeSnapshot>
}

export type OrchestratorAction =
  | { type: 'frame'; frame: ServerFrame }
  | { type: 'session-removed'; sessionId: SessionId }

export function createOrchestratorState(): OrchestratorState {
  return { bySession: {} }
}

export function reduceOrchestratorState(
  state: OrchestratorState,
  action: OrchestratorAction,
): OrchestratorState {
  if (action.type === 'session-removed') {
    return removeOrchestratorSession(state, action.sessionId)
  }
  const { frame } = action

  if (frame.kind === 'agent-mode.snapshot') {
    return {
      bySession: { ...state.bySession, [frame.sessionId]: frame.agentMode },
    }
  }

  if (frame.kind === 'lifecycle') {
    return removeOrchestratorSession(state, frame.sessionId)
  }

  return state
}

function removeOrchestratorSession(
  state: OrchestratorState,
  sessionId: SessionId,
): OrchestratorState {
  if (!(sessionId in state.bySession)) return state
  const bySession = { ...state.bySession }
  delete bySession[sessionId]
  return { bySession }
}

export function selectAgentModeSnapshot(
  state: OrchestratorState,
  sessionId: SessionId | null,
): AgentModeSnapshot | null {
  const snapshot = sessionId ? state.bySession[sessionId] : undefined
  return snapshot ?? null
}

/* ── two-axis worker model (read-time derivation over real shapes) ─────────── */

/** Who must act next on a worker. Never the user: see the module header. */
export type WorkerOwner = 'none' | 'orchestrator'

/**
 * Lifecycle display state (`AgentStateKey`) for one worker. The handoff gate is
 * overlaid on the shared agent-mode lifecycle derivation:
 *   - blocked (handoffStatus) → 'waiting', always: the delegating assistant is
 *     the one that receives the handoff.
 *   - otherwise the persisted lifecycle via `deriveAgentModeWorkerState`
 *     (resumable/stale/result-ready/reviewed/failed/stopped/completed/running).
 */
export function orchestratorWorkerState(
  worker: AgentModeWorkerItem,
): AgentStateKey {
  if (worker.handoffStatus === 'blocked') {
    return 'waiting'
  }
  const state = deriveAgentModeWorkerState({
    status: worker.status,
    synthesisStatus: worker.synthesisStatus,
    origin: worker.origin,
    resumable: worker.resumable,
    role: worker.role ?? '',
    description: worker.description ?? '',
  })
  // `isBackgrounded` reaches the renderer on every live worker
  // (`agentModeDomain.ts` `toLiveWorkerItem`) but was dropped here, so a
  // background spawn and a foreground one rendered identically on the roster and
  // in the Workers list. Applied LAST because only a genuinely running worker can
  // be backgrounded: the prior-session and synthesis states outrank it.
  return state === 'running' && worker.isBackgrounded === true ? 'background' : state
}

/**
 * The docked roster is a live-work and open-business indicator. The Workers tab
 * keeps every worker available for inspection until the engine evicts it.
 */
export function selectDockedOrchestratorWorkers(
  workers: readonly AgentModeWorkerItem[],
): AgentModeWorkerItem[] {
  return workers.filter(worker => {
    const state = orchestratorWorkerState(worker)
    switch (state) {
      case 'running':
      case 'background':
      case 'resumed':
      case 'waiting':
      case 'needs-you':
      case 'paused':
      case 'result-ready':
      case 'failed':
      case 'attention':
        return true
      case 'completed':
      case 'reviewed':
      case 'stopped':
      case 'resumable':
      case 'stale':
        return false
      default: {
        const exhaustive: never = state
        return exhaustive
      }
    }
  })
}

/**
 * Attention owner (the baton). Blocked workers are always assistant-owned: they
 * fed a question back through AskOrchestratorTool (`AskOrchestratorTool.ts:83`)
 * and it lands in the delegating conversation's own queue. A pending-synthesis
 * result and a failed worker likewise await the assistant. A stopped worker is
 * settled and needs nobody.
 */
export function deriveWorkerOwner(worker: AgentModeWorkerItem): WorkerOwner {
  return ownerForState(orchestratorWorkerState(worker))
}

/**
 * The owner axis reads purely off the lifecycle state now that no worker can be
 * user-owned, which lets every caller derive the state once and branch on it.
 * `waiting` is the blocked handoff; the other two are a result the assistant has
 * not synthesised and a worker that died on it.
 */
function ownerForState(state: AgentStateKey): WorkerOwner {
  return state === 'waiting' || state === 'result-ready' || state === 'failed'
    ? 'orchestrator'
    : 'none'
}

export type OrchestratorWorkerSummary = {
  /** Actively running in the foreground, nobody owns the next action. */
  working: number
  /**
   * Running without the turn. Counted apart from `working` so the Workers list
   * and the docked roster tell the same story; folding it in made one surface
   * say "2 working" while the other said "1 working, 1 in background".
   */
  background: number
  /** Awaiting the assistant (blocked / result-ready / failed). */
  orchestrator: number
  /** Reviewed / settled — no news. */
  done: number
}

export function summarizeOrchestratorWorkers(
  workers: readonly AgentModeWorkerItem[],
): OrchestratorWorkerSummary {
  const summary: OrchestratorWorkerSummary = {
    working: 0,
    background: 0,
    orchestrator: 0,
    done: 0,
  }
  // One derivation per worker: with the user bucket gone, the owner axis is a
  // function of the state alone, so asking `deriveWorkerOwner` first (which
  // derives the state internally) and then deriving it again was pure rework.
  for (const worker of workers) {
    const state = orchestratorWorkerState(worker)
    if (ownerForState(state) === 'orchestrator') summary.orchestrator += 1
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
export function orchestratorPill(
  workers: readonly AgentModeWorkerItem[],
): WorkerPill {
  if (workers.length === 0) return null
  const summary = summarizeOrchestratorWorkers(workers)
  // Background workers are in flight, so they belong in "N subagents active"
  // even though the two counts are reported separately elsewhere.
  const busy = summary.working + summary.background + summary.orchestrator
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
export function workerEventPriority(worker: AgentModeWorkerItem): number {
  return priorityForState(orchestratorWorkerState(worker))
}

/** Its state-only half, so a caller holding the state need not re-derive it. */
function priorityForState(state: AgentStateKey): number {
  if (state === 'failed') return 2
  if (state === 'result-ready') return 1
  return 0
}

/** The single worker promoted to the roster one-liner, or null when the swarm is quiet. */
export function selectPromotedWorker(
  workers: readonly AgentModeWorkerItem[],
): { worker: AgentModeWorkerItem; priority: number } | null {
  let lead: { worker: AgentModeWorkerItem; priority: number } | null = null
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
 * One neutral count in the roster's tail (`CountTail`, OrchestratorMode.jsx:224).
 * `tone` is a KEY, not a colour: the host maps it to a literal Tailwind class, so
 * no interpolated arbitrary value can silently no-op (the P4-9 bug).
 */
export type RosterCount = {
  text: string
  tone: 'working' | 'waiting' | 'done'
}

export type OrchestratorRosterLine = {
  /** The single news-bearing worker promoted onto the line, or null at rest. */
  lead: { worker: AgentModeWorkerItem; priority: number } | null
  /** Honest tally of every worker carrying no news, in prototype order. */
  tail: RosterCount[]
  /** Any worker actually running — drives the pulsing rest-state dot. */
  anyWorking: boolean
}

/**
 * The multi-worker roster line: promote at most ONE worker with news, and stay
 * honest about the rest as neutral counts (`OrchestratorMode.jsx:274-296`).
 *
 * The prototype also treats a promoted `working` lead as "any working". That
 * branch is unreachable in this derivation and in the prototype's own: a priority
 * above 0 requires state `failed` or `result-ready`, and neither is `running`.
 * So `anyWorking` reads only the counted workers.
 */
export function selectOrchestratorRosterLine(
  workers: readonly AgentModeWorkerItem[],
): OrchestratorRosterLine {
  let working = 0
  let background = 0
  let waiting = 0
  let done = 0
  let news = 0
  for (const worker of workers) {
    const state = orchestratorWorkerState(worker)
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
  worker: Pick<AgentModeWorkerItem, 'agentId' | 'handle'>,
): string | null {
  const name = displayHandle(worker.handle)?.trim() ?? ''
  if (!name || name === worker.agentId) return null
  return name
}

/**
 * Accessible compact-row label: the visible row stays concise, while its
 * lifecycle and normalized type remain available to assistive technology.
 */
export function workerAccessibleLabel(worker: AgentModeWorkerItem): string {
  const name = selectWorkerDisplayName(worker)
  const type = agentTypeMeta(worker.role)?.label
  const status = agentStateMeta(orchestratorWorkerState(worker)).label
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
  snapshot: AgentModeSnapshot | null,
  agentId: string | null,
): AgentModeWorkerItem | null {
  if (!snapshot || !agentId) return null
  return snapshot.workers.find(worker => worker.agentId === agentId) ?? null
}
