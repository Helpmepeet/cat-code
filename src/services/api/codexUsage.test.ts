import { beforeEach, describe, expect, test } from 'bun:test'

import {
  resetCodexAccountPoolForTest,
  seedCodexAccountPoolForTest,
  type PoolAccount,
} from './codexAccountPool.js'
import {
  buildPoolUsageDisplayAccounts,
  formatPoolUsage,
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
    turnsUsed: overrides.turnsUsed ?? 0,
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
