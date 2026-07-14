import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import {
  resetCodexAccountPoolForTest,
  seedCodexAccountPoolForTest,
  type PoolAccount,
} from './codexAccountPool.js'
import { buildCodexStatus } from './codexStatus.js'
import type { AccountUsage, FetchPoolUsageOptions, PoolUsageSnapshot } from './codexUsage.js'

// Fixed wall-clock reference for availability/reset math (real timestamps in the
// output still use the real clock; only `now` is injected).
const NOW = 1_700_000_000_000 // ms
const FUTURE_RESET_SEC = NOW / 1000 + 3600 // 1h out, in Unix seconds

function buildPoolAccount(
  overrides: Partial<PoolAccount> & Pick<PoolAccount, 'accountId'>,
): PoolAccount {
  return {
    accountId: overrides.accountId,
    accessToken: overrides.accessToken ?? `access-${overrides.accountId}`,
    refreshToken: overrides.refreshToken ?? `refresh-${overrides.accountId}`,
    expiresAt: overrides.expiresAt ?? NOW + 60_000,
    source: overrides.source ?? 'config',
    status: overrides.status ?? 'healthy',
    lastUsedAt: overrides.lastUsedAt ?? 0,
    alias: overrides.alias,
    lastError: overrides.lastError,
    usagePrimary: overrides.usagePrimary,
    usageWeekly: overrides.usageWeekly,
    usageFetchedAt: overrides.usageFetchedAt,
    usageAllowed: overrides.usageAllowed,
    usageLimitReached: overrides.usageLimitReached,
    usageResetAt: overrides.usageResetAt,
    cappedAt: overrides.cappedAt,
    lastErrorAt: overrides.lastErrorAt,
    statusReason: overrides.statusReason,
    planType: overrides.planType,
    planExpiresAt: overrides.planExpiresAt,
    lastRefreshIso: overrides.lastRefreshIso,
    vaultFilePath: overrides.vaultFilePath,
    redeemedAt: overrides.redeemedAt,
  }
}

function buildUsage(overrides: Partial<AccountUsage> & Pick<AccountUsage, 'accountId'>): AccountUsage {
  return {
    accountId: overrides.accountId,
    userId: overrides.userId ?? 'user-id',
    email: overrides.email ?? 'someone@example.com',
    planType: overrides.planType ?? 'plus',
    allowed: overrides.allowed ?? true,
    limitReached: overrides.limitReached ?? false,
    primaryWindow: overrides.primaryWindow ?? {
      usedPercent: 10,
      limitWindowSeconds: 18_000,
      resetAfterSeconds: 3600,
      resetAt: FUTURE_RESET_SEC,
    },
    secondaryWindow: overrides.secondaryWindow ?? {
      usedPercent: 20,
      limitWindowSeconds: 604_800,
      resetAfterSeconds: 200_000,
      resetAt: FUTURE_RESET_SEC + 100_000,
    },
    hasSecondaryWindow: overrides.hasSecondaryWindow ?? true,
    credits: overrides.credits ?? { hasCredits: false, unlimited: false, balance: '0' },
    resetCreditsAvailable: overrides.resetCreditsAvailable,
    fetchedAt: overrides.fetchedAt ?? Date.now(),
  }
}

/** A live-poll snapshot fetcher: fetchedAt in the present → usage_refresh 'live'. */
function liveSnapshot(accounts: AccountUsage[]): (o: FetchPoolUsageOptions) => Promise<PoolUsageSnapshot> {
  return mock(async () => ({ accounts, fetchedAt: Date.now(), errors: [] }))
}

beforeEach(() => {
  resetCodexAccountPoolForTest()
})

