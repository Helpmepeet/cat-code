import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { saveGlobalConfig } from '../../utils/config.js'
import {
  getClaudePoolStatus,
  initClaudeAccountPool,
  loadClaudePoolForObservation,
  resetClaudeAccountPoolForTest,
  resolveClaudeAccountByPrefix,
  seedClaudeAccountPoolForTest,
  setClaudeConfigAccountForTest,
  setClaudeVaultPathForTest,
  updateClaudeAccountTokens,
  type ClaudePoolAccount,
} from './claudeAccountPool.js'

function buildClaudeAccount(
  overrides: Partial<ClaudePoolAccount> & Pick<ClaudePoolAccount, 'accountUuid'>,
): ClaudePoolAccount {
  return {
    accountUuid: overrides.accountUuid,
    emailAddress: overrides.emailAddress ?? `${overrides.accountUuid}@example.com`,
    accessToken: overrides.accessToken ?? `access-${overrides.accountUuid}`,
    refreshToken: overrides.refreshToken ?? `refresh-${overrides.accountUuid}`,
    expiresAt: overrides.expiresAt ?? Date.now() + 60_000,
    status: overrides.status ?? 'healthy',
    alias: overrides.alias,
    scopes: overrides.scopes,
    subscriptionType: overrides.subscriptionType ?? null,
    rateLimitTier: overrides.rateLimitTier ?? null,
    displayName: overrides.displayName,
    organizationUuid: overrides.organizationUuid,
    organizationName: overrides.organizationName,
    organizationRole: overrides.organizationRole,
    workspaceRole: overrides.workspaceRole,
    billingType: overrides.billingType,
    hasExtraUsageEnabled: overrides.hasExtraUsageEnabled,
    accountCreatedAt: overrides.accountCreatedAt,
    subscriptionCreatedAt: overrides.subscriptionCreatedAt,
    vaultFilePath: overrides.vaultFilePath,
  }
}

describe('resolveClaudeAccountByPrefix', () => {
  beforeEach(() => {
    resetClaudeAccountPoolForTest()
  })

  test('returns unique on exact alias match even when another alias has it as a prefix', () => {
    seedClaudeAccountPoolForTest({
      activeAccountUuid: 'uuid-1',
      accounts: [
        buildClaudeAccount({ accountUuid: 'uuid-1', alias: 'work' }),
        buildClaudeAccount({ accountUuid: 'uuid-2', alias: 'work2' }),
      ],
    })

    const result = resolveClaudeAccountByPrefix('work')
    expect(result.kind).toBe('unique')
    if (result.kind === 'unique') {
      expect(result.account.accountUuid).toBe('uuid-1')
    }
  })

  test('returns unique on exact email match', () => {
    seedClaudeAccountPoolForTest({
      activeAccountUuid: 'uuid-1',
      accounts: [
        buildClaudeAccount({ accountUuid: 'uuid-1', emailAddress: 'alice@example.com' }),
        buildClaudeAccount({ accountUuid: 'uuid-2', emailAddress: 'alice2@example.com' }),
      ],
    })

    const result = resolveClaudeAccountByPrefix('alice@example.com')
    expect(result.kind).toBe('unique')
    if (result.kind === 'unique') {
      expect(result.account.accountUuid).toBe('uuid-1')
    }
  })

  test('returns unique on exact uuid match', () => {
    seedClaudeAccountPoolForTest({
      activeAccountUuid: 'uuid-1111',
      accounts: [
        buildClaudeAccount({ accountUuid: 'uuid-1111' }),
        buildClaudeAccount({ accountUuid: 'uuid-1111-extra' }),
      ],
    })

    const result = resolveClaudeAccountByPrefix('uuid-1111')
    expect(result.kind).toBe('unique')
    if (result.kind === 'unique') {
      expect(result.account.accountUuid).toBe('uuid-1111')
    }
  })

  test('returns ambiguous when two aliases share a prefix', () => {
    seedClaudeAccountPoolForTest({
      activeAccountUuid: 'uuid-1',
      accounts: [
        buildClaudeAccount({ accountUuid: 'uuid-1', alias: 'home1' }),
        buildClaudeAccount({ accountUuid: 'uuid-2', alias: 'home2' }),
      ],
    })

    const result = resolveClaudeAccountByPrefix('home')
    expect(result.kind).toBe('ambiguous')
    if (result.kind === 'ambiguous') {
      expect(result.matches.map((a) => a.accountUuid).sort()).toEqual(['uuid-1', 'uuid-2'])
    }
  })

  test('returns ambiguous when two emails share a prefix', () => {
    seedClaudeAccountPoolForTest({
      activeAccountUuid: 'uuid-1',
      accounts: [
        buildClaudeAccount({ accountUuid: 'uuid-1', emailAddress: 'bob@example.com' }),
        buildClaudeAccount({ accountUuid: 'uuid-2', emailAddress: 'bobby@example.com' }),
      ],
    })

    const result = resolveClaudeAccountByPrefix('bob')
    expect(result.kind).toBe('ambiguous')
  })

  test('returns ambiguous when two uuids share a prefix', () => {
    seedClaudeAccountPoolForTest({
      activeAccountUuid: 'aaaa-1',
      accounts: [
        buildClaudeAccount({ accountUuid: 'aaaa-1' }),
        buildClaudeAccount({ accountUuid: 'aaaa-2' }),
      ],
    })

    const result = resolveClaudeAccountByPrefix('aaaa')
    expect(result.kind).toBe('ambiguous')
  })

  test('returns ambiguous on cross-field prefix (alias vs email)', () => {
    seedClaudeAccountPoolForTest({
      activeAccountUuid: 'uuid-1',
      accounts: [
        buildClaudeAccount({ accountUuid: 'uuid-1', alias: 'demo-alias', emailAddress: 'a@x.com' }),
        buildClaudeAccount({ accountUuid: 'uuid-2', alias: 'other', emailAddress: 'demo@x.com' }),
      ],
    })

    const result = resolveClaudeAccountByPrefix('demo')
    expect(result.kind).toBe('ambiguous')
    if (result.kind === 'ambiguous') {
      expect(result.matches.length).toBe(2)
    }
  })

  test('returns none when nothing matches', () => {
    seedClaudeAccountPoolForTest({
      activeAccountUuid: 'uuid-1',
      accounts: [buildClaudeAccount({ accountUuid: 'uuid-1', alias: 'work' })],
    })

    expect(resolveClaudeAccountByPrefix('zzz').kind).toBe('none')
  })

  test('onlyHealthy:true filters out non-healthy accounts', () => {
    seedClaudeAccountPoolForTest({
      activeAccountUuid: 'uuid-1',
      accounts: [
        buildClaudeAccount({ accountUuid: 'uuid-1', alias: 'workA' }),
        buildClaudeAccount({ accountUuid: 'uuid-2', alias: 'workB', status: 'dead' }),
      ],
    })

    // Without filter, 'workA' and 'workB' both prefix 'work' -> ambiguous
    expect(resolveClaudeAccountByPrefix('work').kind).toBe('ambiguous')
    const filtered = resolveClaudeAccountByPrefix('work', { onlyHealthy: true })
    expect(filtered.kind).toBe('unique')
    if (filtered.kind === 'unique') {
      expect(filtered.account.accountUuid).toBe('uuid-1')
    }
  })
})

