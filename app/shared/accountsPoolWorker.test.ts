import { describe, expect, test } from 'bun:test'

import type { AccountStatus, AccountsSnapshot } from './protocol.js'
import {
  ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
  parseAccountsPoolWorkerResult,
  parseAccountsSnapshot,
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