describe('buildCodexStatus', () => {
  test('(1) fresh candidate → delegate (live usage)', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'acct-alpha',
      accounts: [buildPoolAccount({ accountId: 'acct-alpha' })],
    })

    const status = await buildCodexStatus({
      now: NOW,
      refresh: 'auto',
      loadPool: false,
      fetchUsage: liveSnapshot([buildUsage({ accountId: 'acct-alpha' })]),
    })

    expect(status.ok).toBe(true)
    expect(status.decision.action).toBe('delegate')
    expect(status.decision.reason_code).toBe('candidate_available')
    expect(status.observation.usage_refresh).toBe('live')
    expect(status.pool.candidate).toBe(1)
    expect(status.pool.profiles_total).toBe(1)
    expect(status.profiles[0]!.routing_state).toBe('candidate')
    expect(status.profiles[0]!.block_code).toBeNull()
    expect(status.profiles[0]!.usage.freshness).toBe('live')
    expect(status.decision.predicted_initial_profile_ref).toBe(
      status.profiles[0]!.profile_ref,
    )
  })

  test('(2) all capped WITH reset → wait, not_before + earliest_known_reset_at set', async () => {
    seedCodexAccountPoolForTest({
      accounts: [
        buildPoolAccount({
          accountId: 'acct-a',
          status: 'capped',
          statusReason: 'usage_cap',
          cappedAt: NOW - 1000,
          usageResetAt: FUTURE_RESET_SEC,
        }),
        buildPoolAccount({
          accountId: 'acct-b',
          status: 'capped',
          statusReason: 'usage_cap',
          cappedAt: NOW - 1000,
          usageResetAt: FUTURE_RESET_SEC + 7200,
        }),
      ],
    })

    const status = await buildCodexStatus({ now: NOW, refresh: 'never', loadPool: false })

    expect(status.ok).toBe(true)
    expect(status.decision.action).toBe('wait')
    expect(status.decision.reason_code).toBe('quota_blocked_reset_known')
    expect(status.pool.candidate).toBe(0)
    expect(status.pool.quota_blocked).toBe(2)
    expect(status.observation.usage_refresh).toBe('none')

    const expectedReset = new Date(FUTURE_RESET_SEC * 1000).toISOString()
    expect(status.pool.earliest_known_reset_at).toBe(expectedReset)
    expect(status.decision.not_before).toBe(expectedReset)
    expect(status.profiles.every((p) => p.routing_state === 'quota_blocked')).toBe(true)
    expect(status.profiles.every((p) => p.block_code === 'usage_cap')).toBe(true)
  })

  test('(3) all capped with NO credible reset → recheck', async () => {
    seedCodexAccountPoolForTest({
      accounts: [
        buildPoolAccount({
          accountId: 'acct-a',
          status: 'capped',
          statusReason: 'usage_cap',
          cappedAt: NOW - 1000,
          usageResetAt: 0,
        }),
      ],
    })

    const status = await buildCodexStatus({ now: NOW, refresh: 'never', loadPool: false })

    expect(status.decision.action).toBe('recheck')
    expect(status.decision.reason_code).toBe('quota_blocked_no_reset')
    expect(status.decision.not_before).toBeNull()
    expect(status.pool.earliest_known_reset_at).toBeNull()
    expect(status.pool.quota_blocked).toBe(1)
  })

  test('hard cap ignores reset evidence older than cappedAt', async () => {
    seedCodexAccountPoolForTest({
      accounts: [
        buildPoolAccount({
          accountId: 'acct-stale-reset',
          status: 'capped',
          statusReason: 'usage_cap',
          cappedAt: NOW,
          usageResetAt: NOW / 1000 - 60,
        }),
      ],
    })

    const result = await buildCodexStatus({ now: NOW, refresh: 'never', loadPool: false })
    expect(result.decision.action).toBe('recheck')
    expect(result.decision.not_before).toBeNull()
  })

  test('(4) transient/unknown observation → attempt', async () => {
    seedCodexAccountPoolForTest({
      accounts: [
        buildPoolAccount({
          accountId: 'acct-a',
          status: 'quarantined',
          statusReason: 'probe_pending_transport',
          lastError: 'connection problem; retrying',
        }),
      ],
    })

    const status = await buildCodexStatus({ now: NOW, refresh: 'never', loadPool: false })

    expect(status.decision.action).toBe('attempt')
    expect(status.decision.reason_code).toBe('observation_uncertain')
    expect(status.pool.transient_blocked).toBe(1)
    expect(status.pool.candidate).toBe(0)
    expect(status.profiles[0]!.routing_state).toBe('transient_blocked')
    expect(status.profiles[0]!.block_code).toBe('probe_pending_transport')
  })

  test('(5) zero accounts → human_recovery, ok:true (exit-0-worthy)', async () => {
    seedCodexAccountPoolForTest({ accounts: [] })

    const status = await buildCodexStatus({ now: NOW, refresh: 'never', loadPool: false })

    expect(status.ok).toBe(true)
    expect(status.decision.action).toBe('human_recovery')
    expect(status.decision.reason_code).toBe('no_accounts')
    expect(status.pool.profiles_total).toBe(0)
    expect(status.profiles).toEqual([])
    expect(status.decision.predicted_initial_profile_ref).toBeNull()
    expect(status.decision.best_observed_candidate_profile_ref).toBeNull()
  })

  test('(6) opacity: no raw ids/aliases/tokens/paths/errors; profile_ref is opaque', async () => {
    const secrets = [
      'acct-SECRET-9999',
      'topsecretalias',
      'TOKEN-SECRET-xyz',
      'REFRESH-SECRET',
      '/Users/victim/codex-vault/acct.json',
      'raw boom error 42.99.11',
      'leak@example.com',
    ]

    seedCodexAccountPoolForTest({
      activeAccountId: 'acct-SECRET-9999',
      accounts: [
        buildPoolAccount({
          accountId: 'acct-SECRET-9999',
          alias: 'topsecretalias',
          accessToken: 'TOKEN-SECRET-xyz',
          refreshToken: 'REFRESH-SECRET',
          vaultFilePath: '/Users/victim/codex-vault/acct.json',
        }),
        buildPoolAccount({
          accountId: 'acct-dead',
          status: 'dead',
          statusReason: 'auth_dead',
          lastError: 'raw boom error 42.99.11',
        }),
      ],
    })

    const status = await buildCodexStatus({
      now: NOW,
      refresh: 'auto',
      loadPool: false,
      // email present in the usage snapshot must never surface in output.
      fetchUsage: liveSnapshot([
        buildUsage({ accountId: 'acct-SECRET-9999', email: 'leak@example.com' }),
      ]),
    })

    const serialized = JSON.stringify(status)
    for (const secret of secrets) {
      expect(serialized).not.toContain(secret)
    }
    expect(status.profiles.length).toBe(2)
    for (const profile of status.profiles) {
      expect(profile.profile_ref).toMatch(/^cp_[0-9a-f]{4}$/)
    }
  })

  test('(7) refresh:never performs NO fetch (usage fetcher and global fetch untouched)', async () => {
    seedCodexAccountPoolForTest({
      accounts: [buildPoolAccount({ accountId: 'acct-a' })],
    })

    const fetchUsageSpy = mock(async () => ({ accounts: [], fetchedAt: Date.now(), errors: [] }))
    const originalFetch = globalThis.fetch
    const globalFetchSpy = mock(async () => {
      throw new Error('network must not be touched in refresh:never')
    })
    globalThis.fetch = globalFetchSpy as unknown as typeof fetch

    try {
      const status = await buildCodexStatus({
        now: NOW,
        refresh: 'never',
        loadPool: false,
        fetchUsage: fetchUsageSpy,
      })
      expect(status.observation.usage_refresh).toBe('none')
      expect(fetchUsageSpy.mock.calls.length).toBe(0)
      expect(globalFetchSpy.mock.calls.length).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('(8) predicted (persisted-active) differs from best (LRU/usage-ranked) candidate', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'acct-active-busy',
      accounts: [
        buildPoolAccount({
          accountId: 'acct-active-busy',
          usagePrimary: 90,
          usageWeekly: 90,
          usageAllowed: true,
          usageLimitReached: false,
          usageFetchedAt: NOW,
        }),
        buildPoolAccount({
          accountId: 'acct-idle-best',
          usagePrimary: 5,
          usageWeekly: 5,
          usageAllowed: true,
          usageLimitReached: false,
          usageFetchedAt: NOW,
        }),
      ],
    })

    const status = await buildCodexStatus({ now: NOW, refresh: 'never', loadPool: false })

    const byActive = status.profiles.find((p) => p.is_persisted_active)!
    const busy = status.profiles.find((p) => p.usage.primary.used_percent === 90)!
    const idle = status.profiles.find((p) => p.usage.primary.used_percent === 5)!

    expect(byActive.profile_ref).toBe(busy.profile_ref)
    expect(status.decision.predicted_initial_profile_ref).toBe(busy.profile_ref)
    expect(status.decision.best_observed_candidate_profile_ref).toBe(idle.profile_ref)
    expect(status.decision.predicted_initial_profile_ref).not.toBe(
      status.decision.best_observed_candidate_profile_ref,
    )
  })
})

afterEach(() => {
  resetCodexAccountPoolForTest()
})
