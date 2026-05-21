import { afterEach, describe, expect, test } from 'bun:test'

import {
  createCodexLeaseForTest,
  resetCodexLeaseManagerForTest,
  getCodexLeaseForOwner,
  seedCodexLeaseForTest,
} from '../../services/api/codexAccountLeaseManager.js'
import {
  getPoolStatus,
  resetCodexAccountPoolForTest,
  seedCodexAccountPoolForTest,
  type PoolAccount,
} from '../../services/api/codexAccountPool.js'
import { invalidateUsageCache } from '../../services/api/codexUsage.js'
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

  test('usage display remains observational and does not reroll the active Codex account', async () => {
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
    expect(mainAccount?.usagePrimary).toBeUndefined()
  })

  test('usage display does not change next spread lease selection', async () => {
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
    expect(afterProbe.accountId).toBe('worker-old')
    expect(getCodexLeaseForOwner('main-thread')?.accountId).toBe('main-account')
  })
})
