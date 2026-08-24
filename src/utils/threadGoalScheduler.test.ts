import { describe, expect, test } from 'bun:test'
import {
  createThreadGoal,
  parseThreadGoal,
  updateThreadGoalStatus,
  DEFAULT_MAX_GOAL_NO_PROGRESS_TURNS,
  type ThreadGoal,
} from './threadGoal.js'
import { DEFAULT_THREAD_GOAL_WAIT_MS } from './threadGoalWait.js'
import { EMPTY_THREAD_GOAL_USAGE_DELTA } from './threadGoalUsage.js'
import {
  createThreadGoalScheduler,
  type ThreadGoalSchedulerHost,
} from './threadGoalScheduler.js'

const NOW = 5_000_000

const IDLE_ACCOUNTING = {
  usage: EMPTY_THREAD_GOAL_USAGE_DELTA,
  chargedResponseIds: [] as string[],
  contextGrowthTokens: 0,
  timeDeltaSeconds: 1,
  madeNoProgress: false,
  failed: false,
}

function billing(billableTokens: number) {
  return {
    ...EMPTY_THREAD_GOAL_USAGE_DELTA,
    inputTokens: billableTokens,
    billableTokens,
    responseCount: 1,
  }
}

function createHarness(
  initialGoal: ThreadGoal | null,
  overrides: Partial<ThreadGoalSchedulerHost> = {},
) {
  let goal = initialGoal
  let clock = NOW
  const started: { prompt: string; kind: string; attemptId: string }[] = []
  let accept = true
  let canStart = true

  const host: ThreadGoalSchedulerHost = {
    ownerId: 'owner-a',
    now: () => clock,
    getGoal: () => goal,
    saveGoal: next => {
      goal = next
    },
    canStartAutomaticTurn: () => canStart,
    startTurn: input => {
      started.push(input)
      return accept
    },
    ...overrides,
  }

  return {
    scheduler: createThreadGoalScheduler(host),
    started,
    getGoal: () => goal,
    setGoal: (next: ThreadGoal | null) => {
      goal = next
    },
    advance: (ms: number) => {
      clock += ms
    },
    setAccept: (value: boolean) => {
      accept = value
    },
    setCanStart: (value: boolean) => {
      canStart = value
    },
  }
}

function activeGoal(): ThreadGoal {
  return createThreadGoal('session-1', 'ship the scheduler', undefined, NOW)
}

