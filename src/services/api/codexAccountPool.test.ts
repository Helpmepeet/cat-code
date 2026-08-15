import { beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { setIsInteractive, setSessionProvider } from '../../bootstrap/state.js'
import { getAccountInformation } from '../../utils/auth.js'
import {
  appendAccount,
  applyRedeemedUsageReset,
  describeCodexAccountAvailability,
  getCodexAccountAvailability,
  getCodexPlanMetadataFromIdToken,
  getPoolStatus,
  getRedemptionEligibility,
  isCodexAccountSwitchable,
  loadVaultAccountsForTest,
  markAccountDead,
  markPoolAccountCapped,
  mergePoolAccountsForTest,
  REDEEM_HINT_LAG_GRACE_MS,
  removeCodexAccount,
  resetCodexAccountPoolForTest,
  resolveCodexAccountByPrefix,
  saveCodexTokenToVault,
  seedCodexAccountPoolForTest,
  shouldRunStartupCodexTouchAll,
  switchToAccount,
  updateAccountUsageHints,
  type PoolAccount,
  type RedemptionEligibility,
} from './codexAccountPool.js'
import {
  _resetAccountDiagnosticStreamJsonHookForTesting,
  installStreamJsonAccountDiagnosticHook,
} from './accountDiagnostics.js'

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

function createIdToken(auth: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': auth,
    }),
  ).toString('base64url')
  return `${header}.${payload}.signature`
}

describe('codexAccountPool availability', () => {
  const NOW = Date.parse('2026-04-21T00:00:00+00:00')

  test('expired plan metadata is a warning, not a blocker', () => {
    const account = buildPoolAccount({
      accountId: 'plan-account',
      planType: 'plus',
      planExpiresAt: '2026-04-12T03:30:01+00:00',
    })

    expect(getCodexAccountAvailability(account, NOW)).toEqual({
      kind: 'warned',
      warnings: [
        {
          code: 'plan_metadata_expired',
          message: 'saved plan metadata says expired (2026-04-12T03:30:01+00:00); live usage decides availability',
        },
      ],
    })
    expect(isCodexAccountSwitchable(account, NOW)).toBe(true)
  })

  test('free plan metadata is a warning, not a blocker', () => {
    const account = buildPoolAccount({ accountId: 'free-account', planType: 'free' })

    expect(getCodexAccountAvailability(account, NOW)).toEqual({
      kind: 'warned',
      warnings: [
        {
          code: 'plan_metadata_ineligible',
          message: 'saved plan metadata says plan type free is not eligible for Codex; live usage decides availability',
        },
      ],
    })
  })

  test('future plan expiry is available with no warnings', () => {
    const account = buildPoolAccount({
      accountId: 'ok-account',
      planType: 'plus',
      planExpiresAt: '2999-01-01T00:00:00.000Z',
    })

    expect(getCodexAccountAvailability(account, NOW)).toEqual({ kind: 'available' })
  })

  test('runtime caps are blocked regardless of plan metadata', () => {
    const account = buildPoolAccount({
      accountId: 'capped-account',
      status: 'capped',
      statusReason: 'usage_cap',
      lastError: 'Usage cap hit (429)',
    })

    expect(getCodexAccountAvailability(account, NOW)).toEqual({
      kind: 'blocked',
      reason: 'Usage cap hit (429)',
    })
    expect(isCodexAccountSwitchable(account, NOW)).toBe(false)
  })

  test('a fresh hard-429 cap stays blocked even when a stale usageResetAt is already elapsed', () => {
    // The hard-429 path (markPoolAccountCapped) does not refresh usageResetAt, so
    // a prior elapsed reset can linger. It belongs to an earlier window, not this
    // cap, and must not silently unblock a just-capped account.
    const staleReset = buildPoolAccount({
      accountId: 'capped-stale-reset',
      status: 'capped',
      statusReason: 'usage_cap',
      lastError: 'Usage cap hit (429)',
      cappedAt: NOW,
      usageResetAt: Math.floor(NOW / 1000) - 3600, // reset an hour ago, before this cap
    })
    expect(getCodexAccountAvailability(staleReset, NOW)).toEqual({
      kind: 'blocked',
      reason: 'Usage cap hit (429)',
    })
    expect(isCodexAccountSwitchable(staleReset, NOW)).toBe(false)
  })

  test('a hard-429 cap whose post-cap reset window has elapsed becomes available', () => {
    const cappedAt = NOW - 90 * 60 * 1000
    const reset = buildPoolAccount({
      accountId: 'capped-reset-elapsed',
      status: 'capped',
      statusReason: 'usage_cap',
      lastError: 'Usage cap hit (429)',
      cappedAt,
      // reset was set after the cap (future at cap time) and has now elapsed
      usageResetAt: Math.floor((cappedAt + 60 * 60 * 1000) / 1000),
    })
    expect(getCodexAccountAvailability(reset, NOW)).toEqual({ kind: 'available' })
  })

  test('dead auth is blocked', () => {
    const account = buildPoolAccount({
      accountId: 'dead-account',
      status: 'dead',
      statusReason: 'auth_dead',
      lastError: 'Reauthentication required',
    })

    expect(getCodexAccountAvailability(account, NOW)).toEqual({
      kind: 'blocked',
      reason: 'Reauthentication required',
    })
  })

  test('quarantined transport failures are blocked with retry copy', () => {
    const account = buildPoolAccount({
      accountId: 'quarantined-account',
      status: 'quarantined',
      statusReason: 'probe_pending_transport',
    })

    expect(getCodexAccountAvailability(account, NOW)).toEqual({
      kind: 'blocked',
      reason: 'connection problem; retrying',
    })
    expect(isCodexAccountSwitchable(account, NOW)).toBe(false)
  })

  test('fresh blocked usage hints block a healthy account; stale hints do not', () => {
    const freshBlocked = buildPoolAccount({
      accountId: 'fresh-blocked',
      usageAllowed: false,
      usageLimitReached: true,
      usageFetchedAt: NOW - 1_000,
    })
    expect(getCodexAccountAvailability(freshBlocked, NOW)).toEqual({
      kind: 'blocked',
      reason: 'fresh usage data reports this account is capped',
    })

    const staleBlocked = buildPoolAccount({
      accountId: 'stale-blocked',
      usageAllowed: false,
      usageLimitReached: true,
      usageFetchedAt: NOW - 10 * 60 * 1000,
    })
    expect(getCodexAccountAvailability(staleBlocked, NOW)).toEqual({ kind: 'available' })

    // A fresh blocked hint whose reset window (seconds) has already elapsed must
    // not keep blocking — the window reset since the poll.
    const freshButReset = buildPoolAccount({
      accountId: 'fresh-but-reset',
      usageAllowed: false,
      usageLimitReached: true,
      usageFetchedAt: NOW - 1_000,
      usageResetAt: Math.floor(NOW / 1000) - 60, // reset 60s ago, in Unix seconds
    })
    expect(getCodexAccountAvailability(freshButReset, NOW)).toEqual({ kind: 'available' })

    // reset_at = 0 is the API's "unknown" sentinel; it must not unblock.
    const freshUnknownReset = buildPoolAccount({
      accountId: 'fresh-unknown-reset',
      usageAllowed: false,
      usageLimitReached: true,
      usageFetchedAt: NOW - 1_000,
      usageResetAt: 0,
    })
    expect(getCodexAccountAvailability(freshUnknownReset, NOW)).toEqual({
      kind: 'blocked',
      reason: 'fresh usage data reports this account is capped',
    })
  })


  test('describes shared account availability vocabulary', () => {
    expect(describeCodexAccountAvailability(
      buildPoolAccount({ accountId: 'healthy-account' }),
      { now: NOW },
    )).toBe('Ready')

    expect(describeCodexAccountAvailability(
      buildPoolAccount({
        accountId: 'capped-account',
        status: 'capped',
        statusReason: 'usage_cap',
        cappedAt: NOW - 1_000,
        usageResetAt: Math.floor((NOW + 90 * 60 * 1000) / 1000),
      }),
      { now: NOW },
    )).toBe('Limit reached (resets in 1h 30m)')

    expect(describeCodexAccountAvailability(
      buildPoolAccount({
        accountId: 'dead-account',
        status: 'dead',
        statusReason: 'auth_dead',
      }),
      { now: NOW },
    )).toBe('Needs re-login')

    expect(describeCodexAccountAvailability(
      buildPoolAccount({
        accountId: 'quarantined-account',
        status: 'quarantined',
        statusReason: 'probe_pending_transport',
      }),
      { now: NOW, format: 'bracket' },
    )).toBe('[Connection issue (retrying)]')
  })
})

