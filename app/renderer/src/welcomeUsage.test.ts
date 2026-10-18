import { expect, test } from 'bun:test'
import type { AccountStatus } from '../../shared/protocol.js'
import { selectWelcomeUsageWindows } from './welcomeUsage.js'

function account(overrides: Partial<AccountStatus> = {}): AccountStatus {
  return {
    id: 'acct-1',
    credentialGeneration: 0,
    alias: 'account',
    status: 'healthy',
    statusReason: null,
    availability: 'available',
    availabilityLabel: 'Available',
    isDefault: false,
    hasVaultProfile: true,
    source: 'vault',
    usagePrimary: 20,
    usageWeekly: 30,
    usagePrimaryWindowSeconds: 18_000,
    usageSecondaryWindowSeconds: 604_800,
    usageLimitReached: false,
    usageResetAt: 100,
    usageWeeklyResetAt: 200,
    lastRefreshIso: null,
    lastError: null,
    planType: 'plus',
    switchable: false,
    ...overrides,
  }
}

test('weekly-only primary data resolves to the weekly slot', () => {
  expect(selectWelcomeUsageWindows(account({
    usagePrimary: 37,
    usagePrimaryWindowSeconds: 604_800,
    usageSecondaryWindowSeconds: null,
    usageResetAt: 123,
    usageWeeklyResetAt: null,
  }), 0)).toEqual({
    fiveHour: null,
    weekly: { percent: 37, resetAt: 123 },
  })
})

test('ordinary dual-window data resolves both named slots', () => {
  expect(selectWelcomeUsageWindows(account(), 0)).toEqual({
    fiveHour: { percent: 20, resetAt: 100 },
    weekly: { percent: 30, resetAt: 200 },
  })
})

test('five-hour-only data leaves the weekly slot empty', () => {
  expect(selectWelcomeUsageWindows(account({
    usageWeekly: null,
    usageSecondaryWindowSeconds: null,
    usageWeeklyResetAt: null,
  }), 0)).toEqual({
    fiveHour: { percent: 20, resetAt: 100 },
    weekly: null,
  })
})

test('missing and unsupported duration metadata produces empty slots', () => {
  expect(selectWelcomeUsageWindows(account({
    usagePrimaryWindowSeconds: null,
    usageSecondaryWindowSeconds: 86_400,
  }), 0)).toEqual({ fiveHour: null, weekly: null })
})

test('percent and reset values stay paired, including a null percent', () => {
  expect(selectWelcomeUsageWindows(account({
    usagePrimary: null,
    usageResetAt: 456,
  }), 0)).toEqual({
    fiveHour: { percent: null, resetAt: 456 },
    weekly: { percent: 30, resetAt: 200 },
  })
})

test('reversed dual windows resolve by duration rather than position', () => {
  expect(selectWelcomeUsageWindows(account({
    usagePrimary: 37,
    usagePrimaryWindowSeconds: 604_800,
    usageResetAt: 111,
    usageWeekly: 12,
    usageSecondaryWindowSeconds: 18_000,
    usageWeeklyResetAt: 222,
  }), 0)).toEqual({
    fiveHour: { percent: 12, resetAt: 222 },
    weekly: { percent: 37, resetAt: 111 },
  })
})

test('saved windows expire independently at their reset, without fabricating a new reading', () => {
  const saved = account({ usageStale: true })
  expect(selectWelcomeUsageWindows(saved, 99_999)).toEqual({
    fiveHour: { percent: 20, resetAt: 100 },
    weekly: { percent: 30, resetAt: 200 },
  })
  expect(selectWelcomeUsageWindows(saved, 100_000)).toEqual({
    fiveHour: null, weekly: { percent: 30, resetAt: 200 },
  })
  expect(selectWelcomeUsageWindows(saved, 200_000)).toEqual({
    fiveHour: null, weekly: null,
  })
  expect(selectWelcomeUsageWindows(
    account({ usageStale: true, usageResetAt: null, usageWeeklyResetAt: null }),
    0,
  )).toEqual({ fiveHour: null, weekly: null })
})

test('fresh windows also expire without a new publication', () => {
  expect(selectWelcomeUsageWindows(account(), 100_000)).toEqual({
    fiveHour: null,
    weekly: { percent: 30, resetAt: 200 },
  })
})
