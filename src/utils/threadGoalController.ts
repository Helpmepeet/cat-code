import {
  shouldStartThreadGoalBudgetWrapUp,
  shouldStartThreadGoalContinuation,
  type ThreadGoal,
} from './threadGoal.js'

/**
 * What the scheduler should do at an idle boundary.
 *
 * `stalled` used to be a member of this union, decided from an in-memory
 * counter. It is gone: a goal that has stopped making progress now carries the
 * durable `stalled` status, so it simply fails the schedulable check and
 * returns `none`. That removes the v1 split where the scheduler had given up
 * but the persisted goal still read `active`, letting a restart resume it.
 */
export type ThreadGoalContinuationAction =
  | { type: 'continue' }
  | { type: 'budget-wrap-up' }
  | { type: 'ignored' }
  | { type: 'none' }

export function getThreadGoalContinuationAction({
  sessionIsIdle,
  goal,
  goalContinuationInFlight,
  pendingBudgetWrapUpGoalId,
  queuedCommandsCount,
  hasActiveLocalJsxUI,
  isInPlanMode,
}: {
  sessionIsIdle: boolean
  goal: ThreadGoal | null
  goalContinuationInFlight: boolean
  pendingBudgetWrapUpGoalId: string | null
  queuedCommandsCount: number
  hasActiveLocalJsxUI: boolean
  isInPlanMode: boolean
}): ThreadGoalContinuationAction {
  const canHandleGoalContinuation =
    sessionIsIdle &&
    !goalContinuationInFlight &&
    queuedCommandsCount === 0 &&
    !hasActiveLocalJsxUI

  // Plan mode is excluded from automatic continuation, and deliberately
  // returns `ignored` rather than `none`: the caller must NOT mark the idle
  // signal handled, so the goal resumes when the user leaves plan mode.
  if (
    isInPlanMode &&
    canHandleGoalContinuation &&
    (goal?.status === 'active' ||
      (goal?.status === 'budget_limited' &&
        goal.goalId === pendingBudgetWrapUpGoalId))
  ) {
    return { type: 'ignored' }
  }

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
    shouldStartThreadGoalContinuation({
      sessionIsIdle,
      goal,
      goalContinuationInFlight,
      queuedCommandsCount,
      hasActiveLocalJsxUI,
    })
  ) {
    return { type: 'continue' }
  }

  return { type: 'none' }
}
