import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getSessionId,
  getSessionProjectDir,
  switchSession,
} from '../../bootstrap/state.js'
import {
  createSessionState,
  readSessionState,
  updateSessionState,
} from '../../agent-mode/sessionState.js'
import { asSessionId } from '../../types/ids.js'
import { getCurrentThreadGoal } from '../../utils/sessionStorage.js'
import {
  buildThreadGoalToolResponse,
  createThreadGoal,
  updateThreadGoalStatus,
} from '../../utils/threadGoal.js'
import { CreateGoalTool } from './CreateGoalTool.js'

describe('CreateGoalTool', () => {
  const originalSessionId = getSessionId()
  const originalProjectDir = getSessionProjectDir()

  let tempDir: string
  let sessionId: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'create-goal-tool-'))
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

  test('creates an active goal', async () => {
    const { context, getState } = createContext(null)

    await updateSessionState(
      sessionId,
      () =>
        createSessionState({
          sessionId,
          mode: 'agent',
          objective: '',
        }),
      () => {},
    )

    const result = await CreateGoalTool.call(
      { objective: 'finish goal parity' },
      context as never,
      undefined as never,
      {} as never,
    )

    expect(result.data).toEqual({
      ...buildThreadGoalToolResponse(getState().threadGoal),
    })
    expect(getState().threadGoal?.objective).toBe('finish goal parity')
    expect(getCurrentThreadGoal(sessionId)?.objective).toBe('finish goal parity')
    expect((await readSessionState(sessionId))?.objective).toBe(
      'finish goal parity',
    )
  })

  test('creates a budgeted goal and returns remaining tokens', async () => {
    const { context } = createContext(null)

    const result = await CreateGoalTool.call(
      { objective: 'finish within budget', token_budget: 50_000 },
      context as never,
      undefined as never,
      {} as never,
    )

    expect(result.data.goal).toMatchObject({
      objective: 'finish within budget',
      tokenBudget: 50_000,
    })
    expect(result.data.remainingTokens).toBe(50_000)
  })

  test('rejects when an active goal exists', async () => {
    const existingGoal = createThreadGoal(sessionId, 'existing goal')
    const { context } = createContext(existingGoal)

    const validation = await CreateGoalTool.validateInput?.(
      { objective: 'new goal' },
      context as never,
    )

    expect(validation).toEqual({
      result: false,
      message:
        'A current thread goal already exists. Complete or clear it before creating a new goal.',
      errorCode: 1,
    })
  })

  test('allows a new goal after a completed goal', async () => {
    const completedGoal = updateThreadGoalStatus(
      createThreadGoal(sessionId, 'completed goal'),
      'complete',
      'agent_reported_complete',
    )
    const { context, getState } = createContext(completedGoal)

    const result = await CreateGoalTool.call(
      { objective: 'next goal' },
      context as never,
      undefined as never,
      {} as never,
    )

    expect(result.data.goal?.objective).toBe('next goal')
    expect(getState().threadGoal?.objective).toBe('next goal')
    expect(getState().threadGoal?.status).toBe('active')
  })

  test('rejects invalid objective and token budget at the schema level', () => {
    expect(CreateGoalTool.inputSchema.safeParse({ objective: '' }).success).toBe(
      false,
    )
    expect(
      CreateGoalTool.inputSchema.safeParse({
        objective: 'valid objective',
        token_budget: 0,
      }).success,
    ).toBe(false)
    expect(
      CreateGoalTool.inputSchema.safeParse({
        objective: 'valid objective',
        tokenBudget: 1,
      }).success,
    ).toBe(false)
  })

  test('rejects overly long objectives at the schema level', () => {
    expect(
      CreateGoalTool.inputSchema.safeParse({
        objective: 'x'.repeat(4097),
      }).success,
    ).toBe(false)
  })
})
