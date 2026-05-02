import {
  MAX_GOAL_CONTINUATION_STALL_COUNT,
  shouldStartThreadGoalBudgetWrapUp,
  shouldStartThreadGoalContinuation,
  type ThreadGoal,
} from './threadGoal.js'

export type ThreadGoalContinuationAction =
  | { type: 'continue' }
  | { type: 'budget-wrap-up' }
  | { type: 'stalled' }
  | { type: 'none' }

export function getThreadGoalContinuationAction({
  sessionIsIdle,
  goal,
  goalContinuationInFlight,
  goalContinuationStallCount,
  pendingBudgetWrapUpGoalId,
  queuedCommandsCount,
  hasActiveLocalJsxUI,
}: {
  sessionIsIdle: boolean
  goal: ThreadGoal | null
  goalContinuationInFlight: boolean
  goalContinuationStallCount: number
  pendingBudgetWrapUpGoalId: string | null
  queuedCommandsCount: number
  hasActiveLocalJsxUI: boolean
}): ThreadGoalContinuationAction {
  if (
    shouldStartThreadGoalBudgetWrapUp({
      sessionIsIdle,
      goal,
      goalContinuationInFlight,
      pendingBudgetWrapUpGoalId,
      queuedCommandsCount,
      hasActiveLocalJsxUI,
    })
  ) {
    return { type: 'budget-wrap-up' }
  }

  if (
    goal?.status === 'active' &&
    sessionIsIdle &&
    !goalContinuationInFlight &&
    queuedCommandsCount === 0 &&
    !hasActiveLocalJsxUI &&
    goalContinuationStallCount >= MAX_GOAL_CONTINUATION_STALL_COUNT
  ) {
    return { type: 'stalled' }
  }

  if (
    shouldStartThreadGoalContinuation({
      sessionIsIdle,
      goal,
      goalContinuationInFlight,
      goalContinuationStallCount,
      queuedCommandsCount,
      hasActiveLocalJsxUI,
    })
  ) {
    return { type: 'continue' }
  }

  return { type: 'none' }
}
