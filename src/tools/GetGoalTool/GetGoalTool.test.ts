import { describe, expect, test } from 'bun:test'
import { createThreadGoal } from '../../utils/threadGoal.js'
import { GetGoalTool } from './GetGoalTool.js'

describe('GetGoalTool', () => {
  function createContext(threadGoal: ReturnType<typeof createThreadGoal> | null) {
    return {
      getAppState: () => ({ threadGoal }),
    }
  }

  test('returns null when no goal exists', async () => {
    const result = await GetGoalTool.call(
      {},
      createContext(null) as never,
      undefined as never,
      {} as never,
    )

    expect(result.data).toEqual({ goal: null })
  })

  test('returns the active goal and remaining token budget', async () => {
    const goal = {
      ...createThreadGoal('session-1', 'finish implementation', 50_000, 100),
      tokensUsed: 12_000,
      timeUsedSeconds: 45,
    }
    const result = await GetGoalTool.call(
      {},
      createContext(goal) as never,
      undefined as never,
      {} as never,
    )

    expect(result.data.goal).toEqual(goal)
    expect(result.data.remainingTokens).toBe(goal.tokenBudget! - goal.tokensUsed)
  })

  test('is read-only', () => {
    expect(GetGoalTool.isReadOnly()).toBe(true)
  })
})