describe('codexAccountPool appendAccount', () => {
  beforeEach(() => {
    resetCodexAccountPoolForTest()
    _resetAccountDiagnosticStreamJsonHookForTesting()
  })

  test('preserves capped status during token refresh updates', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({ accountId: 'main-account', alias: 'main' }),
        buildPoolAccount({
          accountId: 'backup-account',
          alias: 'backup2',
          status: 'capped',
          lastError: 'Usage snapshot reported account exhaustion',
          usagePrimary: 100,
        }),
      ],
    })

    appendAccount({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt: Date.now() + 120_000,
      accountId: 'backup-account',
    }, {
      preserveCapped: true,
    })

    const updated = getPoolStatus().accounts.find((account) => account.accountId === 'backup-account')
    expect(updated?.status).toBe('capped')
    expect(updated?.lastError).toBe('Usage snapshot reported account exhaustion')
    expect(updated?.accessToken).toBe('new-access')
    expect(updated?.refreshToken).toBe('new-refresh')
  })

  test('token refresh updates clear quarantine even when preserving caps', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({
          accountId: 'main-account',
          status: 'quarantined',
          statusReason: 'probe_pending_transport',
          lastError: 'connection problem; retrying',
        }),
      ],
    })

    appendAccount({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt: Date.now() + 120_000,
      accountId: 'main-account',
    }, {
      preserveCapped: true,
    })

    const updated = getPoolStatus().accounts.find((account) => account.accountId === 'main-account')
    expect(updated?.status).toBe('healthy')
    expect(updated?.statusReason).toBeUndefined()
    expect(updated?.lastError).toBeUndefined()
  })

  test('appendAccount updates plan metadata facts from a provided id_token', () => {
    seedCodexAccountPoolForTest({
      accounts: [
        buildPoolAccount({ accountId: 'acct-1', planType: 'plus', planExpiresAt: '2020-01-01T00:00:00.000Z' }),
      ],
    })

    appendAccount(
      {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresAt: Date.now() + 60_000,
        accountId: 'acct-1',
        idToken: createIdToken({
          chatgpt_plan_type: 'plus',
          chatgpt_subscription_active_until: '2999-01-01T00:00:00.000Z',
        }),
      },
      { preserveCapped: true, writer: 'test' },
    )

    const account = getPoolStatus().accounts[0]!
    expect(account.planType).toBe('plus')
    expect(account.planExpiresAt).toBe('2999-01-01T00:00:00.000Z')
  })

  test('markPoolAccountCapped emits a usage-cap diagnostic', () => {
    const emitted: unknown[] = []
    installStreamJsonAccountDiagnosticHook({
      emit: message => {
        emitted.push(message)
      },
      getSessionId: () => 'usage-cap-session',
      createUuid: () => `usage-cap-${emitted.length + 1}`,
    })
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({ accountId: 'main-account', alias: 'main' }),
        buildPoolAccount({ accountId: 'backup-account', alias: 'backup' }),
      ],
    })

    const { markPoolAccountCapped } = require('./codexAccountPool.js') as typeof import('./codexAccountPool.js')
    markPoolAccountCapped('backup-account', 'usage cap 429')

    expect(emitted.some(message =>
      (message as { code?: string }).code === 'account.usage.cap' &&
      (message as { account_ref?: string }).account_ref !== undefined &&
      (message as { reason?: string }).reason === 'usage cap 429',
    )).toBe(true)
  })

  test('appendAccount emits a usage-uncap diagnostic when a capped account becomes healthy', () => {
    const emitted: unknown[] = []
    installStreamJsonAccountDiagnosticHook({
      emit: message => {
        emitted.push(message)
      },
      getSessionId: () => 'usage-uncap-session',
      createUuid: () => `usage-uncap-${emitted.length + 1}`,
    })
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({ accountId: 'main-account', alias: 'main' }),
        buildPoolAccount({
          accountId: 'backup-account',
          alias: 'backup',
          status: 'capped',
          lastError: 'usage cap 429',
        }),
      ],
    })

    appendAccount({
      accessToken: 'fresh-access',
      refreshToken: 'fresh-refresh',
      expiresAt: Date.now() + 120_000,
      accountId: 'backup-account',
    })

    expect(emitted.some(message =>
      (message as { code?: string }).code === 'account.usage.uncap' &&
      (message as { account_ref?: string }).account_ref !== undefined,
    )).toBe(true)
  })

  test('updateAccountUsageHints does not uncap a hard-429 account from stale or in-grace usage data', () => {
    const now = Date.now()
    const cappedAt = now - 30_000 // capped 30s ago (inside the 2m grace)
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({ accountId: 'main-account', alias: 'main' }),
        buildPoolAccount({
          accountId: 'capped-account',
          alias: 'backup',
          status: 'capped',
          statusReason: 'usage_cap',
          cappedAt,
        }),
      ],
    })

    // A poll that resolved AFTER the cap but reports allowed:true. Its data is
    // pre-cap-lagging, so it must not resurrect the account while the cap is fresh.
    updateAccountUsageHints([
      {
        accountId: 'capped-account',
        primaryPercent: 10,
        weeklyPercent: 5,
        allowed: true,
        limitReached: false,
        fetchedAt: now,
      },
    ])
    const stillCapped = getPoolStatus().accounts.find(a => a.accountId === 'capped-account')
    expect(stillCapped?.status).toBe('capped')

    // A poll fetched BEFORE the cap must never uncap, regardless of grace.
    updateAccountUsageHints([
      {
        accountId: 'capped-account',
        primaryPercent: 10,
        weeklyPercent: 5,
        allowed: true,
        limitReached: false,
        fetchedAt: cappedAt - 10_000,
      },
    ])
    expect(getPoolStatus().accounts.find(a => a.accountId === 'capped-account')?.status).toBe('capped')

    // Isolate the timestamp-ordering guard: cap is PAST the grace window (so the
    // grace clause would permit uncap), but the poll was fetched BEFORE the cap.
    // Only the fetchedAt > cappedAt guard keeps this capped.
    const pastGraceCappedAt = now - 3 * 60 * 1000
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({ accountId: 'main-account', alias: 'main' }),
        buildPoolAccount({
          accountId: 'capped-account',
          alias: 'backup',
          status: 'capped',
          statusReason: 'usage_cap',
          cappedAt: pastGraceCappedAt,
        }),
      ],
    })
    updateAccountUsageHints([
      {
        accountId: 'capped-account',
        primaryPercent: 10,
        weeklyPercent: 5,
        allowed: true,
        limitReached: false,
        fetchedAt: pastGraceCappedAt - 10_000, // fetched before the cap
      },
    ])
    expect(getPoolStatus().accounts.find(a => a.accountId === 'capped-account')?.status).toBe('capped')

    // A genuinely newer poll, once the cap is older than the grace window,
    // clears the cap and cappedAt. Re-seed with a cap that is old in wall-clock
    // time (the grace clause compares Date.now() to cappedAt, not fetchedAt).
    const oldCappedAt = now - 3 * 60 * 1000 // capped 3m ago (past the 2m grace)
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({ accountId: 'main-account', alias: 'main' }),
        buildPoolAccount({
          accountId: 'capped-account',
          alias: 'backup',
          status: 'capped',
          statusReason: 'usage_cap',
          cappedAt: oldCappedAt,
        }),
      ],
    })
    updateAccountUsageHints([
      {
        accountId: 'capped-account',
        primaryPercent: 10,
        weeklyPercent: 5,
        allowed: true,
        limitReached: false,
        fetchedAt: oldCappedAt + 60_000, // fetched after the cap
      },
    ])
    const uncapped = getPoolStatus().accounts.find(a => a.accountId === 'capped-account')
    expect(uncapped?.status).toBe('healthy')
    expect(uncapped?.cappedAt).toBeUndefined()
  })

  test('successful refresh can revive dead accounts', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({ accountId: 'main-account', alias: 'main' }),
        buildPoolAccount({
          accountId: 'stale-account',
          alias: 'backup1',
          status: 'dead',
          lastError: 'Reauthentication required',
        }),
      ],
    })

    appendAccount({
      accessToken: 'fresh-access',
      refreshToken: 'fresh-refresh',
      expiresAt: Date.now() + 120_000,
      accountId: 'stale-account',
    }, {
      preserveCapped: true,
    })

    const updated = getPoolStatus().accounts.find((account) => account.accountId === 'stale-account')
    expect(updated?.status).toBe('healthy')
    expect(updated?.lastError).toBeUndefined()
  })

  test('removes inactive accounts without changing the active selection', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({ accountId: 'main-account', alias: 'main' }),
        buildPoolAccount({ accountId: 'backup-account', alias: 'backup2' }),
      ],
    })

    expect(removeCodexAccount('backup-account')).toBe(true)

    const status = getPoolStatus()
    expect(status.accounts.map((account) => account.accountId)).toEqual(['main-account'])
    expect(status.accounts[status.activeIndex]?.accountId).toBe('main-account')
  })

  test('removes the active account and promotes another healthy account', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'backup-account',
      accounts: [
        buildPoolAccount({ accountId: 'main-account', alias: 'main', lastUsedAt: 5 }),
        buildPoolAccount({ accountId: 'backup-account', alias: 'backup2', lastUsedAt: 10 }),
      ],
    })

    expect(removeCodexAccount('backup-account')).toBe(true)

    const status = getPoolStatus()
    expect(status.accounts.map((account) => account.accountId)).toEqual(['main-account'])
    expect(status.accounts[status.activeIndex]?.accountId).toBe('main-account')
  })

  test('markAccountDead reroll of active account emits account.active.reroll diagnostic', () => {
    const emittedMessages: unknown[] = []
    installStreamJsonAccountDiagnosticHook({
      emit: message => {
        emittedMessages.push(message)
      },
      getSessionId: () => 'active-reroll-session',
      createUuid: () => `active-reroll-${emittedMessages.length + 1}`,
    })

    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount({ accountId: 'main-account', alias: 'main', lastUsedAt: 10 }),
        buildPoolAccount({ accountId: 'backup-account', alias: 'backup', lastUsedAt: 0 }),
      ],
    })

    markAccountDead('main-account', 'refresh token rejected')

    expect(getPoolStatus().accounts[getPoolStatus().activeIndex]?.accountId).toBe(
      'backup-account',
    )
    expect(emittedMessages).toHaveLength(1)
    expect(emittedMessages[0]).toMatchObject({
      type: 'system',
      subtype: 'cat_code_account_diagnostic',
      code: 'account.active.reroll',
      severity: 'warning',
      provider: 'openai',
      recoverable: true,
      reason: 'markAccountDead: refresh token rejected',
    })
    expect((emittedMessages[0] as { from_account_ref?: string }).from_account_ref).toBeDefined()
    expect((emittedMessages[0] as { account_ref?: string }).account_ref).toBeDefined()
  })


  test('ignores the legacy config mirror when any vault account exists', () => {
    const merged = mergePoolAccountsForTest(
      [
        buildPoolAccount({
          accountId: 'vault-account',
          accessToken: 'vault-access',
          refreshToken: 'vault-refresh',
          source: 'vault',
        }),
      ],
      buildPoolAccount({
        accountId: 'config-only-account',
        accessToken: 'config-access',
        refreshToken: 'config-refresh',
        source: 'config',
      }),
    )

    expect(merged.map(account => account.accountId)).toEqual(['vault-account'])
  })

  test('uses the legacy config mirror only when there are no vault accounts', () => {
    const merged = mergePoolAccountsForTest(
      [],
      buildPoolAccount({
        accountId: 'config-only-account',
        accessToken: 'config-access',
        refreshToken: 'config-refresh',
        source: 'config',
      }),
    )

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      accountId: 'config-only-account',
      source: 'config',
      accessToken: 'config-access',
    })
  })

  test('startup touchAll is skipped for non-interactive print sessions', () => {
    setIsInteractive(false)
    expect(shouldRunStartupCodexTouchAll()).toBe(false)

    setIsInteractive(true)
    expect(shouldRunStartupCodexTouchAll()).toBe(true)

    setIsInteractive(false)
  })

  test('keeps the vault account unchanged when config contains the same account id', () => {
    const merged = mergePoolAccountsForTest(
      [
        buildPoolAccount({
          accountId: 'arm-account',
          accessToken: 'vault-access',
          refreshToken: 'vault-refresh',
          expiresAt: 111,
          alias: 'arm',
          source: 'vault',
          vaultFilePath: '/tmp/arm.json',
          lastRefreshIso: '2026-04-21T00:00:00.000Z',
          status: 'capped',
          lastError: 'Usage snapshot reported account exhaustion',
          usagePrimary: 100,
          usageWeekly: 80,
          usageFetchedAt: 123,
          lastErrorAt: 456,
        }),
      ],
      buildPoolAccount({
        accountId: 'arm-account',
        accessToken: 'config-access',
        refreshToken: 'config-refresh',
        expiresAt: 222,
      }),
    )

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      accountId: 'arm-account',
      alias: 'arm',
      source: 'vault',
      vaultFilePath: '/tmp/arm.json',
      lastRefreshIso: '2026-04-21T00:00:00.000Z',
      status: 'capped',
      lastError: 'Usage snapshot reported account exhaustion',
      usagePrimary: 100,
      usageWeekly: 80,
      usageFetchedAt: 123,
      lastErrorAt: 456,
      accessToken: 'vault-access',
      refreshToken: 'vault-refresh',
      expiresAt: 111,
    })
  })

  test('extracts plan metadata facts from id_token claims', () => {
    expect(
      getCodexPlanMetadataFromIdToken(
        createIdToken({
          chatgpt_plan_type: 'Plus',
          chatgpt_subscription_active_until: '2026-04-12T03:30:01+00:00',
        }),
      ),
    ).toEqual({ planType: 'plus', planExpiresAt: '2026-04-12T03:30:01+00:00' })

    expect(getCodexPlanMetadataFromIdToken(undefined)).toEqual({})
    expect(getCodexPlanMetadataFromIdToken('not-a-jwt')).toEqual({})
  })

  test('saveCodexTokenToVault preserves metadata for same account', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-pool-test-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })
    const filePath = join(accountsDir, '78c.json')
    writeFileSync(
      filePath,
      JSON.stringify(
        {
          tokens: {
            access_token: 'old-access',
            refresh_token: 'old-refresh',
            account_id: '78c15115-7a20-4568-9aec-cfa886dd71ae',
          },
          alias: 'main',
          created_at: '2026-04-01T00:00:00.000Z',
          profile_note: 'keep',
        },
        null,
        2,
      ),
      'utf-8',
    )

    const saved = saveCodexTokenToVault(
      {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        accountId: '78c15115-7a20-4568-9aec-cfa886dd71ae',
      },
      { filePath, writer: 'test' },
    )
    const written = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>
    const tokens = written.tokens as Record<string, unknown>

    expect(tokens.access_token).toBe('new-access')
    expect(tokens.refresh_token).toBe('new-refresh')
    expect(tokens.account_id).toBe('78c15115-7a20-4568-9aec-cfa886dd71ae')
    expect(written.alias).toBe('main')
    expect(written.created_at).toBe('2026-04-01T00:00:00.000Z')
    expect(written.profile_note).toBe('keep')
    expect(saved?.metadataAction).toBe('preserved')

    rmSync(dir, { recursive: true, force: true })
  })

  test('saveCodexTokenToVault identity change does not preserve alias', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-pool-test-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })
    const filePath = join(accountsDir, '80e.json')
    writeFileSync(
      filePath,
      JSON.stringify(
        {
          tokens: {
            access_token: 'old-access',
            refresh_token: 'old-refresh',
            account_id: '78c15115-7a20-4568-9aec-cfa886dd71ae',
          },
          alias: 'main',
          profile_note: 'drop',
        },
        null,
        2,
      ),
      'utf-8',
    )

    const saved = saveCodexTokenToVault(
      {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        accountId: '80ef361d-5bdc-411f-8bd1-a8fe2a0f18b3',
      },
      { filePath, writer: 'test' },
    )
    const written = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>
    const tokens = written.tokens as Record<string, unknown>

    expect(tokens.account_id).toBe('80ef361d-5bdc-411f-8bd1-a8fe2a0f18b3')
    expect(written.alias).toBeUndefined()
    expect(saved?.metadataAction).toBe('replaced')
    expect(saved?.accountChanged).toBe(true)

    rmSync(dir, { recursive: true, force: true })
  })

  test('saveCodexTokenToVault explicit alias overrides existing alias', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-pool-test-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })
    const filePath = join(accountsDir, '78c.json')
    writeFileSync(
      filePath,
      JSON.stringify(
        {
          tokens: {
            access_token: 'old-access',
            refresh_token: 'old-refresh',
            account_id: '78c15115-7a20-4568-9aec-cfa886dd71ae',
          },
          alias: 'main',
        },
        null,
        2,
      ),
      'utf-8',
    )

    const saved = saveCodexTokenToVault(
      {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        accountId: '78c15115-7a20-4568-9aec-cfa886dd71ae',
        alias: 'backup',
      },
      { filePath, writer: 'test' },
    )
    const written = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>
    expect(written.alias).toBe('backup')
    expect(saved?.metadataAction).toBe('preserved')

    rmSync(dir, { recursive: true, force: true })
  })

  test('loadVaultAccounts reads real expires_at when present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-pool-vault-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })
    const accountId = '78c15115-7a20-4568-9aec-cfa886dd71ae'
    const future = Date.now() + 4 * 3600_000
    writeFileSync(
      join(accountsDir, `${accountId}.json`),
      JSON.stringify({
        tokens: {
          access_token: 'access',
          refresh_token: 'refresh',
          account_id: accountId,
          expires_at: future,
        },
        last_refresh: new Date().toISOString(),
      }),
      'utf-8',
    )

    const accounts = loadVaultAccountsForTest(dir)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.expiresAt).toBe(future)
    rmSync(dir, { recursive: true, force: true })
  })

  test('loadVaultAccounts falls back to 0 when expires_at is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-pool-vault-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })
    const accountId = '78c15115-7a20-4568-9aec-cfa886dd71ae'
    writeFileSync(
      join(accountsDir, `${accountId}.json`),
      JSON.stringify({
        tokens: {
          access_token: 'access',
          refresh_token: 'refresh',
          account_id: accountId,
        },
        last_refresh: new Date().toISOString(),
      }),
      'utf-8',
    )

    const accounts = loadVaultAccountsForTest(dir)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.expiresAt).toBe(0)
    rmSync(dir, { recursive: true, force: true })
  })

  test('loadVaultAccounts quarantines unknown and historical transport refresh states', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-pool-vault-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })
    const unknownAccountId = 'unknown-refresh-account'
    const historicalAccountId = 'historical-transport-account'

    writeFileSync(
      join(accountsDir, `${unknownAccountId}.json`),
      JSON.stringify({
        tokens: {
          access_token: 'access',
          refresh_token: 'refresh',
          account_id: unknownAccountId,
        },
        last_refresh: new Date().toISOString(),
        refresh: {
          state: 'unknown',
          attempt_id: 'attempt-1',
          refresh_token_hash: 'hash',
          failed_at: new Date().toISOString(),
          reason: 'socket timeout',
        },
      }),
      'utf-8',
    )
    writeFileSync(
      join(accountsDir, `${historicalAccountId}.json`),
      JSON.stringify({
        tokens: {
          access_token: 'access',
          refresh_token: 'refresh',
          account_id: historicalAccountId,
        },
        last_refresh: new Date().toISOString(),
        refresh: {
          state: 'reauth_required',
          refresh_token_hash: 'hash',
          marked_at: new Date().toISOString(),
          reason: 'network_or_timeout',
        },
      }),
      'utf-8',
    )

    const accounts = loadVaultAccountsForTest(dir)
    expect(accounts).toHaveLength(2)
    expect(accounts.map(account => account.status)).toEqual([
      'quarantined',
      'quarantined',
    ])
    expect(accounts.every(account => account.statusReason === 'probe_pending_transport')).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  test('saveCodexTokenToVault persists expires_at and reloads it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-pool-vault-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })
    const accountId = '78c15115-7a20-4568-9aec-cfa886dd71ae'
    const filePath = join(accountsDir, `${accountId}.json`)
    const future = Date.now() + 4 * 3600_000

    saveCodexTokenToVault(
      {
        accessToken: 'access',
        refreshToken: 'refresh',
        accountId,
        expiresAt: future,
      },
      { filePath, writer: 'test' },
    )

    const written = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>
    const tokens = written.tokens as Record<string, unknown>
    expect(tokens.expires_at).toBe(future)

    const accounts = loadVaultAccountsForTest(dir)
    expect(accounts[0]?.expiresAt).toBe(future)

    rmSync(dir, { recursive: true, force: true })
  })

  test('appendAccount can sync vault metadata', () => {
    appendAccount(
      {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresAt: Date.now() + 120_000,
        accountId: 'vault-account',
      },
      {
        source: 'vault',
        vaultFilePath: '/tmp/vault/accounts/78c.json',
        writer: 'test',
      },
    )
    const updated = getPoolStatus().accounts.find((account) => account.accountId === 'vault-account')
    expect(updated?.source).toBe('vault')
    expect(updated?.vaultFilePath).toBe('/tmp/vault/accounts/78c.json')
  })
})

