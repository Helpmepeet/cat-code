import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  getPoolStatus,
  resetCodexAccountPoolForTest,
  seedCodexAccountPoolForTest,
  type PoolAccount,
} from './codexAccountPool.js'
import {
  _resetAccountDiagnosticStreamJsonHookForTesting,
  installStreamJsonAccountDiagnosticHook,
} from './accountDiagnostics.js'
import {
  buildPoolUsageDisplayAccounts,
  fetchPoolUsage,
  formatPoolUsage,
  invalidateUsageCache,
  sortPoolUsageDisplayAccounts,
  type AccountUsage,
  type PoolUsageSnapshot,
} from './codexUsage.js'

function buildPoolAccount(
  overrides: Partial<PoolAccount> & Pick<PoolAccount, 'accountId'>,
): PoolAccount {
  return {
    accountId: overrides.accountId,
    accessToken: overrides.accessToken ?? `access-${overrides.accountId}`,
    refreshToken: overrides.refreshToken ?? `refresh-${overrides.accountId}`,
    expiresAt: overrides.expiresAt ?? Date.now() + 60_000,
    source: overrides.source ?? 'config',
    status: overrides.status ?? 'healthy',
    lastUsedAt: overrides.lastUsedAt ?? 0,
    alias: overrides.alias,
    lastError: overrides.lastError,
    usagePrimary: overrides.usagePrimary,
    usageWeekly: overrides.usageWeekly,
    usageFetchedAt: overrides.usageFetchedAt,
  }
}

function buildUsage(
  accountId: string,
  primaryUsedPercent: number,
  secondaryUsedPercent: number,
  overrides: Partial<AccountUsage> = {},
): AccountUsage {
  return {
    accountId,
    userId: `user-${accountId}`,
    email: `${accountId}@example.com`,
    planType: 'plus',
    allowed: overrides.allowed ?? true,
    limitReached: overrides.limitReached ?? false,
    primaryWindow: {
      usedPercent: primaryUsedPercent,
      limitWindowSeconds: 18_000,
      resetAfterSeconds: 3_600,
      resetAt: 1_700_000_000,
    },
    secondaryWindow: {
      usedPercent: secondaryUsedPercent,
      limitWindowSeconds: 604_800,
      resetAfterSeconds: 86_400,
      resetAt: 1_700_086_400,
    },
    credits: {
      hasCredits: false,
      unlimited: false,
      balance: '0',
    },
    fetchedAt: Date.now(),
    ...overrides,
  }
}

