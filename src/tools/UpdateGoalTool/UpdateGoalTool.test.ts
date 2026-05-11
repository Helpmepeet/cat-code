import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getSessionId, getSessionProjectDir, switchSession } from '../../bootstrap/state.js'
import {
  createSessionState,
  markWorkerResultSynthesized,
  recordWorkerSessionSpawn,
  recordWorkerSessionTerminal,
  readSessionState,
  updateSessionState,
} from '../../agent-mode/sessionState.js'
import { asSessionId } from '../../types/ids.js'
import { getCurrentThreadGoal } from '../../utils/sessionStorage.js'
import {
  accountThreadGoalUsage,
  buildThreadGoalToolResponse,
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

  test('prompt requires evidence-backed completion before marking goal complete', async () => {
    const prompt = await UpdateGoalTool.prompt()

    expect(prompt).toContain(
      'Use this tool only to mark the current thread goal complete.',
    )
    expect(prompt).toContain(
      '- every explicit requirement in the goal objective is satisfied',
    )
    expect(prompt).toContain(
      '- relevant files, command output, tests, logs, PR state, or other real evidence support completion',
    )
    expect(prompt).toContain(
      '- tests or green status actually cover the objective requirements',
    )
    expect(prompt).toContain('- no required work remains')
    expect(prompt).toContain(
      'Do not use this tool because the work seems mostly done.',
    )
    expect(prompt).toContain(
      'Do not use this tool because tests passed unless those tests cover the objective.',
    )
    expect(prompt).toContain(
      'Do not use this tool because the token budget is nearly exhausted.',
    )
    expect(prompt).toContain(
      'Do not use this tool because you are stopping work.',
    )
    expect(prompt).toContain('The only valid status is "complete".')
    expect(prompt).toContain(
      'When marking a budgeted goal complete, report the final token usage and elapsed time from the tool result to the user.',
    )
  })

  test('completion uses shared goal action and clears Agent Mode objective', async () => {
    const goal = createThreadGoal(
      sessionId,
      'finish shared action test',
      undefined,
      100,
    )
    const { context, getState } = createContext(goal)
    const workerAgentId = randomUUID().slice(0, 8)

    await updateSessionState(
      sessionId,
      () =>
        createSessionState({
          sessionId,
          mode: 'agent',
          objective: goal.objective,
        }),
      () => {},
    )
    await recordWorkerSessionSpawn({
      sessionId,
      mode: 'agent',
      objective: goal.objective,
      handle: 'review-1',
      agentId: workerAgentId,
      role: 'reviewer',
      description: 'Review the active goal',
      worktreePath: null,
    })
    await recordWorkerSessionTerminal({
      sessionId,
      agentId: workerAgentId,
      status: 'completed',
      outputSummary: 'Reviewed',
    })
    await markWorkerResultSynthesized({
      sessionId,
      agentId: workerAgentId,
    })

    const result = await UpdateGoalTool.call(
      { status: 'complete' },
      context as never,
      undefined as never,
      {} as never,
    )

    expect(result.data).toEqual({
      ...buildThreadGoalToolResponse(getState().threadGoal),
    })
    expect(getState().threadGoal?.status).toBe('complete')
    expect(getCurrentThreadGoal(sessionId)?.status).toBe('complete')
    expect((await readSessionState(sessionId))?.objective).toBe('')
    expect((await readSessionState(sessionId))?.knownWorkers).toEqual([])
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

    expect(result.data).toEqual({
      ...buildThreadGoalToolResponse(getState().threadGoal, {
        includeCompletionBudgetReport: true,
      }),
    })
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

  test('rejects completion while a worker is still running', async () => {
    const goal = createThreadGoal(sessionId, 'finish phase 1A', undefined, 100)
    const { context } = createContext(goal)
    const workerAgentId = randomUUID().slice(0, 8)

    await updateSessionState(
      sessionId,
      () =>
        createSessionState({
          sessionId,
          mode: 'agent',
          objective: goal.objective,
        }),
      () => {},
    )
    await recordWorkerSessionSpawn({
      sessionId,
      mode: 'agent',
      objective: goal.objective,
      handle: 'implement-1',
      agentId: workerAgentId,
      role: 'implementor',
      description: 'Implement the active goal',
      worktreePath: null,
    })

    await expect(
      UpdateGoalTool.validateInput?.({ status: 'complete' }, context as never),
    ).resolves.toMatchObject({
      result: false,
      errorCode: 6,
    })
  })

  test('rejects completion while a completed worker is pending synthesis', async () => {
    const goal = createThreadGoal(sessionId, 'finish phase 1A', undefined, 100)
    const { context } = createContext(goal)
    const workerAgentId = randomUUID().slice(0, 8)

    await updateSessionState(
      sessionId,
      () =>
        createSessionState({
          sessionId,
          mode: 'agent',
          objective: goal.objective,
        }),
      () => {},
    )
    await recordWorkerSessionSpawn({
      sessionId,
      mode: 'agent',
      objective: goal.objective,
      handle: 'review-1',
      agentId: workerAgentId,
      role: 'reviewer',
      description: 'Review the active goal',
      worktreePath: null,
    })
    await recordWorkerSessionTerminal({
      sessionId,
      agentId: workerAgentId,
      status: 'completed',
      outputSummary: 'Looks good',
    })

    await expect(
      UpdateGoalTool.validateInput?.({ status: 'complete' }, context as never),
    ).resolves.toMatchObject({
      result: false,
      errorCode: 6,
    })
  })

  test('rejects non-complete statuses at the schema level', () => {
    expect(UpdateGoalTool.inputSchema.safeParse({ status: 'paused' }).success).toBe(
      false,
    )
  })

  test('rejects model-visible goalId at the schema level', () => {
    expect(
      UpdateGoalTool.inputSchema.safeParse({
        status: 'complete',
        goalId: 'stale-goal-id',
      }).success,
    ).toBe(false)
  })
})
