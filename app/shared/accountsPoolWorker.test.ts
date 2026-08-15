import { describe, expect, test } from 'bun:test'

import type {
  AccountStatus,
  AccountsSnapshot,
  UsageStatsByRange,
  UsageStatsSnapshot,
} from './protocol.js'
import {
  ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
  parseAccountsPoolWorkerResult,
  parseAccountsSnapshot,
  parseUsageStatsByRange,
  parseUsageStatsSnapshot,
} from './accountsPoolWorker.js'

function account(over: Partial<AccountStatus> = {}): AccountStatus {
  return {
    id: 'acct-1',
    alias: 'work',
    status: 'healthy',
    statusReason: null,
    availability: 'available',
    availabilityLabel: 'Available',
    isDefault: true,
    hasVaultProfile: true,
    source: 'vault',
    usagePrimary: 42,
    usageWeekly: 17,
    usageLimitReached: false,
    usageResetAt: 1_700_000_000,
    lastRefreshIso: null,
    lastError: null,
    planType: 'plus',
    switchable: false,
    ...over,
  }
}

function pool(over: Partial<AccountsSnapshot> = {}): AccountsSnapshot {
  return {
    accounts: [account()],
    activeAccountId: 'acct-1',
    readyCount: 1,
    poolCount: 1,
    initialized: true,
    anthropicAccounts: [
      {
        id: 'anth-1',
        alias: null,
        email: 'person@example.com',
        status: 'healthy',
        isDefault: true,
        hasVaultProfile: true,
        subscriptionType: 'max',
      },
    ],
    anthropicActiveAccountId: 'anth-1',
    anthropicReadyCount: 1,
    anthropicPoolCount: 1,
    anthropicInitialized: true,
    anthropicRouteAvailable: true,
    ...over,
  }
}

function record(snapshot: AccountsSnapshot): unknown {
  return {
    type: 'pool',
    version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
    pool: snapshot,
  }
}

describe('parseAccountsPoolWorkerResult — accepts', () => {
  test('a well-formed pool record round-trips field-for-field', () => {
    const snapshot = pool()
    const parsed = parseAccountsPoolWorkerResult(
      JSON.parse(JSON.stringify(record(snapshot))),
    )
    expect(parsed).not.toBeNull()
    expect(parsed?.type).toBe('pool')
    if (parsed?.type !== 'pool') throw new Error('expected a pool result')
    expect(parsed.pool).toEqual(snapshot)
  })

  test('the optional anthropicSubscriptionActive is preserved when present', () => {
    const snapshot = pool({ anthropicSubscriptionActive: true })
    const parsed = parseAccountsSnapshot(JSON.parse(JSON.stringify(snapshot)))
    expect(parsed?.anthropicSubscriptionActive).toBe(true)
  })

  test('an absent anthropicSubscriptionActive stays absent, not defaulted', () => {
    const parsed = parseAccountsSnapshot(JSON.parse(JSON.stringify(pool())))
    expect(parsed).not.toBeNull()
    expect('anthropicSubscriptionActive' in (parsed ?? {})).toBe(false)
  })

  test('an empty pool is valid (no accounts is a real state, not a failure)', () => {
    const parsed = parseAccountsSnapshot(
      pool({
        accounts: [],
        anthropicAccounts: [],
        activeAccountId: null,
        anthropicActiveAccountId: null,
        readyCount: 0,
        poolCount: 0,
        anthropicReadyCount: 0,
        anthropicPoolCount: 0,
      }),
    )
    expect(parsed?.accounts).toEqual([])
  })

  test('a worker-reported failure parses as a failure', () => {
    const parsed = parseAccountsPoolWorkerResult({
      type: 'failure',
      version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
      reason: 'internal',
    })
    expect(parsed?.type).toBe('failure')
  })
})

