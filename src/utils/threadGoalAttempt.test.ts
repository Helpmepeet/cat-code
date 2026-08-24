import { describe, expect, test } from 'bun:test'
import {
  buildThreadGoalWakeKey,
  claimThreadGoalAttempt,
  EMPTY_THREAD_GOAL_ATTEMPT_RECORD,
  isThreadGoalAttemptValid,
  markThreadGoalAttemptRunning,
  MAX_REMEMBERED_WAKE_KEYS,
  parseThreadGoalAttempt,
  parseThreadGoalAttemptRecord,
  recordThreadGoalWake,
  renewThreadGoalAttemptLease,
  settleThreadGoalAttempt,
  THREAD_GOAL_LEASE_MS,
  type ThreadGoalAttemptRecord,
} from './threadGoalAttempt.js'

const NOW = 1_000_000

function wake(
  record: ThreadGoalAttemptRecord,
  overrides: {
    goalRevision?: number
    sourceId?: string
    nowMs?: number
    attemptId?: string
  } = {},
) {
  return recordThreadGoalWake({
    record,
    goalId: 'goal-1',
    goalRevision: overrides.goalRevision ?? 1,
    trigger: 'idle',
    sourceId: overrides.sourceId ?? 'idle-1',
    nowMs: overrides.nowMs ?? NOW,
    ...(overrides.attemptId ? { attemptId: overrides.attemptId } : {}),
  })
}

describe('wake idempotency', () => {
  test('the same logical wake creates exactly one attempt', () => {
    const first = wake(EMPTY_THREAD_GOAL_ATTEMPT_RECORD)
    expect(first.outcome).toBe('created')

    // Redelivery of the identical event, after the first attempt settled so
    // "busy" cannot be what suppresses it.
    const settled = {
      ...first.record,
      pendingAttempt: settleThreadGoalAttempt({
        record: first.record,
        attemptId: first.record.pendingAttempt!.attemptId,
        nowMs: NOW + 1,
      }).pendingAttempt,
    }
    const second = wake(settled, { nowMs: NOW + 2 })

    expect(second.outcome).toBe('duplicate')
    expect(second.record.pendingAttempt!.attemptId).toBe(
      first.record.pendingAttempt!.attemptId,
    )
  })

  test('a wake key is stable across deliveries and distinct across events', () => {
    const base = {
      goalId: 'goal-1',
      trigger: 'task-completed' as const,
      sourceId: 'task-9',
    }
    // No timestamp or random component: that is what makes redelivery match.
    expect(buildThreadGoalWakeKey(base)).toBe(buildThreadGoalWakeKey(base))
    expect(buildThreadGoalWakeKey(base)).not.toBe(
      buildThreadGoalWakeKey({ ...base, sourceId: 'task-10' }),
    )
    expect(buildThreadGoalWakeKey(base)).not.toBe(
      buildThreadGoalWakeKey({ ...base, trigger: 'timer' }),
    )
    expect(buildThreadGoalWakeKey(base)).not.toBe(
      buildThreadGoalWakeKey({ ...base, goalId: 'goal-2' }),
    )
  })

  test('charging a turn does not un-suppress that turn\'s own wake', () => {
    // Accounting bumps the goal revision. A revision-keyed wake would stop
    // matching its own redelivery exactly when suppression is needed.
    const created = wake(EMPTY_THREAD_GOAL_ATTEMPT_RECORD, { goalRevision: 1 })
    const settled = settleThreadGoalAttempt({
      record: created.record,
      attemptId: created.record.pendingAttempt!.attemptId,
      nowMs: NOW + 1,
    })

    expect(wake(settled, { goalRevision: 2, nowMs: NOW + 2 }).outcome).toBe(
      'duplicate',
    )
  })

  test('a second wake while one is in flight does not create a rival attempt', () => {
    const first = wake(EMPTY_THREAD_GOAL_ATTEMPT_RECORD)
    const claimed = claimThreadGoalAttempt({
      record: first.record,
      attemptId: first.record.pendingAttempt!.attemptId,
      ownerId: 'owner-a',
      currentGoalRevision: 1,
      nowMs: NOW,
    })
    expect(claimed.outcome).toBe('claimed')

    const second = wake(
      (claimed as { record: ThreadGoalAttemptRecord }).record,
      { sourceId: 'idle-2' },
    )

    expect(second.outcome).toBe('busy')
    expect(second.record.pendingAttempt!.attemptId).toBe(
      first.record.pendingAttempt!.attemptId,
    )
  })

  test('an expired lease releases the attempt to a new wake', () => {
    const first = wake(EMPTY_THREAD_GOAL_ATTEMPT_RECORD)
    const claimed = claimThreadGoalAttempt({
      record: first.record,
      attemptId: first.record.pendingAttempt!.attemptId,
      ownerId: 'owner-a',
      currentGoalRevision: 1,
      nowMs: NOW,
    }) as { record: ThreadGoalAttemptRecord }

    // The owning scheduler died without settling. The goal must not stay wedged.
    const later = NOW + THREAD_GOAL_LEASE_MS + 1
    const second = wake(claimed.record, { sourceId: 'idle-2', nowMs: later })

    expect(second.outcome).toBe('created')
    expect(second.record.pendingAttempt!.attemptId).not.toBe(
      first.record.pendingAttempt!.attemptId,
    )
  })

  test('remembered wake keys stay bounded', () => {
    let record = EMPTY_THREAD_GOAL_ATTEMPT_RECORD
    for (let i = 0; i < MAX_REMEMBERED_WAKE_KEYS + 10; i++) {
      const result = wake(record, { sourceId: `idle-${i}`, nowMs: NOW + i })
      record = settleThreadGoalAttempt({
        record: result.record,
        attemptId: result.record.pendingAttempt!.attemptId,
        nowMs: NOW + i,
      })
    }
    expect(record.recentWakeKeys.length).toBe(MAX_REMEMBERED_WAKE_KEYS)
  })
})