describe('loadVaultAccounts correlates a terminal verdict with the token it names', () => {
  // Deliberately not a real account id: these tests drive the vault WRITE path,
  // so a future regression in the temp-path seam must not be able to aim at a
  // profile that exists on the operator's machine.
  const ACCOUNT_ID = '00000000-0000-4000-8000-00000000fake'
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

  function writeProfile(
    dir: string,
    refresh: Record<string, unknown> | undefined,
    refreshToken = 'current-refresh-token',
    lastRefresh = new Date().toISOString(),
    expiresAt = Date.now() + 8 * 24 * 3600_000,
    accountId = ACCOUNT_ID,
  ): void {
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })
    writeFileSync(
      join(accountsDir, `${accountId}.json`),
      JSON.stringify({
        tokens: {
          access_token: 'access',
          refresh_token: refreshToken,
          account_id: accountId,
          expires_at: expiresAt,
        },
        last_refresh: lastRefresh,
        alias: 'bluesky',
        ...(refresh ? { refresh } : {}),
      }),
      'utf-8',
    )
  }

  test('loadVaultAccounts repairs permissive credential modes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-pool-mode-'))
    writeProfile(dir, undefined)
    const accountsDir = join(dir, 'accounts')
    const filePath = join(accountsDir, `${ACCOUNT_ID}.json`)
    chmodSync(accountsDir, 0o755)
    chmodSync(filePath, 0o644)

    expect(loadVaultAccountsForTest(dir)).toHaveLength(1)

    expect(statSync(accountsDir).mode & 0o777).toBe(0o700)
    expect(statSync(filePath).mode & 0o777).toBe(0o600)
    rmSync(dir, { recursive: true, force: true })
  })

  test('loads a day-eight account healthy when its ten-day token has no verdict', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-pool-verdict-'))
    const now = Date.now()
    writeProfile(
      dir,
      undefined,
      'day-eight-refresh-token',
      new Date(now - 8 * 24 * 3600_000).toISOString(),
      now + 2 * 24 * 3600_000,
    )

    const accounts = loadVaultAccountsForTest(dir)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.status).toBe('healthy')
    rmSync(dir, { recursive: true, force: true })
  })

  test('keeps a synchronously rotated pool healthy without verdicts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-pool-verdict-'))
    const now = Date.now()
    const lastRefresh = new Date(now - 8 * 24 * 3600_000).toISOString()
    const expiresAt = now + 2 * 24 * 3600_000
    writeProfile(dir, undefined, 'rotated-refresh-a', lastRefresh, expiresAt, 'rotated-a')
    writeProfile(dir, undefined, 'rotated-refresh-b', lastRefresh, expiresAt, 'rotated-b')

    const accounts = loadVaultAccountsForTest(dir)
    expect(accounts).toHaveLength(2)
    expect(accounts.filter(account => account.status === 'healthy')).toHaveLength(2)
    rmSync(dir, { recursive: true, force: true })
  })

  // The reported bug: a login replaces the refresh token but the preserved
  // verdict still names the old one, so the fresh credential loaded as dead.
  test('ignores a reauth verdict that names a token the profile no longer holds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-pool-verdict-'))
    writeProfile(dir, {
      state: 'reauth_required',
      refresh_token_hash: sha256('an-older-revoked-token'),
      marked_at: '2026-07-15T16:16:47.998Z',
      reason: 'refresh_token_invalidated',
    })

    const accounts = loadVaultAccountsForTest(dir)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.status).toBe('healthy')
    rmSync(dir, { recursive: true, force: true })
  })

  test('keeps a reauth verdict that names the token the profile still holds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-pool-verdict-'))
    writeProfile(dir, {
      state: 'reauth_required',
      refresh_token_hash: sha256('current-refresh-token'),
      marked_at: '2026-07-02T22:03:59.839Z',
      reason: 'http_401',
    })

    const accounts = loadVaultAccountsForTest(dir)
    expect(accounts[0]?.status).toBe('dead')
    expect(accounts[0]?.statusReason).toBe('auth_dead')
    rmSync(dir, { recursive: true, force: true })
  })

  // Fail closed: an uncorrelatable verdict must not resurrect the account, but
  // must not strand it either. Quarantine hands it to the probe.
  test('quarantines rather than resurrects a verdict with no usable hash', () => {
    for (const badHash of [undefined, 'not-a-sha256', '', sha256('x').slice(0, 60)]) {
      const dir = mkdtempSync(join(tmpdir(), 'codex-pool-verdict-'))
      writeProfile(dir, {
        state: 'reauth_required',
        ...(badHash === undefined ? {} : { refresh_token_hash: badHash }),
        marked_at: '2026-07-15T16:16:47.998Z',
        reason: 'refresh_token_invalidated',
      })

      const accounts = loadVaultAccountsForTest(dir)
      expect(accounts[0]?.status).toBe('quarantined')
      expect(accounts[0]?.statusReason).toBe('probe_pending_transport')
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // A corrupted profile must not out-argue the verdict. Coercing a non-string
  // token would hash to a confident mismatch and load the account healthy.
  test('treats a non-string refresh token as uncorrelatable, not as a mismatch', () => {
    for (const badToken of [12345, { token: 'x' }, ['x'], true]) {
      const dir = mkdtempSync(join(tmpdir(), 'codex-pool-verdict-'))
      const accountsDir = join(dir, 'accounts')
      mkdirSync(accountsDir, { recursive: true })
      writeFileSync(
        join(accountsDir, `${ACCOUNT_ID}.json`),
        JSON.stringify({
          tokens: {
            access_token: 'access',
            refresh_token: badToken,
            account_id: ACCOUNT_ID,
            expires_at: Date.now() + 8 * 24 * 3600_000,
          },
          last_refresh: new Date().toISOString(),
          refresh: {
            state: 'reauth_required',
            refresh_token_hash: sha256('a-revoked-token'),
            marked_at: '2026-07-15T16:16:47.998Z',
            reason: 'refresh_token_invalidated',
          },
        }),
        'utf-8',
      )

      const accounts = loadVaultAccountsForTest(dir)
      expect(accounts[0]?.status).not.toBe('healthy')
      expect(accounts[0]?.status).toBe('quarantined')
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // The reset is conditional on the token actually changing. Re-saving the same
  // token must leave a still-current verdict standing.
  test('a save that reuses the stored refresh token preserves the verdict', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-pool-verdict-'))
    const verdict = {
      state: 'reauth_required',
      refresh_token_hash: sha256('current-refresh-token'),
      marked_at: '2026-07-02T22:03:59.839Z',
      reason: 'http_401',
    }
    writeProfile(dir, verdict)
    const filePath = join(dir, 'accounts', `${ACCOUNT_ID}.json`)

    saveCodexTokenToVault(
      {
        accessToken: 'rotated-access-only',
        refreshToken: 'current-refresh-token',
        accountId: ACCOUNT_ID,
      },
      { writer: 'test.sameToken', filePath },
    )

    expect(JSON.parse(readFileSync(filePath, 'utf-8')).refresh).toEqual(verdict)
    expect(loadVaultAccountsForTest(dir)[0]?.status).toBe('dead')
    rmSync(dir, { recursive: true, force: true })
  })

  test('a login over a marked profile clears the verdict and loads healthy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-pool-verdict-'))
    writeProfile(
      dir,
      {
        state: 'reauth_required',
        refresh_token_hash: sha256('old-refresh-token'),
        marked_at: '2026-07-15T16:16:47.998Z',
        reason: 'refresh_token_invalidated',
      },
      'old-refresh-token',
    )
    const filePath = join(dir, 'accounts', `${ACCOUNT_ID}.json`)

    const saved = saveCodexTokenToVault(
      {
        accessToken: 'brand-new-access',
        refreshToken: 'brand-new-refresh',
        accountId: ACCOUNT_ID,
        alias: 'bluesky',
        expiresAt: Date.now() + 10 * 24 * 3600_000,
      },
      { writer: 'test.persistCodexLogin', filePath },
    )

    expect(saved?.metadataAction).toBe('preserved')
    const onDisk = JSON.parse(readFileSync(filePath, 'utf-8'))
    expect(onDisk.refresh).toEqual({ state: 'idle' })
    expect(onDisk.alias).toBe('bluesky')

    expect(loadVaultAccountsForTest(dir)[0]?.status).toBe('healthy')
    rmSync(dir, { recursive: true, force: true })
  })

  // The write must stay beside its target: when `filePath` points somewhere the
  // configured vault does not cover, the old code created its temp file in the
  // real vault and then renamed across directories, which failed outright when
  // the target directory did not exist yet.
  test('saveCodexTokenToVault writes into a target directory it must create', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-pool-seam-'))
    const filePath = join(dir, 'accounts', `${ACCOUNT_ID}.json`)

    const saved = saveCodexTokenToVault(
      {
        accessToken: 'access',
        refreshToken: 'refresh',
        accountId: ACCOUNT_ID,
      },
      { writer: 'test.seam', filePath },
    )

    expect(saved?.filePath).toBe(filePath)
    expect(saved?.metadataAction).toBe('created')
    expect(JSON.parse(readFileSync(filePath, 'utf-8')).tokens.access_token).toBe('access')
    expect(statSync(filePath).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(dir, 'accounts')).filter((f) => f.endsWith('.tmp'))).toHaveLength(0)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('resolveCodexAccountByPrefix', () => {
  beforeEach(() => {
    resetCodexAccountPoolForTest()
  })

  test('returns unique on exact alias match even when another alias has it as a prefix', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'acct-main',
      accounts: [
        buildPoolAccount({ accountId: 'acct-main', alias: 'main' }),
        buildPoolAccount({ accountId: 'acct-main2', alias: 'main2' }),
      ],
    })

    const result = resolveCodexAccountByPrefix('main')
    expect(result.kind).toBe('unique')
    if (result.kind === 'unique') {
      expect(result.account.accountId).toBe('acct-main')
    }
  })

  test('returns ambiguous when two aliases share a prefix and there is no exact match', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'acct-backup1',
      accounts: [
        buildPoolAccount({ accountId: 'acct-backup1', alias: 'backup1' }),
        buildPoolAccount({ accountId: 'acct-backup2', alias: 'backup2' }),
      ],
    })

    const result = resolveCodexAccountByPrefix('backup')
    expect(result.kind).toBe('ambiguous')
    if (result.kind === 'ambiguous') {
      expect(result.matches.map((a) => a.accountId).sort()).toEqual([
        'acct-backup1',
        'acct-backup2',
      ])
    }
  })

  test('returns ambiguous when one matches alias prefix and another matches id prefix', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'acct-abc-1',
      accounts: [
        buildPoolAccount({ accountId: 'acct-abc-1', alias: 'abc-alias' }),
        buildPoolAccount({ accountId: 'abc-id-account', alias: 'other' }),
      ],
    })

    const result = resolveCodexAccountByPrefix('abc')
    expect(result.kind).toBe('ambiguous')
    if (result.kind === 'ambiguous') {
      expect(result.matches.length).toBe(2)
    }
  })

  test('returns none when nothing matches', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'acct-main',
      accounts: [buildPoolAccount({ accountId: 'acct-main', alias: 'main' })],
    })

    expect(resolveCodexAccountByPrefix('xyz').kind).toBe('none')
  })

  test('onlyHealthy:true filters out non-healthy accounts', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'acct-backupA',
      accounts: [
        buildPoolAccount({ accountId: 'acct-backupA', alias: 'backupA' }),
        buildPoolAccount({ accountId: 'acct-backupB', alias: 'backupB', status: 'capped' }),
      ],
    })

    // Without filter, two aliases prefix 'backup' -> ambiguous
    expect(resolveCodexAccountByPrefix('backup').kind).toBe('ambiguous')
    // With filter, only 'backupA' remains
    const filtered = resolveCodexAccountByPrefix('backup', { onlyHealthy: true })
    expect(filtered.kind).toBe('unique')
    if (filtered.kind === 'unique') {
      expect(filtered.account.accountId).toBe('acct-backupA')
    }
  })

  test('onlySwitchable:true filters out accounts with fresh live usage caps', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'acct-backupA',
      accounts: [
        buildPoolAccount({ accountId: 'acct-backupA', alias: 'backupA' }),
        buildPoolAccount({
          accountId: 'acct-backupB',
          alias: 'backupB',
          usageAllowed: false,
          usageLimitReached: true,
          usageFetchedAt: Date.now(),
        }),
      ],
    })

    const filtered = resolveCodexAccountByPrefix('backup', { onlySwitchable: true })
    expect(filtered.kind).toBe('unique')
    if (filtered.kind === 'unique') {
      expect(filtered.account.accountId).toBe('acct-backupA')
    }
  })
})

