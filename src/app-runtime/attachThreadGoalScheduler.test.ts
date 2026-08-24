import { describe, expect, test } from 'bun:test'
import {
  createThreadGoal,
  updateThreadGoalStatus,
  DEFAULT_MAX_GOAL_NO_PROGRESS_TURNS,
  type ThreadGoal,
} from '../utils/threadGoal.js'
import {
  attachThreadGoalScheduler,
  diffCumulativeTurnUsage,
} from './attachThreadGoalScheduler.js'
import type { AppSessionEvent } from './sessionEvents.js'

const NOW = 9_000_000

type ScriptedTurn = {
  toolUses?: number
  toolName?: string
  toolInput?: unknown
  toolResult?: unknown
  cumulativeInput?: number
  cumulativeOutput?: number
  assistantError?: { status?: number; error?: string }
  isError?: boolean
}

/**
 * A controller stand-in that reproduces AppSessionController's ORDERING:
 * turn.status true, then messages, then the result, then turn.status false.
 * The adapter's whole contract is expressed against that ordering.
 */
function createFakeController(script: () => ScriptedTurn) {
  const listeners = new Set<(event: AppSessionEvent) => void>()
  const submitted: { prompt: unknown; isMeta: boolean | undefined }[] = []
  let activeTurn = false

  function emit(event: AppSessionEvent): void {
    for (const listener of [...listeners]) listener(event)
  }

  async function runTurn(prompt: unknown, isMeta?: boolean): Promise<void> {
    if (activeTurn) throw new Error('Session turn already running')
    submitted.push({ prompt, isMeta })
    activeTurn = true
    emit({ type: 'turn.status', activeTurn: true })

    const turn = script()
    for (let i = 0; i < (turn.toolUses ?? 0); i++) {
      emit({
        type: 'message',
        message: {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'call-' + i,
                name: turn.toolName ?? 'Read',
                input: turn.toolInput ?? { file: 'a.ts' },
              },
            ],
          },
        } as never,
      })
      emit({
        type: 'message',
        message: {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call-' + i,
                content: turn.toolResult ?? 'same output',
              },
            ],
          },
        } as never,
      })
    }
    if (turn.assistantError) {
      emit({
        type: 'message',
        message: { type: 'assistant_error', ...turn.assistantError } as never,
      })
    }
    emit({
      type: 'message',
      message: {
        type: 'result',
        is_error: turn.isError ?? false,
        usage: {
          input_tokens: turn.cumulativeInput ?? 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: turn.cumulativeOutput ?? 0,
        },
      } as never,
    })

    activeTurn = false
    emit({ type: 'turn.status', activeTurn: false })
  }

  return {
    submitted,
    controller: {
      subscribe(listener: (event: AppSessionEvent) => void) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      submit(prompt: unknown, options?: { isMeta?: boolean }) {
        return runTurn(prompt, options?.isMeta)
      },
    },
    runClientTurn: (prompt: string) => runTurn(prompt, undefined),
  }
}

function harness(
  initialGoal: ThreadGoal | null,
  script: () => ScriptedTurn = () => ({}),
) {
  let goal = initialGoal
  let clock = NOW
  const fake = createFakeController(script)
  const attachment = attachThreadGoalScheduler({
    controller: fake.controller as never,
    ownerId: 'sidecar-1',
    getGoal: () => goal,
    saveGoal: next => {
      goal = next
    },
    now: () => clock,
  })
  return {
    ...fake,
    ...attachment,
    getGoal: () => goal,
    setGoal: (next: ThreadGoal | null) => {
      goal = next
    },
    advance: (ms: number) => {
      clock += ms
    },
  }
}

function activeGoal(): ThreadGoal {
  return createThreadGoal('session-1', 'run on the app runtime', undefined, NOW)
}

