import { beforeEach, describe, expect, test } from 'bun:test'

import { setSessionProvider } from '../../bootstrap/state.js'
import { SettingsSchema } from '../../utils/settings/types.js'
import { getRetryOwnerId } from './claude.js'
import { createCodexFetch, CodexAccountCapError } from './codex-fetch-adapter.js'
import { classifyAPIError } from './errors.js'
import {
  getPoolStatus,
  markPoolAccountLastError,
  resetCodexAccountPoolForTest,
  seedCodexAccountPoolForTest,
} from './codexAccountPool.js'
import type { PoolAccount } from './codexAccountPool.js'
import { fetchPoolUsage, invalidateUsageCache } from './codexUsage.js'
import { CannotRetryError, withRetry } from './withRetry.js'

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
    expiresAt: overrides.expiresAt ?? Date.now() + 60_000,
    source: overrides.source ?? 'config',
    status: overrides.status ?? 'healthy',
    lastUsedAt: overrides.lastUsedAt ?? 0,
    turnsUsed: overrides.turnsUsed ?? 0,
    alias: overrides.alias,
    lastError: overrides.lastError,
    usagePrimary: overrides.usagePrimary,
    usageWeekly: overrides.usageWeekly,
    usageFetchedAt:
      'usageFetchedAt' in overrides ? overrides.usageFetchedAt : Date.now(),
  }
}

describe('codexAccountLeaseManager', () => {
  let moduleUnderTest: typeof import('./codexAccountLeaseManager.js')

  beforeEach(async () => {
    moduleUnderTest = await import('./codexAccountLeaseManager.js')
    setSessionProvider(null)
    resetCodexAccountPoolForTest()
    invalidateUsageCache()
    moduleUnderTest.resetCodexLeaseManagerForTest()
  })

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

  test('usage refresh marks limit-reached accounts capped before lease selection', async () => {
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
      await fetchPoolUsage(true)
    } finally {
      globalThis.fetch = realFetch
    }

    expect(getPoolStatus().accounts.find((account) => account.accountId === 'main-account'))
      .toMatchObject({
        status: 'capped',
        usagePrimary: 100,
      })

    const lease = moduleUnderTest.createCodexLeaseForTest({
      ownerId: 'usage-refreshed-subagent',
      ownerType: 'subagent',
      ownerLabel: 'Usage Refreshed Subagent',
      strategy: 'follow-main',
    })

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
        model: 'gpt-5.3-codex',
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
          model: 'gpt-5.3-codex',
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
      return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as typeof globalThis.fetch

    try {
      await moduleUnderTest.runWithCodexLeaseOwner('subagent-first-request', async () => {
        const codexFetch = createCodexFetch('fallback-access-token')
        await codexFetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.3-codex', _openaiInstructionAssembly: { instructions: 'test instructions', inputMessages: [] } }),
        })
      })
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(authorizationHeader).toBe(`Bearer ${buildCodexToken('worker-a')}`)
    expect(accountHeader).toBe('worker-a')
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
      return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as typeof globalThis.fetch

    try {
      const codexFetch = createCodexFetch(buildCodexToken('main-account'))

      await moduleUnderTest.runWithCodexLeaseOwner('lease-a', async () => {
        await codexFetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.3-codex', _openaiInstructionAssembly: { instructions: 'test instructions', inputMessages: [] } }),
        })
      })
      await moduleUnderTest.runWithCodexLeaseOwner('lease-b', async () => {
        await codexFetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.3-codex', _openaiInstructionAssembly: { instructions: 'test instructions', inputMessages: [] } }),
        })
      })
      await moduleUnderTest.runWithCodexLeaseOwner('lease-a', async () => {
        await codexFetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.3-codex', _openaiInstructionAssembly: { instructions: 'test instructions', inputMessages: [] } }),
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
        model: 'gpt-5.3-codex',
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
        model: 'gpt-5.3-codex',
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

  test('usage refresh marks limit-reached accounts capped before lease selection', async () => {
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
      await fetchPoolUsage(true)
    } finally {
      globalThis.fetch = realFetch
    }

    expect(getPoolStatus().accounts.find((account) => account.accountId === 'main-account'))
      .toMatchObject({
        status: 'capped',
        usagePrimary: 100,
      })

    const lease = moduleUnderTest.createCodexLeaseForTest({
      ownerId: 'usage-refreshed-subagent',
      ownerType: 'subagent',
      ownerLabel: 'Usage Refreshed Subagent',
      strategy: 'follow-main',
    })

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
        model: 'gpt-5.3-codex',
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
          model: 'gpt-5.3-codex',
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
      return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as typeof globalThis.fetch

    try {
      await moduleUnderTest.runWithCodexLeaseOwner('subagent-first-request', async () => {
        const codexFetch = createCodexFetch('fallback-access-token')
        await codexFetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.3-codex', _openaiInstructionAssembly: { instructions: 'test instructions', inputMessages: [] } }),
        })
      })
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(authorizationHeader).toBe(`Bearer ${buildCodexToken('worker-a')}`)
    expect(accountHeader).toBe('worker-a')
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
      return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as typeof globalThis.fetch

    try {
      const codexFetch = createCodexFetch(buildCodexToken('main-account'))

      await moduleUnderTest.runWithCodexLeaseOwner('lease-a', async () => {
        await codexFetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.3-codex', _openaiInstructionAssembly: { instructions: 'test instructions', inputMessages: [] } }),
        })
      })
      await moduleUnderTest.runWithCodexLeaseOwner('lease-b', async () => {
        await codexFetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.3-codex', _openaiInstructionAssembly: { instructions: 'test instructions', inputMessages: [] } }),
        })
      })
      await moduleUnderTest.runWithCodexLeaseOwner('lease-a', async () => {
        await codexFetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.3-codex', _openaiInstructionAssembly: { instructions: 'test instructions', inputMessages: [] } }),
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
      return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as typeof globalThis.fetch

    try {
      const codexFetch = createCodexFetch(buildCodexToken('main-account'))

      await moduleUnderTest.runWithCodexLeaseOwner('main-thread', async () => {
        await codexFetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.3-codex', _openaiInstructionAssembly: { instructions: 'test instructions', inputMessages: [] } }),
        })
      })
      await moduleUnderTest.runWithCodexLeaseOwner('subagent-a', async () => {
        await codexFetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.3-codex', _openaiInstructionAssembly: { instructions: 'test instructions', inputMessages: [] } }),
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
      return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as typeof globalThis.fetch

    try {
      const codexFetch = createCodexFetch(buildCodexToken('main-account'))

      await moduleUnderTest.runWithCodexLeaseOwner('main-thread', async () => {
        await codexFetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.3-codex', _openaiInstructionAssembly: { instructions: 'test instructions', inputMessages: [] } }),
        })
      })
      await moduleUnderTest.runWithCodexLeaseOwner('main-thread', async () => {
        await codexFetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.4', _openaiInstructionAssembly: { instructions: 'test instructions', inputMessages: [] } }),
        })
      })
      await moduleUnderTest.runWithCodexLeaseOwner('main-thread', async () => {
        await codexFetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.3-codex', _openaiInstructionAssembly: { instructions: 'test instructions', inputMessages: [] } }),
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
        model: 'gpt-5.3-codex',
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
        model: 'gpt-5.3-codex',
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
})