describe('switchToAccount', () => {
  beforeEach(() => {
    resetCodexAccountPoolForTest()
  })

  test('returns null when prefix is ambiguous', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'acct-main',
      accounts: [
        buildPoolAccount({ accountId: 'acct-main', alias: 'main' }),
        buildPoolAccount({ accountId: 'acct-backup1', alias: 'backup1' }),
        buildPoolAccount({ accountId: 'acct-backup2', alias: 'backup2' }),
      ],
    })

    expect(switchToAccount('backup')).toBeNull()
    // active account should not have moved
    expect(getPoolStatus().accounts[getPoolStatus().activeIndex]?.accountId).toBe('acct-main')
  })

  test('still switches successfully for a unique alias', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'acct-main',
      accounts: [
        buildPoolAccount({ accountId: 'acct-main', alias: 'main' }),
        buildPoolAccount({ accountId: 'acct-backup1', alias: 'backup1' }),
      ],
    })

    const result = switchToAccount('backup1')
    expect(result?.accountId).toBe('acct-backup1')
    expect(getPoolStatus().accounts[getPoolStatus().activeIndex]?.accountId).toBe('acct-backup1')
  })

  test('does not switch to an account with a fresh live usage cap', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'acct-main',
      accounts: [
        buildPoolAccount({ accountId: 'acct-main', alias: 'main' }),
        buildPoolAccount({
          accountId: 'acct-backup1',
          alias: 'backup1',
          usageAllowed: false,
          usageLimitReached: true,
          usageFetchedAt: Date.now(),
        }),
      ],
    })

    expect(switchToAccount('backup1')).toBeNull()
    expect(getPoolStatus().accounts[getPoolStatus().activeIndex]?.accountId).toBe('acct-main')
  })
})

