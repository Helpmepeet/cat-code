import { beforeEach, describe, expect, test } from 'bun:test'

import {
  appendAccount,
  buildCodexVaultRecordForSave,
  getPoolStatus,
  getVaultPlanHealthFromIdToken,
  mergePoolAccountsForTest,
  removeCodexAccount,
  resetCodexAccountPoolForTest,
  seedCodexAccountPoolForTest,
  type PoolAccount,
} from './codexAccountPool.js'

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
    lastErrorAt: overrides.lastErrorAt,
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

describe('codexAccountPool appendAccount', () => {
  beforeEach(() => {
    resetCodexAccountPoolForTest()
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

  test('marks expired plus subscriptions capped from id_token claims', () => {
    const health = getVaultPlanHealthFromIdToken(
      createIdToken({
        chatgpt_plan_type: 'plus',
        chatgpt_subscription_active_until: '2026-04-12T03:30:01+00:00',
      }),
      Date.parse('2026-04-21T00:00:00+00:00'),
    )

    expect(health).toEqual({
      status: 'capped',
      lastError: 'Plan expired (2026-04-12T03:30:01+00:00)',
    })
  })

  test('marks free plans capped from id_token claims', () => {
    const health = getVaultPlanHealthFromIdToken(
      createIdToken({
        chatgpt_plan_type: 'free',
      }),
      Date.parse('2026-04-21T00:00:00+00:00'),
    )

    expect(health).toEqual({
      status: 'capped',
      lastError: 'Plan type free is not eligible for Codex usage',
    })
  })

  test('appendAccount marks new account as vault-backed when metadata is provided', () => {
    appendAccount({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 10_000,
      accountId: 'vault-account',
      alias: 'main',
      source: 'vault',
      vaultFilePath: '/tmp/vault-account.json',
    })

    const account = getPoolStatus().accounts.find((a) => a.accountId === 'vault-account')
    expect(account?.source).toBe('vault')
    expect(account?.vaultFilePath).toBe('/tmp/vault-account.json')
    expect(account?.alias).toBe('main')
  })

  test('appendAccount upgrades existing config account to vault-backed metadata', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'upgrade-account',
      accounts: [
        buildPoolAccount({
          accountId: 'upgrade-account',
          source: 'config',
          vaultFilePath: undefined,
        }),
      ],
    })

    appendAccount({
      accessToken: 'access-new',
      refreshToken: 'refresh-new',
      expiresAt: Date.now() + 10_000,
      accountId: 'upgrade-account',
      source: 'vault',
      vaultFilePath: '/tmp/upgrade-account.json',
    })

    const account = getPoolStatus().accounts.find((a) => a.accountId === 'upgrade-account')
    expect(account?.source).toBe('vault')
    expect(account?.vaultFilePath).toBe('/tmp/upgrade-account.json')
  })

  test('appendAccount can explicitly clear vault metadata on update', () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'clear-account',
      accounts: [
        buildPoolAccount({
          accountId: 'clear-account',
          source: 'vault',
          vaultFilePath: '/tmp/clear-account.json',
        }),
      ],
    })

    appendAccount({
      accessToken: 'access-new',
      refreshToken: 'refresh-new',
      expiresAt: Date.now() + 10_000,
      accountId: 'clear-account',
      source: 'config',
      vaultFilePath: undefined,
    })

    const account = getPoolStatus().accounts.find((a) => a.accountId === 'clear-account')
    expect(account?.source).toBe('config')
    expect(account?.vaultFilePath).toBeUndefined()
  })
})

describe('buildCodexVaultRecordForSave', () => {
  const accountA = '78c15115-7a20-4568-9aec-cfa886dd71ae'
  const accountB = '80ef361d-5bdc-411f-8bd1-a8fe2a0f18b3'
  const nowIso = '2026-04-30T00:00:00.000Z'

  test('token-only save preserves alias and metadata for same account', () => {
    const existing = {
      alias: 'main',
      created_at: '2026-04-01T00:00:00.000Z',
      custom: { debug: true },
      tokens: {
        access_token: 'old-access',
        refresh_token: 'old-refresh',
        account_id: accountA,
        id_token: 'old-id-token',
        extra_token_field: 'keep',
      },
    } as Record<string, unknown>

    const result = buildCodexVaultRecordForSave(existing, {
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      accountId: accountA,
    }, nowIso)

    expect(result.metadataAction).toBe('preserved')
    expect(result.aliasAction).toBe('preserved')
    expect(result.identityAction).toBe('same')
    expect(result.record.alias).toBe('main')
    expect(result.record.created_at).toBe('2026-04-01T00:00:00.000Z')
    expect((result.record.custom as Record<string, unknown>).debug).toBe(true)
    const tokens = result.record.tokens as Record<string, unknown>
    expect(tokens.id_token).toBe('old-id-token')
    expect(tokens.extra_token_field).toBe('keep')
  })

  test('explicit alias overrides existing alias', () => {
    const existing = { alias: 'main', tokens: { account_id: accountA } } as Record<string, unknown>
    const result = buildCodexVaultRecordForSave(existing, {
      accessToken: 'a',
      refreshToken: 'r',
      accountId: accountA,
      alias: 'backup',
    }, nowIso)
    expect(result.record.alias).toBe('backup')
    expect(result.aliasAction).toBe('set')
  })

  test('account-id mismatch does not inherit alias without explicit alias', () => {
    const existing = { alias: 'main', tokens: { account_id: accountA } } as Record<string, unknown>
    const result = buildCodexVaultRecordForSave(existing, {
      accessToken: 'a',
      refreshToken: 'r',
      accountId: accountB,
    }, nowIso)
    expect(result.record.alias).toBeUndefined()
    expect(result.metadataAction).toBe('replaced')
    expect(result.aliasAction).toBe('cleared')
    expect(result.identityAction).toBe('mismatch')
  })

  test('account-id mismatch keeps explicit alias', () => {
    const existing = { alias: 'main', tokens: { account_id: accountA } } as Record<string, unknown>
    const result = buildCodexVaultRecordForSave(existing, {
      accessToken: 'a',
      refreshToken: 'r',
      accountId: accountB,
      alias: 'backup2',
    }, nowIso)
    expect(result.record.alias).toBe('backup2')
    expect(result.aliasAction).toBe('set')
    expect(result.identityAction).toBe('mismatch')
  })

  test('new save creates valid minimal record', () => {
    const result = buildCodexVaultRecordForSave(undefined, {
      accessToken: 'a',
      refreshToken: 'r',
      accountId: accountA,
    }, nowIso)
    expect(result.metadataAction).toBe('new')
    expect(result.identityAction).toBe('new')
    const tokens = result.record.tokens as Record<string, unknown>
    expect(tokens.account_id).toBe(accountA)
    expect(result.record.last_refresh).toBe(nowIso)
  })
})
