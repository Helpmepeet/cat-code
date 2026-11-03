import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'

import * as atomic from '../../utils/atomicFile.js'
import * as authority from './claudeAccountAuthority.js'
import * as secure from '../../utils/secureStorage/index.js'
import * as configuration from '../../utils/config.js'
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
  getActiveClaudeAccount,
  reloadActiveClaudeAccountCredentials,
  retryClaudeAccountTokenPersistence,
  appendClaudeAccount,
  getSelectedClaudeAccountIdentity,
  switchToClaudeAccount,
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
  // This suite WRITES: `updateClaudeAccountTokens` ends in
  // `saveClaudeTokenToVault`. `resetClaudeAccountPoolForTest` clears
  // `vaultPathOverrideForTest`, so without an override re-set AFTER it, the
  // vault path falls back to the real `~/claude-vault` and the fixtures below
  // land in the operator's own credential store. That happened: an
  // `account-a@example.com` file sat in the real vault until 2026-08-16.
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

  test.each(['rejected', 'uncertain'] as const)('fresh inventory retains %s metadata without credential payloads', disposition => {
    const installed = authority.commitClaudeLogin('metadata-account', 'login', {
      accessToken: 'secret-access', refreshToken: 'secret-refresh', expiresAt: 100,
    }, { account_uuid: 'metadata-account', email_address: 'metadata@example.com', alias: 'Saved' })
    if (!installed.handle) throw new Error('Expected committed fixture')
    if (disposition === 'rejected') authority.rejectClaudeCredential(installed.handle, 'reject')
    else {
      const claim = authority.claimClaudeRefresh(installed.handle, 'refresh', 'owner').claim!
      authority.startClaudeRefreshDispatch(claim, () => true)
      authority.markClaudeRefreshUncertain(claim)
    }
    setClaudeConfigAccountForTest({ active: true, value: null })
    loadClaudePoolForObservation()
    expect(getClaudePoolStatus().accounts).toHaveLength(1)
    expect(getClaudePoolStatus().accounts[0]).toMatchObject({
      accountUuid: 'metadata-account', emailAddress: 'metadata@example.com', alias: 'Saved',
      status: 'dead', accessToken: '', refreshToken: '', expiresAt: 0,
    })
    expect(getActiveClaudeAccount()).toBeNull()
  })

  test('inventory reload preserves an old chat generation until an exact deliberate selection', () => {
    const first = authority.commitClaudeLogin('pinned', 'first-login', {
      accessToken: 'first', refreshToken: 'first-refresh', expiresAt: 100,
    }, { account_uuid: 'pinned', email_address: 'pinned@example.com' })
    seedClaudeAccountPoolForTest({ accounts: [{
      ...buildClaudeAccount({ accountUuid: 'pinned', accessToken: 'first' }),
      lifecycleGeneration: first.handle!.generation, credentialRevision: 0,
    }], activeAccountUuid: 'pinned' })
    const second = authority.commitClaudeLogin('pinned', 'second-login', {
      accessToken: 'second', refreshToken: 'second-refresh', expiresAt: 100,
    }, { account_uuid: 'pinned', email_address: 'pinned@example.com' })
    setClaudeConfigAccountForTest({ active: true, value: null })
    loadClaudePoolForObservation()
    expect(getSelectedClaudeAccountIdentity()?.generation).toBe(first.handle!.generation)
    expect(getActiveClaudeAccount()).toBeNull()
    expect(switchToClaudeAccount('pinned', { persistDefault: false, expectedLoginGeneration: first.handle!.generation })).toBeNull()
    expect(switchToClaudeAccount('pinned', { persistDefault: false, expectedLoginGeneration: second.handle!.generation })?.accessToken).toBe('second')
  })

  test('observation shows a new staged login using pending metadata only and hides plain tombstones', () => {
    const original = atomic.writeFileAtomicDurableSync
    const fail = spyOn(atomic, 'writeFileAtomicDurableSync').mockImplementation((path, data, options) => {
      if (String(path).includes('authority-v1') && JSON.parse(String(data)).loginGeneration === 1) throw new Error('synthetic login commit failure')
      return original(path, data, options)
    })
    try {
      expect(authority.commitClaudeLogin('new-pending', 'staged-new', {
        accessToken: 'issued-secret', refreshToken: 'issued-refresh', expiresAt: 100,
      }, { account_uuid: 'new-pending', email_address: 'pending@example.com', alias: 'Pending' }).outcome).toBe('persistence_pending')
    } finally { fail.mockRestore() }
    expect(authority.readClaudeAccountAuthority('new-pending')).toMatchObject({
      status: 'persistence_pending', record: { state: 'deleted' },
    })
    setClaudeConfigAccountForTest({ active: true, value: null })
    const writes = spyOn(atomic, 'writeFileAtomicDurableSync')
    try {
      loadClaudePoolForObservation()
      expect(writes).not.toHaveBeenCalled()
      expect(getClaudePoolStatus().accounts).toHaveLength(1)
      expect(getClaudePoolStatus().accounts[0]).toMatchObject({
        accountUuid: 'new-pending', emailAddress: 'pending@example.com', alias: 'Pending',
        accessToken: '', refreshToken: '', expiresAt: 0, status: 'dead',
      })
      expect(getActiveClaudeAccount()).toBeNull()
    } finally { writes.mockRestore() }
    const staged = authority.readClaudeAccountAuthority('new-pending')
    if (!('handle' in staged)) throw new Error('Missing pending handle')
    expect(authority.deleteClaudeAccountAuthority(staged.handle).outcome).toBe('committed')
    loadClaudePoolForObservation()
    expect(getClaudePoolStatus().accounts).toHaveLength(0)
  })

  test('production init can finish a staged login without moving an existing chat to its new generation', () => {
    const account = buildClaudeAccount({ accountUuid: 'pinned-init' })
    const profile = { account_uuid: account.accountUuid, email_address: account.emailAddress }
    const first = authority.commitClaudeLogin(account.accountUuid, 'first', account, profile)
    seedClaudeAccountPoolForTest({ accounts: [{ ...account, lifecycleGeneration: first.handle!.generation }], activeAccountUuid: account.accountUuid })
    const original = atomic.writeFileAtomicDurableSync
    const fail = spyOn(atomic, 'writeFileAtomicDurableSync').mockImplementation((path, data, options) => {
      if (String(path).includes('authority-v1') && JSON.parse(String(data)).loginGeneration === 2) throw new Error('synthetic login commit failure')
      return original(path, data, options)
    })
    try { authority.commitClaudeLogin(account.accountUuid, 'staged', { ...account, accessToken: 'new-login' }, profile) } finally { fail.mockRestore() }
    const save = spyOn(configuration, 'saveGlobalConfig').mockReturnValue(true)
    setClaudeConfigAccountForTest({ active: true, value: null })
    try {
      initClaudeAccountPool()
      expect(authority.readClaudeAccountAuthority(account.accountUuid)).toMatchObject({ status: 'ready', handle: { generation: 2 } })
      expect(getSelectedClaudeAccountIdentity()?.generation).toBe(1)
      expect(getActiveClaudeAccount()).toBeNull()
    } finally { save.mockRestore() }
  })

  test.each(['stage', 'commit'] as const)('append retains the typed receipt after a failed login %s and retries the original operation', phase => {
    const account = buildClaudeAccount({ accountUuid: 'typed-install', accessToken: 'original' })
    const profile = { account_uuid: account.accountUuid, email_address: account.emailAddress }
    authority.commitClaudeLogin(account.accountUuid, 'original', account, profile)
    let config: any = {}
    const storage = spyOn(secure, 'getSecureStorage').mockImplementation(() => { throw new Error('isolated unavailable mirror') })
    const getConfig = spyOn(configuration, 'getGlobalConfig').mockImplementation(() => config)
    const saveConfig = spyOn(configuration, 'saveGlobalConfig').mockImplementation(update => { config = update(config); return true })
    const original = atomic.writeFileAtomicDurableSync
    const fail = spyOn(atomic, 'writeFileAtomicDurableSync').mockImplementation((path, data, options) => {
      const state = String(path).includes('authority-v1') ? JSON.parse(String(data)) : undefined
      if (state && (phase === 'stage' ? state.pendingLogin?.operationId === 'captured-install' : state.loginGeneration === 2)) throw new Error('synthetic disk failure')
      return original(path, data, options)
    })
    try {
      let error: unknown
      try { appendClaudeAccount({ ...account, accessToken: 'issued-secret' }, { operationId: 'captured-install' }) } catch (caught) { error = caught }
      expect(error).toBeInstanceOf(authority.ClaudeLoginInstallationError)
      const receipt = (error as authority.ClaudeLoginInstallationError).result
      expect(receipt).toMatchObject({
        operationId: 'captured-install', outcome: 'persistence_pending', restartRecoverable: phase === 'commit',
      })
      expect(JSON.stringify(error)).not.toContain('issued-secret')
      fail.mockRestore()
      expect(appendClaudeAccount({ ...account, accessToken: 'issued-secret' }, { operationId: receipt.operationId }))
        .toMatchObject({ outcome: 'committed', handle: { generation: 2 } })
      expect(appendClaudeAccount({ ...account, accessToken: 'issued-secret' }, { operationId: receipt.operationId }))
        .toMatchObject({ outcome: 'committed', handle: { generation: 2 } })
    } finally { fail.mockRestore(); storage.mockRestore(); getConfig.mockRestore(); saveConfig.mockRestore() }
  })

  test('a newly issued login does not reuse a failed login operation for the same account', () => {
    const first = buildClaudeAccount({ accountUuid: 'new-login' })
    authority.commitClaudeLogin(first.accountUuid, 'original', first, {
      account_uuid: first.accountUuid, email_address: first.emailAddress,
    })
    let stored: any = {}
    let config: any = {}
    const storage = spyOn(secure, 'getSecureStorage').mockReturnValue({
      name: 'test', read: () => stored, readAsync: async () => stored,
      update: data => { stored = data; return { success: true } }, delete: () => true,
    })
    const getConfig = spyOn(configuration, 'getGlobalConfig').mockImplementation(() => config)
    const saveConfig = spyOn(configuration, 'saveGlobalConfig').mockImplementation(update => { config = update(config); return true })
    const fail = spyOn(atomic, 'writeFileAtomicDurableSync').mockImplementation(() => { throw new Error('synthetic staging failure') })
    try {
      expect(() => appendClaudeAccount({ ...first, accessToken: 'issued-a' }, { operationId: 'issued-a-op' })).toThrow('Failed to save Claude sign-in')
      fail.mockRestore()
      const second = appendClaudeAccount({ ...first, accessToken: 'issued-b' })
      expect(second).toMatchObject({ outcome: 'committed', handle: { generation: 2 } })
      expect(second.operationId).not.toBe('issued-a-op')
      expect(() => appendClaudeAccount({ ...first, accessToken: 'issued-a' }, { operationId: 'issued-a-op' })).toThrow('Failed to save Claude sign-in')
      expect(authority.readClaudeAccountAuthority(first.accountUuid)).toMatchObject({
        status: 'ready', record: { credentials: { accessToken: 'issued-b' } },
      })
    } finally { fail.mockRestore(); storage.mockRestore(); getConfig.mockRestore(); saveConfig.mockRestore() }
  })

  test('inventory reload cannot regress pending credentials and local retry preserves account identity', () => {
    const account = buildClaudeAccount({ accountUuid: 'pending-account' })
    seedClaudeAccountPoolForTest({ accounts: [account], activeAccountUuid: account.accountUuid })
    expect(updateClaudeAccountTokens(account.accountUuid, { accessToken: 'old', expiresAt: 100 })).toBe('durable')
    const write = spyOn(atomic, 'writeFileAtomicDurableSync').mockImplementation(() => { throw new Error('ENOSPC') })
    try {
      expect(updateClaudeAccountTokens(account.accountUuid, { accessToken: 'new', refreshToken: 'rotated', expiresAt: 200 })).toBe('pending')
      setClaudeConfigAccountForTest({ active: true, value: null })
      loadClaudePoolForObservation()
      expect(getActiveClaudeAccount()?.accessToken).toBe('new')
      expect(getActiveClaudeAccount()?.refreshToken).toBe('rotated')
      expect(retryClaudeAccountTokenPersistence(account.accountUuid)).toBe('pending')
    } finally { write.mockRestore() }
    expect(retryClaudeAccountTokenPersistence(account.accountUuid)).toBe('durable')
    expect(JSON.parse(readFileSync(join(vaultDir, 'authority-v1', 'pending-account.json'), 'utf8')).credentials.accessToken).toBe('new')
    expect(JSON.parse(readFileSync(join(vaultDir, 'accounts', 'pending-account.json'), 'utf8')).tokens).toBeUndefined()
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
  function writeVaultAccountFile(
    account: ClaudePoolAccount,
    lastRefresh = new Date().toISOString(),
  ): void {
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
      last_refresh: lastRefresh,
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

  test('loads an account with an eight-day-old refresh timestamp as healthy', () => {
    writeVaultAccountFile(
      buildClaudeAccount({ accountUuid: 'vault-uuid', emailAddress: 'vault@example.com' }),
      new Date(Date.now() - 8 * 24 * 3600_000).toISOString(),
    )
    setClaudeConfigAccountForTest({ active: true, value: null })

    loadClaudePoolForObservation()

    expect(getClaudePoolStatus().accounts[0]?.status).toBe('healthy')
  })

  test('inventory reload retains process selection while a fresh process adopts the disk default', () => {
    writeVaultAccountFile(buildClaudeAccount({ accountUuid: 'apple' }))
    writeVaultAccountFile(buildClaudeAccount({ accountUuid: 'gmail' }))
    setClaudeConfigAccountForTest({ active: true, value: null })
    saveGlobalConfig(current => ({ ...current, activeClaudeAccountUuid: 'apple' }))
    loadClaudePoolForObservation()
    saveGlobalConfig(current => ({ ...current, activeClaudeAccountUuid: 'gmail' }))
    writeVaultAccountFile(buildClaudeAccount({ accountUuid: 'apple', accessToken: 'refreshed-apple' }))
    loadClaudePoolForObservation()
    expect(getActiveClaudeAccount()?.accountUuid).toBe('apple')
    expect(getActiveClaudeAccount()?.accessToken).toBe('refreshed-apple')

    resetClaudeAccountPoolForTest()
    setClaudeVaultPathForTest(vaultDir)
    setClaudeConfigAccountForTest({ active: true, value: null })
    loadClaudePoolForObservation()
    expect(getActiveClaudeAccount()?.accountUuid).toBe('gmail')
  })

  test('credential reload updates only the selected identity from its vault', () => {
    writeVaultAccountFile(buildClaudeAccount({ accountUuid: 'apple' }))
    writeVaultAccountFile(buildClaudeAccount({ accountUuid: 'gmail' }))
    setClaudeConfigAccountForTest({ active: true, value: null })
    saveGlobalConfig(current => ({ ...current, activeClaudeAccountUuid: 'apple' }))
    loadClaudePoolForObservation()
    const selected = getActiveClaudeAccount()
    writeVaultAccountFile(buildClaudeAccount({ accountUuid: 'apple', accessToken: 'fresh', emailAddress: 'changed@example.com' }))
    saveGlobalConfig(current => ({ ...current, activeClaudeAccountUuid: 'gmail' }))
    reloadActiveClaudeAccountCredentials()
    expect(getActiveClaudeAccount()).toBe(selected)
    expect(selected?.accountUuid).toBe('apple')
    expect(selected?.emailAddress).toBe('apple@example.com')
    expect(selected?.accessToken).toBe('fresh')
  })

  test('keeps each vault credential when the config identity is paired with another account token', () => {
    const apple = buildClaudeAccount({ accountUuid: 'apple' })
    const gmail = buildClaudeAccount({ accountUuid: 'gmail' })
    writeVaultAccountFile(apple)
    writeVaultAccountFile(gmail)
    setClaudeConfigAccountForTest({
      active: true,
      value: { ...apple, accessToken: gmail.accessToken, refreshToken: gmail.refreshToken },
    })
    saveGlobalConfig(current => ({ ...current, activeClaudeAccountUuid: apple.accountUuid }))

    loadClaudePoolForObservation()

    const { accounts, activeIndex } = getClaudePoolStatus()
    expect(accounts[activeIndex]?.accountUuid).toBe(apple.accountUuid)
    expect(accounts.map(({ accountUuid, accessToken, refreshToken }) => ({
      accountUuid, accessToken, refreshToken,
    }))).toEqual([apple, gmail].map(({ accountUuid, accessToken, refreshToken }) => ({
      accountUuid, accessToken, refreshToken,
    })))
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

    const written = JSON.parse(readFileSync(join(vaultDir, 'authority-v1', 'resurrection-uuid.json'), 'utf-8')) as {
      credentials: { accessToken: string }
      profile: { account_uuid: string }
    }
    expect(written.credentials.accessToken).toBe(configOnly.accessToken)
    expect(written.profile.account_uuid).toBe('resurrection-uuid')
    expect(statSync(accountsDir()).mode & 0o777).toBe(0o700)
    expect(statSync(filePath).mode & 0o777).toBe(0o600)
    expect(readdirSync(accountsDir()).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  test('observation does not write permission repairs; initialization does', () => {
    const account = buildClaudeAccount({ accountUuid: 'repair-uuid' })
    writeVaultAccountFile(account)
    const filePath = vaultFilePathFor(account.accountUuid)
    chmodSync(accountsDir(), 0o755)
    chmodSync(filePath, 0o644)

    loadClaudePoolForObservation()

    expect(statSync(accountsDir()).mode & 0o777).toBe(0o755)
    expect(statSync(filePath).mode & 0o777).toBe(0o644)
    initClaudeAccountPool()
    expect(statSync(accountsDir()).mode & 0o777).toBe(0o700)
    expect(statSync(filePath).mode & 0o777).toBe(0o600)
  })
})

describe('Claude vault cross-process mutations', () => {
  for (const action of ['save', 'alias', 'delete'] as const) {
    test(`${action} waits for the terminal profile lock`, async () => {
      const dir = mkdtempSync(join(tmpdir(), `claude-vault-${action}-`))
      const accountsDir = join(dir, 'accounts')
      mkdirSync(accountsDir, { recursive: true })
      const vaultPath = join(accountsDir, 'synthetic-account.json')
      const readyPath = join(dir, 'terminal-ready')
      writeFileSync(
        vaultPath,
        JSON.stringify({
          tokens: {
            access_token: 'old-access',
            refresh_token: 'old-refresh',
            expires_at: Date.now() + 60_000,
          },
          profile: {
            account_uuid: 'synthetic-account',
            email_address: 'synthetic@example.com',
          },
        }),
        { mode: 0o600 },
      )
      const childPath = join(
        import.meta.dir,
        'claudeAccountPool.probe.child.ts',
      )
      const original = JSON.parse(readFileSync(vaultPath, 'utf8'))
      const children = ['terminal-holder', 'desktop-mutator'].map(role =>
        Bun.spawn(
          [process.execPath, childPath, role, action, vaultPath, readyPath],
          { stdout: 'pipe', stderr: 'pipe' },
        ),
      )
      const recordedPids = children.map(child => child.pid)

      try {
        const exits = await Promise.race([
          Promise.all(children.map(child => child.exited)),
          new Promise<never>((_, reject) => {
            setTimeout(() => {
              for (const child of children) child.kill()
              reject(
                new Error(
                  `timed out waiting for exact child PIDs ${recordedPids.join(', ')}`,
                ),
              )
            }, 10_000).unref()
          }),
        ])
        const [stdout, stderr] = await Promise.all([
          Promise.all(
            children.map(child => new Response(child.stdout).text()),
          ),
          Promise.all(
            children.map(child => new Response(child.stderr).text()),
          ),
        ])
        expect(exits, stderr.join('\n')).toEqual([0, 0])
        expect(
          stdout
            .map(value => (JSON.parse(value) as { pid: number }).pid)
            .sort(),
        ).toEqual(recordedPids.sort())

        if (action === 'delete') {
          expect(existsSync(vaultPath)).toBe(false)
        } else {
          const value = JSON.parse(readFileSync(vaultPath, 'utf8'))
          if (action === 'save') {
            const record = JSON.parse(readFileSync(join(dir, 'authority-v1', 'synthetic-account.json'), 'utf8'))
            expect(record.credentials.accessToken).toBe('desktop-access')
            expect(record.migration.legacyHash).toBe(createHash('sha256')
              .update(JSON.stringify({ ...original, terminal_marker: action }, (_key, item) =>
                item && typeof item === 'object' && !Array.isArray(item)
                  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex'))
            expect(value.tokens).toBeUndefined()
          } else {
            expect(value.terminal_marker).toBe(action)
            expect(value.alias).toBe('desktop-alias')
          }
        }
      } finally {
        await Promise.all(children.map(child => child.exited))
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }
})
