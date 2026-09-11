import { afterEach, describe, expect, test } from 'bun:test'

import {
  createCodexLeaseForTest,
  resetCodexLeaseManagerForTest,
  getCodexLeaseForOwner,
  seedCodexLeaseForTest,
} from '../../services/api/codexAccountLeaseManager.js'
import {
  getPoolStatus,
  isCodexAccountSwitchable,
  resetCodexAccountPoolForTest,
  seedCodexAccountPoolForTest,
  type PoolAccount,
} from '../../services/api/codexAccountPool.js'
import { fetchPoolUsage, invalidateUsageCache } from '../../services/api/codexUsage.js'
import { call } from './accounts.js'

function createCodexAccount(
  accountId: string,
  alias: string,
  lastUsedAt = 0,
): PoolAccount {
  return {
    accountId,
    accessToken: `${accountId}-access`,
    refreshToken: `${accountId}-refresh`,
    expiresAt: Date.now() + 60_000,
    source: 'vault',
    status: 'healthy',
    lastUsedAt,
    credentialGeneration: 0,
    credentialGenerationState: 'legacy_unbound',
    alias,
  }
}

function usageResponse(accountId: string, usedPercent: number): Response {
  return new Response(
    JSON.stringify({
      user_id: `user-${accountId}`,
      email: `${accountId}@example.com`,
      plan_type: 'pro',
      rate_limit: {
        allowed: usedPercent < 100,
        limit_reached: usedPercent >= 100,
        primary_window: {
          used_percent: usedPercent,
          limit_window_seconds: 18000,
          reset_after_seconds: 60,
          reset_at: Date.now() + 60_000,
        },
        secondary_window: {
          used_percent: usedPercent,
          limit_window_seconds: 604800,
          reset_after_seconds: 3600,
          reset_at: Date.now() + 3_600_000,
        },
      },
      credits: {
        has_credits: usedPercent < 100,
        unlimited: false,
        balance: usedPercent >= 100 ? '0' : '10',
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

describe('/accounts', () => {
  const realFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = realFetch
    invalidateUsageCache()
    resetCodexAccountPoolForTest()
    resetCodexLeaseManagerForTest()
  })

  test('usage display records availability without rerolling the active Codex account', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        createCodexAccount('main-account', 'main', 0),
        createCodexAccount('backup-account', 'backup', 10),
      ],
    })

    globalThis.fetch = (async (_input, init) => {
      const authHeader = new Headers(init?.headers).get('Authorization')
      if (authHeader === 'Bearer main-account-access') {
        return usageResponse('main-account', 100)
      }
      return usageResponse('backup-account', 10)
    }) as typeof globalThis.fetch

    const result = await call('', {} as Parameters<typeof call>[1])

    expect(result.type).toBe('text')
    expect(result.value).toContain('main')
    const pool = getPoolStatus()
    expect(pool.accounts[pool.activeIndex]?.accountId).toBe('main-account')
    const mainAccount = pool.accounts.find(account => account.accountId === 'main-account')
    expect(mainAccount?.status).toBe('healthy')
    expect(mainAccount?.usagePrimary).toBe(100)
    expect(mainAccount?.usageLimitReached).toBe(true)
    expect(mainAccount ? isCodexAccountSwitchable(mainAccount) : false).toBe(false)
  })

  test('bypasses a cached usage snapshot', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [createCodexAccount('main-account', 'main')],
    })

    let fetchCount = 0
    globalThis.fetch = (async () => {
      fetchCount += 1
      return usageResponse('main-account', fetchCount === 1 ? 10 : 20)
    }) as typeof globalThis.fetch

    await fetchPoolUsage()
    const result = await call('', {} as Parameters<typeof call>[1])

    expect(fetchCount).toBe(2)
    expect(result.value).toContain('20%')
  })

  test('usage display records availability for later spread lease selection', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        createCodexAccount('main-account', 'main', 20),
        createCodexAccount('worker-old', 'old', 0),
        createCodexAccount('worker-new', 'new', 10),
      ],
    })

    seedCodexLeaseForTest({
      ownerId: 'main-thread',
      ownerType: 'main',
      ownerLabel: 'Main thread',
      accountId: 'main-account',
      strategy: 'follow-main',
    })

    globalThis.fetch = (async (_input, init) => {
      const authHeader = new Headers(init?.headers).get('Authorization')
      if (authHeader === 'Bearer worker-old-access') {
        return usageResponse('worker-old', 100)
      }
      if (authHeader === 'Bearer worker-new-access') {
        return usageResponse('worker-new', 0)
      }
      return usageResponse('main-account', 0)
    }) as typeof globalThis.fetch

    await call('', {} as Parameters<typeof call>[1])

    const afterProbe = createCodexLeaseForTest({
      ownerId: 'probe-after',
      ownerType: 'subagent',
      ownerLabel: 'Probe After',
      strategy: 'spread',
    })
    expect(afterProbe.accountId).toBe('worker-new')
    expect(getCodexLeaseForOwner('main-thread')?.accountId).toBe('main-account')
  })

  test('fallback display marks the main lease account active before pool activeIndex', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'pool-active',
      accounts: [
        createCodexAccount('pool-active', 'pool-active'),
        createCodexAccount('lease-active', 'lease-active'),
      ],
    })
    seedCodexLeaseForTest({
      ownerId: 'main-thread',
      ownerType: 'main',
      ownerLabel: 'Main thread',
      accountId: 'lease-active',
      strategy: 'follow-main',
    })

    globalThis.fetch = (async () =>
      new Response('unavailable', { status: 503 })) as unknown as typeof globalThis.fetch

    const result = await call('', {} as Parameters<typeof call>[1])

    if (result.type !== 'text') {
      throw new Error(`Expected text result, got ${result.type}`)
    }
    expect(result.value).toContain('  pool-active  [Ready]')
    expect(result.value).toContain('● lease-active  [Ready]')
  })

  test('fallback display uses shared availability labels for quarantined Codex accounts', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        createCodexAccount('main-account', 'main'),
        {
          ...createCodexAccount('quarantined-account', 'retrying'),
          status: 'quarantined',
          lastError: 'temporary connection failure',
        },
      ],
    })

    globalThis.fetch = (async () =>
      new Response('unavailable', { status: 503 })) as unknown as typeof globalThis.fetch

    const result = await call('', {} as Parameters<typeof call>[1])

    if (result.type !== 'text') {
      throw new Error(`Expected text result, got ${result.type}`)
    }
    expect(result.value).toContain('retrying  [Connection issue (retrying)]')
    expect(result.value).toContain('Total: 2 (1 Ready, 1 Connection issue (retrying))')
  })
})
