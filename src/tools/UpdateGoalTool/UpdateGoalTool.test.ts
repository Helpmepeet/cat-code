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
  accountThreadGoalTurn,
  buildThreadGoalToolResponse,
  createThreadGoal,
  updateThreadGoalStatus,
} from '../../utils/threadGoal.js'
import { applyThreadGoalTransition } from '../../utils/threadGoalActions.js'
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
      'Use this tool to mark the current thread goal complete, or to report that it is blocked.',
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
    expect(prompt).toContain('The only valid statuses are "complete" and "blocked".')
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
    const { goal } = accountThreadGoalTurn(
      createThreadGoal(sessionId, 'finish phase 1A', 50_000, 100),
      {
        usage: {
          inputTokens: 12_000,
          outputTokens: 0,
          cachedInputTokens: 0,
          billableTokens: 12_000,
          responseCount: 1,
        },
        chargedResponseIds: ['resp-1'],
        contextGrowthTokens: 0,
        timeDeltaSeconds: 45,
        wasAutomaticContinuation: false,
        madeNoProgress: false,
        failed: false,
      },
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
      'token_budget_exhausted',
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

  test('rejects completing a paused goal', async () => {
    const goal = updateThreadGoalStatus(
      createThreadGoal(sessionId, 'finish phase 1A', undefined, 100),
      'paused',
      'user_paused',
      200,
    )
    const { context } = createContext(goal)

    await expect(
      UpdateGoalTool.validateInput?.({ status: 'complete' }, context as never),
    ).resolves.toEqual({
      result: false,
      message: 'A goal with status paused cannot be set to complete.',
      errorCode: 5,
    })
  })

  test('rejects a status the model has no authority to set', async () => {
    const goal = createThreadGoal(sessionId, 'finish phase 1A', undefined, 100)
    const { context } = createContext(goal)

    // Schema-level: only complete and blocked parse at all.
    for (const status of ['paused', 'active', 'stalled', 'failed']) {
      expect(UpdateGoalTool.inputSchema.safeParse({ status }).success).toBe(false)
    }

    // Transition-level: even a parseable status is re-checked against the
    // table, so widening the schema alone cannot widen model authority.
    await expect(
      UpdateGoalTool.validateInput?.({ status: 'blocked' }, context as never),
    ).resolves.toEqual({ result: true })
  })

  test('reports a goal blocked and persists the reason', async () => {
    const goal = createThreadGoal(sessionId, 'finish phase 1A', undefined, 100)
    const { context, getState } = createContext(goal)

    await UpdateGoalTool.call(
      { status: 'blocked' },
      context as never,
      undefined as never,
      {} as never,
    )

    expect(getState().threadGoal?.status).toBe('blocked')
    expect(getState().threadGoal?.statusReason).toBe('agent_reported_blocked')
    expect(getCurrentThreadGoal(sessionId)?.status).toBe('blocked')
  })

  test('a pause during the turn beats a completion decided before it', async () => {
    const goal = createThreadGoal(sessionId, 'finish phase 1A', undefined, 100)
    const { context, getState } = createContext(goal)

    // The user pauses between the model deciding to complete and the tool
    // writing. The transition table refuses paused -> complete outright, so
    // the user's control action wins without any durable write.
    const paused = updateThreadGoalStatus(goal, 'paused', 'user_paused', 300)
    context.setAppState(() => ({ threadGoal: paused }))

    await expect(
      UpdateGoalTool.call(
        { status: 'complete' },
        context as never,
        undefined as never,
        {} as never,
      ),
    ).rejects.toThrow(/cannot be set to complete/)

    expect(getState().threadGoal?.status).toBe('paused')
    expect(getState().threadGoal?.revision).toBe(paused.revision)
  })

  test('a stale revision loses the compare-and-swap', async () => {
    const goal = createThreadGoal(sessionId, 'finish phase 1A', undefined, 100)
    const { context, getState } = createContext(goal)

    // Same goal, but it has been mutated since the caller read it. The write
    // is refused rather than applied on top of the newer state.
    const bumped = updateThreadGoalStatus(goal, 'active', 'user_resumed', 300)
    context.setAppState(() => ({ threadGoal: bumped }))

    const result = await applyThreadGoalTransition({
      context: context as never,
      goalId: goal.goalId,
      to: 'complete',
      reason: 'agent_reported_complete',
      actor: 'agent',
      expectedRevision: goal.revision,
    })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('stale')
    expect(getState().threadGoal?.status).toBe('active')
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

  test('rejects model-visible goalId at the schema level', () => {
    expect(
      UpdateGoalTool.inputSchema.safeParse({
        status: 'complete',
        goalId: 'stale-goal-id',
      }).success,
    ).toBe(false)
  })
})
