import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { APIConnectionError } from '@anthropic-ai/sdk'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { setSessionProvider } from '../../bootstrap/state.js'
import { getGlobalConfig } from '../../utils/config.js'
import { clearCodexOAuthTokens, saveCodexOAuthTokens } from '../../utils/auth.js'
import { SettingsSchema } from '../../utils/settings/types.js'
import { getRetryOwnerId } from './claude.js'
import {
  _markStickyHttpFallbackForTest,
  createCodexFetch,
  CodexAccountAuthError,
  CodexAccountCapError,
  CodexResponseFailedError,
  resetCodexCacheContext,
} from './codex-fetch-adapter.js'
import { resolveCodexOAuthTokensForLeaseOwner } from './client.js'
import { classifyAPIError } from './errors.js'
import {
  getPoolStatus,
  markPoolAccountLastError,
  resetCodexAccountPoolForTest,
  seedCodexAccountPoolForTest,
} from './codexAccountPool.js'
import type { PoolAccount } from './codexAccountPool.js'
import { fetchPoolUsage, invalidateUsageCache } from './codexUsage.js'
import {
  CannotRetryError,
  _resetCodexNetworkOutageDelaysForTest,
  _setCodexNetworkOutageDelaysForTest,
  withRetry,
} from './withRetry.js'
import { _resetKeepAliveForTesting } from '../../utils/proxy.js'
import {
  _resetAccountDiagnosticStreamJsonHookForTesting,
  installStreamJsonAccountDiagnosticHook,
} from './accountDiagnostics.js'

function buildCodexToken(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
    'base64url',
  )
  const payload = Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': {
        chatgpt_account_id: accountId,
      },
    }),
  ).toString('base64url')
  return `${header}.${payload}.signature`
}

function buildPoolAccount(
  overrides: Partial<PoolAccount> & Pick<PoolAccount, 'accountId'>,
): PoolAccount {
  return {
    accountId: overrides.accountId,
    accessToken: overrides.accessToken ?? buildCodexToken(overrides.accountId),
    refreshToken: overrides.refreshToken ?? `refresh-${overrides.accountId}`,
    expiresAt: overrides.expiresAt ?? Date.now() + 5 * 60_000,
    source: overrides.source ?? 'config',
    status: overrides.status ?? 'healthy',
    statusReason: overrides.statusReason,
    lastUsedAt: overrides.lastUsedAt ?? 0,
    alias: overrides.alias,
    lastError: overrides.lastError,
    usagePrimary: overrides.usagePrimary,
    usageWeekly: overrides.usageWeekly,
    usageAllowed: overrides.usageAllowed,
    usageLimitReached: overrides.usageLimitReached,
    usageFetchedAt:
      'usageFetchedAt' in overrides ? overrides.usageFetchedAt : Date.now(),
    planType: overrides.planType,
    planExpiresAt: overrides.planExpiresAt,
  }
}