describe('updateClaudeAccountTokens', () => {
  beforeEach(() => {
    resetClaudeAccountPoolForTest()
  })

  test('updates the refresh source account when another account is active', () => {
    seedClaudeAccountPoolForTest({
      activeAccountUuid: 'account-b',
      accounts: [
        buildClaudeAccount({
          accountUuid: 'account-a',
          accessToken: 'access-a',
          refreshToken: 'refresh-a',
        }),
        buildClaudeAccount({
          accountUuid: 'account-b',
          accessToken: 'access-b',
          refreshToken: 'refresh-b',
        }),
      ],
    })

    updateClaudeAccountTokens('account-a', {
      accessToken: 'refreshed-access-a',
      refreshToken: 'refreshed-refresh-a',
    })

    const accounts = getClaudePoolStatus().accounts
    expect(accounts.find(account => account.accountUuid === 'account-a')).toMatchObject({
      accessToken: 'refreshed-access-a',
      refreshToken: 'refreshed-refresh-a',
    })
    expect(accounts.find(account => account.accountUuid === 'account-b')).toMatchObject({
      accessToken: 'access-b',
      refreshToken: 'refresh-b',
    })
  })
})

// Regression coverage for the accounts-pool-worker fix: the worker must be
// able to populate the Anthropic pool for display (loadClaudePoolForObservation)
// without ever performing the vault-migration write that resurrects a
// deleted account's credential file (initClaudeAccountPool's write half).
describe('loadClaudePoolForObservation vs initClaudeAccountPool (disk-write boundary)', () => {
  let vaultDir: string

  beforeEach(() => {
    resetClaudeAccountPoolForTest()
    vaultDir = mkdtempSync(join(tmpdir(), 'claude-vault-test-'))
    setClaudeVaultPathForTest(vaultDir)
  })

  afterEach(() => {
    resetClaudeAccountPoolForTest()
    rmSync(vaultDir, { recursive: true, force: true })
  })

  function accountsDir(): string {
    return join(vaultDir, 'accounts')
  }

  function vaultFilePathFor(uuid: string): string {
    return join(accountsDir(), `${uuid}.json`)
  }

  // Writes a vault JSON file directly (bypassing the module under test) to
  // seed a pre-existing vault account, matching the on-disk shape
  // loadVaultAccounts() expects.
  function writeVaultAccountFile(account: ClaudePoolAccount): void {
    mkdirSync(accountsDir(), { recursive: true })
    const data = {
      tokens: {
        access_token: account.accessToken,
        refresh_token: account.refreshToken,
        expires_at: account.expiresAt,
        scopes: account.scopes,
        subscription_type: account.subscriptionType,
        rate_limit_tier: account.rateLimitTier,
      },
      profile: {
        account_uuid: account.accountUuid,
        email_address: account.emailAddress,
      },
      last_refresh: new Date().toISOString(),
    }
    writeFileSync(vaultFilePathFor(account.accountUuid), JSON.stringify(data, null, 2) + '\n', 'utf-8')
  }

  test('loadClaudePoolForObservation reads an existing vault account without writing (worker regression)', () => {
    writeVaultAccountFile(
      buildClaudeAccount({ accountUuid: 'vault-uuid', emailAddress: 'vault@example.com' }),
    )
    setClaudeConfigAccountForTest({ active: true, value: null })

    loadClaudePoolForObservation()

    const status = getClaudePoolStatus()
    expect(status.initialized).toBe(true)
    expect(status.accounts.map((a) => a.accountUuid)).toEqual(['vault-uuid'])
    expect(status.accounts[0]?.status).toBe('healthy')
    expect(status.activeIndex).toBe(0)
  })

  test('loadClaudePoolForObservation merges a config-only account into memory without writing to the vault', () => {
    const configOnly = buildClaudeAccount({
      accountUuid: 'resurrection-uuid',
      emailAddress: 'resurrected@example.com',
    })
    setClaudeConfigAccountForTest({ active: true, value: configOnly })
    saveGlobalConfig((current) => ({ ...current, activeClaudeAccountUuid: 'resurrection-uuid' }))

    loadClaudePoolForObservation()

    const status = getClaudePoolStatus()
    expect(status.initialized).toBe(true)
    expect(status.accounts.map((a) => a.accountUuid)).toEqual(['resurrection-uuid'])
    expect(status.accounts[0]?.vaultFilePath).toBeUndefined()
    expect(status.activeIndex).toBe(0)

    // No disk write at all: not the file, not even the accounts directory.
    expect(existsSync(vaultFilePathFor('resurrection-uuid'))).toBe(false)
    expect(existsSync(accountsDir())).toBe(false)
  })

  test('initClaudeAccountPool still migrates a config-only account to the vault under the same state (extraction is behavior-preserving)', () => {
    const configOnly = buildClaudeAccount({
      accountUuid: 'resurrection-uuid',
      emailAddress: 'resurrected@example.com',
    })
    setClaudeConfigAccountForTest({ active: true, value: configOnly })
    saveGlobalConfig((current) => ({ ...current, activeClaudeAccountUuid: 'resurrection-uuid' }))

    initClaudeAccountPool()

    const status = getClaudePoolStatus()
    expect(status.initialized).toBe(true)
    expect(status.accounts.map((a) => a.accountUuid)).toEqual(['resurrection-uuid'])
    expect(status.activeIndex).toBe(0)

    const filePath = vaultFilePathFor('resurrection-uuid')
    expect(existsSync(filePath)).toBe(true)
    expect(status.accounts[0]?.vaultFilePath).toBe(filePath)

    const written = JSON.parse(readFileSync(filePath, 'utf-8')) as {
      tokens: { access_token: string }
      profile: { account_uuid: string }
    }
    expect(written.tokens.access_token).toBe(configOnly.accessToken)
    expect(written.profile.account_uuid).toBe('resurrection-uuid')
    expect(statSync(accountsDir()).mode & 0o777).toBe(0o700)
    expect(statSync(filePath).mode & 0o777).toBe(0o600)
    expect(readdirSync(accountsDir()).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  test('loadClaudePoolForObservation repairs permissive vault file and directory modes', () => {
    const account = buildClaudeAccount({ accountUuid: 'repair-uuid' })
    writeVaultAccountFile(account)
    const filePath = vaultFilePathFor(account.accountUuid)
    chmodSync(accountsDir(), 0o755)
    chmodSync(filePath, 0o644)

    loadClaudePoolForObservation()

    expect(statSync(accountsDir()).mode & 0o777).toBe(0o700)
    expect(statSync(filePath).mode & 0o777).toBe(0o600)
  })
})