describe('parseAccountsPoolWorkerResult — fails closed', () => {
  test('a wrong boundary version is rejected', () => {
    expect(
      parseAccountsPoolWorkerResult({ ...(record(pool()) as object), version: 2 }),
    ).toBeNull()
  })

  test('an unknown discriminant is rejected', () => {
    expect(
      parseAccountsPoolWorkerResult({ ...(record(pool()) as object), type: 'other' }),
    ).toBeNull()
  })

  test('an extra top-level key is rejected', () => {
    expect(
      parseAccountsPoolWorkerResult({ ...(record(pool()) as object), extra: 1 }),
    ).toBeNull()
  })

  /**
   * The closed-vocabulary gate is what makes a credential structurally
   * unrepresentable on this boundary: a token key cannot ride along even before
   * `secretGuard` runs. This is the projection-omits + guard-would-block pair the
   * accounts seam states, asserted at the parse end.
   */
  test('an account row carrying a token key is rejected outright', () => {
    const snapshot = pool()
    const smuggled = {
      ...snapshot,
      accounts: [{ ...account(), accessToken: 'sk-should-never-cross' }],
    }
    expect(parseAccountsSnapshot(smuggled)).toBeNull()
  })

  test('a missing account field fails the WHOLE snapshot, not just the row', () => {
    const partial = { ...account() } as Record<string, unknown>
    delete partial.switchable
    expect(parseAccountsSnapshot(pool({ accounts: [partial as never] }))).toBeNull()
  })

  test('an out-of-vocabulary status is rejected', () => {
    expect(
      parseAccountsSnapshot(
        pool({ accounts: [account({ status: 'sleepy' as never })] }),
      ),
    ).toBeNull()
  })

  test('an out-of-vocabulary availability is rejected', () => {
    expect(
      parseAccountsSnapshot(
        pool({ accounts: [account({ availability: 'maybe' as never })] }),
      ),
    ).toBeNull()
  })

  test('a string where a number belongs is rejected', () => {
    expect(
      parseAccountsSnapshot(
        pool({ accounts: [account({ usagePrimary: '42' as never })] }),
      ),
    ).toBeNull()
  })

  test('a present-but-wrong-typed optional flag is rejected', () => {
    expect(
      parseAccountsSnapshot(
        pool({ anthropicSubscriptionActive: 'yes' as never }),
      ),
    ).toBeNull()
  })

  test('a malformed Anthropic row fails the whole snapshot', () => {
    expect(
      parseAccountsSnapshot(
        pool({ anthropicAccounts: [{ id: 'anth-1' } as never] }),
      ),
    ).toBeNull()
  })

  test('non-record input is rejected', () => {
    expect(parseAccountsPoolWorkerResult(null)).toBeNull()
    expect(parseAccountsPoolWorkerResult('pool')).toBeNull()
    expect(parseAccountsPoolWorkerResult([])).toBeNull()
  })
})

/* ------------------------------------------------------------------------- *
 * usageStats — the Accounts page's analytics, riding the same worker record
 * ------------------------------------------------------------------------- */

function stats(over: Partial<UsageStatsSnapshot> = {}): UsageStatsSnapshot {
  return {
    range: '7d',
    totalTokens: 2_138_901,
    dailyModelTokens: [
      { date: '2026-08-13', tokensByModel: { 'gpt-5.6-sol': 562_713 } },
    ],
    modelUsage: {
      'gpt-5.6-sol': {
        inputTokens: 400_000,
        outputTokens: 162_713,
        cacheCreationInputTokens: 12_000,
        cacheReadInputTokens: 900_000,
      },
    },
    dailyActivity: [
      { date: '2026-08-13', messageCount: 812, sessionCount: 9, toolCallCount: 240 },
    ],
    cacheHitRate: 68,
    cacheReadTokens: 900_000,
    cacheWriteTokens: 12_000,
    freshInputTokens: 400_000,
    totalSessions: 76,
    totalMessages: 33_482,
    activeDays: 4,
    ...over,
  }
}

function byRange(over: Partial<UsageStatsByRange> = {}): UsageStatsByRange {
  return {
    '7d': stats(),
    '30d': stats({ range: '30d', totalTokens: 4_421_134, activeDays: 20 }),
    ...over,
  }
}

function poolWithStats(usageStats: unknown): unknown {
  return {
    type: 'pool',
    version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
    pool: pool(),
    usageStats,
  }
}

