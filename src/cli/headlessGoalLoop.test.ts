import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import {
  getSessionId,
  getSessionProjectDir,
  switchSession,
} from '../bootstrap/state.js'
import { asSessionId } from '../types/ids.js'
import type { AppState } from '../state/AppState.js'
import type { Message } from '../types/message.js'
import {
  createThreadGoal,
  updateThreadGoalStatus,
  type ThreadGoal,
} from '../utils/threadGoal.js'
import {
  createHeadlessGoalLoop,
  DISABLE_HEADLESS_GOAL_LOOP_ENV,
} from './headlessGoalLoop.js'

const originalSessionId = getSessionId()
const originalProjectDir = getSessionProjectDir()
const tempDirs: string[] = []

afterEach(() => {
  switchSession(asSessionId(originalSessionId), originalProjectDir)
  delete process.env[DISABLE_HEADLESS_GOAL_LOOP_ENV]
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function withSession(): string {
  const dir = mkdtempSync(join(tmpdir(), 'headless-goal-'))
  tempDirs.push(dir)
  const sessionId = randomUUID()
  switchSession(asSessionId(sessionId), dir)
  return sessionId
}

function harness(goal: ThreadGoal | null) {
  let state = { threadGoal: goal } as unknown as AppState
  const loop = createHeadlessGoalLoop({
    getAppState: () => state,
    setAppState: updater => {
      state = updater(state)
    },
  })
  return { loop, getGoal: () => (state as { threadGoal: ThreadGoal | null }).threadGoal }
}

/**
 * A growing conversation, like the real caller's `mutableMessages`.
 *
 * print.ts passes ONE array that accumulates across turns, so the loop slices
 * it from the turn's start index. A fresh array per turn would make every
 * slice empty and every turn look unproductive.
 */
function conversation() {
  const messages: Message[] = []
  return {
    all: () => messages,
    addProductiveTurn: () => {
      messages.push(...productiveTurn())
      return messages
    },
  }
}

/** One assistant message with a tool call, so the turn counts as progress. */
function productiveTurn(): Message[] {
  return [
    {
      type: 'assistant',
      uuid: randomUUID(),
      message: {
        id: 'msg-' + randomUUID(),
        model: 'claude-opus-5',
        content: [{ type: 'tool_use' }],
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 5,
        },
      },
    } as unknown as Message,
  ]
}

describe('the headless goal loop', () => {
  test('an active goal produces a continuation prompt', async () => {
    const sessionId = withSession()
    const { loop } = harness(
      createThreadGoal(sessionId, 'finish the migration', undefined, 100),
    )

    const prompt = await loop!.nextContinuation(productiveTurn())

    expect(prompt).not.toBeNull()
    expect(prompt).toContain('finish the migration')
  })

  test('no goal means no loop, so an ordinary -p run is one-shot', async () => {
    withSession()
    const { loop } = harness(null)
    expect(await loop!.nextContinuation(productiveTurn())).toBeNull()
  })

  test('a stopped goal does not continue', async () => {
    const sessionId = withSession()
    const { loop } = harness(
      updateThreadGoalStatus(
        createThreadGoal(sessionId, 'paused work', undefined, 100),
        'paused',
        'user_paused',
        200,
      ),
    )
    expect(await loop!.nextContinuation(productiveTurn())).toBeNull()
  })

  test('a long run does not re-charge responses from earlier turns', async () => {
    // The walk is bounded to the turn. Walking the whole conversation
    // re-charged everything that had aged out of the 512-entry ledger, so
    // tokensUsed climbed with no matching spend until a budget it never spent
    // stopped the goal.
    const sessionId = withSession()
    const { loop, getGoal } = harness(
      createThreadGoal(sessionId, 'long run', undefined, 100),
    )
    const convo = conversation()

    for (let i = 0; i < 5; i++) {
      await loop!.nextContinuation(convo.addProductiveTurn())
    }

    // 5 turns x 15 billable tokens each, charged exactly once.
    expect(getGoal()!.tokensUsed).toBe(75)
  })

  test('the loop is bounded by the turn ceiling like every other runtime', async () => {
    const sessionId = withSession()
    const base = createThreadGoal(sessionId, 'never ending', undefined, 100)
    const { loop, getGoal } = harness({ ...base, maxContinuationTurns: 3 })

    const convo = conversation()
    let continuations = 0
    for (let i = 0; i < 20; i++) {
      const prompt = await loop!.nextContinuation(convo.addProductiveTurn())
      if (!prompt) break
      continuations++
    }

    expect(continuations).toBe(3)
    expect(getGoal()!.status).toBe('budget_limited')
    expect(getGoal()!.statusReason).toBe('turn_budget_exhausted')
  })

  test('the escape hatch disables it entirely', async () => {
    const sessionId = withSession()
    process.env[DISABLE_HEADLESS_GOAL_LOOP_ENV] = '1'
    const { loop } = harness(
      createThreadGoal(sessionId, 'finish the migration', undefined, 100),
    )
    // Null loop: the caller skips the idle check and -p stays one-shot.
    expect(loop).toBeNull()
  })

  test('real usage is charged, so headless budgets behave like the others', async () => {
    const sessionId = withSession()
    const { loop, getGoal } = harness(
      createThreadGoal(sessionId, 'charge me', undefined, 100),
    )

    const convo = conversation()
    await loop!.nextContinuation(convo.addProductiveTurn())

    // 10 input + 5 output from the single response above.
    expect(getGoal()!.tokensUsed).toBe(15)
  })
})