describe('starting a continuation', () => {
  test('an active idle goal starts exactly one turn', async () => {
    const h = createHarness(activeGoal())

    const decision = await h.scheduler.wake({
      trigger: 'idle',
      sourceId: 'idle-1',
    })

    expect(decision.type).toBe('started')
    expect(h.started).toHaveLength(1)
    expect(h.started[0]!.kind).toBe('active')
    expect(h.started[0]!.prompt).toContain('ship the scheduler')
    // The claim is persisted before the turn runs, so a crash cannot lose it.
    expect(h.getGoal()!.pendingAttempt?.status).toBe('running')
    expect(h.getGoal()!.pendingAttempt?.claimedBy).toBe('owner-a')
  })

  test('a redelivered wake starts no second turn', async () => {
    const h = createHarness(activeGoal())

    await h.scheduler.wake({ trigger: 'idle', sourceId: 'idle-1' })
    const attempt = h.scheduler.getRunningAttempt()!
    h.scheduler.settle({
      attempt,
      goalId: attempt.goalId,
      accounting: IDLE_ACCOUNTING,
    })

    const second = await h.scheduler.wake({
      trigger: 'idle',
      sourceId: 'idle-1',
    })

    expect(second).toEqual({ type: 'skipped', reason: 'duplicate-wake' })
    expect(h.started).toHaveLength(1)
  })

  test('a wake while a turn is in flight starts no rival turn', async () => {
    const h = createHarness(activeGoal())

    await h.scheduler.wake({ trigger: 'idle', sourceId: 'idle-1' })
    const second = await h.scheduler.wake({
      trigger: 'idle',
      sourceId: 'idle-2',
    })

    expect(second).toEqual({ type: 'skipped', reason: 'attempt-in-flight' })
    expect(h.started).toHaveLength(1)
  })

  test('queued user input outranks automatic continuation', async () => {
    const h = createHarness(activeGoal())
    h.setCanStart(false)

    const decision = await h.scheduler.wake({
      trigger: 'idle',
      sourceId: 'idle-1',
    })

    expect(decision).toEqual({ type: 'skipped', reason: 'host-busy' })
    expect(h.started).toHaveLength(0)
    // Nothing was recorded, so the same wake still works once the user is done.
    expect(h.getGoal()!.pendingAttempt).toBeNull()
  })

  test('an outer scheduler suppresses native continuation entirely', async () => {
    const h = createHarness(activeGoal(), {
      hasExternalScheduler: () => true,
    })

    const decision = await h.scheduler.wake({
      trigger: 'idle',
      sourceId: 'idle-1',
    })

    expect(decision).toEqual({ type: 'skipped', reason: 'external-scheduler' })
    expect(h.started).toHaveLength(0)
    // Not even a wake record: an attempt this scheduler never runs would block
    // the owning scheduler's own attempt.
    expect(h.getGoal()!.pendingAttempt).toBeNull()
    expect(h.getGoal()!.recentWakeKeys).toEqual([])
  })

  test('a declined turn releases the attempt and charges nothing', async () => {
    const h = createHarness(activeGoal())
    h.setAccept(false)

    const decision = await h.scheduler.wake({
      trigger: 'idle',
      sourceId: 'idle-1',
    })

    expect(decision).toEqual({ type: 'skipped', reason: 'host-declined' })
    expect(h.scheduler.getRunningAttempt()).toBeNull()
    expect(h.getGoal()!.pendingAttempt?.status).toBe('settled')
    expect(h.getGoal()!.tokensUsed).toBe(0)
  })

  test('no non-active status starts an ordinary continuation', async () => {
    for (const [status, reason] of [
      ['paused', 'user_paused'],
      ['blocked', 'agent_reported_blocked'],
      ['stalled', 'no_progress'],
      ['failed', 'runtime_error'],
      ['usage_limited', 'provider_usage_limit'],
      ['waiting', 'waiting_on_dependency'],
      ['complete', 'agent_reported_complete'],
    ] as const) {
      const h = createHarness(
        updateThreadGoalStatus(activeGoal(), status, reason, NOW),
      )

      const decision = await h.scheduler.wake({
        trigger: 'idle',
        sourceId: 'idle-1',
      })

      expect(decision).toEqual({ type: 'skipped', reason: 'not-schedulable' })
      expect(h.started).toHaveLength(0)
    }
  })

  test('a budget-limited goal gets a wrap-up turn but not an ordinary one', async () => {
    const limited = updateThreadGoalStatus(
      activeGoal(),
      'budget_limited',
      'token_budget_exhausted',
      NOW,
    )

    const idle = createHarness(limited)
    expect(
      (await idle.scheduler.wake({ trigger: 'idle', sourceId: 'idle-1' })).type,
    ).toBe('skipped')

    const wrap = createHarness(limited)
    const decision = await wrap.scheduler.wake({
      trigger: 'budget-wrap-up',
      sourceId: 'wrap-1',
    })

    expect(decision).toMatchObject({ type: 'started', kind: 'budget-wrap-up' })
    expect(wrap.started[0]!.prompt).toContain('reached its token budget')
  })
})

