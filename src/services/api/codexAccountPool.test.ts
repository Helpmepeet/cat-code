import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  appendAccount,
  getCodexAccountAvailability,
  getCodexPlanMetadataFromIdToken,
  getPoolStatus,
  isCodexAccountLeaseSelectable,
  isCodexAccountSwitchable,
  loadVaultAccountsForTest,
  markAccountDead,
  mergePoolAccountsForTest,
  removeCodexAccount,
  resetCodexAccountPoolForTest,
  resolveCodexAccountByPrefix,
  saveCodexTokenToVault,
  seedCodexAccountPoolForTest,
  switchToAccount,
  updateAccountUsageHints,
  type PoolAccount,
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
    expect(isCodexAccountLeaseSelectable(account, NOW)).toBe(true)
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

  test('dead auth is blocked', () => {
    const account = buildPoolAccount({
      accountId: 'dead-account',
      status: 'dead',
      statusReason: 'auth_dead',
      lastError: 'Token expired (>7 days since last refresh)',
    })

    expect(getCodexAccountAvailability(account, NOW)).toEqual({
      kind: 'blocked',
      reason: 'Token expired (>7 days since last refresh)',
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
          lastError: 'Token expired (>7 days since last refresh)',
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
