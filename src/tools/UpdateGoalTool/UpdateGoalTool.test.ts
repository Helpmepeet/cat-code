import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getSessionId, getSessionProjectDir, switchSession } from '../../bootstrap/state.js'
import { asSessionId } from '../../types/ids.js'
import { getCurrentThreadGoal } from '../../utils/sessionStorage.js'
import {
  accountThreadGoalUsage,
  createThreadGoal,
  updateThreadGoalStatus,
} from '../../utils/threadGoal.js'
import { UpdateGoalTool } from './UpdateGoalTool.js'
import { randomUUID } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('UpdateGoalTool', () => {
  const originalSessionId = getSessionId()
  const originalProjectDir = getSessionProjectDir()

  let tempDir: string
  let sessionId: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'update-goal-tool-'))
    sessionId = randomUUID()
    switchSession(asSessionId(sessionId), tempDir)
  })

  afterEach(() => {
    switchSession(asSessionId(originalSessionId), originalProjectDir)
    rmSync(tempDir, { recursive: true, force: true })
  })

  function createContext(threadGoal: ReturnType<typeof createThreadGoal> | null) {
    let state = { threadGoal }

    return {
      context: {
        getAppState: () => state,
        setAppState: (
          updater: (prev: { threadGoal: typeof threadGoal }) => {
            threadGoal: typeof threadGoal
          },
        ) => {
          state = updater(state)
        },
      },
      getState: () => state,
    }
  }

  test('marks an active goal complete', async () => {
    const goal = createThreadGoal(sessionId, 'finish phase 1A', undefined, 100)
    const { context, getState } = createContext(goal)

    const result = await UpdateGoalTool.call(
      { status: 'complete' },
      context as never,
      undefined as never,
      {} as never,
    )

    expect(result.data).toMatchObject({
      message: 'Thread goal marked complete.',
      goalId: goal.goalId,
      status: 'complete',
      objective: goal.objective,
      tokensUsed: goal.tokensUsed,
      timeUsedSeconds: goal.timeUsedSeconds,
    })
    expect(getState().threadGoal?.status).toBe('complete')
    expect(getCurrentThreadGoal(sessionId)?.status).toBe('complete')
  })

  test('returns budget usage details for a budgeted goal', async () => {
    const goal = accountThreadGoalUsage(
      createThreadGoal(sessionId, 'finish phase 1A', 50_000, 100),
      12_000,
      45,
      200,
    )
    const { context, getState } = createContext(goal)

    const result = await UpdateGoalTool.call(
      { status: 'complete' },
      context as never,
      undefined as never,
      {} as never,
    )

    expect(result.data).toMatchObject({
      tokenBudget: 50_000,
      remainingTokens: 38_000,
    })
    expect(result.data.completionBudgetReport).toContain(
      'tokens used: 12000 of 50000',
    )
    expect(result.data.completionBudgetReport).toContain('time used: 45 seconds')
    expect(getState().threadGoal?.status).toBe('complete')
  })

  test('marks a budget-limited goal complete', async () => {
    const goal = updateThreadGoalStatus(
      createThreadGoal(sessionId, 'finish phase 1A', 50_000, 100),
      'budget_limited',
      200,
    )
    const { context, getState } = createContext(goal)

    await UpdateGoalTool.call(
      { status: 'complete' },
      context as never,
      undefined as never,
      {} as never,
    )

    expect(getState().threadGoal?.status).toBe('complete')
  })

  test('rejects when no goal exists', async () => {
    const { context } = createContext(null)

    await expect(
      UpdateGoalTool.validateInput?.({ status: 'complete' }, context as never),
    ).resolves.toEqual({
      result: false,
      message: 'No current thread goal exists.',
      errorCode: 1,
    })
  })

  test('rejects a stale goalId', async () => {
    const goal = createThreadGoal(sessionId, 'finish phase 1A', undefined, 100)
    const { context } = createContext(goal)

    await expect(
      UpdateGoalTool.validateInput?.(
        { status: 'complete', goalId: 'stale-goal-id' },
        context as never,
      ),
    ).resolves.toEqual({
      result: false,
      message: `Goal ID stale-goal-id is stale. Current goal ID is ${goal.goalId}.`,
      errorCode: 2,
    })
  })

  test('rejects an old goalId after clear', async () => {
    const oldGoal = createThreadGoal(sessionId, 'finish phase 1A', undefined, 100)
    const { context } = createContext(null)

    await expect(
      UpdateGoalTool.validateInput?.(
        { status: 'complete', goalId: oldGoal.goalId },
        context as never,
      ),
    ).resolves.toEqual({
      result: false,
      message: 'No current thread goal exists.',
      errorCode: 1,
    })
  })

  test('rejects an old goalId after a new goal replaces it', async () => {
    const oldGoal = createThreadGoal(sessionId, 'finish phase 1A', undefined, 100)
    const newGoal = createThreadGoal(sessionId, 'finish phase 1B', undefined, 200)
    const { context } = createContext(newGoal)

    await expect(
      UpdateGoalTool.validateInput?.(
        { status: 'complete', goalId: oldGoal.goalId },
        context as never,
      ),
    ).resolves.toEqual({
      result: false,
      message: `Goal ID ${oldGoal.goalId} is stale. Current goal ID is ${newGoal.goalId}.`,
      errorCode: 2,
    })
  })

  test('rejects paused goals', async () => {
    const goal = updateThreadGoalStatus(
      createThreadGoal(sessionId, 'finish phase 1A', undefined, 100),
      'paused',
      200,
    )
    const { context } = createContext(goal)

    await expect(
      UpdateGoalTool.validateInput?.({ status: 'complete' }, context as never),
    ).resolves.toEqual({
      result: false,
      message: 'Paused goals cannot be marked complete.',
      errorCode: 3,
    })
  })

  test('rejects non-complete statuses at the schema level', () => {
    expect(UpdateGoalTool.inputSchema.safeParse({ status: 'paused' }).success).toBe(
      false,
    )
  })
})