describe('attempt leases', () => {
  test('two owners cannot hold one attempt at the same epoch', () => {
    const created = wake(EMPTY_THREAD_GOAL_ATTEMPT_RECORD)
    const attemptId = created.record.pendingAttempt!.attemptId

    const a = claimThreadGoalAttempt({
      record: created.record,
      attemptId,
      ownerId: 'owner-a',
      currentGoalRevision: 1,
      nowMs: NOW,
    }) as { outcome: string; record: ThreadGoalAttemptRecord }
    expect(a.outcome).toBe('claimed')

    const b = claimThreadGoalAttempt({
      record: a.record,
      attemptId,
      ownerId: 'owner-b',
      currentGoalRevision: 1,
      nowMs: NOW + 1,
    })

    expect(b.outcome).toBe('held-by-other')
    expect((b as { heldBy: string }).heldBy).toBe('owner-a')
  })

  test('a long turn is still valid: expiry does not police turn duration', () => {
    // Expiry means "the scheduler that claimed this is gone", not "this turn
    // took too long". A turn running a test suite routinely exceeds the lease,
    // and voiding it there silently disabled every accounting ceiling.
    const created = wake(EMPTY_THREAD_GOAL_ATTEMPT_RECORD)
    const attemptId = created.record.pendingAttempt!.attemptId
    const claimed = claimThreadGoalAttempt({
      record: created.record,
      attemptId,
      ownerId: 'owner-a',
      currentGoalRevision: 1,
      nowMs: NOW,
    }) as { record: ThreadGoalAttemptRecord }

    expect(
      isThreadGoalAttemptValid({
        record: claimed.record,
        attemptId,
        ownerId: 'owner-a',
        leaseEpoch: claimed.record.pendingAttempt!.leaseEpoch,
        currentGoalRevision: 1,
      }),
    ).toBe(true)
  })

  test('a takeover after expiry bumps the epoch and invalidates the old owner', () => {
    const created = wake(EMPTY_THREAD_GOAL_ATTEMPT_RECORD)
    const attemptId = created.record.pendingAttempt!.attemptId

    const a = claimThreadGoalAttempt({
      record: created.record,
      attemptId,
      ownerId: 'owner-a',
      currentGoalRevision: 1,
      nowMs: NOW,
    }) as { record: ThreadGoalAttemptRecord }
    const epochA = a.record.pendingAttempt!.leaseEpoch

    const takeover = NOW + THREAD_GOAL_LEASE_MS + 1
    const b = claimThreadGoalAttempt({
      record: a.record,
      attemptId,
      ownerId: 'owner-b',
      currentGoalRevision: 1,
      nowMs: takeover,
    }) as { outcome: string; record: ThreadGoalAttemptRecord }

    expect(b.outcome).toBe('claimed')
    expect(b.record.pendingAttempt!.leaseEpoch).toBe(epochA + 1)

    // owner-a must now fail its own validity check rather than finishing work.
    expect(
      isThreadGoalAttemptValid({
        record: b.record,
        attemptId,
        ownerId: 'owner-a',
        leaseEpoch: epochA,
        currentGoalRevision: 1,
      }),
    ).toBe(false)
  })

  test('a goal edit invalidates an attempt decided before it', () => {
    const created = wake(EMPTY_THREAD_GOAL_ATTEMPT_RECORD)
    const attemptId = created.record.pendingAttempt!.attemptId

    // The user edits or pauses the goal after the wake but before the claim.
    expect(
      claimThreadGoalAttempt({
        record: created.record,
        attemptId,
        ownerId: 'owner-a',
        currentGoalRevision: 2,
        nowMs: NOW,
      }).outcome,
    ).toBe('stale')

    // And after a successful claim, the edit still invalidates it mid-turn.
    const claimed = claimThreadGoalAttempt({
      record: created.record,
      attemptId,
      ownerId: 'owner-a',
      currentGoalRevision: 1,
      nowMs: NOW,
    }) as { record: ThreadGoalAttemptRecord }

    expect(
      isThreadGoalAttemptValid({
        record: claimed.record,
        attemptId,
        ownerId: 'owner-a',
        leaseEpoch: claimed.record.pendingAttempt!.leaseEpoch,
        currentGoalRevision: 2,
      }),
    ).toBe(false)
  })

  test('a settled attempt cannot be reclaimed or revalidated', () => {
    const created = wake(EMPTY_THREAD_GOAL_ATTEMPT_RECORD)
    const attemptId = created.record.pendingAttempt!.attemptId
    const claimed = claimThreadGoalAttempt({
      record: created.record,
      attemptId,
      ownerId: 'owner-a',
      currentGoalRevision: 1,
      nowMs: NOW,
    }) as { record: ThreadGoalAttemptRecord }
    const epoch = claimed.record.pendingAttempt!.leaseEpoch

    const settled = settleThreadGoalAttempt({
      record: claimed.record,
      attemptId,
      nowMs: NOW + 5,
    })

    expect(
      claimThreadGoalAttempt({
        record: settled,
        attemptId,
        ownerId: 'owner-a',
        currentGoalRevision: 1,
        nowMs: NOW + 6,
      }).outcome,
    ).toBe('missing')
    expect(
      isThreadGoalAttemptValid({
        record: settled,
        attemptId,
        ownerId: 'owner-a',
        leaseEpoch: epoch,
        currentGoalRevision: 1,
      }),
    ).toBe(false)
  })

  test('only the current owner at the current epoch may renew', () => {
    const created = wake(EMPTY_THREAD_GOAL_ATTEMPT_RECORD)
    const attemptId = created.record.pendingAttempt!.attemptId
    const claimed = claimThreadGoalAttempt({
      record: created.record,
      attemptId,
      ownerId: 'owner-a',
      currentGoalRevision: 1,
      nowMs: NOW,
    }) as { record: ThreadGoalAttemptRecord }
    const epoch = claimed.record.pendingAttempt!.leaseEpoch

    const renewed = renewThreadGoalAttemptLease({
      record: claimed.record,
      attemptId,
      ownerId: 'owner-a',
      leaseEpoch: epoch,
      nowMs: NOW + 1_000,
    })
    expect(renewed.pendingAttempt!.leaseExpiresAtMs).toBe(
      NOW + 1_000 + THREAD_GOAL_LEASE_MS,
    )

    const rejected = renewThreadGoalAttemptLease({
      record: renewed,
      attemptId,
      ownerId: 'owner-b',
      leaseEpoch: epoch,
      nowMs: NOW + 2_000,
    })
    expect(rejected).toBe(renewed)
  })

  test('running is a state change, not a new claim', () => {
    const created = wake(EMPTY_THREAD_GOAL_ATTEMPT_RECORD)
    const attemptId = created.record.pendingAttempt!.attemptId
    const claimed = claimThreadGoalAttempt({
      record: created.record,
      attemptId,
      ownerId: 'owner-a',
      currentGoalRevision: 1,
      nowMs: NOW,
    }) as { record: ThreadGoalAttemptRecord }

    const running = markThreadGoalAttemptRunning({
      record: claimed.record,
      attemptId,
      nowMs: NOW + 1,
    })

    expect(running.pendingAttempt!.status).toBe('running')
    expect(running.pendingAttempt!.leaseEpoch).toBe(
      claimed.record.pendingAttempt!.leaseEpoch,
    )
  })
})