describe('codexUsage display helpers', () => {
  beforeEach(() => {
    resetCodexAccountPoolForTest()
    _resetAccountDiagnosticStreamJsonHookForTesting()
    invalidateUsageCache()
  })

  afterEach(() => {
    _resetAccountDiagnosticStreamJsonHookForTesting()
    invalidateUsageCache()
  })

  test('keeps pool accounts visible when usage data is missing for some of them', () => {
    const poolAccounts = [
      buildPoolAccount({ accountId: 'main-account', alias: 'main' }),
      buildPoolAccount({ accountId: 'backup-account', alias: 'backup2' }),
      buildPoolAccount({ accountId: 'error-account', alias: 'backup1' }),
    ]
    const snapshot: PoolUsageSnapshot = {
      accounts: [
        buildUsage('main-account', 10, 40),
        buildUsage('backup-account', 100, 0, { allowed: false, limitReached: true }),
      ],
      fetchedAt: Date.now(),
      errors: [
        { accountId: 'error-account', error: 'HTTP 401' },
      ],
    }

    const displayAccounts = buildPoolUsageDisplayAccounts(poolAccounts, snapshot, 0)

    expect(displayAccounts.map((account) => account.alias)).toEqual([
      'main',
      'backup2',
      'backup1',
    ])
    expect(displayAccounts[0]?.isActive).toBe(true)
    expect(displayAccounts[1]?.usage?.limitReached).toBe(true)
    expect(displayAccounts[2]?.usage).toBeNull()
    expect(displayAccounts[2]?.error).toBe('HTTP 401')
  })

  test('sorts healthy usage rows ahead of capped and unavailable rows', () => {
    const displayAccounts = sortPoolUsageDisplayAccounts([
      {
        accountId: 'error-account',
        alias: 'backup1',
        isActive: false,
        status: 'healthy',
        usage: null,
        error: 'HTTP 401',
      },
      {
        accountId: 'capped-account',
        alias: 'backup2',
        isActive: false,
        status: 'capped',
        usage: buildUsage('capped-account', 100, 0, {
          allowed: false,
          limitReached: true,
        }),
        error: null,
      },
      {
        accountId: 'main-account',
        alias: 'main',
        isActive: true,
        status: 'healthy',
        usage: buildUsage('main-account', 10, 40),
        error: null,
      },
    ])

    expect(displayAccounts.map((account) => account.alias)).toEqual([
      'main',
      'backup2',
      'backup1',
    ])
  })

  test('fetchPoolUsage does not mutate account status (observational only)', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({ accountId: 'main-account', alias: 'main' }),
      ],
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          user_id: 'u1',
          email: 'main@example.com',
          plan_type: 'plus',
          rate_limit: {
            allowed: false,
            limit_reached: true,
            primary_window: {
              used_percent: 100,
              limit_window_seconds: 18000,
              reset_after_seconds: 60,
              reset_at: 0,
            },
            secondary_window: {
              used_percent: 0,
              limit_window_seconds: 604800,
              reset_after_seconds: 0,
              reset_at: 0,
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof globalThis.fetch

    invalidateUsageCache()
    try {
      await fetchPoolUsage(true)
    } finally {
      globalThis.fetch = originalFetch
      invalidateUsageCache()
    }

    const status = getPoolStatus()
    expect(status.accounts.find((a) => a.accountId === 'main-account')?.status).toBe(
      'healthy',
    )
  })

  test('fetchPoolUsage does not move pool.activeIndex', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({ accountId: 'main-account', alias: 'main' }),
        buildPoolAccount({ accountId: 'backup-account', alias: 'backup' }),
      ],
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          user_id: 'u',
          email: 'x@example.com',
          plan_type: 'plus',
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: {
              used_percent: 50,
              limit_window_seconds: 18000,
              reset_after_seconds: 60,
              reset_at: 0,
            },
            secondary_window: {
              used_percent: 0,
              limit_window_seconds: 604800,
              reset_after_seconds: 0,
              reset_at: 0,
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof globalThis.fetch

    const beforeIndex = getPoolStatus().activeIndex
    invalidateUsageCache()
    try {
      await fetchPoolUsage(true)
    } finally {
      globalThis.fetch = originalFetch
      invalidateUsageCache()
    }

    expect(getPoolStatus().activeIndex).toBe(beforeIndex)
  })

  test('fetchPoolUsage treats HTTP 401 as observational and does not refresh tokens', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({
          accountId: 'main-account',
          alias: 'main',
          source: 'vault',
          vaultFilePath: '/tmp/main-account.json',
        }),
      ],
    })

    const originalFetch = globalThis.fetch
    let fetchCount = 0
    globalThis.fetch = (async () => {
      fetchCount += 1
      return new Response('unauthorized', { status: 401 })
    }) as unknown as typeof globalThis.fetch

    invalidateUsageCache()
    try {
      const snapshot = await fetchPoolUsage(true)
      expect(snapshot.accounts).toEqual([])
      expect(snapshot.errors).toEqual([
        { accountId: 'main-account', error: 'HTTP 401' },
      ])
    } finally {
      globalThis.fetch = originalFetch
      invalidateUsageCache()
    }

    expect(fetchCount).toBe(1)
    const status = getPoolStatus()
    expect(status.accounts[status.activeIndex]?.accountId).toBe('main-account')
    expect(status.accounts[status.activeIndex]?.status).toBe('healthy')
  })

  test('emits a sanitized usage warning at or above 80 percent and below cap', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'near-cap-account',
      accounts: [
        buildPoolAccount({ accountId: 'near-cap-account', alias: 'primary' }),
      ],
    })
    const emitted: unknown[] = []
    installStreamJsonAccountDiagnosticHook({
      emit: message => {
        emitted.push(message)
      },
      getSessionId: () => 'usage-warning-session',
      createUuid: () => `usage-warning-${emitted.length + 1}`,
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          user_id: 'user-near-cap',
          email: 'near-cap@example.com',
          plan_type: 'plus',
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: {
              used_percent: 80,
              limit_window_seconds: 18000,
              reset_after_seconds: 60,
              reset_at: 0,
            },
            secondary_window: {
              used_percent: 10,
              limit_window_seconds: 604800,
              reset_after_seconds: 0,
              reset_at: 0,
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof globalThis.fetch

    try {
      await fetchPoolUsage(true)
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(emitted).toEqual([
      expect.objectContaining({
        type: 'system',
        subtype: 'cat_code_account_diagnostic',
        code: 'account.usage.warning',
        severity: 'warning',
        provider: 'openai',
        recoverable: true,
        account_ref: 'codex#1',
        counts: {
          total: 1,
          healthy: 1,
          capped: 0,
          dead: 0,
          locked: 0,
        },
      }),
    ])
    expect(JSON.stringify(emitted)).not.toContain('near-cap-account')
    expect(JSON.stringify(emitted)).not.toContain('primary')
    expect(JSON.stringify(emitted)).not.toContain('near-cap@example.com')
  })

  test('does not emit a usage warning below the near-cap threshold', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'below-threshold-account',
      accounts: [
        buildPoolAccount({ accountId: 'below-threshold-account', alias: 'primary' }),
      ],
    })
    const emitted: unknown[] = []
    installStreamJsonAccountDiagnosticHook({
      emit: message => {
        emitted.push(message)
      },
      getSessionId: () => 'usage-warning-session',
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          user_id: 'user-below-threshold',
          email: 'below-threshold@example.com',
          plan_type: 'plus',
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: {
              used_percent: 79,
              limit_window_seconds: 18000,
              reset_after_seconds: 60,
              reset_at: 0,
            },
            secondary_window: {
              used_percent: 10,
              limit_window_seconds: 604800,
              reset_after_seconds: 0,
              reset_at: 0,
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof globalThis.fetch

    try {
      await fetchPoolUsage(true)
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(emitted).toEqual([])
  })

  test('does not emit a usage warning when the account is already capped', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'capped-account',
      accounts: [
        buildPoolAccount({
          accountId: 'capped-account',
          alias: 'primary',
          status: 'capped',
        }),
      ],
    })
    const emitted: unknown[] = []
    installStreamJsonAccountDiagnosticHook({
      emit: message => {
        emitted.push(message)
      },
      getSessionId: () => 'usage-warning-session',
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          user_id: 'user-capped',
          email: 'capped@example.com',
          plan_type: 'plus',
          rate_limit: {
            allowed: false,
            limit_reached: true,
            primary_window: {
              used_percent: 100,
              limit_window_seconds: 18000,
              reset_after_seconds: 60,
              reset_at: 0,
            },
            secondary_window: {
              used_percent: 10,
              limit_window_seconds: 604800,
              reset_after_seconds: 0,
              reset_at: 0,
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof globalThis.fetch

    try {
      await fetchPoolUsage(true)
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(emitted).toEqual([])
  })

  test('formats unavailable accounts instead of dropping them from /accounts', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({ accountId: 'main-account', alias: 'main' }),
        buildPoolAccount({ accountId: 'backup-account', alias: 'backup2', status: 'capped' }),
        buildPoolAccount({ accountId: 'error-account', alias: 'backup1' }),
      ],
    })

    const output = formatPoolUsage({
      accounts: [
        buildUsage('main-account', 10, 40),
        buildUsage('backup-account', 100, 0, { allowed: false, limitReached: true }),
      ],
      fetchedAt: Date.now(),
      errors: [
        { accountId: 'error-account', error: 'HTTP 401' },
      ],
    })

    expect(output).toContain('● main')
    expect(output).toContain('  backup2  [capped]')
    expect(output).toContain('  backup1  [usage unavailable]')
    expect(output).toContain('usage      unavailable (HTTP 401)')
    expect(output).toContain('3 accounts, 1 available, 1 capped, 1 unavailable')
  })
})
