/**
 * Orchestrator state (P4-8, D2 `decisions/AGENT-CHROME.md`) — per-session
 * `agent-mode.snapshot` frames from the read-seam, plus the two-axis worker
 * derivation (lifecycle × attention owner) ported from the prototype's
 * `deriveWorker`/`summarizeWorkers`/`bgTaskPill` (OrchestratorMode.jsx) but
 * computed at READ time over the REAL `AgentModeWorkerItem` shape and the shared
 * P4-2 `agentIdentity` vocabulary — never stored, never a mock worker.
 *
 * The two axes are independent (D2 §1): a worker has a LIFECYCLE state (what it is
 * doing) AND an attention OWNER (who must act next). A blocked worker is neutral
 * ("Waiting on orchestrator") while an orchestrator is active — only the solo case
 * (no orchestrator to pick up the handoff) escalates to the amber "needs you".
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
  bySession: Record<SessionId, AgentModeSnapshot | undefined>
}

export type OrchestratorAction = { type: 'frame'; frame: ServerFrame }

export function createOrchestratorState(): OrchestratorState {
  return { bySession: {} }
}

export function reduceOrchestratorState(
  state: OrchestratorState,
  action: OrchestratorAction,
): OrchestratorState {
  const { frame } = action

  if (frame.kind === 'agent-mode.snapshot') {
    return {
      bySession: { ...state.bySession, [frame.sessionId]: frame.agentMode },
    }
  }

  if (frame.kind === 'lifecycle') {
    return {
      bySession: { ...state.bySession, [frame.sessionId]: undefined },
    }
  }

  return state
}

export function selectAgentModeSnapshot(
  state: OrchestratorState,
  sessionId: SessionId | null,
): AgentModeSnapshot | null {
  const snapshot = sessionId ? state.bySession[sessionId] : undefined
  return snapshot ?? null
}

/* ── two-axis worker model (read-time derivation over real shapes) ─────────── */

/** Who must act next on a worker. `user` = the reserved solo case (no orchestrator). */
export type WorkerOwner = 'none' | 'orchestrator' | 'user'

/**
 * Lifecycle display state (`AgentStateKey`) for one worker. The handoff gate is
 * overlaid on the shared agent-mode lifecycle derivation:
 *   - blocked (handoffStatus) → 'waiting' when an orchestrator owns it (active),
 *     else the solo 'needs-you' (the P4-8 wiring of the `waiting` state).
 *   - otherwise the persisted lifecycle via `deriveAgentModeWorkerState`
 *     (resumable/stale/result-ready/reviewed/attention/completed/running).
 */