function codexCompletedStreamResponse(): Response {
  return new Response(
    [
      'event: response.output_text.delta',
      `data: ${JSON.stringify({
        type: 'response.output_text.delta',
        delta: 'ok',
      })}`,
      '',
      'event: response.completed',
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_test',
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            input_tokens_details: { cached_tokens: 0 },
          },
        },
      })}`,
      '',
    ].join('\n'),
    {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    },
  )
}

describe('codexAccountLeaseManager', () => {
  let moduleUnderTest: typeof import('./codexAccountLeaseManager.js')

  beforeEach(async () => {
    moduleUnderTest = await import('./codexAccountLeaseManager.js')
    setSessionProvider(null)
    resetCodexAccountPoolForTest()
    invalidateUsageCache()
    moduleUnderTest.resetCodexLeaseManagerForTest()
    _resetAccountDiagnosticStreamJsonHookForTesting()
  })

  afterEach(() => {
    _resetCodexNetworkOutageDelaysForTest()
    _resetKeepAliveForTesting()
    clearCodexOAuthTokens()
  })

  function createLeaseAwareCodexFetch(
    accessToken: string,
    conversationIdOverride?: string,
  ): ReturnType<typeof createCodexFetch> {
    return createCodexFetch(accessToken, conversationIdOverride, {
      resolveTokensForRequest: () => {
        const lease = moduleUnderTest.getCurrentCodexLease()
        return resolveCodexOAuthTokensForLeaseOwner({
          codexLeaseOwnerId: lease?.ownerId,
          codexLeaseOwnerType: lease?.ownerType,
        })
      },
    })
  }

  test('stores leases and accepts follow-main strategy settings', () => {
    const settingsResult = SettingsSchema().safeParse({
      codexSubagentAccountStrategy: 'follow-main',
    })

    expect(settingsResult.success).toBe(true)
    if (!settingsResult.success) {
      throw new Error('Expected follow-main strategy to be accepted')
    }
    expect(settingsResult.data.codexSubagentAccountStrategy).toBe('follow-main')

    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({
          accountId: 'main-account',
          alias: 'main',
        }),
      ],
    })

    const lease = moduleUnderTest.createCodexLeaseForTest({
      ownerId: 'subagent-1',
      ownerType: 'subagent',
      ownerLabel: 'Subagent 1',
    })

    expect(lease.ownerId).toBe('subagent-1')
    expect(lease.ownerType).toBe('subagent')
    expect(lease.ownerLabel).toBe('Subagent 1')
    expect(lease.accountId).toBe('main-account')
    expect(lease.strategy).toBe('spread')
    expect(lease.state).toBe('active')
    expect(lease.failoverCount).toBe(0)
    expect(typeof lease.createdAt).toBe('number')
    expect(typeof lease.updatedAt).toBe('number')
    expect(lease.createdAt).toBe(lease.updatedAt)
    expect(lease.leaseId).toBe('subagent-1')

    expect(moduleUnderTest.getCodexLeaseSnapshotForTest()).toEqual({
      leases: [lease],
    })

    moduleUnderTest.resetCodexLeaseManagerForTest()
    expect(moduleUnderTest.getCodexLeaseSnapshotForTest()).toEqual({
      leases: [],
    })
  })

  test('spread prefers the least crowded healthy account and deprioritizes the main account', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({
          accountId: 'main-account',
          alias: 'main',
          usagePrimary: 0,
          usageWeekly: 0,
          lastUsedAt: 10,
        }),
        buildPoolAccount({
          accountId: 'worker-a',
          usagePrimary: 10,
          usageWeekly: 5,
          lastUsedAt: 20,
        }),
        buildPoolAccount({
          accountId: 'worker-b',
          usagePrimary: 10,
          usageWeekly: 5,
          lastUsedAt: 30,
        }),
      ],
    })

    moduleUnderTest.seedCodexLeaseForTest({
      ownerId: 'existing-subagent',
      ownerType: 'subagent',
      ownerLabel: 'Existing Subagent',
      accountId: 'worker-a',
    })

    const lease = moduleUnderTest.createCodexLeaseForTest({
      ownerId: 'new-subagent',
      ownerType: 'subagent',
      ownerLabel: 'New Subagent',
    })

    expect(lease.accountId).toBe('worker-b')
    expect(lease.selectionReason).toBe('spread selected least crowded healthy account')
  })

  test('lease acquisition excludes capped and dead accounts before first request', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({
          accountId: 'main-account',
          alias: 'main',
          status: 'capped',
        }),
        buildPoolAccount({
          accountId: 'dead-account',
          status: 'dead',
          lastError: 'refresh failed',
        }),
        buildPoolAccount({
          accountId: 'healthy-account',
          usagePrimary: 40,
          usageWeekly: 10,
        }),
      ],
    })

    const lease = moduleUnderTest.createCodexLeaseForTest({
      ownerId: 'subagent-healthy',
      ownerType: 'subagent',
      ownerLabel: 'Healthy pick',
    })

    expect(lease.accountId).toBe('healthy-account')

    moduleUnderTest.resetCodexLeaseManagerForTest()
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({
          accountId: 'main-account',
          alias: 'main',
          status: 'capped',
        }),
        buildPoolAccount({
          accountId: 'dead-account',
          status: 'dead',
        }),
      ],
    })

    expect(() =>
      moduleUnderTest.createCodexLeaseForTest({
        ownerId: 'subagent-none-left',
        ownerType: 'subagent',
        ownerLabel: 'No account left',
      }),
    ).toThrow('All Codex accounts are capped or unavailable')
  })

  test('main-thread lease skips a blocked active account', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'active-capped',
      accounts: [
        buildPoolAccount({
          accountId: 'active-capped',
          alias: 'active',
          usageAllowed: false,
          usageLimitReached: true,
          usageFetchedAt: Date.now(),
        }),
        buildPoolAccount({ accountId: 'backup-clean', alias: 'backup' }),
      ],
    })

    const lease = moduleUnderTest.createCodexLeaseForTest({
      ownerId: 'main-thread',
      ownerType: 'main',
      ownerLabel: 'main thread',
    })

    expect(lease.accountId).toBe('backup-clean')
  })

  test('token resolution falls back when the leased account is blocked', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'backup-clean',
      accounts: [
        buildPoolAccount({
          accountId: 'leased-capped',
          alias: 'leased',
          status: 'capped',
          statusReason: 'usage_cap',
          lastError: 'Usage cap hit (429)',
        }),
        buildPoolAccount({ accountId: 'backup-clean', alias: 'backup' }),
      ],
    })
    moduleUnderTest.seedCodexLeaseForTest({
      ownerId: 'main-thread',
      ownerType: 'main',
      ownerLabel: 'Main thread',
      accountId: 'leased-capped',
      strategy: 'follow-main',
    })

    const tokens = await resolveCodexOAuthTokensForLeaseOwner({
      codexLeaseOwnerType: 'main',
    })

    expect(tokens?.accountId).toBe('backup-clean')
    expect(moduleUnderTest.getCodexLeaseForOwner('main-thread')?.accountId).toBe(
      'backup-clean',
    )
  })

  test('single-account token resolution prefers pool token over stale config token', async () => {
    saveCodexOAuthTokens({
      accessToken: buildCodexToken('solo-account'),
      refreshToken: 'stale-refresh',
      expiresAt: Date.now() + 5 * 60_000,
      accountId: 'solo-account',
    })
    const liveAccessToken = `${buildCodexToken('solo-account')}.live`
    seedCodexAccountPoolForTest({
      activeAccountId: 'solo-account',
      accounts: [
        buildPoolAccount({
          accountId: 'solo-account',
          accessToken: liveAccessToken,
          refreshToken: 'live-refresh',
          source: 'vault',
        }),
      ],
    })

    const tokens = await resolveCodexOAuthTokensForLeaseOwner({
      codexLeaseOwnerType: 'main',
    })

    expect(tokens?.source).toBe('pool')
    expect(tokens?.accessToken).toBe(liveAccessToken)
    expect(tokens?.refreshToken).toBe('live-refresh')
  })

  test('single vault account without config entry resolves through the pool', async () => {
    clearCodexOAuthTokens()
    const liveAccessToken = buildCodexToken('vault-only')
    seedCodexAccountPoolForTest({
      activeAccountId: 'vault-only',
      accounts: [
        buildPoolAccount({
          accountId: 'vault-only',
          accessToken: liveAccessToken,
          refreshToken: 'vault-refresh',
          source: 'vault',
        }),
      ],
    })

    const tokens = await resolveCodexOAuthTokensForLeaseOwner({
      codexLeaseOwnerType: 'main',
    })

    expect(tokens).toMatchObject({
      accountId: 'vault-only',
      accessToken: liveAccessToken,
      refreshToken: 'vault-refresh',
      source: 'pool',
    })
  })


  test('config-only Codex fallback still resolves when the pool has no accounts', async () => {
    resetCodexAccountPoolForTest()
    saveCodexOAuthTokens({
      accessToken: buildCodexToken('config-only'),
      refreshToken: 'config-refresh',
      expiresAt: Date.now() + 5 * 60_000,
      accountId: 'config-only',
    })

    const tokens = await resolveCodexOAuthTokensForLeaseOwner({
      codexLeaseOwnerType: 'main',
    })

    expect(tokens).toMatchObject({
      accountId: 'config-only',
      refreshToken: 'config-refresh',
      source: 'config',
    })
  })

  test('spread lease prefers a clean account over a warned one', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'warned-account',
      accounts: [
        buildPoolAccount({
          accountId: 'warned-account',
          alias: 'warned',
          planType: 'plus',
          planExpiresAt: '2020-01-01T00:00:00.000Z',
        }),
        buildPoolAccount({ accountId: 'clean-account', alias: 'clean' }),
      ],
    })

    const lease = moduleUnderTest.createCodexLeaseForTest({
      ownerId: 'agent-1',
      ownerType: 'subagent',
      ownerLabel: 'agent 1',
      strategy: 'spread',
    })

    expect(lease.accountId).toBe('clean-account')
  })

  test('spread lease uses a warned account when no clean account exists', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'warned-account',
      accounts: [
        buildPoolAccount({
          accountId: 'warned-account',
          alias: 'warned',
          planType: 'plus',
          planExpiresAt: '2020-01-01T00:00:00.000Z',
        }),
      ],
    })

    const lease = moduleUnderTest.createCodexLeaseForTest({
      ownerId: 'agent-2',
      ownerType: 'subagent',
      ownerLabel: 'agent 2',
      strategy: 'spread',
    })

    expect(lease.accountId).toBe('warned-account')
  })

  test('follow-main chooses the healthy main account directly', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({
          accountId: 'main-account',
          alias: 'main',
          lastUsedAt: 100,
          usagePrimary: 90,
          usageWeekly: 90,
        }),
        buildPoolAccount({
          accountId: 'worker-a',
          lastUsedAt: 0,
          usagePrimary: 0,
          usageWeekly: 0,
        }),
      ],
    })

    const lease = moduleUnderTest.createCodexLeaseForTest({
      ownerId: 'follow-main-healthy',
      ownerType: 'subagent',
      ownerLabel: 'Follow main healthy',
      strategy: 'follow-main',
    })

    expect(lease.accountId).toBe('main-account')
    expect(lease.selectionReason).toBe('follow-main selected main account')
  })

  test('follow-main falls back to the best healthy account when main is unhealthy', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({
          accountId: 'main-account',
          alias: 'main',
          status: 'capped',
          lastUsedAt: 0,
          usagePrimary: 0,
          usageWeekly: 0,
        }),
        buildPoolAccount({
          accountId: 'worker-a',
          lastUsedAt: 100,
          usagePrimary: 20,
          usageWeekly: 10,
        }),
        buildPoolAccount({
          accountId: 'worker-b',
          lastUsedAt: 200,
          usagePrimary: 40,
          usageWeekly: 20,
        }),
      ],
    })

    const lease = moduleUnderTest.createCodexLeaseForTest({
      ownerId: 'follow-main-fallback',
      ownerType: 'subagent',
      ownerLabel: 'Follow main fallback',
      strategy: 'follow-main',
    })

    expect(lease.accountId).toBe('worker-a')
    expect(lease.selectionReason).toBe('follow-main selected best healthy account')
  })

  test('released leases are removed and no longer count against future selections', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({
          accountId: 'main-account',
          alias: 'main',
          usagePrimary: 5,
          usageWeekly: 5,
          lastUsedAt: 0,
        }),
        buildPoolAccount({
          accountId: 'worker-a',
          usagePrimary: 10,
          usageWeekly: 5,
          lastUsedAt: 100,
        }),
      ],
    })

    const releasedLease = moduleUnderTest.createCodexLeaseForTest({
      ownerId: 'release-me',
      ownerType: 'subagent',
      ownerLabel: 'Release me',
    })
    const retainedLease = moduleUnderTest.createCodexLeaseForTest({
      ownerId: 'stay-put',
      ownerType: 'subagent',
      ownerLabel: 'Stay put',
    })

    moduleUnderTest.releaseCodexLease('release-me')

    expect(moduleUnderTest.getCodexLeaseSnapshotForTest()).toEqual({
      leases: [retainedLease],
    })

    const replacementLease = moduleUnderTest.createCodexLeaseForTest({
      ownerId: 'replacement',
      ownerType: 'subagent',
      ownerLabel: 'Replacement',
    })

    expect(releasedLease.accountId).toBe('worker-a')
    expect(retainedLease.accountId).toBe('main-account')
    expect(replacementLease.accountId).toBe('worker-a')
  })

  test('failover reassigns only the failed lease and preserves other active leases', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({
          accountId: 'main-account',
          alias: 'main',
          usagePrimary: 0,
          usageWeekly: 0,
          lastUsedAt: 0,
        }),
        buildPoolAccount({
          accountId: 'worker-a',
          usagePrimary: 10,
          usageWeekly: 5,
          lastUsedAt: 100,
        }),
      ],
    })

    const failedLease = moduleUnderTest.createCodexLeaseForTest({
      ownerId: 'subagent-failing',
      ownerType: 'subagent',
      ownerLabel: 'Subagent Failing',
    })
    const untouchedLease = moduleUnderTest.createCodexLeaseForTest({
      ownerId: 'subagent-stable',
      ownerType: 'subagent',
      ownerLabel: 'Subagent Stable',
    })

    const replacementLease = moduleUnderTest.failoverCodexLease(
      'subagent-failing',
      failedLease.accountId,
      'usage cap 429',
    )

    expect(replacementLease.ownerId).toBe('subagent-failing')
    expect(replacementLease.accountId).toBe('main-account')
    expect(replacementLease.failoverCount).toBe(1)
    expect(replacementLease.state).toBe('active')
    expect(replacementLease.lastFailureReason).toBe('usage cap 429')
    expect(replacementLease.updatedAt).toBeGreaterThanOrEqual(failedLease.updatedAt)

    const snapshot = moduleUnderTest.getCodexLeaseSnapshotForTest()
    expect(snapshot.leases).toHaveLength(2)
    expect(snapshot.leases.find((lease) => lease.ownerId === 'subagent-stable')).toEqual(
      untouchedLease,
    )
    expect(snapshot.leases.find((lease) => lease.ownerId === 'subagent-failing'))
      .toMatchObject({
        accountId: 'main-account',
        failoverCount: 1,
        lastFailureReason: 'usage cap 429',
      })

    expect(
      getPoolStatus().accounts.find((account) => account.accountId === failedLease.accountId),
    ).toMatchObject({
      status: 'capped',
      lastError: 'usage cap 429',
    })
  })

  test('failover keeps the failed lease marked failed when no replacement account exists', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'worker-a',
      accounts: [
        buildPoolAccount({
          accountId: 'worker-a',
          usagePrimary: 95,
          usageWeekly: 90,
        }),
      ],
    })

    const failedLease = moduleUnderTest.createCodexLeaseForTest({
      ownerId: 'single-subagent',
      ownerType: 'subagent',
      ownerLabel: 'Single Subagent',
    })

    expect(() =>
      moduleUnderTest.failoverCodexLease(
        'single-subagent',
        failedLease.accountId,
        'all accounts capped',
      ),
    ).toThrow('All Codex accounts are capped or unavailable')

    const failedSnapshot = moduleUnderTest.getCodexLeaseSnapshotForTest()
    expect(failedSnapshot.leases).toHaveLength(1)
    expect(failedSnapshot.leases[0]).toMatchObject({
      ownerId: 'single-subagent',
      accountId: 'worker-a',
      state: 'failed',
      failoverCount: 1,
      lastFailureReason: 'all accounts capped',
    })

    expect(
      getPoolStatus().accounts.find((account) => account.accountId === 'worker-a'),
    ).toMatchObject({
      status: 'capped',
      lastError: 'all accounts capped',
    })
  })

  test('failover rejects mismatched failed account ids without mutating lease state', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({
          accountId: 'main-account',
          alias: 'main',
          usagePrimary: 0,
          usageWeekly: 0,
          lastUsedAt: 0,
        }),
        buildPoolAccount({
          accountId: 'worker-a',
          usagePrimary: 10,
          usageWeekly: 5,
          lastUsedAt: 100,
        }),
      ],
    })

    const currentLease = moduleUnderTest.createCodexLeaseForTest({
      ownerId: 'subagent-failing',
      ownerType: 'subagent',
      ownerLabel: 'Subagent Failing',
    })
    const snapshotBefore = moduleUnderTest.getCodexLeaseSnapshotForTest()
    const poolBefore = getPoolStatus()
    const wrongAccountId =
      currentLease.accountId === 'worker-a' ? 'main-account' : 'worker-a'

    expect(() =>
      moduleUnderTest.failoverCodexLease(
        'subagent-failing',
        wrongAccountId,
        'wrong account id should fail',
      ),
    ).toThrow(
      `Codex lease for owner subagent-failing is on account ${currentLease.accountId}, not ${wrongAccountId}`,
    )

    expect(moduleUnderTest.getCodexLeaseSnapshotForTest()).toEqual(snapshotBefore)
    expect(getPoolStatus()).toEqual(poolBefore)
  })

  test('usage refresh blocks route selection without mutating account status', async () => {
    const realFetch = globalThis.fetch
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({
          accountId: 'main-account',
          alias: 'main',
        }),
        buildPoolAccount({
          accountId: 'worker-a',
        }),
      ],
    })

    globalThis.fetch = (async (_input, init) => {
      const authHeader = new Headers(init?.headers).get('Authorization')
      if (authHeader === `Bearer ${buildCodexToken('main-account')}`) {
        return new Response(
          JSON.stringify({
            user_id: 'user-main',
            email: 'main@example.com',
            plan_type: 'pro',
            rate_limit: {
              allowed: false,
              limit_reached: true,
              primary_window: {
                used_percent: 100,
                limit_window_seconds: 18000,
                reset_after_seconds: 60,
                reset_at: Date.now() + 60_000,
              },
              secondary_window: {
                used_percent: 100,
                limit_window_seconds: 604800,
                reset_after_seconds: 3600,
                reset_at: Date.now() + 3_600_000,
              },
            },
            credits: {
              has_credits: false,
              unlimited: false,
              balance: '0',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }

      return new Response(
        JSON.stringify({
          user_id: 'user-worker',
          email: 'worker@example.com',
          plan_type: 'pro',
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: {
              used_percent: 10,
              limit_window_seconds: 18000,
              reset_after_seconds: 60,
              reset_at: Date.now() + 60_000,
            },
            secondary_window: {
              used_percent: 5,
              limit_window_seconds: 604800,
              reset_after_seconds: 3600,
              reset_at: Date.now() + 3_600_000,
            },
          },
          credits: {
            has_credits: true,
            unlimited: false,
            balance: '10',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as typeof globalThis.fetch

    try {
      await fetchPoolUsage({ forceRefresh: true, updateRoutingHints: true })
    } finally {
      globalThis.fetch = realFetch
    }

    expect(getPoolStatus().accounts.find((account) => account.accountId === 'main-account'))
      .toMatchObject({
        status: 'healthy',
        usagePrimary: 100,
        usageAllowed: false,
        usageLimitReached: true,
      })

    const lease = moduleUnderTest.createCodexLeaseForTest({
      ownerId: 'usage-refreshed-subagent',
      ownerType: 'subagent',
      ownerLabel: 'Usage Refreshed Subagent',
      strategy: 'follow-main',
    })

    // Usage observations do not mutate internal status, but fresh usage caps
    // should block new route selection before another request hits a known cap.
    expect(lease.accountId).toBe('worker-a')
  })

  test('withRetry classifies exhausted lease failures as usage exhaustion instead of connectivity', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({
          accountId: 'main-account',
          alias: 'main',
        }),
      ],
    })

    moduleUnderTest.createCodexLeaseForTest({
      ownerId: 'subagent-exhausted',
      ownerType: 'subagent',
      ownerLabel: 'Subagent Exhausted',
    })

    const generator = withRetry(
      async () => ({}) as never,
      async () => {
        throw new CodexAccountCapError('main-account')
      },
      {
        model: 'gpt-5.6-luna',
        thinkingConfig: { type: 'disabled' },
        ownerId: 'subagent-exhausted',
      } as Parameters<typeof withRetry>[2],
    )

    await expect(async () => {
      for await (const _message of generator) {
        // consume retry messages if any
      }
    }).toThrow(CannotRetryError)

    let thrown: unknown
    try {
      for await (const _message of withRetry(
        async () => ({}) as never,
        async () => {
          throw new CodexAccountCapError('main-account')
        },
        {
          model: 'gpt-5.6-luna',
          thinkingConfig: { type: 'disabled' },
          ownerId: 'subagent-exhausted',
        },
      )) {
        // unreachable
      }
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(CannotRetryError)
    expect((thrown as CannotRetryError).originalError).toBeInstanceOf(Error)
    expect((thrown as CannotRetryError).deferredTerminalFailure?.code).toBe('quota_exhausted')
    expect(((thrown as CannotRetryError).originalError as Error).message).toContain(
      'All Codex accounts are capped or unavailable',
    )
    expect(
      classifyAPIError((thrown as CannotRetryError).originalError as Error),
    ).toBe('rate_limit')
  })

  test('non-quota response failure cannot inherit quota evidence from capped pool state', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'capped-account',
      accounts: [buildPoolAccount({
        accountId: 'capped-account',
        status: 'capped',
        statusReason: 'usage_cap',
      })],
    })

    let thrown: unknown
    try {
      for await (const _message of withRetry(
        async () => ({}) as never,
        async () => {
          throw new CodexResponseFailedError({
            code: 'server_error',
            message: 'non-quota structured failure',
          })
        },
        {
          maxRetries: 0,
          model: 'gpt-5.6-luna',
          thinkingConfig: { type: 'disabled' },
          isCodexRequest: true,
        } as Parameters<typeof withRetry>[2],
      )) {
        // unreachable
      }
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(CannotRetryError)
    expect((thrown as CannotRetryError).originalError).toBeInstanceOf(CodexResponseFailedError)
    expect((thrown as CannotRetryError).deferredTerminalFailure).toBeUndefined()
  })

  test('withRetry records a single-account cap without rotating', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'solo-cap',
      accounts: [buildPoolAccount({ accountId: 'solo-cap' })],
    })

    let capThrown: unknown
    try {
      for await (const _message of withRetry(
        async () => ({}) as never,
        async () => {
          throw new CodexAccountCapError('solo-cap')
        },
        {
          maxRetries: 0,
          model: 'gpt-5.6-luna',
          thinkingConfig: { type: 'disabled' },
          isCodexRequest: true,
        } as Parameters<typeof withRetry>[2],
      )) {
        // unreachable
      }
    } catch (error) {
      capThrown = error
    }

    expect(capThrown).toBeInstanceOf(CannotRetryError)
    expect(getPoolStatus().accounts[0]).toMatchObject({
      accountId: 'solo-cap',
      status: 'capped',
      statusReason: 'usage_cap',
    })
    expect(((capThrown as CannotRetryError).originalError as Error).message).toContain(
      'All Codex accounts are capped or unavailable',
    )
  })

  test('withRetry records invalid-grant auth failure without live OAuth', async () => {
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    const scratchConfigDir = mkdtempSync(join(tmpdir(), 'codex-lease-auth-'))
    const originalFetch = globalThis.fetch
    let oauthRefreshCalls = 0

    try {
      process.env.CLAUDE_CONFIG_DIR = scratchConfigDir
      seedCodexAccountPoolForTest({
        activeAccountId: 'solo-auth',
        accounts: [buildPoolAccount({ accountId: 'solo-auth' })],
      })
      globalThis.fetch = (async input => {
        const url = String(input)
        if (url !== 'https://auth.openai.com/oauth/token') {
          throw new Error(`unexpected fetch: ${url}`)
        }
        oauthRefreshCalls += 1
        return new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      }) as typeof globalThis.fetch

      for await (const _message of withRetry(
        async () => ({}) as never,
        async () => {
          throw new CodexAccountAuthError('solo-auth', 401)
        },
        {
          maxRetries: 0,
          model: 'gpt-5.6-luna',
          thinkingConfig: { type: 'disabled' },
          isCodexRequest: true,
        } as Parameters<typeof withRetry>[2],
      )) {
        // unreachable
      }

      throw new Error('Expected invalid-grant auth recovery to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(CannotRetryError)
      expect(oauthRefreshCalls).toBe(1)
      expect(getPoolStatus().accounts[0]).toMatchObject({
        accountId: 'solo-auth',
        status: 'dead',
        statusReason: 'auth_dead',
      })
      expect((error as CannotRetryError).deferredTerminalFailure?.code).toBe(
        'account_recovery',
      )
    } finally {
      globalThis.fetch = originalFetch
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
      rmSync(scratchConfigDir, { recursive: true, force: true })
    }
  })

  test('failover keeps the failed lease inspectable when no healthy replacement exists', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'worker-a',
      accounts: [
        buildPoolAccount({
          accountId: 'worker-a',
          lastUsedAt: 100,
        }),
      ],
    })

    const failedLease = moduleUnderTest.createCodexLeaseForTest({
      ownerId: 'fails-without-replacement',
      ownerType: 'subagent',
      ownerLabel: 'Fails Without Replacement',
    })

    expect(() =>
      moduleUnderTest.failoverCodexLease(
        'fails-without-replacement',
        failedLease.accountId,
        '429 usage cap',
      ),
    ).toThrow('All Codex accounts are capped or unavailable')

    const failedSnapshot = moduleUnderTest.getCodexLeaseSnapshotForTest()
    expect(failedSnapshot.leases).toHaveLength(1)
    expect(failedSnapshot.leases[0]).toMatchObject({
      ownerId: failedLease.ownerId,
      ownerType: failedLease.ownerType,
      ownerLabel: failedLease.ownerLabel,
      accountId: failedLease.accountId,
      strategy: failedLease.strategy,
      createdAt: failedLease.createdAt,
      state: 'failed',
      failoverCount: 1,
      lastFailureReason: '429 usage cap',
    })
    expect(failedSnapshot.leases[0]?.updatedAt).toBeGreaterThanOrEqual(
      failedLease.updatedAt,
    )

    const failedAccount = getPoolStatus().accounts.find(
      (account) => account.accountId === failedLease.accountId,
    )
    expect(failedAccount?.status).toBe('capped')
    expect(failedAccount?.lastError).toBe('429 usage cap')
  })

  test('withRetry lease-local failover only switches the current owner lease', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({
          accountId: 'main-account',
          alias: 'main',
          lastUsedAt: 0,
        }),
        buildPoolAccount({
          accountId: 'worker-a',
          lastUsedAt: 100,
        }),
        buildPoolAccount({
          accountId: 'worker-b',
          lastUsedAt: 200,
        }),
      ],
    })

    const currentLease = moduleUnderTest.createCodexLeaseForTest({
      ownerId: 'subagent-failing',
      ownerType: 'subagent',
      ownerLabel: 'Subagent Failing',
    })
    const otherLease = moduleUnderTest.createCodexLeaseForTest({
      ownerId: 'subagent-stable',
      ownerType: 'subagent',
      ownerLabel: 'Subagent Stable',
    })

    let attempts = 0
    let secondAttemptLeaseAccountId: string | undefined
    for await (const _message of withRetry(
      async () => ({}) as never,
      async (_client, _attempt) => {
        attempts += 1
        const currentLeaseForAttempt = moduleUnderTest.getCodexLeaseForOwner('subagent-failing')
        if (attempts === 1) {
          expect(currentLeaseForAttempt?.accountId).toBe(currentLease.accountId)
          throw new CodexAccountCapError(currentLease.accountId)
        }
        secondAttemptLeaseAccountId = currentLeaseForAttempt?.accountId
        return currentLeaseForAttempt?.accountId
      },
      {
        model: 'gpt-5.6-luna',
        thinkingConfig: { type: 'disabled' },
        ownerId: 'subagent-failing',
      } as Parameters<typeof withRetry>[2],
    )) {
      // consume system retry messages
    }

    expect(attempts).toBe(2)
    expect(secondAttemptLeaseAccountId).toBe('main-account')

    const snapshot = moduleUnderTest.getCodexLeaseSnapshotForTest()
    expect(snapshot.leases.find((lease) => lease.ownerId === 'subagent-failing'))
      .toMatchObject({
        accountId: 'main-account',
        failoverCount: 1,
        lastFailureReason: 'Codex account worker-a hit usage cap',
      })
    expect(snapshot.leases.find((lease) => lease.ownerId === 'subagent-stable')).toEqual(
      otherLease,
    )
  })

  test('single-account pool-managed sessions still use main-thread retry owner and lease', () => {
    setSessionProvider('openai')
    seedCodexAccountPoolForTest({
      activeAccountId: 'solo-main',
      accounts: [
        buildPoolAccount({
          accountId: 'solo-main',
          alias: 'main',
        }),
      ],
    })

    expect(getRetryOwnerId({})).toBe('main-thread')

    const lease = moduleUnderTest.createCodexLeaseForTest({
      ownerId: 'main-thread',
      ownerType: 'main',
      ownerLabel: 'Main thread',
      strategy: 'follow-main',
    })

    expect(lease).toMatchObject({
      ownerId: 'main-thread',
      ownerType: 'main',
      accountId: 'solo-main',
      state: 'active',
    })
  })

  test('main-thread retries resolve to main-thread owner and fail over the main lease', async () => {
    setSessionProvider('openai')
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({
          accountId: 'main-account',
          alias: 'main',
          lastUsedAt: 0,
        }),
        buildPoolAccount({
          accountId: 'worker-a',
          lastUsedAt: 100,
        }),
      ],
    })

    expect(getRetryOwnerId({})).toBe('main-thread')

    moduleUnderTest.createCodexLeaseForTest({
      ownerId: 'main-thread',
      ownerType: 'main',
      ownerLabel: 'Main thread',
      strategy: 'follow-main',
    })

    let attempts = 0
    let secondAttemptLeaseAccountId: string | undefined
    for await (const _message of withRetry(
      async () => ({}) as never,
      async (_client, _attempt) => {
        attempts += 1
        const currentLeaseForAttempt = moduleUnderTest.getCodexLeaseForOwner('main-thread')
        if (attempts === 1) {
          expect(currentLeaseForAttempt?.accountId).toBe('main-account')
          throw new CodexAccountCapError('main-account')
        }

        secondAttemptLeaseAccountId = currentLeaseForAttempt?.accountId
        return currentLeaseForAttempt?.accountId
      },
      {
        model: 'gpt-5.6-luna',
        thinkingConfig: { type: 'disabled' },
        ownerId: getRetryOwnerId({}),
      } as Parameters<typeof withRetry>[2],
    )) {
      // consume system retry messages
    }

    expect(attempts).toBe(2)
    expect(secondAttemptLeaseAccountId).toBe('worker-a')
    expect(moduleUnderTest.getCodexLeaseForOwner('main-thread')).toMatchObject({
      accountId: 'worker-a',
      failoverCount: 1,
      lastFailureReason: 'Codex account main-account hit usage cap',
    })
  })

  test('withRetry classifies exhausted lease failures as usage exhaustion instead of connectivity', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({
          accountId: 'main-account',
          alias: 'main',
        }),
      ],
    })

    moduleUnderTest.createCodexLeaseForTest({
      ownerId: 'subagent-exhausted',
      ownerType: 'subagent',
      ownerLabel: 'Subagent Exhausted',
    })

    const generator = withRetry(
      async () => ({}) as never,
      async () => {
        throw new CodexAccountCapError('main-account')
      },
      {
        model: 'gpt-5.6-luna',
        thinkingConfig: { type: 'disabled' },
        ownerId: 'subagent-exhausted',
      } as Parameters<typeof withRetry>[2],
    )

    await expect(async () => {
      for await (const _message of generator) {
        // consume retry messages if any
      }
    }).toThrow(CannotRetryError)

    let thrown: unknown
    try {
      for await (const _message of withRetry(
        async () => ({}) as never,
        async () => {
          throw new CodexAccountCapError('main-account')
        },
        {
          model: 'gpt-5.6-luna',
          thinkingConfig: { type: 'disabled' },
          ownerId: 'subagent-exhausted',
        },
      )) {
        // unreachable
      }
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(CannotRetryError)
    expect((thrown as CannotRetryError).originalError).toBeInstanceOf(Error)
    expect(((thrown as CannotRetryError).originalError as Error).message).toContain(
      'All Codex accounts are capped or unavailable',
    )
    expect(
      classifyAPIError((thrown as CannotRetryError).originalError as Error),
    ).toBe('rate_limit')
  })

  test('createCodexFetch routes the first pooled request through the current lease account', async () => {
    setSessionProvider('openai')
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({
          accountId: 'main-account',
          alias: 'main',
        }),
        buildPoolAccount({
          accountId: 'worker-a',
          lastUsedAt: 100,
        }),
      ],
    })

    moduleUnderTest.seedCodexLeaseForTest({
      ownerId: 'subagent-first-request',
      ownerType: 'subagent',
      ownerLabel: 'Subagent First Request',
      accountId: 'worker-a',
    })

    const originalFetch = globalThis.fetch
    let authorizationHeader: string | null = null
    let accountHeader: string | null = null

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      authorizationHeader = headers.get('Authorization')
      accountHeader = headers.get('chatgpt-account-id')
      return codexCompletedStreamResponse()
    }) as typeof globalThis.fetch

    try {
      await moduleUnderTest.runWithCodexLeaseOwner('subagent-first-request', async () => {
        const codexFetch = createLeaseAwareCodexFetch('fallback-access-token')
        await codexFetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.6-luna', _openaiInstructionAssembly: { instructions: 'test instructions', inputMessages: [] } }),
        })
      })
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(authorizationHeader).toBe(`Bearer ${buildCodexToken('worker-a')}`)
    expect(accountHeader).toBe('worker-a')
  })

  test('createCodexFetch per-request resolver repairs a blocked lease before sending', async () => {
    setSessionProvider('openai')
    seedCodexAccountPoolForTest({
      activeAccountId: 'backup-clean',
      accounts: [
        buildPoolAccount({
          accountId: 'leased-capped',
          status: 'capped',
          statusReason: 'usage_cap',
          lastError: 'Usage cap hit (429)',
        }),
        buildPoolAccount({ accountId: 'backup-clean' }),
      ],
    })
    moduleUnderTest.seedCodexLeaseForTest({
      ownerId: 'subagent-repair',
      ownerType: 'subagent',
      ownerLabel: 'Subagent Repair',
      accountId: 'leased-capped',
    })

    const originalFetch = globalThis.fetch
    let accountHeader: string | null = null
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      accountHeader = new Headers(init?.headers).get('chatgpt-account-id')
      return codexCompletedStreamResponse()
    }) as typeof globalThis.fetch

    try {
      await moduleUnderTest.runWithCodexLeaseOwner('subagent-repair', async () => {
        const codexFetch = createLeaseAwareCodexFetch(buildCodexToken('leased-capped'))
        await codexFetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.6-luna', _openaiInstructionAssembly: { instructions: 'test instructions', inputMessages: [] } }),
        })
      })
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(accountHeader).toBe('backup-clean')
    expect(moduleUnderTest.getCodexLeaseForOwner('subagent-repair')?.accountId).toBe(
      'backup-clean',
    )
  })

  test('single-account HTTP 401/429 responses are classified as account errors', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'solo-account',
      accounts: [buildPoolAccount({ accountId: 'solo-account' })],
    })

    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = (async () =>
        new Response('unauthorized expired token', { status: 401 })) as unknown as typeof globalThis.fetch
      await expect(
        createLeaseAwareCodexFetch(buildCodexToken('solo-account'))(
          'https://api.anthropic.com/v1/messages',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'gpt-5.6-luna', _openaiInstructionAssembly: { instructions: 'test instructions', inputMessages: [] } }),
          },
        ),
      ).rejects.toBeInstanceOf(CodexAccountAuthError)

      globalThis.fetch = (async () =>
        new Response('usage limit reached', { status: 429 })) as unknown as typeof globalThis.fetch
      await expect(
        createLeaseAwareCodexFetch(buildCodexToken('solo-account'))(
          'https://api.anthropic.com/v1/messages',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'gpt-5.6-luna', _openaiInstructionAssembly: { instructions: 'test instructions', inputMessages: [] } }),
          },
        ),
      ).rejects.toBeInstanceOf(CodexAccountCapError)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('createCodexFetch keeps conversation ids isolated across interleaved lease owners', async () => {
    setSessionProvider('openai')
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({
          accountId: 'main-account',
          alias: 'main',
        }),
        buildPoolAccount({
          accountId: 'worker-a',
          lastUsedAt: 100,
        }),
        buildPoolAccount({
          accountId: 'worker-b',
          lastUsedAt: 200,
        }),
      ],
    })

    moduleUnderTest.seedCodexLeaseForTest({
      ownerId: 'lease-a',
      ownerType: 'subagent',
      ownerLabel: 'Lease A',
      accountId: 'worker-a',
    })
    moduleUnderTest.seedCodexLeaseForTest({
      ownerId: 'lease-b',
      ownerType: 'subagent',
      ownerLabel: 'Lease B',
      accountId: 'worker-b',
    })

    const originalFetch = globalThis.fetch
    const seenConversationIds = new Map<string, string[]>()

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      const accountId = headers.get('chatgpt-account-id') ?? 'unknown'
      const conversationId = headers.get('conversation-id') ?? 'missing'
      const existing = seenConversationIds.get(accountId) ?? []
      existing.push(conversationId)
      seenConversationIds.set(accountId, existing)
      return codexCompletedStreamResponse()
    }) as typeof globalThis.fetch

    try {
      const codexFetch = createLeaseAwareCodexFetch(buildCodexToken('main-account'))

      await moduleUnderTest.runWithCodexLeaseOwner('lease-a', async () => {
        await codexFetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.6-luna', _openaiInstructionAssembly: { instructions: 'test instructions', inputMessages: [] } }),
        })
      })
      await moduleUnderTest.runWithCodexLeaseOwner('lease-b', async () => {
        await codexFetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.6-luna', _openaiInstructionAssembly: { instructions: 'test instructions', inputMessages: [] } }),
        })
      })
      await moduleUnderTest.runWithCodexLeaseOwner('lease-a', async () => {
        await codexFetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.6-luna', _openaiInstructionAssembly: { instructions: 'test instructions', inputMessages: [] } }),
        })
      })
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(seenConversationIds.get('worker-a')).toHaveLength(2)
    expect(seenConversationIds.get('worker-b')).toHaveLength(1)
    expect(seenConversationIds.get('worker-a')?.[0]).toBe(
      seenConversationIds.get('worker-a')?.[1],
    )
    expect(seenConversationIds.get('worker-a')?.[0]).not.toBe(
      seenConversationIds.get('worker-b')?.[0],
    )
  })

  test('createCodexFetch shares conversation ids across different owners on the same account', async () => {
    setSessionProvider('openai')
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({
          accountId: 'main-account',
          alias: 'main',
        }),
      ],
    })

    moduleUnderTest.seedCodexLeaseForTest({
      ownerId: 'main-thread',
      ownerType: 'main',
      ownerLabel: 'Main thread',
      accountId: 'main-account',
    })
    moduleUnderTest.seedCodexLeaseForTest({
      ownerId: 'subagent-a',
      ownerType: 'subagent',
      ownerLabel: 'Subagent A',
      accountId: 'main-account',
    })

    const originalFetch = globalThis.fetch
    const seenConversationIds: string[] = []

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      seenConversationIds.push(headers.get('conversation-id') ?? 'missing')
      return codexCompletedStreamResponse()
    }) as typeof globalThis.fetch

    try {
      const codexFetch = createLeaseAwareCodexFetch(buildCodexToken('main-account'))

      await moduleUnderTest.runWithCodexLeaseOwner('main-thread', async () => {
        await codexFetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.6-luna', _openaiInstructionAssembly: { instructions: 'test instructions', inputMessages: [] } }),
        })
      })
      await moduleUnderTest.runWithCodexLeaseOwner('subagent-a', async () => {
        await codexFetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.6-luna', _openaiInstructionAssembly: { instructions: 'test instructions', inputMessages: [] } }),
        })
      })

      expect(seenConversationIds).toHaveLength(2)
      expect(seenConversationIds[0]).toBe(seenConversationIds[1])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('createCodexFetch keeps conversation ids distinct per model on the same account', async () => {
    setSessionProvider('openai')
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({
          accountId: 'main-account',
          alias: 'main',
        }),
      ],
    })

    moduleUnderTest.seedCodexLeaseForTest({
      ownerId: 'main-thread',
      ownerType: 'main',
      ownerLabel: 'Main thread',
      accountId: 'main-account',
    })

    const originalFetch = globalThis.fetch
    const seenConversationIds: string[] = []

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      seenConversationIds.push(headers.get('conversation-id') ?? 'missing')
      return codexCompletedStreamResponse()
    }) as typeof globalThis.fetch

    try {
      const codexFetch = createLeaseAwareCodexFetch(buildCodexToken('main-account'))

      await moduleUnderTest.runWithCodexLeaseOwner('main-thread', async () => {
        await codexFetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.6-luna', _openaiInstructionAssembly: { instructions: 'test instructions', inputMessages: [] } }),
        })
      })
      await moduleUnderTest.runWithCodexLeaseOwner('main-thread', async () => {
        await codexFetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.6-terra', _openaiInstructionAssembly: { instructions: 'test instructions', inputMessages: [] } }),
        })
      })
      await moduleUnderTest.runWithCodexLeaseOwner('main-thread', async () => {
        await codexFetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.6-luna', _openaiInstructionAssembly: { instructions: 'test instructions', inputMessages: [] } }),
        })
      })

      expect(seenConversationIds).toHaveLength(3)
      expect(seenConversationIds[0]).not.toBe(seenConversationIds[1])
      expect(seenConversationIds[0]).toBe(seenConversationIds[2])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('withRetry lease-local failover only switches the current owner lease', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({
          accountId: 'main-account',
          alias: 'main',
          lastUsedAt: 0,
        }),
        buildPoolAccount({
          accountId: 'worker-a',
          lastUsedAt: 100,
        }),
        buildPoolAccount({
          accountId: 'worker-b',
          lastUsedAt: 200,
        }),
      ],
    })

    const currentLease = moduleUnderTest.createCodexLeaseForTest({
      ownerId: 'subagent-failing',
      ownerType: 'subagent',
      ownerLabel: 'Subagent Failing',
    })
    const otherLease = moduleUnderTest.createCodexLeaseForTest({
      ownerId: 'subagent-stable',
      ownerType: 'subagent',
      ownerLabel: 'Subagent Stable',
    })

    let attempts = 0
    let secondAttemptLeaseAccountId: string | undefined
    for await (const _message of withRetry(
      async () => ({}) as never,
      async (_client, _attempt) => {
        attempts += 1
        const currentLeaseForAttempt = moduleUnderTest.getCodexLeaseForOwner('subagent-failing')
        if (attempts === 1) {
          expect(currentLeaseForAttempt?.accountId).toBe(currentLease.accountId)
          throw new CodexAccountCapError(currentLease.accountId)
        }
        secondAttemptLeaseAccountId = currentLeaseForAttempt?.accountId
        return currentLeaseForAttempt?.accountId
      },
      {
        model: 'gpt-5.6-luna',
        thinkingConfig: { type: 'disabled' },
        ownerId: 'subagent-failing',
      } as Parameters<typeof withRetry>[2],
    )) {
      // consume system retry messages
    }

    expect(attempts).toBe(2)
    expect(secondAttemptLeaseAccountId).toBe('main-account')

    const snapshot = moduleUnderTest.getCodexLeaseSnapshotForTest()
    expect(snapshot.leases.find((lease) => lease.ownerId === 'subagent-failing'))
      .toMatchObject({
        accountId: 'main-account',
        failoverCount: 1,
        lastFailureReason: 'Codex account worker-a hit usage cap',
      })
    expect(snapshot.leases.find((lease) => lease.ownerId === 'subagent-stable')).toEqual(
      otherLease,
    )
  })

  test('main-thread retries resolve to main-thread owner and fail over the main lease', async () => {
    setSessionProvider('openai')
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({
          accountId: 'main-account',
          alias: 'main',
          lastUsedAt: 0,
        }),
        buildPoolAccount({
          accountId: 'worker-a',
          lastUsedAt: 100,
        }),
      ],
    })

    expect(getRetryOwnerId({})).toBe('main-thread')

    moduleUnderTest.createCodexLeaseForTest({
      ownerId: 'main-thread',
      ownerType: 'main',
      ownerLabel: 'Main thread',
      strategy: 'follow-main',
    })

    let attempts = 0
    let secondAttemptLeaseAccountId: string | undefined
    for await (const _message of withRetry(
      async () => ({}) as never,
      async (_client, _attempt) => {
        attempts += 1
        const currentLeaseForAttempt = moduleUnderTest.getCodexLeaseForOwner('main-thread')
        if (attempts === 1) {
          expect(currentLeaseForAttempt?.accountId).toBe('main-account')
          throw new CodexAccountCapError('main-account')
        }

        secondAttemptLeaseAccountId = currentLeaseForAttempt?.accountId
        return currentLeaseForAttempt?.accountId
      },
      {
        model: 'gpt-5.6-luna',
        thinkingConfig: { type: 'disabled' },
        ownerId: getRetryOwnerId({}),
      } as Parameters<typeof withRetry>[2],
    )) {
      // consume system retry messages
    }

    expect(attempts).toBe(2)
    expect(secondAttemptLeaseAccountId).toBe('worker-a')
    expect(moduleUnderTest.getCodexLeaseForOwner('main-thread')).toMatchObject({
      accountId: 'worker-a',
      failoverCount: 1,
      lastFailureReason: 'Codex account main-account hit usage cap',
    })
  })

  test('withRetry retries leased Codex streams when response.failed reports a usage limit before output', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({
          accountId: 'main-account',
          alias: 'main',
          lastUsedAt: 0,
        }),
        buildPoolAccount({
          accountId: 'worker-a',
          lastUsedAt: 100,
        }),
      ],
    })

    const currentLease = moduleUnderTest.createCodexLeaseForTest({
      ownerId: 'subagent-response-failed',
      ownerType: 'subagent',
      ownerLabel: 'Subagent Response Failed',
    })

    const originalFetch = globalThis.fetch
    const conversationId = 'conv_response_failed_retry'
    const seenAccountIds: string[] = []

    _markStickyHttpFallbackForTest(conversationId, 'test')
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      const accountId = headers.get('chatgpt-account-id') ?? 'missing'
      seenAccountIds.push(accountId)

      if (accountId === currentLease.accountId) {
        return new Response(
          [
            'event: response.failed',
            `data: ${JSON.stringify({
              type: 'response.failed',
              response: {
                error: {
                  code: 'usage_limit_reached',
                  message: 'usage limit reached',
                },
              },
            })}`,
            '',
          ].join('\n'),
          {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          },
        )
      }

      return new Response(
        [
          'event: response.output_text.delta',
          `data: ${JSON.stringify({
            type: 'response.output_text.delta',
            delta: 'retried successfully',
          })}`,
          '',
          'event: response.completed',
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: {
              usage: {
                input_tokens: 4,
                output_tokens: 2,
                input_tokens_details: { cached_tokens: 0 },
              },
            },
          })}`,
          '',
        ].join('\n'),
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      )
    }) as typeof globalThis.fetch

    try {
      let attempts = 0
      for await (const _message of withRetry(
        async () => ({}) as never,
        async () => {
          attempts += 1
          const response = await createLeaseAwareCodexFetch(
            buildCodexToken('main-account'),
            conversationId,
          )('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              stream: true,
              model: 'gpt-5.6-luna',
              _openaiInstructionAssembly: {
                instructions: 'test instructions',
                inputMessages: [],
              },
            }),
          })
          const body = await response.text()
          expect(body).toContain('retried successfully')
          return body
        },
        {
          maxRetries: 1,
          model: 'gpt-5.6-luna',
          thinkingConfig: { type: 'disabled' },
          ownerId: 'subagent-response-failed',
          isCodexRequest: true,
        } as Parameters<typeof withRetry>[2],
      )) {
        // consume system retry messages
      }

      expect(attempts).toBe(2)
      expect(seenAccountIds).toEqual([currentLease.accountId, 'main-account'])
      expect(moduleUnderTest.getCodexLeaseForOwner('subagent-response-failed'))
        .toMatchObject({
          accountId: 'main-account',
          failoverCount: 1,
        })
      expect(
        getPoolStatus().accounts.find((account) => account.accountId === currentLease.accountId),
      ).toMatchObject({
        status: 'capped',
      })
    } finally {
      globalThis.fetch = originalFetch
      resetCodexCacheContext()
    }
  })

  test('cool-down deprioritises a recently-errored account over a clean one', () => {
    const now = Date.now()
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({
          accountId: 'main-account',
          alias: 'main',
          lastUsedAt: 0,
        }),
        buildPoolAccount({
          accountId: 'worker-a',
          lastUsedAt: 100,
          // lastErrorAt will be stamped below
        }),
        buildPoolAccount({
          accountId: 'worker-b',
          lastUsedAt: 200,
        }),
      ],
    })

    // Simulate worker-a having just errored.
    markPoolAccountLastError('worker-a')

    // First subagent should land on worker-b (worker-a is in cool-down).
    const lease = moduleUnderTest.createCodexLeaseForTest({
      ownerId: 'sibling-2',
      ownerType: 'subagent',
      ownerLabel: 'Sibling 2',
    })

    expect(lease.accountId).toBe('worker-b')
    expect(
      getPoolStatus().accounts.find((a) => a.accountId === 'worker-a')?.lastErrorAt,
    ).toBeGreaterThanOrEqual(now)
  })

  test('cool-down still selects the errored account when it is the only healthy one', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'worker-a',
      accounts: [
        buildPoolAccount({
          accountId: 'worker-a',
          lastUsedAt: 0,
        }),
      ],
    })

    markPoolAccountLastError('worker-a')

    // Only account available — must still be selected despite cool-down.
    const lease = moduleUnderTest.createCodexLeaseForTest({
      ownerId: 'only-subagent',
      ownerType: 'subagent',
      ownerLabel: 'Only Subagent',
    })

    expect(lease.accountId).toBe('worker-a')
  })

  test('withRetry does not fail over Codex leases for non-Codex connection errors', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({
          accountId: 'main-account',
          alias: 'main',
        }),
        buildPoolAccount({
          accountId: 'worker-a',
          lastUsedAt: 100,
        }),
      ],
    })

    moduleUnderTest.createCodexLeaseForTest({
      ownerId: 'main-thread',
      ownerType: 'main',
      ownerLabel: 'Main thread',
      strategy: 'follow-main',
    })

    let thrown: unknown
    try {
      for await (const _message of withRetry(
        async () => ({}) as never,
        async () => {
          throw new APIConnectionError({ message: 'Claude OAuth refresh failed' })
        },
        {
          maxRetries: 1,
          model: 'claude-haiku-4-5-20251001',
          thinkingConfig: { type: 'disabled' },
          ownerId: 'main-thread',
        } as Parameters<typeof withRetry>[2],
      )) {
        // unreachable
      }
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(CannotRetryError)
    expect(moduleUnderTest.getCodexLeaseForOwner('main-thread')).toMatchObject({
      accountId: 'main-account',
      state: 'active',
      failoverCount: 0,
    })
    expect(getPoolStatus().accounts.find((account) => account.accountId === 'main-account'))
      .toMatchObject({
        status: 'healthy',
        usagePrimary: undefined,
      })
  })

  test('withRetry Codex connection failover leaves the failed account healthy', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({
          accountId: 'main-account',
          alias: 'main',
          lastUsedAt: 0,
        }),
        buildPoolAccount({
          accountId: 'worker-a',
          lastUsedAt: 100,
        }),
      ],
    })

    moduleUnderTest.createCodexLeaseForTest({
      ownerId: 'main-thread',
      ownerType: 'main',
      ownerLabel: 'Main thread',
      strategy: 'follow-main',
    })

    let attempts = 0
    for await (const _message of withRetry(
      async () => ({}) as never,
      async () => {
        attempts += 1
        if (attempts <= 2) {
          throw new APIConnectionError({ message: 'Connection error.' })
        }
        return attempts
      },
      {
        maxRetries: 2,
        model: 'gpt-5.6-luna',
        thinkingConfig: { type: 'disabled' },
        ownerId: 'main-thread',
        isCodexRequest: true,
      } as Parameters<typeof withRetry>[2],
    )) {
      // consume retry messages if any
    }

    expect(attempts).toBe(3)
    expect(moduleUnderTest.getCodexLeaseForOwner('main-thread')).toMatchObject({
      accountId: 'worker-a',
      state: 'active',
      failoverCount: 1,
      lastFailureReason: 'Connection error.',
    })
    const failedAccount = getPoolStatus().accounts.find(
      (account) => account.accountId === 'main-account',
    )
    expect(failedAccount)
      .toMatchObject({
        status: 'healthy',
        usagePrimary: undefined,
      })
    expect(failedAccount?.lastErrorAt).toBeGreaterThan(0)
  })

  test('withRetry Codex connection errors without a replacement preserve the connection failure', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({
          accountId: 'main-account',
          alias: 'main',
        }),
      ],
    })

    moduleUnderTest.createCodexLeaseForTest({
      ownerId: 'main-thread',
      ownerType: 'main',
      ownerLabel: 'Main thread',
      strategy: 'follow-main',
    })

    let attempts = 0
    let thrown: unknown
    try {
      for await (const _message of withRetry(
        async () => ({}) as never,
        async () => {
          attempts += 1
          throw new APIConnectionError({ message: 'Connection error.' })
        },
        {
          maxRetries: 2,
          model: 'gpt-5.6-luna',
          thinkingConfig: { type: 'disabled' },
          ownerId: 'main-thread',
          isCodexRequest: true,
        } as Parameters<typeof withRetry>[2],
      )) {
        // unreachable
      }
    } catch (error) {
      thrown = error
    }

    expect(attempts).toBe(3)
    expect(thrown).toBeInstanceOf(CannotRetryError)
    expect((thrown as CannotRetryError).originalError).toBeInstanceOf(APIConnectionError)
    expect(moduleUnderTest.getCodexLeaseForOwner('main-thread')).toMatchObject({
      accountId: 'main-account',
      state: 'active',
      failoverCount: 0,
    })
    expect(getPoolStatus().accounts.find((account) => account.accountId === 'main-account'))
      .toMatchObject({
        status: 'healthy',
        usagePrimary: undefined,
      })
  })

  test('subagent failoverCodexLease does not move pool.activeIndex', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({ accountId: 'main-account', alias: 'main' }),
        buildPoolAccount({ accountId: 'worker-a', alias: 'worker' }),
        buildPoolAccount({ accountId: 'backup', alias: 'backup' }),
      ],
    })

    moduleUnderTest.seedCodexLeaseForTest({
      ownerId: 'subagent-x',
      ownerType: 'subagent',
      ownerLabel: 'Subagent X',
      accountId: 'worker-a',
      strategy: 'spread',
    })

    const before = getPoolStatus()
    expect(before.accounts[before.activeIndex]?.accountId).toBe('main-account')

    moduleUnderTest.failoverCodexLease(
      'subagent-x',
      'worker-a',
      'usage cap 429',
    )

    const after = getPoolStatus()
    expect(after.accounts[after.activeIndex]?.accountId).toBe('main-account')
  })

  test('subagent failover from the globally active account leaves pool.activeIndex unchanged', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'worker-a',
      accounts: [
        buildPoolAccount({ accountId: 'main-account', alias: 'main' }),
        buildPoolAccount({ accountId: 'worker-a', alias: 'worker' }),
        buildPoolAccount({ accountId: 'backup', alias: 'backup' }),
      ],
    })

    moduleUnderTest.seedCodexLeaseForTest({
      ownerId: 'subagent-active',
      ownerType: 'subagent',
      ownerLabel: 'Subagent Active',
      accountId: 'worker-a',
      strategy: 'spread',
    })

    moduleUnderTest.failoverCodexLease(
      'subagent-active',
      'worker-a',
      'usage cap 429',
    )

    const after = getPoolStatus()
    expect(after.accounts[after.activeIndex]?.accountId).toBe('worker-a')
    expect(after.accounts[after.activeIndex]?.status).toBe('capped')
  })

  test('manual active-account reassignment updates main and follow-main leases only', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'new-main',
      accounts: [
        buildPoolAccount({ accountId: 'old-main', alias: 'old' }),
        buildPoolAccount({ accountId: 'new-main', alias: 'main' }),
        buildPoolAccount({ accountId: 'spread-account', alias: 'spread' }),
      ],
    })

    moduleUnderTest.seedCodexLeaseForTest({
      ownerId: 'main-thread',
      ownerType: 'main',
      ownerLabel: 'Main thread',
      accountId: 'old-main',
      strategy: 'follow-main',
    })
    moduleUnderTest.seedCodexLeaseForTest({
      ownerId: 'follow-worker',
      ownerType: 'subagent',
      ownerLabel: 'Follow Worker',
      accountId: 'old-main',
      strategy: 'follow-main',
    })
    moduleUnderTest.seedCodexLeaseForTest({
      ownerId: 'spread-worker',
      ownerType: 'subagent',
      ownerLabel: 'Spread Worker',
      accountId: 'spread-account',
      strategy: 'spread',
    })

    moduleUnderTest.reassignCodexLeasesToActiveAccount()

    expect(moduleUnderTest.getCodexLeaseForOwner('main-thread')?.accountId).toBe('new-main')
    expect(moduleUnderTest.getCodexLeaseForOwner('follow-worker')?.accountId).toBe('new-main')
    expect(moduleUnderTest.getCodexLeaseForOwner('spread-worker')?.accountId).toBe('spread-account')
  })

  test('failoverCodexLease emits lease failover diagnostic with old and new account refs', () => {
    const emitted: unknown[] = []
    installStreamJsonAccountDiagnosticHook({
      emit: message => {
        emitted.push(message)
      },
      getSessionId: () => 'lease-diag-session',
      createUuid: () => `lease-diag-${emitted.length + 1}`,
    })

    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({ accountId: 'main-account', alias: 'main' }),
        buildPoolAccount({ accountId: 'worker-a', alias: 'worker' }),
      ],
    })

    moduleUnderTest.seedCodexLeaseForTest({
      ownerId: 'subagent-diag',
      ownerType: 'subagent',
      ownerLabel: 'Subagent Diagnostic',
      accountId: 'worker-a',
      strategy: 'spread',
    })

    moduleUnderTest.failoverCodexLease(
      'subagent-diag',
      'worker-a',
      'usage cap 429',
    )

    const leaseFailover = emitted.find(
      message => (message as { code?: string }).code === 'account.lease.failover',
    )
    expect(leaseFailover).toMatchObject({
      type: 'system',
      subtype: 'cat_code_account_diagnostic',
      code: 'account.lease.failover',
      severity: 'info',
      provider: 'openai',
      recoverable: true,
      reason: 'usage cap 429',
    })
    expect((leaseFailover as { from_account_ref?: string }).from_account_ref).toBeDefined()
    expect((leaseFailover as { account_ref?: string }).account_ref).toBeDefined()
    expect((leaseFailover as { from_account_ref?: string }).from_account_ref).not.toBe(
      (leaseFailover as { account_ref?: string }).account_ref,
    )
  })

  test('withRetry bounds repeated Codex cap failovers and emits retry exhausted diagnostic', async () => {
    const emitted: unknown[] = []
    installStreamJsonAccountDiagnosticHook({
      emit: message => {
        emitted.push(message)
      },
      getSessionId: () => 'retry-bound-session',
      createUuid: () => `retry-bound-${emitted.length + 1}`,
    })

    seedCodexAccountPoolForTest({
      activeAccountId: 'account-a',
      accounts: [
        buildPoolAccount({ accountId: 'account-a', alias: 'a' }),
        buildPoolAccount({ accountId: 'account-b', alias: 'b' }),
        buildPoolAccount({ accountId: 'account-c', alias: 'c' }),
      ],
    })

    moduleUnderTest.seedCodexLeaseForTest({
      ownerId: 'main-thread',
      ownerType: 'main',
      ownerLabel: 'Main thread',
      accountId: 'account-a',
      strategy: 'follow-main',
    })

    let switchCount = 0
    let thrown: unknown
    try {
      for await (const _message of withRetry(
        async () => ({}) as never,
        async () => {
          const currentLease = moduleUnderTest.getCodexLeaseForOwner('main-thread')
          throw new CodexAccountCapError(currentLease?.accountId ?? 'account-a')
        },
        {
          maxRetries: 1,
          model: 'gpt-5.6-luna',
          thinkingConfig: { type: 'disabled' },
          ownerId: 'main-thread',
          isCodexRequest: true,
          onCodexAccountSwitch: () => {
            switchCount += 1
          },
        } as Parameters<typeof withRetry>[2],
      )) {
        // consume retry messages if any
      }
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(CannotRetryError)
    expect(switchCount).toBeLessThanOrEqual(1)
    expect(
      emitted.some(
        message =>
          (message as { code?: string }).code === 'account.retry.exhausted' &&
          (message as { recoverable?: boolean }).recoverable === false,
      ),
    ).toBe(true)
  })

  test('failover-budget exhaustion does not claim quota exhaustion while accounts remain', async () => {
    // The budget assert fires BEFORE capping/failing over the current account,
    // so selectable accounts can still remain — pool-wide quota exhaustion was
    // never established. Inferring `quota_exhausted` from the CodexAccountCapError
    // class here would authorize an unattended /continue-after-limit resume on
    // evidence we never gathered.
    seedCodexAccountPoolForTest({
      activeAccountId: 'account-a',
      accounts: [
        buildPoolAccount({ accountId: 'account-a', alias: 'a' }),
        buildPoolAccount({ accountId: 'account-b', alias: 'b' }),
        buildPoolAccount({ accountId: 'account-c', alias: 'c' }),
      ],
    })

    moduleUnderTest.seedCodexLeaseForTest({
      ownerId: 'main-thread',
      ownerType: 'main',
      ownerLabel: 'Main thread',
      accountId: 'account-a',
      strategy: 'follow-main',
    })

    let thrown: unknown
    try {
      for await (const _message of withRetry(
        async () => ({}) as never,
        async () => {
          const currentLease = moduleUnderTest.getCodexLeaseForOwner('main-thread')
          throw new CodexAccountCapError(currentLease?.accountId ?? 'account-a')
        },
        {
          maxRetries: 1,
          model: 'gpt-5.6-luna',
          thinkingConfig: { type: 'disabled' },
          ownerId: 'main-thread',
          isCodexRequest: true,
        } as Parameters<typeof withRetry>[2],
      )) {
        // consume retry messages if any
      }
    } catch (error) {
      thrown = error
    }

    // Precondition: the budget ran out with a healthy account still unused.
    expect(
      getPoolStatus().accounts.some(account => account.status === 'healthy'),
    ).toBe(true)

    expect(thrown).toBeInstanceOf(CannotRetryError)
    expect((thrown as CannotRetryError).deferredTerminalFailure).toMatchObject({
      version: 1,
      provider: 'openai',
      code: 'ambiguous_rate_limit',
    })
  })

  test('terminal capped-plus-dead pool reports recovery, not quota exhaustion', async () => {
    // A reset for the capped account cannot repair a dead account. The terminal
    // decision therefore requires account recovery rather than continuation.
    const emitted: unknown[] = []
    installStreamJsonAccountDiagnosticHook({
      emit: message => {
        emitted.push(message)
      },
      getSessionId: () => 'partial-cap-session',
      createUuid: () => `partial-cap-${emitted.length + 1}`,
    })

    seedCodexAccountPoolForTest({
      activeAccountId: 'account-a',
      accounts: [
        buildPoolAccount({ accountId: 'account-a', alias: 'a' }),
        buildPoolAccount({ accountId: 'account-b', alias: 'b', status: 'dead' }),
      ],
    })

    let thrown: unknown
    try {
      for await (const _message of withRetry(
        async () => ({}) as never,
        async () => {
          throw new CodexAccountCapError('account-a')
        },
        {
          maxRetries: 0,
          model: 'gpt-5.6-luna',
          thinkingConfig: { type: 'disabled' },
          isCodexRequest: true,
        } as Parameters<typeof withRetry>[2],
      )) {
        // unreachable
      }
    } catch (error) {
      thrown = error
    }

    const statuses = getPoolStatus().accounts.map(account => account.status)
    const capped = statuses.filter(status => status === 'capped').length
    // Precondition: partially capped at the terminal decision.
    expect(capped).toBeGreaterThan(0)
    expect(capped).toBeLessThan(statuses.length)

    expect(thrown).toBeInstanceOf(CannotRetryError)
    expect((thrown as CannotRetryError).deferredTerminalFailure).toMatchObject({
      version: 1,
      provider: 'openai',
      code: 'account_recovery',
    })
    expect(
      emitted.some(
        message => (message as { code?: string }).code === 'quota.exhausted',
      ),
    ).toBe(false)
    expect(
      emitted.some(
        message =>
          (message as { code?: string }).code === 'account.pool.unavailable',
      ),
    ).toBe(true)
  })

  test('withRetry global Codex cap failover uses the replacement account instead of falsely exhausting', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'account-a',
      accounts: [
        buildPoolAccount({ accountId: 'account-a', alias: 'a', lastUsedAt: 0 }),
        buildPoolAccount({ accountId: 'account-b', alias: 'b', lastUsedAt: 100 }),
      ],
    })

    let attempts = 0
    let secondAttemptActiveAccountId: string | undefined

    for await (const _message of withRetry(
      async () => ({}) as never,
      async () => {
        attempts += 1
        if (attempts === 1) {
          throw new CodexAccountCapError('account-a')
        }
        const status = getPoolStatus()
        secondAttemptActiveAccountId = status.accounts[status.activeIndex]?.accountId
        return secondAttemptActiveAccountId
      },
      {
        maxRetries: 1,
        model: 'gpt-5.6-luna',
        thinkingConfig: { type: 'disabled' },
        isCodexRequest: true,
      } as Parameters<typeof withRetry>[2],
    )) {
      // consume retry messages if any
    }

    expect(attempts).toBe(2)
    expect(secondAttemptActiveAccountId).toBe('account-b')
    expect(getGlobalConfig().activeCodexAccountId).toBe('account-b')
  })

  test('withRetry bounds repeated Codex connection-error failovers across accounts', async () => {
    _setCodexNetworkOutageDelaysForTest(10, 20)
    try {
      const emitted: unknown[] = []
      installStreamJsonAccountDiagnosticHook({
        emit: message => {
          emitted.push(message)
        },
        getSessionId: () => 'connection-bound-session',
        createUuid: () => `connection-bound-${emitted.length + 1}`,
      })

      seedCodexAccountPoolForTest({
        activeAccountId: 'account-a',
        accounts: [
          buildPoolAccount({ accountId: 'account-a', alias: 'a' }),
          buildPoolAccount({ accountId: 'account-b', alias: 'b' }),
          buildPoolAccount({ accountId: 'account-c', alias: 'c' }),
        ],
      })
      moduleUnderTest.seedCodexLeaseForTest({
        ownerId: 'main-thread',
        ownerType: 'main',
        ownerLabel: 'Main thread',
        accountId: 'account-a',
        strategy: 'follow-main',
      })

      let attempts = 0
      let thrown: unknown
      try {
        for await (const _message of withRetry(
          async () => ({}) as never,
          async () => {
            attempts += 1
            throw new APIConnectionError({ message: `connection failed ${attempts}` })
          },
          {
            maxRetries: 2,
            model: 'gpt-5.6-luna',
            thinkingConfig: { type: 'disabled' },
            ownerId: 'main-thread',
            isCodexRequest: true,
          } as Parameters<typeof withRetry>[2],
        )) {
          // consume retry messages if any
        }
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(CannotRetryError)
      expect(attempts).toBeLessThanOrEqual(4)
      expect(
        emitted.some(
          message =>
            (message as { code?: string }).code === 'account.retry.exhausted' &&
            (message as { recoverable?: boolean }).recoverable === false,
        ),
      ).toBe(true)
    } finally {
      _resetCodexNetworkOutageDelaysForTest()
    }
  })

  test('releaseCodexLease does not change pool.activeIndex', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({ accountId: 'main-account', alias: 'main' }),
        buildPoolAccount({ accountId: 'worker-a', alias: 'worker' }),
      ],
    })

    moduleUnderTest.seedCodexLeaseForTest({
      ownerId: 'subagent-y',
      ownerType: 'subagent',
      ownerLabel: 'Subagent Y',
      accountId: 'worker-a',
      strategy: 'spread',
    })

    const before = getPoolStatus()
    expect(before.accounts[before.activeIndex]?.accountId).toBe('main-account')

    moduleUnderTest.releaseCodexLease('subagent-y')

    const after = getPoolStatus()
    expect(after.accounts[after.activeIndex]?.accountId).toBe('main-account')
    expect(moduleUnderTest.getCodexLeaseForOwner('subagent-y')).toBeUndefined()
  })

  test('repairLeasesForDeletedAccount reassigns leases pointing at the deleted account', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({ accountId: 'main-account', alias: 'main' }),
        buildPoolAccount({ accountId: 'worker-a', alias: 'worker' }),
      ],
    })

    moduleUnderTest.seedCodexLeaseForTest({
      ownerId: 'subagent-on-deleted',
      ownerType: 'subagent',
      ownerLabel: 'Subagent On Deleted',
      accountId: 'gone-account',
      strategy: 'spread',
    })
    moduleUnderTest.seedCodexLeaseForTest({
      ownerId: 'subagent-untouched',
      ownerType: 'subagent',
      ownerLabel: 'Subagent Untouched',
      accountId: 'worker-a',
      strategy: 'spread',
    })

    moduleUnderTest.repairLeasesForDeletedAccount('gone-account')

    const snapshot = moduleUnderTest.getCodexLeaseSnapshotForTest()
    const repaired = snapshot.leases.find(
      (lease) => lease.ownerId === 'subagent-on-deleted',
    )
    const untouched = snapshot.leases.find(
      (lease) => lease.ownerId === 'subagent-untouched',
    )

    expect(repaired).toBeDefined()
    expect(repaired?.accountId).not.toBe('gone-account')
    expect(repaired?.state).toBe('active')
    expect(untouched).toBeDefined()
    expect(untouched?.accountId).toBe('worker-a')
    expect(untouched?.state).toBe('active')
  })

  test('repairLeasesForDeletedAccount releases leases when no healthy alternative exists', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'dead-account',
      accounts: [
        buildPoolAccount({
          accountId: 'dead-account',
          alias: 'dead',
          status: 'capped',
        }),
      ],
    })

    moduleUnderTest.seedCodexLeaseForTest({
      ownerId: 'orphan',
      ownerType: 'subagent',
      ownerLabel: 'Orphan',
      accountId: 'gone-account',
      strategy: 'spread',
    })

    moduleUnderTest.repairLeasesForDeletedAccount('gone-account')

    expect(moduleUnderTest.getCodexLeaseForOwner('orphan')).toBeUndefined()
  })

  test('repairLeasesForDeletedAccount repairs main before follow-main leases', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'new-main',
      accounts: [
        buildPoolAccount({ accountId: 'new-main', alias: 'main', lastUsedAt: 100 }),
        buildPoolAccount({ accountId: 'other-account', alias: 'other', lastUsedAt: 0 }),
      ],
    })

    moduleUnderTest.seedCodexLeaseForTest({
      ownerId: 'follow-worker',
      ownerType: 'subagent',
      ownerLabel: 'Follow Worker',
      accountId: 'gone-account',
      strategy: 'follow-main',
    })
    moduleUnderTest.seedCodexLeaseForTest({
      ownerId: 'main-thread',
      ownerType: 'main',
      ownerLabel: 'Main thread',
      accountId: 'gone-account',
      strategy: 'follow-main',
    })

    moduleUnderTest.repairLeasesForDeletedAccount('gone-account')

    expect(moduleUnderTest.getCodexLeaseForOwner('main-thread')?.accountId).toBe('new-main')
    expect(moduleUnderTest.getCodexLeaseForOwner('follow-worker')?.accountId).toBe('new-main')
  })

  test('a lease records WHY it moved as values, not only as prose', () => {
    // `selectionReason` interpolates account ids into a sentence, which left every
    // consumer either parsing prose or unable to name the account at all.
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({ accountId: 'main-account', alias: 'main' }),
        buildPoolAccount({ accountId: 'worker-a', alias: 'worker' }),
      ],
    })

    const fresh = moduleUnderTest.createCodexLeaseForTest({
      ownerId: 'subagent-kind',
      ownerType: 'subagent',
      ownerLabel: 'Subagent Kind',
      strategy: 'spread',
    })
    expect(fresh.selectionKind).toBe('initial')
    expect(fresh.previousAccountId).toBeUndefined()

    const movedFrom = fresh.accountId
    const replacement = moduleUnderTest.failoverCodexLease(
      'subagent-kind',
      movedFrom,
      'usage cap 429',
    )
    expect(replacement.selectionKind).toBe('failover')
    expect(replacement.previousAccountId).toBe(movedFrom)
    expect(replacement.accountId).not.toBe(movedFrom)
    // The prose is unchanged, so nothing that logs it regresses.
    expect(replacement.selectionReason).toContain('failover from')
  })

  test('a manual switch-account records itself as manual, with the account it left', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({ accountId: 'main-account', alias: 'main' }),
        buildPoolAccount({ accountId: 'worker-a', alias: 'worker' }),
      ],
    })
    moduleUnderTest.seedCodexLeaseForTest({
      ownerId: 'main-thread',
      ownerType: 'main',
      ownerLabel: 'Main thread',
      accountId: 'worker-a',
      strategy: 'follow-main',
    })

    moduleUnderTest.reassignCodexLeaseToActiveAccount('main-thread')

    const lease = moduleUnderTest.getCodexLeaseForOwner('main-thread')
    expect(lease?.selectionKind).toBe('manual')
    expect(lease?.previousAccountId).toBe('worker-a')
    expect(lease?.accountId).toBe('main-account')
  })

  test('a snapshot with no real main lease reports the pool account as SYNTHETIC', () => {
    // Its timestamps are minted per snapshot, so anything that renders them as a
    // duration is showing a number that measures nothing. The kind is the marker
    // that lets the desktop projection drop the row instead of asserting it.
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [buildPoolAccount({ accountId: 'main-account', alias: 'main' })],
    })

    const first = moduleUnderTest.getCodexLeaseSnapshot().mainLease
    expect(first?.selectionKind).toBe('synthetic')
    expect(first?.ownerId).toBe('main-thread')

    // Proof that its createdAt measures nothing: a second read re-mints it.
    const second = moduleUnderTest.getCodexLeaseSnapshot().mainLease
    expect(second?.createdAt).toBeGreaterThanOrEqual(first?.createdAt ?? 0)

    // A real registered main lease is NOT synthetic, and keeps its own timestamp.
    moduleUnderTest.seedCodexLeaseForTest({
      ownerId: 'main-thread',
      ownerType: 'main',
      ownerLabel: 'Main thread',
      accountId: 'main-account',
      strategy: 'follow-main',
    })
    expect(moduleUnderTest.getCodexLeaseSnapshot().mainLease?.selectionKind).toBe(
      'initial',
    )
  })
})
