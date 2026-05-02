import { describe, expect, test } from 'bun:test'
import { createThreadGoal, updateThreadGoalStatus } from './threadGoal.js'
import { getThreadGoalContinuationAction } from './threadGoalController.js'

describe('getThreadGoalContinuationAction', () => {
  test('returns continue for active idle goals below stall threshold', () => {
    const goal = createThreadGoal('session-1', 'finish goal mode')

    expect(
      getThreadGoalContinuationAction({
        sessionIsIdle: true,
        goal,
        goalContinuationInFlight: false,
        goalContinuationStallCount: 0,
        pendingBudgetWrapUpGoalId: null,
        queuedCommandsCount: 0,
        hasActiveLocalJsxUI: false,
      }),
    ).toEqual({ type: 'continue' })
  })

  test('returns stalled when active goal reaches stall threshold', () => {
    const goal = createThreadGoal('session-1', 'finish goal mode')

    expect(
      getThreadGoalContinuationAction({
        sessionIsIdle: true,
        goal,
        goalContinuationInFlight: false,
        goalContinuationStallCount: 2,
        pendingBudgetWrapUpGoalId: null,
        queuedCommandsCount: 0,
        hasActiveLocalJsxUI: false,
      }),
    ).toEqual({ type: 'stalled' })
  })

  test('returns budget-wrap-up for pending budget-limited goal', () => {
    const goal = updateThreadGoalStatus(
      createThreadGoal('session-1', 'finish goal mode'),
      'budget_limited',
    )

    expect(
      getThreadGoalContinuationAction({
        sessionIsIdle: true,
        goal,
        goalContinuationInFlight: false,
        goalContinuationStallCount: 0,
        pendingBudgetWrapUpGoalId: goal.goalId,
        queuedCommandsCount: 0,
        hasActiveLocalJsxUI: false,
      }),
    ).toEqual({ type: 'budget-wrap-up' })
  })

  test('returns none when blocked by queued input or active UI', () => {
    const goal = createThreadGoal('session-1', 'finish goal mode')

    expect(
      getThreadGoalContinuationAction({
        sessionIsIdle: true,
        goal,
        goalContinuationInFlight: false,
        goalContinuationStallCount: 0,
        pendingBudgetWrapUpGoalId: null,
        queuedCommandsCount: 1,
        hasActiveLocalJsxUI: false,
      }),
    ).toEqual({ type: 'none' })
    expect(
      getThreadGoalContinuationAction({
        sessionIsIdle: true,
        goal,
        goalContinuationInFlight: false,
        goalContinuationStallCount: 0,
        pendingBudgetWrapUpGoalId: null,
        queuedCommandsCount: 0,
        hasActiveLocalJsxUI: true,
      }),
    ).toEqual({ type: 'none' })
  })
})