describe('parseAccountsPoolWorkerResult — usageStats accepts', () => {
  test('a well-formed both-ranges record round-trips', () => {
    const result = parseAccountsPoolWorkerResult(poolWithStats(byRange()))
    expect(result?.type).toBe('pool')
    expect(result?.type === 'pool' && result.usageStats).toEqual(byRange())
  })

  test('an absent usageStats stays absent, not defaulted to an empty snapshot', () => {
    // The whole point of the optional field: a failed stats read must not be
    // published as "this user has no history".
    const result = parseAccountsPoolWorkerResult(record(pool()))
    expect(result?.type).toBe('pool')
    expect(result?.type === 'pool' && 'usageStats' in result).toBe(false)
  })

  test('a genuinely empty history is a valid snapshot, not a rejection', () => {
    const empty = stats({
      totalTokens: 0,
      dailyModelTokens: [],
      modelUsage: {},
      dailyActivity: [],
      cacheHitRate: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      freshInputTokens: 0,
      totalSessions: 0,
      totalMessages: 0,
      activeDays: 0,
    })
    expect(parseUsageStatsSnapshot(empty)).toEqual(empty)
  })
})

describe('parseAccountsPoolWorkerResult — usageStats fails closed', () => {
  test('a present-but-malformed usageStats fails the WHOLE record', () => {
    // Not "drop the bad field and keep the pool": a child emitting garbage in one
    // field is not trusted in the others.
    expect(parseAccountsPoolWorkerResult(poolWithStats({ '7d': 1 }))).toBeNull()
  })

  test('a missing range is rejected — both or neither', () => {
    expect(
      parseAccountsPoolWorkerResult(poolWithStats({ '7d': stats() })),
    ).toBeNull()
  })

  test('a snapshot filed under the wrong range key is rejected', () => {
    // The renderer keys its store by this and never re-checks, so 30-day totals
    // must not be able to arrive under the 7-day toggle.
    expect(
      parseUsageStatsByRange({ '7d': stats({ range: '30d' }), '30d': stats() }),
    ).toBeNull()
  })

  test('an unknown range value is rejected', () => {
    expect(parseUsageStatsSnapshot(stats({ range: '90d' as never }))).toBeNull()
  })

  test('an extra key on the snapshot is rejected', () => {
    expect(
      parseUsageStatsSnapshot({ ...stats(), surprise: 1 } as never),
    ).toBeNull()
  })

  test('a missing snapshot field is rejected', () => {
    const { activeDays: _dropped, ...missing } = stats()
    expect(parseUsageStatsSnapshot(missing)).toBeNull()
  })

  test('a non-finite number is rejected everywhere it can appear', () => {
    expect(parseUsageStatsSnapshot(stats({ totalTokens: NaN }))).toBeNull()
    expect(parseUsageStatsSnapshot(stats({ cacheHitRate: Infinity }))).toBeNull()
    expect(
      parseUsageStatsSnapshot(
        stats({ dailyModelTokens: [{ date: 'd', tokensByModel: { m: NaN } }] }),
      ),
    ).toBeNull()
    expect(
      parseUsageStatsSnapshot(
        stats({
          modelUsage: {
            m: {
              inputTokens: NaN,
              outputTokens: 0,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 0,
            },
          },
        }),
      ),
    ).toBeNull()
    expect(
      parseUsageStatsSnapshot(
        stats({
          dailyActivity: [
            { date: 'd', messageCount: NaN, sessionCount: 0, toolCallCount: 0 },
          ],
        }),
      ),
    ).toBeNull()
  })

  test('a string where a number belongs is rejected', () => {
    expect(parseUsageStatsSnapshot(stats({ totalSessions: '76' as never }))).toBeNull()
  })

  test('a malformed daily row fails the whole snapshot', () => {
    expect(
      parseUsageStatsSnapshot(
        stats({ dailyModelTokens: [{ date: 'd' } as never] }),
      ),
    ).toBeNull()
  })

  test('non-record input is rejected', () => {
    expect(parseUsageStatsByRange(null)).toBeNull()
    expect(parseUsageStatsByRange([])).toBeNull()
    expect(parseUsageStatsSnapshot('stats')).toBeNull()
  })
})
