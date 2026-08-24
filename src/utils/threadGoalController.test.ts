import { describe, expect, test } from 'bun:test'
import { createThreadGoal, updateThreadGoalStatus } from './threadGoal.js'
import { getThreadGoalContinuationAction } from './threadGoalController.js'

describe('getThreadGoalContinuationAction', () => {
  test('returns continue for an active idle goal', () => {
    const goal = createThreadGoal('session-1', 'finish goal mode')

    expect(
      getThreadGoalContinuationAction({
        sessionIsIdle: true,
        goal,
        goalContinuationInFlight: false,
        pendingBudgetWrapUpGoalId: null,
        queuedCommandsCount: 0,
        hasActiveLocalJsxUI: false,
        isInPlanMode: false,
      }),
    ).toEqual({ type: 'continue' })
  })

  test('a stalled goal returns none, not a scheduler-only stall decision', () => {
    // The scheduler no longer carries its own stall verdict. A goal that
    // stopped making progress carries the durable `stalled` status, so it is
    // simply unschedulable, and a restart cannot disagree with that.
    const goal = updateThreadGoalStatus(
      createThreadGoal('session-1', 'finish goal mode'),
      'stalled',
      'no_progress',
    )

    expect(
      getThreadGoalContinuationAction({
        sessionIsIdle: true,
        goal,
        goalContinuationInFlight: false,
        pendingBudgetWrapUpGoalId: null,
        queuedCommandsCount: 0,
        hasActiveLocalJsxUI: false,
        isInPlanMode: false,
      }),
    ).toEqual({ type: 'none' })
  })

  test('waiting, blocked, and failed goals are not schedulable either', () => {
    for (const [status, reason] of [
      ['waiting', 'waiting_on_dependency'],
      ['blocked', 'agent_reported_blocked'],
      ['failed', 'runtime_error'],
    ] as const) {
      const goal = updateThreadGoalStatus(
        createThreadGoal('session-1', 'finish goal mode'),
        status,
        reason,
      )

      expect(
        getThreadGoalContinuationAction({
          sessionIsIdle: true,
          goal,
          goalContinuationInFlight: false,
          pendingBudgetWrapUpGoalId: null,
          queuedCommandsCount: 0,
          hasActiveLocalJsxUI: false,
          isInPlanMode: false,
        }),
      ).toEqual({ type: 'none' })
    }
  })

  test('returns budget-wrap-up for pending budget-limited goal', () => {
    const goal = updateThreadGoalStatus(
      createThreadGoal('session-1', 'finish goal mode'),
      'budget_limited',
      'token_budget_exhausted',
    )

    expect(
      getThreadGoalContinuationAction({
        sessionIsIdle: true,
        goal,
        goalContinuationInFlight: false,
        pendingBudgetWrapUpGoalId: goal.goalId,
        queuedCommandsCount: 0,
        hasActiveLocalJsxUI: false,
        isInPlanMode: false,
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
        pendingBudgetWrapUpGoalId: null,
        queuedCommandsCount: 1,
        hasActiveLocalJsxUI: false,
        isInPlanMode: false,
      }),
    ).toEqual({ type: 'none' })
    expect(
      getThreadGoalContinuationAction({
        sessionIsIdle: true,
        goal,
        goalContinuationInFlight: false,
        pendingBudgetWrapUpGoalId: null,
        queuedCommandsCount: 0,
        hasActiveLocalJsxUI: true,
        isInPlanMode: false,
      }),
    ).toEqual({ type: 'none' })
  })

  test('ignores goal continuation while plan mode is active', () => {
    const goal = createThreadGoal('session-1', 'finish goal mode')

    expect(
      getThreadGoalContinuationAction({
        sessionIsIdle: true,
        goal,
        goalContinuationInFlight: false,
        pendingBudgetWrapUpGoalId: null,
        queuedCommandsCount: 0,
        hasActiveLocalJsxUI: false,
        isInPlanMode: true,
      }),
    ).toEqual({ type: 'ignored' })
  })

  test('ignores budget wrap-up while plan mode is active', () => {
    const goal = updateThreadGoalStatus(
      createThreadGoal('session-1', 'finish goal mode'),
      'budget_limited',
      'token_budget_exhausted',
    )

    expect(
      getThreadGoalContinuationAction({
        sessionIsIdle: true,
        goal,
        goalContinuationInFlight: false,
        pendingBudgetWrapUpGoalId: goal.goalId,
        queuedCommandsCount: 0,
        hasActiveLocalJsxUI: false,
        isInPlanMode: true,
      }),
    ).toEqual({ type: 'ignored' })
  })
})