describe('parking on dependencies', () => {
  function parkingHarness(deps: { subjectId: string; label: string }[]) {
    let goal: ThreadGoal | null = activeGoal()
    let clock = NOW
    const started: unknown[] = []
    let dependencies = deps
    const scheduler = createThreadGoalScheduler({
      ownerId: 'owner-a',
      now: () => clock,
      getGoal: () => goal,
      saveGoal: next => {
        goal = next
      },
      canStartAutomaticTurn: () => true,
      getUnresolvedDependencies: () =>
        dependencies.map(d => ({ kind: 'worker' as const, ...d })),
      createWaitId: () => 'wait-1',
      startTurn: input => {
        started.push(input)
        return true
      },
    })
    return {
      scheduler,
      started,
      getGoal: () => goal,
      resolveAll: () => {
        dependencies = []
      },
      advance: (ms: number) => {
        clock += ms
      },
    }
  }

  test('an outstanding dependency parks the goal instead of taking a turn', async () => {
    const h = parkingHarness([{ subjectId: 'worker-7', label: 'reviewer' }])

    const decision = await h.scheduler.wake({
      trigger: 'idle',
      sourceId: 'idle-1',
    })

    expect(decision).toEqual({ type: 'parked', subjectId: 'worker-7' })
    expect(h.started).toHaveLength(0)
    expect(h.getGoal()!.status).toBe('waiting')
    expect(h.getGoal()!.statusReason).toBe('waiting_on_dependency')
    expect(h.getGoal()!.wait!.subjectId).toBe('worker-7')
  })

  test('a parked goal spends no turns no matter how often it is woken', async () => {
    // This is the whole point: without parking, each of these ticks would be
    // a model turn spent asking whether the worker had finished.
    const h = parkingHarness([{ subjectId: 'worker-7', label: 'reviewer' }])
    await h.scheduler.wake({ trigger: 'idle', sourceId: 'idle-1' })

    for (let i = 0; i < 10; i++) {
      const decision = await h.scheduler.wake({
        trigger: 'idle',
        sourceId: `idle-${i + 2}`,
      })
      expect(decision).toEqual({ type: 'skipped', reason: 'not-schedulable' })
    }

    expect(h.started).toHaveLength(0)
    expect(h.getGoal()!.continuationTurns).toBe(0)
    expect(h.getGoal()!.status).toBe('waiting')
  })

  test('the awaited work completing wakes the goal and runs one turn', async () => {
    const h = parkingHarness([{ subjectId: 'worker-7', label: 'reviewer' }])
    await h.scheduler.wake({ trigger: 'idle', sourceId: 'idle-1' })
    h.resolveAll()

    const decision = await h.scheduler.wake({
      trigger: 'task-completed',
      sourceId: 'worker-7',
    })

    expect(decision.type).toBe('started')
    expect(h.started).toHaveLength(1)
    expect(h.getGoal()!.status).toBe('active')
    expect(h.getGoal()!.wait).toBeNull()
  })

  test('a completion for something else leaves the goal parked', async () => {
    const h = parkingHarness([{ subjectId: 'worker-7', label: 'reviewer' }])
    await h.scheduler.wake({ trigger: 'idle', sourceId: 'idle-1' })

    const decision = await h.scheduler.wake({
      trigger: 'task-completed',
      sourceId: 'some-other-worker',
    })

    expect(decision).toEqual({ type: 'skipped', reason: 'not-schedulable' })
    expect(h.getGoal()!.status).toBe('waiting')
  })

  test('a wake that never arrives times out into an honest stopped state', async () => {
    const h = parkingHarness([{ subjectId: 'worker-7', label: 'reviewer' }])
    await h.scheduler.wake({ trigger: 'idle', sourceId: 'idle-1' })

    h.advance(DEFAULT_THREAD_GOAL_WAIT_MS + 1)
    const decision = await h.scheduler.wake({
      trigger: 'idle',
      sourceId: 'idle-later',
    })

    expect(decision).toEqual({ type: 'skipped', reason: 'not-schedulable' })
    expect(h.getGoal()!.status).toBe('stalled')
    expect(h.getGoal()!.statusReason).toBe('dependency_timeout')
    expect(h.getGoal()!.wait).toBeNull()
    // Never success, and never left looking alive.
    expect(h.getGoal()!.status).not.toBe('complete')
  })

  test('a restart resumes the park rather than losing it', async () => {
    const h = parkingHarness([{ subjectId: 'worker-7', label: 'reviewer' }])
    await h.scheduler.wake({ trigger: 'idle', sourceId: 'idle-1' })

    const reloaded = parseThreadGoal(JSON.parse(JSON.stringify(h.getGoal())))

    expect(reloaded!.status).toBe('waiting')
    expect(reloaded!.wait).toEqual(h.getGoal()!.wait)
    // The deadline survives the process that set it.
    expect(reloaded!.wait!.deadlineMs).toBe(
      NOW + DEFAULT_THREAD_GOAL_WAIT_MS,
    )
  })

  test('a user resume clears the park', async () => {
    const h = parkingHarness([{ subjectId: 'worker-7', label: 'reviewer' }])
    await h.scheduler.wake({ trigger: 'idle', sourceId: 'idle-1' })

    const resumed = updateThreadGoalStatus(
      h.getGoal()!,
      'active',
      'user_resumed',
      NOW + 5,
    )

    expect(resumed.status).toBe('active')
    expect(resumed.wait).toBeNull()
  })
})