export function orchestratorWorkerState(
  worker: AgentModeWorkerItem,
  active: boolean,
): AgentStateKey {
  if (worker.handoffStatus === 'blocked') {
    return active ? 'waiting' : 'needs-you'
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
 * Attention owner (the baton). Blocked workers are orchestrator-owned while an
 * orchestrator is active (they fed a question back via AskOrchestratorTool to the
 * orchestrator's queue — `AskOrchestratorTool.ts:83`), user-owned only in the solo
 * case. A pending-synthesis result and a failed/killed worker also await the
 * orchestrator. Everything else needs nobody.
 */
export function deriveWorkerOwner(
  worker: AgentModeWorkerItem,
  active: boolean,
): WorkerOwner {
  if (worker.handoffStatus === 'blocked') {
    return active ? 'orchestrator' : 'user'
  }
  const state = orchestratorWorkerState(worker, active)
  if (state === 'result-ready' || state === 'attention') return 'orchestrator'
  return 'none'
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
  /** Awaiting the orchestrator (blocked/result-ready/failed under an active orchestrator). */
  orchestrator: number
  /** Awaiting the human (the solo blocked case). */
  user: number
  /** Reviewed / settled — no news. */
  done: number
}

export function summarizeOrchestratorWorkers(
  workers: readonly AgentModeWorkerItem[],
  active: boolean,
): OrchestratorWorkerSummary {
  const summary: OrchestratorWorkerSummary = {
    working: 0,
    background: 0,
    orchestrator: 0,
    user: 0,
    done: 0,
  }
  for (const worker of workers) {
    const owner = deriveWorkerOwner(worker, active)
    if (owner === 'user') summary.user += 1
    else if (owner === 'orchestrator') summary.orchestrator += 1
    else {
      const state = orchestratorWorkerState(worker, active)
      if (state === 'running') summary.working += 1
      else if (state === 'background') summary.background += 1
      else summary.done += 1
    }
  }
  return summary
}

export type WorkerPill = {
  label: string
  /** neutral accent (subagents active) vs amber attention (a worker needs YOU). */
  attention: boolean
} | null

/**
 * Footer/summary pill. Amber ONLY when the human owns the next action (the solo
 * escalation). Workers waiting on the orchestrator do NOT alert (D2 C2).
 */
export function orchestratorPill(
  workers: readonly AgentModeWorkerItem[],
  active: boolean,
): WorkerPill {
  if (workers.length === 0) return null
  const summary = summarizeOrchestratorWorkers(workers, active)
  if (summary.user > 0) {
    return { label: `${summary.user} needs you`, attention: true }
  }
  // Background workers are in flight, so they belong in "N subagents active"
  // even though the two counts are reported separately elsewhere.
  const busy = summary.working + summary.background + summary.orchestrator
  if (busy > 0) {
    return { label: `${busy} subagent${busy > 1 ? 's' : ''} active`, attention: false }
  }
  return null
}

/**
 * News priority for the roster one-liner (the "whisper" model): a solo escalation
 * (3) outranks a failure (2), which outranks a ready result (1). Working /
 * needs-input / reviewed carry no news (0) — they stay a neutral count.
 */
export function workerEventPriority(
  worker: AgentModeWorkerItem,
  active: boolean,
): number {
  const owner = deriveWorkerOwner(worker, active)
  if (owner === 'user') return 3
  const state = orchestratorWorkerState(worker, active)
  if (state === 'attention') return 2
  if (state === 'result-ready') return 1
  return 0
}

/** The single worker promoted to the roster one-liner, or null when the swarm is quiet. */
export function selectPromotedWorker(
  workers: readonly AgentModeWorkerItem[],
  active: boolean,
): { worker: AgentModeWorkerItem; priority: number } | null {
  let lead: { worker: AgentModeWorkerItem; priority: number } | null = null
  for (const worker of workers) {
    const priority = workerEventPriority(worker, active)
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
 * above 0 requires owner `user`, `attention`, or `result-ready`, and none of those
 * is `running`. So `anyWorking` reads only the counted workers.
 */
export function selectOrchestratorRosterLine(
  workers: readonly AgentModeWorkerItem[],
  active: boolean,
): OrchestratorRosterLine {
  let working = 0
  let background = 0
  let waiting = 0
  let done = 0
  let news = 0
  for (const worker of workers) {
    if (workerEventPriority(worker, active) > 0) {
      news += 1
      continue
    }
    const state = orchestratorWorkerState(worker, active)
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
  if (waiting > 0) tail.push({ text: `${waiting} needs input`, tone: 'waiting' })
  if (done > 0) tail.push({ text: `${done} done`, tone: 'done' })
  // Every news-bearing worker beyond the promoted lead stays visible as a count.
  if (news > 1) tail.push({ text: `+${news - 1} more`, tone: 'done' })
  return {
    lead: selectPromotedWorker(workers, active),
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
export function workerAccessibleLabel(
  worker: AgentModeWorkerItem,
  active: boolean,
): string {
  const name = selectWorkerDisplayName(worker)
  const type = agentTypeMeta(worker.role)?.label
  const status = agentStateMeta(orchestratorWorkerState(worker, active)).label
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