describe('getPoolStatus', () => {
  beforeEach(() => {
    resetCodexAccountPoolForTest()
  })

  test('does not expose turnThreshold', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'acct-main',
      accounts: [buildPoolAccount({ accountId: 'acct-main', alias: 'main' })],
    })

    const status = getPoolStatus()
    expect(Object.keys(status)).not.toContain('turnThreshold')
  })
})


// ── Slice 4: quota belief reconciler directional semantics ─────────────────

describe('quota belief reconciler directional semantics', () => {
  beforeEach(() => {
    resetCodexAccountPoolForTest()
    _resetAccountDiagnosticStreamJsonHookForTesting()
  })

  test('429 then stale uncap poll stays capped', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'capped-acct',
      accounts: [
        buildPoolAccount({ accountId: 'capped-acct' }),
        buildPoolAccount({ accountId: 'backup-acct' }),
      ],
    })

    const resetAt = Math.floor((Date.now() + 60 * 60 * 1000) / 1000)
    markPoolAccountCapped('capped-acct', 'Usage cap hit (429)', { rerollActive: false, resetAt })
    const cappedAt = getPoolStatus().accounts.find(a => a.accountId === 'capped-acct')!.cappedAt!

    updateAccountUsageHints([
      {
        accountId: 'capped-acct',
        primaryPercent: 10,
        weeklyPercent: 5,
        allowed: true,
        limitReached: false,
        fetchedAt: cappedAt + 1,
      },
    ])

    const acct = getPoolStatus().accounts.find(a => a.accountId === 'capped-acct')!
    expect(acct.status).toBe('capped')
    expect(acct.cappedAt).toBe(cappedAt)
    expect(acct.usageResetAt).toBe(resetAt)
    expect(getCodexAccountAvailability(acct).kind).toBe('blocked')
  })

  test('redeem then stale block poll stays healed', () => {
    const now = Date.now()
    seedCodexAccountPoolForTest({
      activeAccountId: 'backup-acct',
      accounts: [
        buildPoolAccount({ accountId: 'backup-acct' }),
        buildPoolAccount({
          accountId: 'redeemed-acct',
          status: 'capped',
          statusReason: 'usage_cap',
          cappedAt: now - 1_000,
          usageAllowed: false,
          usageLimitReached: true,
          usageFetchedAt: now - 500,
        }),
      ],
    })

    applyRedeemedUsageReset('redeemed-acct')
    const redeemedAt = getPoolStatus().accounts.find(a => a.accountId === 'redeemed-acct')!.redeemedAt!

    updateAccountUsageHints([
      {
        accountId: 'redeemed-acct',
        primaryPercent: 100,
        weeklyPercent: 100,
        allowed: false,
        limitReached: true,
        fetchedAt: redeemedAt + 1,
      },
    ])

    const acct = getPoolStatus().accounts.find(a => a.accountId === 'redeemed-acct')!
    expect(acct.status).toBe('healthy')
    expect(acct.usageAllowed).toBe(true)
    expect(acct.usageLimitReached).toBe(false)
    expect(acct.usageFetchedAt).toBeUndefined()
    expect(getCodexAccountAvailability(acct).kind).not.toBe('blocked')
  })

  test('redeem belief rejects older blocking polls even after propagation lag', () => {
    const now = Date.now()
    const redeemedAt = now - REDEEM_HINT_LAG_GRACE_MS - 1_000
    seedCodexAccountPoolForTest({
      accounts: [
        buildPoolAccount({
          accountId: 'redeemed-acct',
          status: 'healthy',
          redeemedAt,
          usageAllowed: true,
          usageLimitReached: false,
        }),
      ],
    })

    updateAccountUsageHints([
      {
        accountId: 'redeemed-acct',
        primaryPercent: 100,
        weeklyPercent: 100,
        allowed: false,
        limitReached: true,
        fetchedAt: redeemedAt - 1,
      },
    ])

    const acct = getPoolStatus().accounts.find(a => a.accountId === 'redeemed-acct')!
    expect(acct.usageAllowed).toBe(true)
    expect(acct.usageLimitReached).toBe(false)
    expect(acct.usageFetchedAt).toBeUndefined()
    expect(getCodexAccountAvailability(acct).kind).not.toBe('blocked')
  })

  test('post-failover forceRefresh uncap poll does not undo the fresh cap', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'failed-acct',
      accounts: [
        buildPoolAccount({ accountId: 'failed-acct', lastUsedAt: 10 }),
        buildPoolAccount({ accountId: 'backup-acct', lastUsedAt: 0 }),
      ],
    })

    markPoolAccountCapped('failed-acct', 'Usage cap hit (429)')
    const statusAfterFailover = getPoolStatus()
    const cappedAt = statusAfterFailover.accounts.find(a => a.accountId === 'failed-acct')!.cappedAt!
    expect(statusAfterFailover.accounts[statusAfterFailover.activeIndex]?.accountId).toBe('backup-acct')

    updateAccountUsageHints([
      {
        accountId: 'failed-acct',
        primaryPercent: 1,
        weeklyPercent: 1,
        allowed: true,
        limitReached: false,
        fetchedAt: cappedAt + 1,
      },
    ])

    const status = getPoolStatus()
    const failed = status.accounts.find(a => a.accountId === 'failed-acct')!
    expect(failed.status).toBe('capped')
    expect(isCodexAccountSwitchable(failed)).toBe(false)
    expect(status.accounts[status.activeIndex]?.accountId).toBe('backup-acct')
  })

  test('missing and zero resetAt do not unblock quota blocks', () => {
    const now = Date.parse('2026-04-21T00:00:00.000Z')

    const missingResetAt = buildPoolAccount({
      accountId: 'missing-reset',
      usageAllowed: false,
      usageLimitReached: true,
      usageFetchedAt: now - 1_000,
    })
    expect(getCodexAccountAvailability(missingResetAt, now)).toEqual({
      kind: 'blocked',
      reason: 'fresh usage data reports this account is capped',
    })

    const zeroResetAt = buildPoolAccount({
      accountId: 'zero-reset',
      usageAllowed: false,
      usageLimitReached: true,
      usageFetchedAt: now - 1_000,
      usageResetAt: 0,
    })
    expect(getCodexAccountAvailability(zeroResetAt, now)).toEqual({
      kind: 'blocked',
      reason: 'fresh usage data reports this account is capped',
    })

    const elapsedResetAt = buildPoolAccount({
      accountId: 'elapsed-reset',
      usageAllowed: false,
      usageLimitReached: true,
      usageFetchedAt: now - 1_000,
      usageResetAt: Math.floor((now - 1_000) / 1000),
    })
    expect(getCodexAccountAvailability(elapsedResetAt, now)).toEqual({ kind: 'available' })

    const cappedZeroResetAt = buildPoolAccount({
      accountId: 'capped-zero-reset',
      status: 'capped',
      statusReason: 'usage_cap',
      cappedAt: now - 1_000,
      usageResetAt: 0,
    })
    expect(getCodexAccountAvailability(cappedZeroResetAt, now)).toEqual({
      kind: 'blocked',
      reason: 'account is capped',
    })

    const cappedElapsedResetAt = buildPoolAccount({
      accountId: 'capped-elapsed-reset',
      status: 'capped',
      statusReason: 'usage_cap',
      cappedAt: now - 1_000,
      usageResetAt: Math.floor((now - 1_000) / 1000),
    })
    expect(getCodexAccountAvailability(cappedElapsedResetAt, now)).toEqual({ kind: 'available' })
  })

  test('poll block only blocks while within the usage hint TTL', () => {
    const now = Date.parse('2026-04-21T00:00:00.000Z')
    const usageHintStaleMs = 5 * 60 * 1000

    const barelyFresh = buildPoolAccount({
      accountId: 'barely-fresh',
      usageAllowed: false,
      usageLimitReached: true,
      usageFetchedAt: now - usageHintStaleMs + 1,
    })
    expect(getCodexAccountAvailability(barelyFresh, now)).toEqual({
      kind: 'blocked',
      reason: 'fresh usage data reports this account is capped',
    })

    const exactlyStale = buildPoolAccount({
      accountId: 'exactly-stale',
      usageAllowed: false,
      usageLimitReached: true,
      usageFetchedAt: now - usageHintStaleMs,
    })
    expect(getCodexAccountAvailability(exactlyStale, now)).toEqual({ kind: 'available' })
  })
})

