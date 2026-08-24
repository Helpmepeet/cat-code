import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_THREAD_GOAL_WAIT_MS,
  parseThreadGoalWait,
  resolveThreadGoalWait,
  selectThreadGoalWait,
  type ThreadGoalWait,
} from './threadGoalWait.js'

const NOW = 3_000_000

function wait(overrides: Partial<ThreadGoalWait> = {}): ThreadGoalWait {
  return {
    waitId: 'wait-1',
    kind: 'worker',
    subjectId: 'worker-7',
    label: 'reviewer',
    startedAtMs: NOW,
    deadlineMs: NOW + DEFAULT_THREAD_GOAL_WAIT_MS,
    timeoutDisposition: 'stalled',
    ...overrides,
  }
}

describe('resolving a wait', () => {
  test('the awaited subject completing continues the goal', () => {
    expect(
      resolveThreadGoalWait({
        wait: wait(),
        completedSubjectId: 'worker-7',
        nowMs: NOW + 1_000,
      }),
    ).toEqual({ type: 'continue' })
  })

  test('a different subject completing leaves the goal parked', () => {
    // An unrelated task finishing is not evidence that this dependency did.
    expect(
      resolveThreadGoalWait({
        wait: wait(),
        completedSubjectId: 'worker-99',
        nowMs: NOW + 1_000,
      }),
    ).toEqual({ type: 'still-waiting' })
  })

  test('an idle tick carries no subject and never satisfies the wait', () => {
    expect(
      resolveThreadGoalWait({
        wait: wait(),
        completedSubjectId: null,
        nowMs: NOW + 1_000,
      }),
    ).toEqual({ type: 'still-waiting' })
  })

  test('passing the deadline times out with its declared disposition', () => {
    for (const disposition of ['blocked', 'stalled', 'failed'] as const) {
      expect(
        resolveThreadGoalWait({
          wait: wait({ timeoutDisposition: disposition }),
          completedSubjectId: null,
          nowMs: NOW + DEFAULT_THREAD_GOAL_WAIT_MS + 1,
        }),
      ).toEqual({ type: 'timed-out', disposition })
    }
  })

  test('a completion arriving exactly at the deadline still counts as done', () => {
    // The work finishing and the clock running out in the same moment should
    // read as success of the wait, not as a timeout.
    expect(
      resolveThreadGoalWait({
        wait: wait(),
        completedSubjectId: 'worker-7',
        nowMs: NOW + DEFAULT_THREAD_GOAL_WAIT_MS,
      }),
    ).toEqual({ type: 'continue' })
  })

  test('a timeout is never a success disposition', () => {
    const resolution = resolveThreadGoalWait({
      wait: wait(),
      completedSubjectId: null,
      nowMs: NOW + DEFAULT_THREAD_GOAL_WAIT_MS + 1,
    })
    expect(resolution.type).toBe('timed-out')
    expect(['blocked', 'stalled', 'failed']).toContain(
      (resolution as { disposition: string }).disposition,
    )
  })
})

describe('selecting what to park on', () => {
  test('nothing outstanding means no park', () => {
    expect(
      selectThreadGoalWait({
        dependencies: [],
        nowMs: NOW,
        createWaitId: () => 'wait-1',
      }),
    ).toBeNull()
  })

  test('one dependency at a time, so the wake is unambiguous', () => {
    const selected = selectThreadGoalWait({
      dependencies: [
        { kind: 'worker', subjectId: 'worker-a', label: 'a' },
        { kind: 'task', subjectId: 'task-b', label: 'b' },
      ],
      nowMs: NOW,
      createWaitId: () => 'wait-1',
    })
    expect(selected!.subjectId).toBe('worker-a')
    expect(selected!.deadlineMs).toBe(NOW + DEFAULT_THREAD_GOAL_WAIT_MS)
  })
})

describe('persistence', () => {
  test('a wait round-trips so a restart resumes the park', () => {
    const record = wait()
    expect(parseThreadGoalWait(JSON.parse(JSON.stringify(record)))).toEqual(
      record,
    )
  })

  test('a wait with no usable deadline is dropped, not half-read', () => {
    // A park with no way out is strictly worse than not being parked.
    expect(parseThreadGoalWait({ ...wait(), deadlineMs: 'soon' })).toBeNull()
    expect(parseThreadGoalWait({ ...wait(), kind: 'vibes' })).toBeNull()
    expect(
      parseThreadGoalWait({ ...wait(), timeoutDisposition: 'complete' }),
    ).toBeNull()
    expect(parseThreadGoalWait(null)).toBeNull()
  })
})
