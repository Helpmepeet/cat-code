import type { AppStateStore } from '../../src/state/AppStateStore.js'
import {
  formatThreadGoalStatusReason,
  formatThreadGoalSummary,
  type ThreadGoal,
} from '../../src/utils/threadGoal.js'
import type { ThreadGoalSnapshot } from '../shared/protocol.js'

export type SidecarGoalDomain = {
  /** Live read-only snapshot over the same app-state store the runtime mutates. */
  getSnapshot(): ThreadGoalSnapshot | null
  subscribe(listener: () => void): () => void
}

export function createSidecarGoalDomain(
  appStateStore: AppStateStore,
): SidecarGoalDomain {
  return {
    getSnapshot() {
      return threadGoalSnapshot(appStateStore.getState().threadGoal)
    },
    subscribe(listener) {
      return appStateStore.subscribe(listener)
    },
  }
}

export function threadGoalSnapshot(goal: ThreadGoal | null): ThreadGoalSnapshot | null {
  if (!goal) return null
  return {
    threadId: goal.threadId,
    goalId: goal.goalId,
    objective: goal.objective,
    status: goal.status,
    revision: goal.revision,
    ...(goal.tokenBudget !== undefined ? { tokenBudget: goal.tokenBudget } : {}),
    tokensUsed: goal.tokensUsed,
    continuationTurns: goal.continuationTurns,
    maxContinuationTurns: goal.maxContinuationTurns,
    timeUsedSeconds: goal.timeUsedSeconds,
    createdAtMs: goal.createdAtMs,
    updatedAtMs: goal.updatedAtMs,
    summary: formatThreadGoalSummary(goal),
    statusNote: formatThreadGoalStatusReason(goal),
  }
}