// ── Slice 2: applyRedeemedUsageReset ──────────────────────────────────────

describe('applyRedeemedUsageReset', () => {
  beforeEach(() => {
    resetCodexAccountPoolForTest()
    _resetAccountDiagnosticStreamJsonHookForTesting()
  })

  test('heals a capped/usage_cap account even when cappedAt is seconds old', () => {
    const now = Date.now()
    seedCodexAccountPoolForTest({
      activeAccountId: 'other',
      accounts: [
        buildPoolAccount({ accountId: 'other' }),
        buildPoolAccount({
          accountId: 'capped-acct',
          status: 'capped',
          statusReason: 'usage_cap',
          cappedAt: now - 5_000, // only 5s ago — well inside the 2min uncap grace
          lastError: 'Usage cap hit (429)',
          usageAllowed: false,
          usageLimitReached: true,
          usageFetchedAt: now - 3_000,
          usageResetAt: Math.floor((now + 3600_000) / 1000),
        }),
      ],
    })

    applyRedeemedUsageReset('capped-acct')

    const acct = getPoolStatus().accounts.find(a => a.accountId === 'capped-acct')!
    expect(acct.status).toBe('healthy')
    expect(acct.statusReason).toBeUndefined()
    expect(acct.lastError).toBeUndefined()
    expect(acct.cappedAt).toBeUndefined()
    // Hint fields cleared
    expect(acct.usageAllowed).toBe(true)
    expect(acct.usageLimitReached).toBe(false)
    expect(acct.usageFetchedAt).toBeUndefined()
    expect(acct.usageResetAt).toBeUndefined()
    // redeemedAt set
    expect(acct.redeemedAt).toBeGreaterThan(0)
  })

  test('clears hint fields so getCodexAccountAvailability returns available', () => {
    seedCodexAccountPoolForTest({
      accounts: [
        buildPoolAccount({
          accountId: 'acct-1',
          status: 'capped',
          statusReason: 'usage_cap',
          cappedAt: Date.now() - 1_000,
          usageAllowed: false,
          usageLimitReached: true,
          usageFetchedAt: Date.now(),
        }),
      ],
    })

    applyRedeemedUsageReset('acct-1')

    const acct = getPoolStatus().accounts[0]!
    expect(getCodexAccountAvailability(acct)).toEqual({ kind: 'available' })
  })

  test('leaves dead account untouched', () => {
    seedCodexAccountPoolForTest({
      accounts: [
        buildPoolAccount({
          accountId: 'dead-acct',
          status: 'dead',
          statusReason: 'auth_dead',
          lastError: 'Reauthentication required',
        }),
      ],
    })

    applyRedeemedUsageReset('dead-acct')

    const acct = getPoolStatus().accounts[0]!
    expect(acct.status).toBe('dead')
    expect(acct.statusReason).toBe('auth_dead')
    expect(acct.lastError).toBe('Reauthentication required')
    // Still sets redeemedAt (it's a no-op on status but stamps the time)
    expect(acct.redeemedAt).toBeGreaterThan(0)
  })

  test('leaves quarantined account untouched', () => {
    seedCodexAccountPoolForTest({
      accounts: [
        buildPoolAccount({
          accountId: 'q-acct',
          status: 'quarantined',
          statusReason: 'probe_pending_transport',
          lastError: 'connection problem',
        }),
      ],
    })

    applyRedeemedUsageReset('q-acct')

    const acct = getPoolStatus().accounts[0]!
    expect(acct.status).toBe('quarantined')
    expect(acct.statusReason).toBe('probe_pending_transport')
  })

  test('sets redeemedAt on the account', () => {
    const before = Date.now()
    seedCodexAccountPoolForTest({
      accounts: [
        buildPoolAccount({
          accountId: 'acct-1',
          status: 'capped',
          statusReason: 'usage_cap',
          cappedAt: before - 1_000,
        }),
      ],
    })

    applyRedeemedUsageReset('acct-1')

    const acct = getPoolStatus().accounts[0]!
    expect(acct.redeemedAt).toBeDefined()
    expect(acct.redeemedAt!).toBeGreaterThanOrEqual(before)
    expect(acct.redeemedAt!).toBeLessThanOrEqual(Date.now())
  })

  test('emits account.usage.uncap diagnostic with reason "usage reset redeemed"', () => {
    const emitted: unknown[] = []
    installStreamJsonAccountDiagnosticHook({
      emit: message => {
        emitted.push(message)
      },
      getSessionId: () => 'redeem-session',
      createUuid: () => `redeem-${emitted.length + 1}`,
    })
    seedCodexAccountPoolForTest({
      accounts: [
        buildPoolAccount({
          accountId: 'acct-1',
          status: 'capped',
          statusReason: 'usage_cap',
          cappedAt: Date.now() - 1_000,
          lastError: 'Usage cap hit (429)',
        }),
      ],
    })

    applyRedeemedUsageReset('acct-1')

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({
      code: 'account.usage.uncap',
      reason: 'usage reset redeemed: Usage cap hit (429)',
    })
  })

  test('no-ops for a non-existent account', () => {
    seedCodexAccountPoolForTest({ accounts: [] })
    // Should not throw
    applyRedeemedUsageReset('nonexistent')
  })
})

