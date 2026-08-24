import { describe, expect, test } from 'bun:test'
import {
  detectThreadGoalRepetition,
  fingerprintThreadGoalToolCall,
  MAX_THREAD_GOAL_CALL_HISTORY,
  parseThreadGoalCallHistory,
  THREAD_GOAL_REPETITION_THRESHOLD,
} from './threadGoalRepetition.js'

const READ = { toolName: 'Read', input: { file: 'a.ts' }, result: 'contents' }

function repeat(call: typeof READ, times: number) {
  let history: string[] = []
  let last = detectThreadGoalRepetition({ history, calls: [call] })
  for (let i = 1; i < times; i++) {
    history = last.nextHistory
    last = detectThreadGoalRepetition({ history, calls: [call] })
  }
  return last
}

describe('call identity', () => {
  test('the same call with the same result has one fingerprint', () => {
    expect(fingerprintThreadGoalToolCall(READ)).toBe(
      fingerprintThreadGoalToolCall({ ...READ }),
    )
  })

  test('a different result makes it a different event', () => {
    // The anti-false-positive property: re-running a check that now passes is
    // progress, not repetition.
    expect(fingerprintThreadGoalToolCall(READ)).not.toBe(
      fingerprintThreadGoalToolCall({ ...READ, result: 'different contents' }),
    )
  })

  test('argument key order does not change identity', () => {
    expect(
      fingerprintThreadGoalToolCall({
        toolName: 'Bash',
        input: { command: 'ls', timeout: 5 },
        result: 'ok',
      }),
    ).toBe(
      fingerprintThreadGoalToolCall({
        toolName: 'Bash',
        input: { timeout: 5, command: 'ls' },
        result: 'ok',
      }),
    )
  })

  test('a different tool with identical arguments is a different call', () => {
    expect(fingerprintThreadGoalToolCall(READ)).not.toBe(
      fingerprintThreadGoalToolCall({ ...READ, toolName: 'Grep' }),
    )
  })
})

describe('detecting a loop', () => {
  test('the same call with the same result trips at the threshold', () => {
    const below = repeat(READ, THREAD_GOAL_REPETITION_THRESHOLD - 1)
    expect(below.repeatedEverything).toBe(false)

    const atThreshold = repeat(READ, THREAD_GOAL_REPETITION_THRESHOLD)
    expect(atThreshold.repeatedEverything).toBe(true)
    expect(atThreshold.loopingFingerprints).toHaveLength(1)
  })

  test('a materially changed result does not trip it', () => {
    // The call runs four times but tells us something new each time.
    let history: string[] = []
    let verdict = detectThreadGoalRepetition({ history, calls: [READ] })
    for (const result of ['second', 'third', 'fourth']) {
      history = verdict.nextHistory
      verdict = detectThreadGoalRepetition({
        history,
        calls: [{ ...READ, result }],
      })
    }
    expect(verdict.repeatedEverything).toBe(false)
    expect(verdict.loopingFingerprints).toHaveLength(0)
  })

  test('one genuinely new call rescues an otherwise repetitive turn', () => {
    const repeated = repeat(READ, THREAD_GOAL_REPETITION_THRESHOLD)
    const verdict = detectThreadGoalRepetition({
      history: repeated.nextHistory,
      calls: [READ, { toolName: 'Edit', input: { file: 'a.ts' }, result: 'ok' }],
    })

    // The old call is still flagged as looping, but the turn as a whole did
    // something new, so it is not blocked.
    expect(verdict.loopingFingerprints).toHaveLength(1)
    expect(verdict.repeatedEverything).toBe(false)
  })

  test('a turn with no tool calls is not repetition', () => {
    // Doing nothing is a different failure from doing the same thing again,
    // and reporting the wrong reason sends the user to the wrong fix.
    const verdict = detectThreadGoalRepetition({
      history: repeat(READ, THREAD_GOAL_REPETITION_THRESHOLD).nextHistory,
      calls: [],
    })
    expect(verdict.repeatedEverything).toBe(false)
  })
})

describe('history persistence', () => {
  test('history is bounded and keeps the most recent calls', () => {
    let history: string[] = []
    for (let i = 0; i < MAX_THREAD_GOAL_CALL_HISTORY + 10; i++) {
      history = detectThreadGoalRepetition({
        history,
        calls: [{ ...READ, result: 'result-' + i }],
      }).nextHistory
    }
    expect(history).toHaveLength(MAX_THREAD_GOAL_CALL_HISTORY)
    expect(history.at(-1)).toBe(
      fingerprintThreadGoalToolCall({
        ...READ,
        result: 'result-' + (MAX_THREAD_GOAL_CALL_HISTORY + 9),
      }),
    )
  })

  test('history survives a round trip, which is what outlives compaction', () => {
    const verdict = repeat(READ, 2)
    expect(
      parseThreadGoalCallHistory(
        JSON.parse(JSON.stringify(verdict.nextHistory)),
      ),
    ).toEqual(verdict.nextHistory)
    expect(parseThreadGoalCallHistory('nonsense')).toEqual([])
  })

  test('a loop building before compaction is still detected after it', () => {
    // The whole reason history lives on the goal: compaction prunes the
    // messages a message-derived check would need to look back across.
    const beforeCompaction = repeat(READ, THREAD_GOAL_REPETITION_THRESHOLD - 1)
    const survived = parseThreadGoalCallHistory(
      JSON.parse(JSON.stringify(beforeCompaction.nextHistory)),
    )

    const afterCompaction = detectThreadGoalRepetition({
      history: survived,
      calls: [READ],
    })
    expect(afterCompaction.repeatedEverything).toBe(true)
  })
})