describe('turn usage from cumulative totals', () => {
  test('a turn is charged its delta, not the running total', () => {
    const first = diffCumulativeTurnUsage(
      { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      { inputTokens: 1_000, outputTokens: 100, cachedInputTokens: 50 },
    )
    expect(first.billableTokens).toBe(1_100)

    const second = diffCumulativeTurnUsage(
      { inputTokens: 1_000, outputTokens: 100, cachedInputTokens: 50 },
      { inputTokens: 2_500, outputTokens: 300, cachedInputTokens: 90 },
    )
    // Not 2_800: the second turn cost the difference.
    expect(second.billableTokens).toBe(1_700)
    expect(second.cachedInputTokens).toBe(40)
  })

  test('a replaced engine restarts the total rather than charging nothing', () => {
    // A resume mints a fresh QueryEngine whose total starts at zero. Treating
    // the decrease as a clamped negative would silently lose that turn.
    const afterRestart = diffCumulativeTurnUsage(
      { inputTokens: 9_000, outputTokens: 900, cachedInputTokens: 0 },
      { inputTokens: 400, outputTokens: 40, cachedInputTokens: 0 },
    )
    expect(afterRestart.billableTokens).toBe(440)
  })
})

describe('the app runtime drives the same loop', () => {
  test('the loop runs to the turn ceiling and then stops on its own', async () => {
    // One client turn kicks it off; every later turn must come from the loop.
    // The ceiling both proves it looped and proves it is bounded.
    const goal = {
      ...activeGoal(),
      maxContinuationTurns: 3,
    }
    const h = harness(goal, () => ({ toolUses: 1 }))

    await h.runClientTurn('kick off')
    for (let i = 0; i < 50; i++) {
      await new Promise(resolve => setTimeout(resolve, 0))
      if (h.getGoal()?.status !== 'active') break
    }

    // 1 client turn + exactly 3 automatic ones.
    expect(h.submitted).toHaveLength(4)
    expect(h.submitted[0]!.isMeta).toBeUndefined()
    expect(h.submitted.slice(1).every(entry => entry.isMeta === true)).toBe(true)
    expect(h.getGoal()!.continuationTurns).toBe(3)
    expect(h.getGoal()!.status).toBe('budget_limited')
    expect(h.getGoal()!.statusReason).toBe('turn_budget_exhausted')
  })

  test('a non-schedulable goal produces no automatic turn', async () => {
    const h = harness(
      updateThreadGoalStatus(activeGoal(), 'paused', 'user_paused', NOW),
      () => ({ toolUses: 1 }),
    )

    await h.runClientTurn('one user turn')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(h.submitted).toHaveLength(1)
  })

  test('a user turn is charged, but not as an automatic continuation', async () => {
    const h = harness(activeGoal(), () => ({
      toolUses: 1,
      cumulativeInput: 500,
      cumulativeOutput: 50,
    }))
    h.detach()

    // Re-attach with the loop suppressed so exactly one turn is observed.
    let goal: ThreadGoal | null = activeGoal()
    const fake = createFakeController(() => ({
      cumulativeInput: 500,
      cumulativeOutput: 50,
    }))
    attachThreadGoalScheduler({
      controller: fake.controller as never,
      ownerId: 'sidecar-1',
      getGoal: () => goal,
      saveGoal: next => {
        goal = next
      },
      hasExternalScheduler: () => true,
      now: () => NOW,
    })

    await fake.runClientTurn('do the thing')

    expect(goal!.tokensUsed).toBe(550)
    // A user-driven turn never counts toward the automatic-turn ceiling.
    expect(goal!.continuationTurns).toBe(0)
    expect(fake.submitted).toHaveLength(1)
  })

  test('an outer scheduler suppresses the loop entirely', async () => {
    let goal: ThreadGoal | null = activeGoal()
    const fake = createFakeController(() => ({ toolUses: 1 }))
    attachThreadGoalScheduler({
      controller: fake.controller as never,
      ownerId: 'sidecar-1',
      getGoal: () => goal,
      saveGoal: next => {
        goal = next
      },
      hasExternalScheduler: () => true,
      now: () => NOW,
    })

    await fake.runClientTurn('one turn only')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(fake.submitted).toHaveLength(1)
    expect(goal!.pendingAttempt).toBeNull()
  })

  test('a rate-limited turn stops the goal as usage limited', async () => {
    let goal: ThreadGoal | null = activeGoal()
    const fake = createFakeController(() => ({
      assistantError: { status: 429 },
      isError: true,
    }))
    attachThreadGoalScheduler({
      controller: fake.controller as never,
      ownerId: 'sidecar-1',
      getGoal: () => goal,
      saveGoal: next => {
        goal = next
      },
      hasExternalScheduler: () => true,
      now: () => NOW,
    })

    await fake.runClientTurn('hits the limit')

    expect(goal!.status).toBe('usage_limited')
    expect(goal!.statusReason).toBe('provider_usage_limit')
  })

  test('automatic turns with no tool calls stall the goal and stop the loop', async () => {
    const h = harness(activeGoal(), () => ({ toolUses: 0 }))

    await h.runClientTurn('kick off')
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setTimeout(resolve, 0))
      if (h.getGoal()?.status === 'stalled') break
    }

    expect(h.getGoal()!.status).toBe('stalled')
    expect(h.getGoal()!.statusReason).toBe('no_progress')
    // Bounded: it stopped at the threshold rather than running away.
    expect(h.submitted.length).toBeLessThanOrEqual(
      DEFAULT_MAX_GOAL_NO_PROGRESS_TURNS + 1,
    )
  })

  test('a tool-using loop that repeats itself is stopped, not run forever', async () => {
    // The coarse signal cannot catch this: every turn calls a tool. What stops
    // it is that the call and its result are identical each time.
    const h = harness(activeGoal(), () => ({
      toolUses: 1,
      toolResult: 'identical every time',
    }))

    await h.runClientTurn('kick off')
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 0))
      if (h.getGoal()?.status !== 'active') break
    }

    expect(h.getGoal()!.status).toBe('stalled')
    expect(h.getGoal()!.statusReason).toBe('no_progress')
    // Well inside the 20-turn ceiling: repetition caught it first.
    expect(h.submitted.length).toBeLessThan(10)
  })

  test('a tool-using turn whose results keep changing is not stopped', async () => {
    // The false positive this must avoid: real progress looks like repetition
    // if the result is ignored.
    let counter = 0
    const h = harness(activeGoal(), () => ({
      toolUses: 1,
      toolResult: 'output ' + counter++,
    }))

    await h.runClientTurn('kick off')
    for (let i = 0; i < 40; i++) {
      await new Promise(resolve => setTimeout(resolve, 0))
      if (h.getGoal()?.status !== 'active') break
    }

    // It ran until the turn ceiling, not until a false stall.
    expect(h.getGoal()!.statusReason).toBe('turn_budget_exhausted')
    expect(h.getGoal()!.status).toBe('budget_limited')
  })

  test('detach stops the loop', async () => {
    const h = harness(activeGoal(), () => ({ toolUses: 1 }))
    h.detach()

    await h.runClientTurn('kick off')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(h.submitted).toHaveLength(1)
  })
})