// ── Slice 2: REDEEM_HINT_LAG_GRACE_MS guard ───────────────────────────────

describe('REDEEM_HINT_LAG_GRACE_MS guard in updateAccountUsageHints', () => {
  beforeEach(() => {
    resetCodexAccountPoolForTest()
    _resetAccountDiagnosticStreamJsonHookForTesting()
  })

  test('within the grace, a hint with limitReached:true is skipped', () => {
    const now = Date.now()
    seedCodexAccountPoolForTest({
      accounts: [
        buildPoolAccount({
          accountId: 'acct-1',
          status: 'healthy',
          redeemedAt: now - 10_000, // redeemed 10s ago — well inside 2min grace
        }),
      ],
    })

    updateAccountUsageHints([
      {
        accountId: 'acct-1',
        primaryPercent: 100,
        weeklyPercent: 100,
        allowed: false,
        limitReached: true,
        fetchedAt: now,
      },
    ])

    const acct = getPoolStatus().accounts[0]!
    // The blocking fields should NOT have been applied
    expect(acct.usageAllowed).toBeUndefined()
    expect(acct.usageLimitReached).toBeUndefined()
    expect(acct.usageFetchedAt).toBeUndefined()
    // But the scoring fields were updated
    expect(acct.usagePrimary).toBe(100)
    expect(acct.usageWeekly).toBe(100)
    // Account should still be available for routing
    expect(getCodexAccountAvailability(acct).kind).not.toBe('blocked')
  })

  test('after the grace, the same hint applies normally', () => {
    const now = Date.now()
    seedCodexAccountPoolForTest({
      accounts: [
        buildPoolAccount({
          accountId: 'acct-1',
          status: 'healthy',
          redeemedAt: now - REDEEM_HINT_LAG_GRACE_MS - 1_000, // past grace
        }),
      ],
    })

    updateAccountUsageHints([
      {
        accountId: 'acct-1',
        primaryPercent: 100,
        weeklyPercent: 100,
        allowed: false,
        limitReached: true,
        fetchedAt: now,
      },
    ])

    const acct = getPoolStatus().accounts[0]!
    expect(acct.usageAllowed).toBe(false)
    expect(acct.usageLimitReached).toBe(true)
    expect(acct.usageFetchedAt).toBeDefined()
    // Fresh blocked hint should make it blocked
    expect(getCodexAccountAvailability(acct).kind).toBe('blocked')
  })

  test('existing uncap-branch tests still pass — allowed:true hint still uncaps after normal grace', () => {
    // This is a regression check: the REDEEM_HINT_LAG_GRACE_MS guard must not
    // interfere with the normal uncap flow for accounts that have never been redeemed.
    const now = Date.now()
    const oldCappedAt = now - 3 * 60 * 1000 // 3min ago, past USAGE_UNCAP_GRACE_MS
    seedCodexAccountPoolForTest({
      accounts: [
        buildPoolAccount({ accountId: 'main-account' }),
        buildPoolAccount({
          accountId: 'capped-account',
          status: 'capped',
          statusReason: 'usage_cap',
          cappedAt: oldCappedAt,
          // No redeemedAt — never redeemed
        }),
      ],
    })

    updateAccountUsageHints([
      {
        accountId: 'capped-account',
        primaryPercent: 10,
        weeklyPercent: 5,
        allowed: true,
        limitReached: false,
        fetchedAt: oldCappedAt + 60_000,
      },
    ])

    const uncapped = getPoolStatus().accounts.find(a => a.accountId === 'capped-account')!
    expect(uncapped.status).toBe('healthy')
    expect(uncapped.cappedAt).toBeUndefined()
  })
})

