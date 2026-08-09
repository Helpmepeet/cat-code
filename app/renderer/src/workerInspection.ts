/**
 * Worker inspection selectors (P4-32b — `decisions/ORCHESTRATOR-IN-SESSION.md` §8,
 * inspection ruling **D1**: read-only detail inside `/tasks`, no main-column focus).
 *
 * Read-time derivations over the REAL `AgentModeWorkerItem` shape for the `/tasks`
 * Workers tab and its drilldown. No stored derived state, no mock worker, and no
 * write path: the only action the detail offers is the EXISTING `task.stop` verb.
 *
 * The two-axis lifecycle/owner derivations live in `orchestratorState.ts` (P4-8a);
 * this module is only the list/detail shaping the inspection host needs.
 */
import { agentTypeMeta } from './agentIdentity.js'
import type { AgentModeWorkerItem } from '../../shared/protocol.js'

/**
 * The roles the orchestrator itself delegates, first, so ordering is stable
 * across snapshots (the prototype's `roleOrder`, `OrchestratorMode.jsx:727`).
 * Everything else follows in first-seen order: a non-orchestrator session's
 * workers carry real cat-code agent types (`implementor`, `general-purpose`,
 * `Explore`, …) and must never be dropped from the list.
 */
const KNOWN_ROLE_ORDER: readonly string[] = [
  'agent-mode-coding-worker',
  'coding-worker',
  'verification',
]

/** Fallback role key for a worker whose `role` is null (the prototype's default). */
const DEFAULT_ROLE = 'general-purpose'

export type WorkerRoleGroup = {
  role: string
  /** Caption from the SHARED agent vocabulary, pluralised: "Coding workers". */
  label: string
  workers: AgentModeWorkerItem[]
}

/**
 * Group the roster by role for the Workers tab. Known orchestrator roles lead;
 * unknown roles keep their first-seen order rather than vanishing.
 */
export function groupWorkersByRole(
  workers: readonly AgentModeWorkerItem[],
): WorkerRoleGroup[] {
  const byRole = new Map<string, AgentModeWorkerItem[]>()
  for (const worker of workers) {
    const role = worker.role && worker.role.length > 0 ? worker.role : DEFAULT_ROLE
    const bucket = byRole.get(role)
    if (bucket) bucket.push(worker)
    else byRole.set(role, [worker])
  }

  return [...byRole.entries()]
    .sort(([left], [right]) => roleRank(left) - roleRank(right))
    .map(([role, grouped]) => ({
      role,
      label: workerRoleGroupLabel(role, grouped.length),
      workers: grouped,
    }))
}

function roleRank(role: string): number {
  const known = KNOWN_ROLE_ORDER.indexOf(role)
  return known === -1 ? KNOWN_ROLE_ORDER.length : known
}

/**
 * Group caption. Uses the shared `agentTypeMeta` label so the panel never invents
 * a second role vocabulary; falls back to the raw role for a type the table has
 * never seen (`agentTypeMeta` already synthesises that case).
 */
export function workerRoleGroupLabel(role: string, count: number): string {
  const label = agentTypeMeta(role)?.label ?? role
  return count === 1 ? label : `${label}s`
}

/**
 * The task id to name on a `task.stop` verb for this worker, or null when the
 * worker cannot be stopped.
 *
 * A live `local_agent` task's id IS the `agentId` the roster carries
 * (`createTaskStateBase(agentId, 'local_agent', …)`,
 * `src/tasks/LocalAgentTask/LocalAgentTask.tsx:618`;
 * `agentId: task.agentId ?? task.id`, `app/sidecar/agentModeDomain.ts:212`), so
 * no extra wire field is needed. Workers marked `origin === 'prior'` have no
 * live task in this process, and a terminal worker has nothing to kill — both
 * return null so the control is absent rather than dead. The sidecar re-resolves
 * the id against the live store regardless and fails closed on an unknown target
 * (`sidecarServer.ts` `handleTaskControlVerb`).
 */
export function selectWorkerStopTargetId(
  worker: AgentModeWorkerItem,
): string | null {
  if (worker.origin === 'prior') return null
  if (worker.status !== 'running') return null
  return worker.agentId
}

/**
 * The task id to name on a `task.dismiss` verb for this worker, or null when the
 * worker has nothing to dismiss.
 *
 * The exact complement of the Stop target: same id (a live `local_agent` task's
 * id IS the roster's `agentId`), same `prior`-origin exclusion, but FINISHED
 * rather than running. It exists because a finished worker is not guaranteed to
 * leave on its own — a `status: blocked` handoff line in the report makes the
 * engine stamp no `evictAfter` at all (`LocalAgentTask.tsx:540,548`), so nothing
 * ever retires the row. The terminal REPL answers that with its `x` key
 * (`teammateViewHelpers.ts:116`); this is the desktop's same escape hatch.
 * The sidecar re-resolves the id against the live store regardless and fails
 * closed on a target it cannot dismiss.
 */
export function selectWorkerDismissTargetId(
  worker: AgentModeWorkerItem,
): string | null {
  if (worker.origin === 'prior') return null
  if (worker.status === 'running') return null
  return worker.agentId
}

/**
 * The real result text to show in read-only `/tasks` detail, or null.
 *
 * **Result policy Q2** (operator ruling 2026-07-30): a worker's own conclusion may
 * appear ONLY here, never in the main transcript and never in a focus column, so
 * the orchestrator stays the narrator of outcomes on the thread itself. Both
 * fields are engine-persisted (`outputSummary` from the agent-mode ledger,
 * `verdict` from a verifier's real run) and already crossed the seam unread.
 */
export function selectWorkerResult(
  worker: AgentModeWorkerItem,
): { label: string; text: string } | null {
  if (worker.verdict) {
    return {
      label: 'Verdict',
      text: worker.outputSummary
        ? `${worker.verdict}: ${worker.outputSummary}`
        : worker.verdict,
    }
  }
  if (worker.outputSummary) {
    return { label: 'Result', text: worker.outputSummary }
  }
  return null
}
