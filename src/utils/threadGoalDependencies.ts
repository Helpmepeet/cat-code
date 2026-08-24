import { getSessionId } from '../bootstrap/state.js'
import { readSessionState } from '../agent-mode/sessionState.js'
import type { ThreadGoalDependency } from './threadGoalWait.js'

/**
 * The work a goal is currently waiting on.
 *
 * Deliberately derived from durable session state rather than declared by the
 * model. A goal that asked the model "are you waiting on anything?" would get
 * an answer shaped by whatever the model believed, and the failure mode is the
 * expensive one: a goal that thinks it is unblocked spends its whole turn
 * ceiling asking a worker whether it has finished.
 *
 * Agent Mode workers are the source today because they are the dependency the
 * engine already tracks durably and already blocks completion on. Processes,
 * approvals, and child sessions use the same wait vocabulary and can be added
 * here without touching the scheduler.
 */
export async function getUnresolvedThreadGoalDependencies(): Promise<
  ThreadGoalDependency[]
> {
  const sessionState = await readSessionState(getSessionId())
  if (!sessionState) return []

  return sessionState.knownWorkers
    .filter(
      worker =>
        worker.status === 'running' || worker.synthesisStatus === 'pending',
    )
    .map(worker => ({
      kind: 'worker' as const,
      subjectId: worker.agentId,
      // The handle is a runtime-assigned name, not model prose.
      label:
        worker.handle && worker.handle !== worker.agentId
          ? worker.handle
          : worker.agentId,
    }))
}

/**
 * Cached view of the above for the scheduler's synchronous port.
 *
 * The scheduler asks for dependencies inside a synchronous decision, but the
 * session state lives on disk. The runtime refreshes this at turn boundaries,
 * which is exactly when the answer can have changed, and the scheduler reads
 * the last refreshed value.
 */
export function createThreadGoalDependencyCache(): {
  read(): readonly ThreadGoalDependency[]
  /** Every child agent seen so far, for the goal's expansion budget. */
  readChildAgentIds(): readonly string[]
  refresh(): Promise<void>
} {
  let current: readonly ThreadGoalDependency[] = []
  let childAgentIds: readonly string[] = []
  return {
    read: () => current,
    readChildAgentIds: () => childAgentIds,
    async refresh() {
      try {
        const sessionState = await readSessionState(getSessionId())
        const workers = sessionState?.knownWorkers ?? []
        // Expansion counts EVERY worker the goal produced, not just the ones
        // still running: a goal that spawns and resolves one worker per turn
        // is still fanning out without bound.
        childAgentIds = workers.map(worker => worker.agentId)
        current = workers
          .filter(
            worker =>
              worker.status === 'running' ||
              worker.synthesisStatus === 'pending',
          )
          .map(worker => ({
            kind: 'worker' as const,
            subjectId: worker.agentId,
            label:
              worker.handle && worker.handle !== worker.agentId
                ? worker.handle
                : worker.agentId,
          }))
      } catch {
        // A read failure must not park the goal on imagined work, and must not
        // fail the turn that triggered the refresh. Previously-seen children
        // are kept so a transient failure cannot reset the expansion budget.
        current = []
      }
    },
  }
}
