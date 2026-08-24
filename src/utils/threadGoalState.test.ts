import { describe, expect, test } from 'bun:test'
import {
  AGENT_SETTABLE_THREAD_GOAL_STATUSES,
  checkThreadGoalTransition,
  getThreadGoalLifecycleClass,
  isResumableThreadGoalStatus,
  isSchedulableThreadGoalStatus,
  isSuccessfulThreadGoalStatus,
  isTerminalThreadGoalStatus,
  isThreadGoalStatus,
  THREAD_GOAL_STATUSES,
  type ThreadGoalActor,
  type ThreadGoalStatus,
} from './threadGoalState.js'

const ACTORS: ThreadGoalActor[] = ['user', 'agent', 'runtime']

describe('thread goal status classification', () => {
  test('complete is the only success and the only terminal status', () => {
    const successes = THREAD_GOAL_STATUSES.filter(isSuccessfulThreadGoalStatus)
    const terminals = THREAD_GOAL_STATUSES.filter(isTerminalThreadGoalStatus)

    expect(successes).toEqual(['complete'])
    expect(terminals).toEqual(['complete'])
  })

  test('every stopped status is resumable and no running status is', () => {
    for (const status of THREAD_GOAL_STATUSES) {
      expect(isResumableThreadGoalStatus(status)).toBe(
        getThreadGoalLifecycleClass(status) === 'stopped',
      )
    }

    expect(THREAD_GOAL_STATUSES.filter(isResumableThreadGoalStatus)).toEqual([
      'paused',
      'blocked',
      'stalled',
      'budget_limited',
      'usage_limited',
      'failed',
    ])
  })

  test('only active is schedulable, so a parked wait spends no turn', () => {
    expect(THREAD_GOAL_STATUSES.filter(isSchedulableThreadGoalStatus)).toEqual([
      'active',
    ])
    expect(isSchedulableThreadGoalStatus('waiting')).toBe(false)
  })

  test('every status is classified, and unknown strings are rejected', () => {
    expect(THREAD_GOAL_STATUSES).toHaveLength(9)
    for (const status of THREAD_GOAL_STATUSES) {
      expect(isThreadGoalStatus(status)).toBe(true)
      expect(getThreadGoalLifecycleClass(status)).toBeDefined()
    }
    expect(isThreadGoalStatus('done')).toBe(false)
    expect(isThreadGoalStatus(undefined)).toBe(false)
  })
})

describe('thread goal transition authority', () => {
  test('nothing may leave complete, by any actor', () => {
    for (const to of THREAD_GOAL_STATUSES) {
      if (to === 'complete') continue
      for (const actor of ACTORS) {
        const check = checkThreadGoalTransition({ from: 'complete', to, actor })
        expect(check.allowed).toBe(false)
        expect(check.code).toBe('terminal')
      }
    }
  })

  test('only the agent may complete a goal, and only from a running status', () => {
    expect(
      checkThreadGoalTransition({
        from: 'active',
        to: 'complete',
        actor: 'agent',
      }).allowed,
    ).toBe(true)

    // The runtime completing a goal would let a budget stop or a crash
    // recovery path serialize as success.
    for (const actor of ['user', 'runtime'] as const) {
      const check = checkThreadGoalTransition({
        from: 'active',
        to: 'complete',
        actor,
      })
      expect(check.allowed).toBe(false)
      expect(check.code).toBe('unauthorized')
    }

    // A stalled or failed goal cannot be completed at all.
    for (const from of ['stalled', 'failed', 'paused'] as const) {
      expect(
        checkThreadGoalTransition({ from, to: 'complete', actor: 'agent' })
          .allowed,
      ).toBe(false)
    }
  })

  test('the agent may only ever request complete or blocked', () => {
    const agentReachable = new Set<ThreadGoalStatus>()
    for (const from of THREAD_GOAL_STATUSES) {
      for (const to of THREAD_GOAL_STATUSES) {
        if (from === to) continue
        if (checkThreadGoalTransition({ from, to, actor: 'agent' }).allowed) {
          agentReachable.add(to)
        }
      }
    }

    expect([...agentReachable].sort()).toEqual(
      [...AGENT_SETTABLE_THREAD_GOAL_STATUSES].sort(),
    )
  })

  test('the runtime never resumes a stopped goal on its own', () => {
    // This is what stops a restart from relaunching a loop the scheduler
    // already abandoned: only a human reopens a stopped goal.
    for (const from of THREAD_GOAL_STATUSES.filter(
      isResumableThreadGoalStatus,
    )) {
      expect(
        checkThreadGoalTransition({ from, to: 'active', actor: 'user' }).allowed,
      ).toBe(true)
      const runtime = checkThreadGoalTransition({
        from,
        to: 'active',
        actor: 'runtime',
      })
      expect(runtime.allowed).toBe(false)
      expect(runtime.code).toBe('unauthorized')
    }
  })

  test('a same-status request is allowed so accounting writes stay on one path', () => {
    for (const status of THREAD_GOAL_STATUSES) {
      expect(
        checkThreadGoalTransition({ from: status, to: status, actor: 'runtime' })
          .allowed,
      ).toBe(true)
    }
  })

  test('a transition with no rule is forbidden rather than silently allowed', () => {
    const check = checkThreadGoalTransition({
      from: 'paused',
      to: 'stalled',
      actor: 'runtime',
    })
    expect(check.allowed).toBe(false)
    expect(check.code).toBe('forbidden')
  })

  test('the budget wrap-up turn may finish or block, but not resume itself', () => {
    expect(
      checkThreadGoalTransition({
        from: 'budget_limited',
        to: 'complete',
        actor: 'agent',
      }).allowed,
    ).toBe(true)
    expect(
      checkThreadGoalTransition({
        from: 'budget_limited',
        to: 'active',
        actor: 'agent',
      }).allowed,
    ).toBe(false)
  })
})