describe('settling a continuation', () => {
  test('a completed turn is charged and the attempt retired', async () => {
    const h = createHarness(activeGoal())
    await h.scheduler.wake({ trigger: 'idle', sourceId: 'idle-1' })
    const attempt = h.scheduler.getRunningAttempt()!

    const settled = h.scheduler.settle({
      attempt,
      goalId: attempt.goalId,
      accounting: { ...IDLE_ACCOUNTING, usage: billing(900) },
    })

    expect(settled!.tokensUsed).toBe(900)
    expect(settled!.continuationTurns).toBe(1)
    expect(settled!.pendingAttempt?.status).toBe('settled')
    expect(h.scheduler.getRunningAttempt()).toBeNull()
  })

  test('a pause during the turn stops the settle from charging it', async () => {
    const h = createHarness(activeGoal())
    await h.scheduler.wake({ trigger: 'idle', sourceId: 'idle-1' })
    const attempt = h.scheduler.getRunningAttempt()!

    // The user pauses while the turn runs. The revision bump is what the
    // settle detects.
    h.setGoal(
      updateThreadGoalStatus(h.getGoal()!, 'paused', 'user_paused', NOW + 10),
    )

    const settled = h.scheduler.settle({
      attempt,
      goalId: attempt.goalId,
      accounting: { ...IDLE_ACCOUNTING, usage: billing(900) },
    })

    expect(settled).toBeNull()
    expect(h.getGoal()!.status).toBe('paused')
    expect(h.getGoal()!.tokensUsed).toBe(0)
    expect(h.getGoal()!.pendingAttempt?.status).toBe('settled')
  })

  test('a replacement during the turn is never charged or completed', async () => {
    const h = createHarness(activeGoal())
    await h.scheduler.wake({ trigger: 'idle', sourceId: 'idle-1' })
    const attempt = h.scheduler.getRunningAttempt()!

    const replacement = createThreadGoal(
      'session-1',
      'a different objective',
      undefined,
      NOW + 10,
    )
    h.setGoal(replacement)

    const settled = h.scheduler.settle({
      attempt,
      goalId: attempt.goalId,
      accounting: { ...IDLE_ACCOUNTING, usage: billing(900) },
    })

    expect(settled).toBeNull()
    expect(h.getGoal()!.goalId).toBe(replacement.goalId)
    expect(h.getGoal()!.tokensUsed).toBe(0)
    expect(h.getGoal()!.continuationTurns).toBe(0)
  })

  test('a clear during the turn leaves nothing to charge', async () => {
    const h = createHarness(activeGoal())
    await h.scheduler.wake({ trigger: 'idle', sourceId: 'idle-1' })
    const attempt = h.scheduler.getRunningAttempt()!

    h.setGoal(null)

    expect(
      h.scheduler.settle({
        attempt,
        goalId: attempt.goalId,
        accounting: { ...IDLE_ACCOUNTING, usage: billing(900) },
      }),
    ).toBeNull()
    expect(h.getGoal()).toBeNull()
  })

  test('a goal completed mid-turn is not reopened by accounting', async () => {
    const h = createHarness(activeGoal())
    await h.scheduler.wake({ trigger: 'idle', sourceId: 'idle-1' })
    const attempt = h.scheduler.getRunningAttempt()!

    h.setGoal(
      updateThreadGoalStatus(
        h.getGoal()!,
        'complete',
        'agent_reported_complete',
        NOW + 10,
      ),
    )

    const settled = h.scheduler.settle({
      attempt,
      goalId: attempt.goalId,
      accounting: { ...IDLE_ACCOUNTING, usage: billing(900) },
    })

    expect(settled).toBeNull()
    expect(h.getGoal()!.status).toBe('complete')
  })

  test('a lease taken over by another owner voids this settle', async () => {
    const h = createHarness(activeGoal())
    await h.scheduler.wake({ trigger: 'idle', sourceId: 'idle-1' })
    const attempt = h.scheduler.getRunningAttempt()!

    // Another scheduler reclaims the expired lease and bumps the epoch.
    const goal = h.getGoal()!
    h.setGoal({
      ...goal,
      pendingAttempt: {
        ...goal.pendingAttempt!,
        claimedBy: 'owner-b',
        leaseEpoch: goal.pendingAttempt!.leaseEpoch + 1,
      },
    })

    expect(
      h.scheduler.settle({
        attempt,
        goalId: attempt.goalId,
        accounting: { ...IDLE_ACCOUNTING, usage: billing(900) },
      }),
    ).toBeNull()
    expect(h.getGoal()!.tokensUsed).toBe(0)
  })

  test('repeated unproductive automatic turns stall the goal through the loop', async () => {
    const h = createHarness(activeGoal())

    for (let i = 0; i < DEFAULT_MAX_GOAL_NO_PROGRESS_TURNS; i++) {
      const decision = await h.scheduler.wake({
        trigger: 'idle',
        sourceId: `idle-${i}`,
      })
      expect(decision.type).toBe('started')
      const running = h.scheduler.getRunningAttempt()!
      h.scheduler.settle({
        attempt: running,
        goalId: running.goalId,
        accounting: { ...IDLE_ACCOUNTING, madeNoProgress: true },
      })
      h.advance(1_000)
    }

    expect(h.getGoal()!.status).toBe('stalled')

    // And the loop stops on its own: the next wake finds it unschedulable.
    const after = await h.scheduler.wake({
      trigger: 'idle',
      sourceId: 'idle-final',
    })
    expect(after).toEqual({ type: 'skipped', reason: 'not-schedulable' })
  })

  test('every automatic turn counts toward the turn ceiling', async () => {
    const h = createHarness(activeGoal())

    for (let i = 0; i < 3; i++) {
      await h.scheduler.wake({ trigger: 'idle', sourceId: `idle-${i}` })
      const running = h.scheduler.getRunningAttempt()!
      h.scheduler.settle({
        attempt: running,
        goalId: running.goalId,
        accounting: IDLE_ACCOUNTING,
      })
    }

    expect(h.getGoal()!.continuationTurns).toBe(3)
  })
})
