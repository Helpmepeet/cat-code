import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  getPoolStatus,
  isCodexAccountSwitchable,
  resetCodexAccountPoolForTest,
  seedCodexAccountPoolForTest,
  type PoolAccount,
} from './codexAccountPool.js'
import {
  _resetAccountDiagnosticStreamJsonHookForTesting,
  installStreamJsonAccountDiagnosticHook,
} from './accountDiagnostics.js'
import {
  resetCodexLeaseManagerForTest,
  seedCodexLeaseForTest,
} from './codexAccountLeaseManager.js'
import {
  buildPoolUsageDisplayAccounts,
  emitCachedUsageWarningsForActiveSink,
  fetchPoolUsage,
  formatPoolUsage,
  invalidateUsageCache,
  consumeUsageLimitReset,
  schedulePoolUsageRefresh,
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
    planType: overrides.planType,
    planExpiresAt: overrides.planExpiresAt,
    lastError: overrides.lastError,
    usagePrimary: overrides.usagePrimary,
    usageWeekly: overrides.usageWeekly,
    usageFetchedAt: overrides.usageFetchedAt,
    usageAllowed: overrides.usageAllowed,
    usageLimitReached: overrides.usageLimitReached,
    usageResetAt: overrides.usageResetAt,
    statusReason: overrides.statusReason,
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
    resetCodexLeaseManagerForTest()
    _resetAccountDiagnosticStreamJsonHookForTesting()
    invalidateUsageCache()
  })

  afterEach(() => {
    resetCodexLeaseManagerForTest()
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
        availabilityWarnings: [],
        usage: null,
        error: 'HTTP 401',
      },
      {
        accountId: 'capped-account',
        alias: 'backup2',
        isActive: false,
        status: 'capped',
        availabilityWarnings: [],
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
        availabilityWarnings: [],
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

  test('fetchPoolUsage records usage caps without mutating account status', async () => {
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
      await fetchPoolUsage({ forceRefresh: true, updateRoutingHints: true })
    } finally {
      globalThis.fetch = originalFetch
      invalidateUsageCache()
    }

    const status = getPoolStatus()
    const account = status.accounts.find((a) => a.accountId === 'main-account')
    expect(account?.status).toBe('healthy')
    expect(account?.usageAllowed).toBe(false)
    expect(account?.usageLimitReached).toBe(true)
    expect(account ? isCodexAccountSwitchable(account) : false).toBe(false)
  })

  test('routing-hint path unblocks when the 5h window has reset even if the weekly window has not', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({ accountId: 'main-account', alias: 'main' }),
      ],
    })

    const nowSeconds = Math.floor(Date.now() / 1000)
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
              reset_after_seconds: 0,
              reset_at: nowSeconds - 60, // 5h window reset a minute ago
            },
            secondary_window: {
              used_percent: 40,
              limit_window_seconds: 604800,
              reset_after_seconds: 300000,
              reset_at: nowSeconds + 300_000, // weekly window resets days out
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof globalThis.fetch

    invalidateUsageCache()
    try {
      await fetchPoolUsage({ forceRefresh: true, updateRoutingHints: true })
    } finally {
      globalThis.fetch = originalFetch
      invalidateUsageCache()
    }

    const account = getPoolStatus().accounts.find((a) => a.accountId === 'main-account')
    // Gating on the primary reset (not max across windows) lets the account
    // route again now that the 5h window has reset.
    expect(account ? isCodexAccountSwitchable(account) : false).toBe(true)
  })

  test('fetchPoolUsage parses a free/capped account with a null secondary window', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({ accountId: 'free-account', alias: 'hiby', planType: 'free' }),
      ],
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          user_id: 'u1',
          email: 'hiby@example.com',
          plan_type: 'free',
          rate_limit: {
            allowed: false,
            limit_reached: true,
            primary_window: {
              used_percent: 100,
              limit_window_seconds: 2592000,
              reset_after_seconds: 2427459,
              reset_at: 0,
            },
            // Free plans return a null secondary window; the capped signal must
            // still survive instead of collapsing the whole response to null.
            secondary_window: null,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof globalThis.fetch

    invalidateUsageCache()
    let snapshot: PoolUsageSnapshot
    try {
      snapshot = await fetchPoolUsage({ forceRefresh: true, updateRoutingHints: true })
    } finally {
      globalThis.fetch = originalFetch
      invalidateUsageCache()
    }

    expect(snapshot.errors).toEqual([])
    expect(snapshot.accounts).toHaveLength(1)
    const usage = snapshot.accounts[0]!
    expect(usage.allowed).toBe(false)
    expect(usage.limitReached).toBe(true)
    expect(usage.primaryWindow.usedPercent).toBe(100)
    expect(usage.secondaryWindow.usedPercent).toBe(0)

    const account = getPoolStatus().accounts.find((a) => a.accountId === 'free-account')
    expect(account ? isCodexAccountSwitchable(account) : true).toBe(false)
  })

  test('fetchPoolUsage treats a response without rate_limit as an error', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({ accountId: 'eligibility-only', alias: 'creds' }),
      ],
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          user_id: 'u1',
          email: 'creds@example.com',
          plan_type: 'free',
          credits: { has_credits: false, unlimited: false, balance: null },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof globalThis.fetch

    invalidateUsageCache()
    let snapshot: PoolUsageSnapshot
    try {
      snapshot = await fetchPoolUsage({ forceRefresh: true })
    } finally {
      globalThis.fetch = originalFetch
      invalidateUsageCache()
    }

    expect(snapshot.accounts).toHaveLength(0)
    expect(snapshot.errors).toEqual([
      { accountId: 'eligibility-only', error: 'Unexpected usage response' },
    ])
  })

  test('fetchPoolUsage sends the ChatGPT account selector', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({ accountId: 'main-account', alias: 'main' }),
      ],
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_input, init) => {
      const headers = new Headers(init?.headers)
      expect(headers.get('Authorization')).toBe('Bearer access-main-account')
      expect(headers.get('chatgpt-account-id')).toBe('main-account')
      expect(headers.get('originator')).toBe('codex_cli_rs')
      expect(headers.get('Accept')).toBe('application/json')
      return new Response(
        JSON.stringify({
          user_id: 'u',
          email: 'main@example.com',
          plan_type: 'plus',
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: {
              used_percent: 10,
              limit_window_seconds: 18000,
              reset_after_seconds: 60,
              reset_at: 0,
            },
            secondary_window: {
              used_percent: 20,
              limit_window_seconds: 604800,
              reset_after_seconds: 0,
              reset_at: 0,
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof globalThis.fetch

    invalidateUsageCache()
    try {
      const snapshot = await fetchPoolUsage(true)
      expect(snapshot.errors).toEqual([])
      expect(snapshot.accounts).toHaveLength(1)
    } finally {
      globalThis.fetch = originalFetch
      invalidateUsageCache()
    }
  })

  test('fetchPoolUsage parses reset credit availability without changing existing usage fields', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'with-credits',
      accounts: [
        buildPoolAccount({ accountId: 'with-credits' }),
        buildPoolAccount({ accountId: 'without-field' }),
        buildPoolAccount({ accountId: 'null-field' }),
        buildPoolAccount({ accountId: 'malformed-field' }),
      ],
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_input, init) => {
      const accountId = new Headers(init?.headers).get('chatgpt-account-id') ?? ''
      const resetCredits =
        accountId === 'with-credits'
          ? { available_count: 2 }
          : accountId === 'null-field'
            ? null
            : accountId === 'malformed-field'
              ? { available_count: '2' }
              : undefined
      return new Response(
        JSON.stringify({
          user_id: `user-${accountId}`,
          email: `${accountId}@example.com`,
          plan_type: 'plus',
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: {
              used_percent: 10,
              limit_window_seconds: 18000,
              reset_after_seconds: 60,
              reset_at: 0,
            },
            secondary_window: {
              used_percent: 20,
              limit_window_seconds: 604800,
              reset_after_seconds: 0,
              reset_at: 0,
            },
          },
          ...(resetCredits !== undefined
            ? { rate_limit_reset_credits: resetCredits }
            : {}),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof globalThis.fetch

    try {
      const snapshot = await fetchPoolUsage(true)
      const byId = new Map(snapshot.accounts.map((usage) => [usage.accountId, usage]))
      expect(byId.get('with-credits')?.resetCreditsAvailable).toBe(2)
      expect(byId.get('without-field')?.resetCreditsAvailable).toBeUndefined()
      expect(byId.get('null-field')?.resetCreditsAvailable).toBeUndefined()
      expect(byId.get('malformed-field')?.resetCreditsAvailable).toBeUndefined()
      expect(byId.get('with-credits')?.primaryWindow.usedPercent).toBe(10)
      expect(byId.get('with-credits')?.secondaryWindow.usedPercent).toBe(20)
    } finally {
      globalThis.fetch = originalFetch
      invalidateUsageCache()
    }
  })

  test('fetchPoolUsage reports an aborted availability read as a fetch error', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'timeout-account',
      accounts: [
        buildPoolAccount({ accountId: 'timeout-account' }),
      ],
    })

    const originalFetch = globalThis.fetch
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((callback: TimerHandler) => {
      if (typeof callback === 'function') callback()
      return 1 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout
    globalThis.fetch = (async (_input, init) => {
      const signal = init?.signal
      if (signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError')
      }
      throw new Error('expected abort')
    }) as unknown as typeof globalThis.fetch

    try {
      const snapshot = await fetchPoolUsage(true)
      expect(snapshot.accounts).toEqual([])
      expect(snapshot.errors).toEqual([
        { accountId: 'timeout-account', error: 'The operation was aborted.' },
      ])
    } finally {
      globalThis.fetch = originalFetch
      globalThis.setTimeout = originalSetTimeout
      invalidateUsageCache()
    }
  })

  test('consumeUsageLimitReset posts the idempotency key without an originator header', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
      expect(input).toBe('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume')
      expect(init?.method).toBe('POST')
      expect(init?.body).toBe(JSON.stringify({ redeem_request_id: 'redeem-123' }))
      const headers = new Headers(init?.headers)
      expect(headers.get('Authorization')).toBe('Bearer access-main')
      expect(headers.get('chatgpt-account-id')).toBe('main-account')
      expect(headers.get('Content-Type')).toBe('application/json')
      expect(headers.get('Accept')).toBe('application/json')
      expect(headers.has('originator')).toBe(false)
      return new Response(
        JSON.stringify({ code: 'reset', windows_reset: 2 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof globalThis.fetch

    try {
      await expect(
        consumeUsageLimitReset(
          { accountId: 'main-account', accessToken: 'access-main' },
          'redeem-123',
        ),
      ).resolves.toEqual({ kind: 'reset', windowsReset: 2 })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('consumeUsageLimitReset maps known response codes to outcomes', async () => {
    const cases = [
      [{ code: 'reset', windows_reset: 1 }, { kind: 'reset', windowsReset: 1 }],
      [{ code: 'already_redeemed', windows_reset: 3 }, { kind: 'already_redeemed', windowsReset: 3 }],
      [{ code: 'nothing_to_reset', windows_reset: 0 }, { kind: 'nothing_to_reset' }],
      [{ code: 'no_credit', windows_reset: 0 }, { kind: 'no_credit' }],
    ] as const

    const originalFetch = globalThis.fetch
    try {
      for (const [body, expected] of cases) {
        globalThis.fetch = (async () =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })) as unknown as typeof globalThis.fetch

        await expect(
          consumeUsageLimitReset(
            { accountId: 'main-account', accessToken: 'access-main' },
            'redeem-123',
          ),
        ).resolves.toEqual(expected)
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('consumeUsageLimitReset defaults a missing windows_reset to zero for reset outcomes', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: 'reset' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof globalThis.fetch

    try {
      await expect(
        consumeUsageLimitReset(
          { accountId: 'main-account', accessToken: 'access-main' },
          'redeem-123',
        ),
      ).resolves.toEqual({ kind: 'reset', windowsReset: 0 })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('consumeUsageLimitReset rejects unknown success codes and malformed windows_reset values', async () => {
    const bodies = [
      null,
      { code: 'unexpected', windows_reset: 1 },
      { code: 'reset', windows_reset: null },
      { code: 'reset', windows_reset: '1' },
    ]

    const originalFetch = globalThis.fetch
    try {
      for (const body of bodies) {
        globalThis.fetch = (async () =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })) as unknown as typeof globalThis.fetch

        const outcome = await consumeUsageLimitReset(
          { accountId: 'main-account', accessToken: 'access-main' },
          'redeem-123',
        )
        expect(outcome.kind).toBe('invalid_response')
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('consumeUsageLimitReset returns http_error for non-2xx responses', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('not authorized', { status: 401 })) as unknown as typeof globalThis.fetch

    try {
      await expect(
        consumeUsageLimitReset(
          { accountId: 'main-account', accessToken: 'access-main' },
          'redeem-123',
        ),
      ).resolves.toEqual({
        kind: 'http_error',
        status: 401,
        bodySnippet: 'not authorized',
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('consumeUsageLimitReset returns network_error when fetch throws', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error('socket closed')
    }) as unknown as typeof globalThis.fetch

    try {
      await expect(
        consumeUsageLimitReset(
          { accountId: 'main-account', accessToken: 'access-main' },
          'redeem-123',
        ),
      ).resolves.toEqual({
        kind: 'network_error',
        error: 'socket closed',
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('consumeUsageLimitReset returns network_error when the consume request times out', async () => {
    const originalFetch = globalThis.fetch
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((callback: TimerHandler) => {
      if (typeof callback === 'function') callback()
      return 1 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout
    globalThis.fetch = (async (_input, init) => {
      const signal = init?.signal
      if (signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError')
      }
      throw new Error('expected abort')
    }) as unknown as typeof globalThis.fetch

    try {
      await expect(
        consumeUsageLimitReset(
          { accountId: 'main-account', accessToken: 'access-main' },
          'redeem-123',
        ),
      ).resolves.toEqual({
        kind: 'network_error',
        error: 'The operation was aborted.',
      })
    } finally {
      globalThis.fetch = originalFetch
      globalThis.setTimeout = originalSetTimeout
    }
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

  test('cached fetchPoolUsage records availability when updateRoutingHints is requested later', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({ accountId: 'main-account', alias: 'main' }),
      ],
    })

    const originalFetch = globalThis.fetch
    let fetchCount = 0
    globalThis.fetch = (async () => {
      fetchCount += 1
      return new Response(
        JSON.stringify({
          user_id: 'u',
          email: 'x@example.com',
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
      )
    }) as unknown as typeof globalThis.fetch

    try {
      await fetchPoolUsage(true)
      await fetchPoolUsage({ updateRoutingHints: true })
    } finally {
      globalThis.fetch = originalFetch
      invalidateUsageCache()
    }

    const account = getPoolStatus().accounts.find((a) => a.accountId === 'main-account')
    expect(fetchCount).toBe(1)
    expect(account?.usageAllowed).toBe(false)
    expect(account?.usageLimitReached).toBe(true)
  })

  test('coalesces overlapping live usage fetches', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({ accountId: 'main-account', alias: 'main' }),
      ],
    })

    const originalFetch = globalThis.fetch
    let fetchCount = 0
    let resolveResponse: ((response: Response) => void) | undefined
    globalThis.fetch = (() => {
      fetchCount += 1
      return new Promise<Response>(resolve => {
        resolveResponse = resolve
      })
    }) as unknown as typeof globalThis.fetch

    try {
      const first = fetchPoolUsage({ forceRefresh: true })
      const second = fetchPoolUsage({ forceRefresh: true, updateRoutingHints: true })

      expect(fetchCount).toBe(1)
      resolveResponse?.(
        new Response(
          JSON.stringify({
            user_id: 'u',
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
        ),
      )

      await Promise.all([first, second])
    } finally {
      globalThis.fetch = originalFetch
      invalidateUsageCache()
    }

    const account = getPoolStatus().accounts.find((entry) => entry.accountId === 'main-account')
    expect(account?.usageLimitReached).toBe(true)
  })

  test('debounces a fresh usage poll after completed Codex turns', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({ accountId: 'main-account', alias: 'main' }),
      ],
    })

    const originalFetch = globalThis.fetch
    let fetchCount = 0
    globalThis.fetch = (async () => {
      fetchCount += 1
      return new Response(
        JSON.stringify({
          user_id: 'u',
          email: 'main@example.com',
          plan_type: 'plus',
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: {
              used_percent: fetchCount * 10,
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
      )
    }) as unknown as typeof globalThis.fetch

    try {
      await fetchPoolUsage()
      schedulePoolUsageRefresh()
      schedulePoolUsageRefresh()
      await new Promise(resolve => setTimeout(resolve, 1_100))
    } finally {
      globalThis.fetch = originalFetch
      invalidateUsageCache()
    }

    expect(fetchCount).toBe(2)
  })

  test('fetchPoolUsage clears only usage-derived capped status when live usage is allowed', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({
          accountId: 'main-account',
          alias: 'main',
          status: 'capped',
          statusReason: 'usage_cap',
          lastError: 'Usage cap hit (429)',
        }),
        buildPoolAccount({
          accountId: 'plan-account',
          alias: 'plan',
          status: 'capped',
          statusReason: 'runtime_cap',
          lastError: 'Runtime turn failure (429)',
        }),
        buildPoolAccount({
          accountId: 'dead-account',
          alias: 'dead',
          status: 'dead',
          statusReason: 'auth_dead',
          lastError: 'Token refresh failed',
        }),
      ],
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_input, init) => {
      const authHeader = new Headers(init?.headers).get('Authorization')
      const accountId = authHeader?.replace('Bearer access-', '') ?? 'main-account'
      return new Response(
        JSON.stringify({
          user_id: `u-${accountId}`,
          email: `${accountId}@example.com`,
          plan_type: 'plus',
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: {
              used_percent: 10,
              limit_window_seconds: 18000,
              reset_after_seconds: 60,
              reset_at: 0,
            },
            secondary_window: {
              used_percent: 20,
              limit_window_seconds: 604800,
              reset_after_seconds: 0,
              reset_at: 0,
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof globalThis.fetch

    try {
      await fetchPoolUsage({ forceRefresh: true, updateRoutingHints: true })
    } finally {
      globalThis.fetch = originalFetch
      invalidateUsageCache()
    }

    const accounts = getPoolStatus().accounts
    const main = accounts.find((a) => a.accountId === 'main-account')
    const plan = accounts.find((a) => a.accountId === 'plan-account')
    const dead = accounts.find((a) => a.accountId === 'dead-account')
    expect(main?.status).toBe('healthy')
    expect(main?.statusReason).toBeUndefined()
    expect(main?.lastError).toBeUndefined()
    expect(plan?.status).toBe('capped')
    expect(plan?.statusReason).toBe('runtime_cap')
    expect(dead?.status).toBe('dead')
    expect(dead?.statusReason).toBe('auth_dead')
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
          quarantined: 0,
          dead: 0,
          locked: 0,
        },
      }),
    ])
    expect(JSON.stringify(emitted)).not.toContain('near-cap-account')
    expect(JSON.stringify(emitted)).not.toContain('primary')
    expect(JSON.stringify(emitted)).not.toContain('near-cap@example.com')
  })

  test('emits a cached usage warning after a stream-json sink is installed without refetching', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'cached-near-cap-account',
      accounts: [
        buildPoolAccount({ accountId: 'cached-near-cap-account', alias: 'primary' }),
      ],
    })

    const originalFetch = globalThis.fetch
    let fetchCount = 0
    globalThis.fetch = (async () => {
      fetchCount += 1
      return new Response(
        JSON.stringify({
          user_id: 'user-cached-near-cap',
          email: 'cached-near-cap@example.com',
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
      )
    }) as unknown as typeof globalThis.fetch

    const emitted: unknown[] = []
    try {
      await fetchPoolUsage(true)
      installStreamJsonAccountDiagnosticHook({
        emit: message => {
          emitted.push(message)
        },
        getSessionId: () => 'cached-usage-warning-session',
        createUuid: () => `cached-usage-warning-${emitted.length + 1}`,
      })

      emitCachedUsageWarningsForActiveSink()
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(fetchCount).toBe(1)
    expect(emitted).toEqual([
      expect.objectContaining({
        code: 'account.usage.warning',
        severity: 'warning',
        provider: 'openai',
        recoverable: true,
        account_ref: 'codex#1',
      }),
    ])
    expect(JSON.stringify(emitted)).not.toContain('cached-near-cap-account')
    expect(JSON.stringify(emitted)).not.toContain('primary')
    expect(JSON.stringify(emitted)).not.toContain('cached-near-cap@example.com')
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

    expect(output).toContain('● main  [Ready]')
    expect(output).toContain('  backup2  [Limit reached (resets in unknown)]')
    expect(output).toContain('  backup1  [Ready]')
    expect(output).toContain('usage      unavailable (HTTP 401)')
    expect(output).toContain('3 accounts, 2 routable, 2 with usage data, 1 Limit reached, 1 usage unavailable')
  })

  test('formatPoolUsage marks the main lease account active before pool activeIndex', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'pool-active',
      accounts: [
        buildPoolAccount({ accountId: 'pool-active', alias: 'pool' }),
        buildPoolAccount({ accountId: 'lease-active', alias: 'leased' }),
      ],
    })
    seedCodexLeaseForTest({
      ownerId: 'main-thread',
      ownerType: 'main',
      ownerLabel: 'Main thread',
      accountId: 'lease-active',
      strategy: 'follow-main',
    })

    const output = formatPoolUsage({
      accounts: [
        buildUsage('pool-active', 10, 10),
        buildUsage('lease-active', 20, 20),
      ],
      fetchedAt: Date.now(),
      errors: [],
    })

    expect(output).toContain('  pool  [Ready]')
    expect(output).toContain('● leased  [Ready]')
  })

  test('formatPoolUsage omits the weekly row when the secondary window is absent', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'free-account',
      accounts: [buildPoolAccount({ accountId: 'free-account', alias: 'hiby' })],
    })

    const output = formatPoolUsage({
      accounts: [
        buildUsage('free-account', 100, 0, {
          allowed: false,
          limitReached: true,
          hasSecondaryWindow: false,
        }),
      ],
      fetchedAt: Date.now(),
      errors: [],
    })

    expect(output).toContain('5h')
    expect(output).not.toContain('7d')
  })

  test('formatPoolUsage shows no Codex access for a free plan instead of usage bars', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'free-account',
      accounts: [buildPoolAccount({ accountId: 'free-account', alias: 'hiby', planType: 'free' })],
    })

    const output = formatPoolUsage({
      accounts: [
        buildUsage('free-account', 100, 0, {
          planType: 'free',
          allowed: false,
          limitReached: true,
          hasSecondaryWindow: false,
        }),
      ],
      fetchedAt: Date.now(),
      errors: [],
    })

    expect(output).toContain('[free — no Codex access]')
    expect(output).toContain('upgrade to a paid plan to use Codex')
    // No usage bars or reset timers for a plan that has no quota.
    expect(output).not.toContain('5h')
    expect(output).not.toContain('7d')
    expect(output).not.toContain('Limit reached')
  })

  test('formatPoolUsage keeps the weekly row when the secondary window is present', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'paid-account',
      accounts: [buildPoolAccount({ accountId: 'paid-account', alias: 'main' })],
    })

    const output = formatPoolUsage({
      accounts: [buildUsage('paid-account', 10, 40)],
      fetchedAt: Date.now(),
      errors: [],
    })

    expect(output).toContain('5h')
    expect(output).toContain('7d')
  })

  test('formatPoolUsage shows shared availability status even when live usage is available', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({ accountId: 'main-account', alias: 'main' }),
        buildPoolAccount({
          accountId: 'blocked-account',
          alias: 'blocked',
          status: 'capped',
          statusReason: 'usage_cap',
          lastError: 'Usage cap hit (429)',
        }),
      ],
    })

    const output = formatPoolUsage({
      accounts: [
        buildUsage('main-account', 10, 40),
        buildUsage('blocked-account', 1, 72, { allowed: true, limitReached: false }),
      ],
      fetchedAt: Date.now(),
      errors: [],
    })

    expect(output).toContain('blocked  [Limit reached (resets in unknown)]')
    expect(output).toContain('reason: Usage cap hit (429)')
  })

  test('formatPoolUsage separates routability from quota data in the summary', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({ accountId: 'main-account', alias: 'main' }),
        buildPoolAccount({
          accountId: 'dead-account',
          alias: 'dead',
          status: 'dead',
          statusReason: 'auth_dead',
          lastError: 'http_401',
        }),
        buildPoolAccount({ accountId: 'unknown-account', alias: 'unknown' }),
      ],
    })

    const output = formatPoolUsage({
      accounts: [
        buildUsage('main-account', 10, 40),
        buildUsage('dead-account', 1, 20, { allowed: true, limitReached: false }),
      ],
      fetchedAt: Date.now(),
      errors: [
        { accountId: 'unknown-account', error: 'Unexpected usage response' },
      ],
    })

    expect(output).toContain('dead  [Needs re-login]')
    expect(output).toContain('reason: Token refresh failed: HTTP 401')
    expect(output).toContain('3 accounts, 2 routable, 2 with usage data, 1 usage unavailable')
    expect(output).not.toContain('2 available')
  })

  test('formatPoolUsage shows stale plan metadata as a warning on a switchable account', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({
          accountId: 'main-account',
          alias: 'main',
          planType: 'plus',
          planExpiresAt: '2026-04-12T03:30:01+00:00',
        }),
      ],
    })

    const output = formatPoolUsage({
      accounts: [buildUsage('main-account', 1, 72, { allowed: true, limitReached: false })],
      fetchedAt: Date.now(),
      errors: [],
    })

    expect(output).toContain('● main')
    expect(output).toContain('[Ready]')
    expect(output).toContain(
      'warning: saved plan metadata says expired (2026-04-12T03:30:01+00:00); live usage decides availability',
    )
  })
})