describe('attempt persistence', () => {
  test('a claimed attempt survives a restart intact', () => {
    const created = wake(EMPTY_THREAD_GOAL_ATTEMPT_RECORD)
    const attemptId = created.record.pendingAttempt!.attemptId
    const claimed = claimThreadGoalAttempt({
      record: created.record,
      attemptId,
      ownerId: 'owner-a',
      currentGoalRevision: 1,
      nowMs: NOW,
    }) as { record: ThreadGoalAttemptRecord }

    const roundTripped = parseThreadGoalAttemptRecord(
      JSON.parse(JSON.stringify(claimed.record.pendingAttempt)),
      JSON.parse(JSON.stringify(claimed.record.recentWakeKeys)),
    )

    expect(roundTripped).toEqual(claimed.record)
  })

  test('an unreadable attempt parses to null rather than a partial claim', () => {
    // A half-parsed attempt would read as a live lease and wedge the goal.
    expect(parseThreadGoalAttempt({ attemptId: 'a' })).toBeNull()
    expect(
      parseThreadGoalAttempt({
        attemptId: 'a',
        wakeKey: 'k',
        goalRevision: 1,
        leaseEpoch: 1,
        leaseExpiresAtMs: 1,
        createdAtMs: 1,
        updatedAtMs: 1,
        trigger: 'not-a-trigger',
        status: 'claimed',
        claimedBy: null,
      }),
    ).toBeNull()
    expect(parseThreadGoalAttemptRecord(undefined, undefined)).toEqual(
      EMPTY_THREAD_GOAL_ATTEMPT_RECORD,
    )
  })
})