// ── Slice 2: Integration-style heal → stale hint → grace ─────────────────

describe('usage reset integration: cap → heal → stale hint within grace → still available', () => {
  beforeEach(() => {
    resetCodexAccountPoolForTest()
    _resetAccountDiagnosticStreamJsonHookForTesting()
  })

  test('fresh cap → heal → stale capped hint within grace → still available; after grace → hints govern', () => {
    const now = Date.now()
    // Step 1: Account gets capped (fresh cappedAt)
    seedCodexAccountPoolForTest({
      activeAccountId: 'other',
      accounts: [
        buildPoolAccount({ accountId: 'other' }),
        buildPoolAccount({
          accountId: 'target',
          status: 'capped',
          statusReason: 'usage_cap',
          cappedAt: now - 2_000, // capped 2s ago — very fresh
          lastError: 'Usage cap hit (429)',
          usageAllowed: false,
          usageLimitReached: true,
          usageFetchedAt: now - 1_000,
        }),
      ],
    })

    // Step 2: Heal via applyRedeemedUsageReset (bypasses uncap grace)
    applyRedeemedUsageReset('target')
    let target = getPoolStatus().accounts.find(a => a.accountId === 'target')!
    expect(target.status).toBe('healthy')
    expect(getCodexAccountAvailability(target).kind).not.toBe('blocked')
    expect(isCodexAccountSwitchable(target)).toBe(true)

    // Step 3: A stale hint arrives within the REDEEM_HINT_LAG_GRACE_MS
    // (server still reports the old state)
    updateAccountUsageHints([
      {
        accountId: 'target',
        primaryPercent: 100,
        weeklyPercent: 100,
        allowed: false,
        limitReached: true,
        fetchedAt: now, // stale data, fetched around now
      },
    ])

    target = getPoolStatus().accounts.find(a => a.accountId === 'target')!
    // Should still be available — the lag guard protects it
    expect(target.status).toBe('healthy')
    expect(getCodexAccountAvailability(target).kind).not.toBe('blocked')
    expect(isCodexAccountSwitchable(target)).toBe(true)

    // Step 4: Simulate time passing beyond the grace (re-seed with old redeemedAt)
    seedCodexAccountPoolForTest({
      activeAccountId: 'other',
      accounts: [
        buildPoolAccount({ accountId: 'other' }),
        buildPoolAccount({
          accountId: 'target',
          status: 'healthy', // healed
          redeemedAt: now - REDEEM_HINT_LAG_GRACE_MS - 1_000, // past grace
        }),
      ],
    })

    // A hint with blocked data now applies normally
    updateAccountUsageHints([
      {
        accountId: 'target',
        primaryPercent: 100,
        weeklyPercent: 100,
        allowed: false,
        limitReached: true,
        fetchedAt: Date.now(),
      },
    ])

    target = getPoolStatus().accounts.find(a => a.accountId === 'target')!
    expect(target.usageAllowed).toBe(false)
    expect(target.usageLimitReached).toBe(true)
    // Now the hint blocks the account
    expect(getCodexAccountAvailability(target).kind).toBe('blocked')
  })
})

// ── Slice 2: Redemption eligibility predicate ─────────────────────────────

describe('getRedemptionEligibility', () => {
  test('healthy account with token is eligible', () => {
    const acct = buildPoolAccount({ accountId: 'acct-1', status: 'healthy' })
    expect(getRedemptionEligibility(acct)).toEqual({ eligible: true })
  })

  test('capped/usage_cap account with token is eligible', () => {
    const acct = buildPoolAccount({
      accountId: 'acct-1',
      status: 'capped',
      statusReason: 'usage_cap',
      lastError: 'Usage cap hit (429)',
    })
    expect(getRedemptionEligibility(acct)).toEqual({ eligible: true })
  })

  test('dead account is ineligible with reason', () => {
    const acct = buildPoolAccount({
      accountId: 'acct-1',
      status: 'dead',
      statusReason: 'auth_dead',
      lastError: 'Reauthentication required',
    })
    const result = getRedemptionEligibility(acct)
    expect(result.eligible).toBe(false)
    expect((result as { reason: string }).reason).toBe('re-login required')
  })

  test('quarantined account is ineligible with reason', () => {
    const acct = buildPoolAccount({
      accountId: 'acct-1',
      status: 'quarantined',
      statusReason: 'probe_pending_transport',
    })
    const result = getRedemptionEligibility(acct)
    expect(result.eligible).toBe(false)
    expect((result as { reason: string }).reason).toBe('connection problems; retry later')
  })

  test('account with no token is ineligible', () => {
    const acct = buildPoolAccount({
      accountId: 'acct-1',
      status: 'healthy',
      accessToken: '',
    })
    const result = getRedemptionEligibility(acct)
    expect(result.eligible).toBe(false)
    expect((result as { reason: string }).reason).toBe('re-login required')
  })

  test('capped/runtime_cap is ineligible', () => {
    const acct = buildPoolAccount({
      accountId: 'acct-1',
      status: 'capped',
      statusReason: 'runtime_cap',
      lastError: 'Runtime cap hit',
    })
    const result = getRedemptionEligibility(acct)
    expect(result.eligible).toBe(false)
    expect((result as { reason: string }).reason).toBe('Runtime cap hit')
  })
})

describe('OpenAI account information', () => {
  beforeEach(() => {
    resetCodexAccountPoolForTest()
    setSessionProvider(null)
  })

  test('reports the routable active Codex account when the raw active account is blocked', () => {
    try {
      setSessionProvider('openai')
      seedCodexAccountPoolForTest({
        activeAccountId: 'blocked-active',
        accounts: [
          buildPoolAccount({
            accountId: 'blocked-active',
            status: 'quarantined',
            lastError: 'temporary connection failure',
          }),
          buildPoolAccount({ accountId: 'healthy-backup' }),
        ],
      })

      expect(getAccountInformation()?.accountId).toBe('healthy-backup')
    } finally {
      setSessionProvider(null)
      resetCodexAccountPoolForTest()
    }
  })
})
