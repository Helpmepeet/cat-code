/**
 * Worker inspection selectors for the `/tasks` Workers tab and its drilldown.
 * All values are read-time projections of the live worker snapshot.
 */
import { agentTypeMeta } from './agentIdentity.js'
import type { LiveWorkerItem } from '../../shared/protocol.js'

/** Known worker roles lead the list; unknown roles keep first-seen order. */
const KNOWN_ROLE_ORDER: readonly string[] = [
  'coding-worker',
  'verification',
]

/** Fallback role key for a worker whose `role` is null (the prototype's default). */
const DEFAULT_ROLE = 'general-purpose'

export type WorkerRoleGroup = {
  role: string
  /** Caption from the SHARED agent vocabulary, pluralised: "Coding workers". */
  label: string
  workers: LiveWorkerItem[]
}

/**
 * Group the roster by role for the Workers tab. Unknown roles are retained.
 */
export function groupWorkersByRole(
  workers: readonly LiveWorkerItem[],
): WorkerRoleGroup[] {
  const byRole = new Map<string, LiveWorkerItem[]>()
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
 * A live `local_agent` task's id is the `agentId` the roster carries, so no
 * extra wire field is needed. A terminal worker has nothing to kill, and the
 * sidecar re-resolves the id against the live store regardless.
 */
export function selectWorkerStopTargetId(
  worker: LiveWorkerItem,
): string | null {
  if (worker.status !== 'running') return null
  return worker.agentId
}

/**
 * The task id to name on a `task.dismiss` verb for this worker, or null when the
 * worker has nothing to dismiss.
 *
 * A finished live worker may not leave on its own when its handoff is blocked,
 * so the detail keeps the dismiss escape hatch for terminal rows.
 */
export function selectWorkerDismissTargetId(
  worker: LiveWorkerItem,
): string | null {
  if (worker.status === 'running') return null
  return worker.agentId
}

export type WorkerResult = {
  summary: string | null
  verdict: 'PASS' | 'FAIL' | 'PARTIAL' | null
}

/** The live result summary and verdict, kept as separate display fields. */
export function selectWorkerResult(
  worker: LiveWorkerItem,
): WorkerResult | null {
  if (!worker.resultSummary && !worker.verdict) return null
  return {
    summary: worker.resultSummary ?? null,
    verdict: worker.verdict ?? null,
  }
}
