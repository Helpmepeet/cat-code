import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as config from '../../utils/config.js'
import * as secure from '../../utils/secureStorage/index.js'
import { removeMatchingClaudeOAuthFromStores } from '../../utils/secureStorage/crossProcessStorage.js'
import { plainTextStorage } from '../../utils/secureStorage/plainTextStorage.js'
import { clearOAuthTokenCache, getClaudeAIOAuthTokens, getClaudeAIOAuthTokensAsync } from '../../utils/auth.js'
import * as pool from './claudeAccountPool.js'
import * as authority from './claudeAccountAuthority.js'
import * as atomic from '../../utils/atomicFile.js'
import * as auth from '../../utils/auth.js'
import * as oauth from '../oauth/client.js'
import { blockSessionAccountRoute, clearSessionAccountRouteBlock } from './sessionAccountRouting.js'

let dir: string
let data: any
let settings: any
let failStorage: boolean
let failConfig: boolean
let previousConfigDir: string | undefined
let previousCustomHeaders: string | undefined
const account = {
  accountUuid: 'deleted', emailAddress: 'deleted@example.com',
  accessToken: 'access-deleted', refreshToken: 'refresh-deleted',
  expiresAt: Date.now() + 3600000, status: 'healthy' as const,
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-delete-'))
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  previousCustomHeaders = process.env.ANTHROPIC_CUSTOM_HEADERS
  delete process.env.ANTHROPIC_CUSTOM_HEADERS
  process.env.CLAUDE_CONFIG_DIR = dir
  mkdirSync(join(dir, 'accounts'))
  writeFileSync(join(dir, 'accounts/deleted.json'), JSON.stringify({
    profile: { account_uuid: account.accountUuid, email_address: account.emailAddress },
    tokens: { access_token: account.accessToken, refresh_token: account.refreshToken, expires_at: account.expiresAt },
  }))
  data = { claudeAiOauth: { ...account, scopes: ['user:inference'] }, otherProvider: { token: 'keep' } }
  settings = { oauthAccount: { accountUuid: account.accountUuid, emailAddress: account.emailAddress }, activeClaudeAccountUuid: account.accountUuid, codex: 'keep' }
  failStorage = false
  failConfig = false
  spyOn(secure, 'removeMatchingClaudeOAuthCredentials').mockImplementation(tokens =>
    removeMatchingClaudeOAuthFromStores([{
      name: 'test',
      readFresh: () => data === null ? { status: 'unavailable', data: null } : { status: 'present', data: structuredClone(data) },
      read: () => structuredClone(data),
      readAsync: async () => structuredClone(data),
      update: next => { if (failStorage) return { success: false }; data = structuredClone(next); return { success: true } },
      delete: () => { throw new Error('must not wipe storage') },
    }], tokens))
  spyOn(secure, 'getSecureStorage').mockImplementation(() => ({
    name: 'test', read: () => structuredClone(data), readAsync: async () => structuredClone(data),
    update: next => { if (failStorage) return { success: false }; data = structuredClone(next); return { success: true } },
    delete: () => { throw new Error('must not wipe storage') },
  }))
  spyOn(config, 'getGlobalConfig').mockImplementation(() => settings)
  spyOn(config, 'saveGlobalConfig').mockImplementation(updater => {
    if (failConfig) return false
    settings = updater(settings)
    return true
  })
  pool.resetClaudeAccountPoolForTest()
  pool.setClaudeVaultPathForTest(dir)
  pool.seedClaudeAccountPoolForTest({ accounts: [{ ...account, vaultFilePath: join(dir, 'accounts/deleted.json') }], activeAccountUuid: account.accountUuid })
  clearOAuthTokenCache()
})

afterEach(() => {
  clearSessionAccountRouteBlock('anthropic')
  clearOAuthTokenCache()
  mock.restore()
  pool.resetClaudeAccountPoolForTest()
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  if (previousCustomHeaders === undefined) delete process.env.ANTHROPIC_CUSTOM_HEADERS
  else process.env.ANTHROPIC_CUSTOM_HEADERS = previousCustomHeaders
  rmSync(dir, { recursive: true, force: true })
})

test('signout preserves inventory and nickname through reload and relogin, with stale-generation fencing', () => {
  pool.appendClaudeAccount({ ...account, alias: 'legacy nickname' })
  const generation = authority.readClaudeAccountAuthority(account.accountUuid)
  if (!('handle' in generation)) throw new Error('missing authority')
  expect(pool.signOutClaudeAccount(account.accountUuid, generation.handle.generation + 1)).toBe(false)
  expect(pool.signOutClaudeAccount(account.accountUuid, generation.handle.generation)).toBe(true)
  expect(settings.activeClaudeAccountUuid).toBe(account.accountUuid)
  pool.resetClaudeAccountPoolForTest()
  pool.setClaudeVaultPathForTest(dir)
  pool.loadClaudePoolForObservation()
  const signedOut = pool.getClaudeProfileInventory().signedOutProfiles
  expect(signedOut).toHaveLength(1)
  expect(signedOut[0]?.alias).toBe('legacy nickname')
  pool.appendClaudeAccount(account, { makeDefault: false })
  expect(pool.getClaudePoolStatus().accounts[0]?.alias).toBe('legacy nickname')
  expect(pool.getClaudeProfileInventory().signedOutProfiles).toHaveLength(0)
  expect(pool.removeClaudeAccount(account.accountUuid, signedOut[0]!.loginGeneration)).toBe(false)
})

test('signed out metadata can be deleted by its observed generation', () => {
  pool.appendClaudeAccount(account)
  const read = authority.readClaudeAccountAuthority(account.accountUuid)
  if (!('handle' in read)) throw new Error('missing authority')
  expect(pool.signOutClaudeAccount(account.accountUuid, read.handle.generation)).toBe(true)
  const profile = pool.getClaudeProfileInventory().signedOutProfiles[0]!
  expect(pool.removeClaudeAccount(profile.accountUuid, profile.loginGeneration)).toBe(true)
  expect(pool.getClaudeProfileInventory().signedOutProfiles).toHaveLength(0)
})

test('idle sign-in check uses account authority without changing default or exposing credentials', async () => {
  pool.appendClaudeAccount(account)
  pool.appendClaudeAccount({ ...account, accountUuid: 'idle' }, { makeDefault: false })
  const before = pool.getClaudeDefaultSelection()
  expect(await pool.checkClaudeAccountSignIn('idle')).toEqual({ status: 'ready' })
  expect(pool.getClaudeDefaultSelection()).toEqual(before)
  expect(await pool.checkClaudeAccountSignIn('unknown')).toEqual({ status: 'temporarily_unavailable' })
})

test('expired idle account refreshes through its generation-bound authority without selecting it', async () => {
  pool.appendClaudeAccount(account)
  pool.appendClaudeAccount({ ...account, accountUuid: 'expired-idle', refreshToken: 'idle-refresh', expiresAt: Date.now() - 3 * 86400_000 }, { makeDefault: false })
  const before = pool.getClaudeDefaultSelection()
  const refresh = spyOn(oauth, 'refreshOAuthToken').mockImplementation(async (_token, options) =>
    options!.initiateRequest!(() => Promise.resolve({
      accessToken: 'idle-successor', refreshToken: 'idle-successor-refresh', expiresAt: Date.now() + 3600_000,
      scopes: ['user:inference'], subscriptionType: null, rateLimitTier: null,
    })))
  expect(await pool.checkClaudeAccountSignIn('expired-idle')).toEqual({ status: 'ready' })
  expect(refresh).toHaveBeenCalledWith('idle-refresh', expect.any(Object))
  expect(pool.getClaudeDefaultSelection()).toEqual(before)
  const read = authority.readClaudeAccountAuthority('expired-idle')
  expect('record' in read && read.record.credentials?.accessToken).toBe('idle-successor')
})

test('explicit desktop default opt-out preserves saved choice and restart uses healthy fallback', () => {
  pool.appendClaudeAccount(account)
  pool.appendClaudeAccount({ ...account, accountUuid: 'other', emailAddress: 'other@example.com' }, { makeDefault: false })
  expect(pool.getClaudeDefaultSelection()).toEqual({ savedAccountId: account.accountUuid, effectiveAccountId: account.accountUuid })
  const read = authority.readClaudeAccountAuthority(account.accountUuid)
  if (!('handle' in read)) throw new Error('missing authority')
  authority.rejectClaudeCredential(read.handle)
  // The in-memory selected identity still names the now-rejected account.
  expect(pool.getClaudeDefaultSelection()).toEqual({ savedAccountId: account.accountUuid, effectiveAccountId: 'other' })
  pool.appendClaudeAccount({ ...account, accountUuid: 'z-not-default' }, { makeDefault: false })
  expect(settings.activeClaudeAccountUuid).toBe(account.accountUuid)
  pool.resetClaudeAccountPoolForTest()
  pool.setClaudeVaultPathForTest(dir)
  pool.loadClaudePoolForObservation()
  expect(pool.getClaudeDefaultSelection()).toEqual({ savedAccountId: account.accountUuid, effectiveAccountId: 'other' })
  pool.appendClaudeAccount({ ...account, accountUuid: 'third' }, { makeDefault: true })
  expect(settings.activeClaudeAccountUuid).toBe('third')
  settings.activeClaudeAccountUuid = undefined
  const implicitDefault = pool.getClaudeDefaultSelection().effectiveAccountId
  pool.appendClaudeAccount({ ...account, accountUuid: 'fourth' }, { makeDefault: false })
  expect(settings.activeClaudeAccountUuid).toBeUndefined()
  expect(pool.getClaudeDefaultSelection().effectiveAccountId).toBe(implicitDefault)
})

test('desktop login replaces broken saved default only when no usable fallback exists', () => {
  pool.appendClaudeAccount(account)
  const read = authority.readClaudeAccountAuthority(account.accountUuid)
  if (!('handle' in read)) throw new Error('missing authority')
  authority.rejectClaudeCredential(read.handle)
  expect(pool.getClaudeDefaultSelection()).toEqual({ savedAccountId: account.accountUuid, effectiveAccountId: null })
  pool.appendClaudeAccount({ ...account, accountUuid: 'replacement' }, { makeDefault: false })
  expect(pool.getClaudeDefaultSelection()).toEqual({ savedAccountId: 'replacement', effectiveAccountId: 'replacement' })
})

test('inventory is memory-only and reset clears cached signed-out profiles', () => {
  pool.appendClaudeAccount(account)
  const read = authority.readClaudeAccountAuthority(account.accountUuid)
  if (!('handle' in read)) throw new Error('missing authority')
  expect(pool.signOutClaudeAccount(account.accountUuid, read.handle.generation)).toBe(true)
  const diskRead = spyOn(authority, 'readClaudeAccountAuthority').mockImplementation(() => {
    throw new Error('Inventory must not read authority')
  })
  expect(pool.getClaudeProfileInventory().signedOutProfiles).toHaveLength(1)
  expect(diskRead).not.toHaveBeenCalled()
  pool.resetClaudeAccountPoolForTest()
  expect(pool.getClaudeProfileInventory()).toEqual({ accounts: [], signedOutProfiles: [] })
})

function reloadIsolatedPool(): void {
  pool.resetClaudeAccountPoolForTest()
  pool.setClaudeVaultPathForTest(dir)
  pool.setClaudeConfigAccountForTest({ active: true, value: null })
  pool.loadClaudePoolForObservation()
}

test('failed signout retains non-routable cleanup evidence across restart and profile deletion', () => {
  pool.appendClaudeAccount(account)
  const read = authority.readClaudeAccountAuthority(account.accountUuid)
  if (!('handle' in read)) throw new Error('missing authority')
  failStorage = true
  expect(pool.signOutClaudeAccount(account.accountUuid, read.handle.generation)).toBe(false)
  reloadIsolatedPool()
  expect(pool.getClaudePoolStatus().accounts).toHaveLength(0)
  expect(getClaudeAIOAuthTokens()).toBeNull()
  const profile = pool.getClaudeProfileInventory().signedOutProfiles[0]!
  expect(profile.accountUuid).toBe(account.accountUuid)
  failStorage = false
  expect(pool.removeClaudeAccount(profile.accountUuid, profile.loginGeneration)).toBe(true)
  expect(data.claudeAiOauth).toBeUndefined()
  expect(data.otherProvider).toEqual({ token: 'keep' })
  const deleted = authority.readClaudeAccountAuthority(account.accountUuid)
  expect('record' in deleted && deleted.record.deletionCleanup).toBeUndefined()
  reloadIsolatedPool()
  expect(pool.getClaudeProfileInventory().signedOutProfiles).toHaveLength(0)
})

test('repeated cleanup failure and restart retain the signed-out profile for retry', () => {
  pool.appendClaudeAccount(account)
  const read = authority.readClaudeAccountAuthority(account.accountUuid)
  if (!('handle' in read)) throw new Error('missing authority')
  failStorage = true
  expect(pool.signOutClaudeAccount(account.accountUuid, read.handle.generation)).toBe(false)
  for (let attempt = 0; attempt < 2; attempt++) {
    reloadIsolatedPool()
    const profile = pool.getClaudeProfileInventory().signedOutProfiles[0]!
    expect(profile.emailAddress).toBe(account.emailAddress)
    expect(pool.removeClaudeAccount(profile.accountUuid, profile.loginGeneration)).toBe(false)
    expect(data.claudeAiOauth.accessToken).toBe(account.accessToken)
  }
  reloadIsolatedPool()
  expect(pool.getClaudeProfileInventory().signedOutProfiles).toHaveLength(1)
})

test('cleanup retry after restart preserves newer same-account credentials', () => {
  pool.appendClaudeAccount(account)
  const read = authority.readClaudeAccountAuthority(account.accountUuid)
  if (!('handle' in read)) throw new Error('missing authority')
  failStorage = true
  expect(pool.signOutClaudeAccount(account.accountUuid, read.handle.generation)).toBe(false)
  reloadIsolatedPool()
  data.claudeAiOauth = { ...account, accessToken: 'new-access', refreshToken: 'new-refresh' }
  failStorage = false
  const profile = pool.getClaudeProfileInventory().signedOutProfiles[0]!
  expect(pool.removeClaudeAccount(profile.accountUuid, profile.loginGeneration)).toBe(true)
  expect(data.claudeAiOauth.accessToken).toBe('new-access')
  expect(data.otherProvider).toEqual({ token: 'keep' })
})

for (const expired of [false, true]) {
  test(`legacy observed ${expired ? 'days-expired' : 'valid'} account can be checked without changing default`, async () => {
    writeFileSync(join(dir, 'accounts/deleted.json'), JSON.stringify({
      profile: { account_uuid: account.accountUuid, email_address: account.emailAddress },
      tokens: { access_token: account.accessToken, refresh_token: account.refreshToken,
        expires_at: Date.now() + (expired ? -3 * 86400_000 : 3600_000) },
    }))
    reloadIsolatedPool()
    pool.appendClaudeAccount({ ...account, accountUuid: 'default-other' })
    const before = pool.getClaudeDefaultSelection()
    const refresh = spyOn(oauth, 'refreshOAuthToken').mockImplementation(async (_token, options) =>
      options!.initiateRequest!(() => Promise.resolve({
        accessToken: 'legacy-successor', refreshToken: 'legacy-refresh', expiresAt: Date.now() + 3600_000,
        scopes: ['user:inference'], subscriptionType: null, rateLimitTier: null,
      })))
    expect(await pool.checkClaudeAccountSignIn(account.accountUuid)).toEqual({ status: 'ready' })
    expect(refresh).toHaveBeenCalledTimes(expired ? 1 : 0)
    expect(pool.getClaudeDefaultSelection()).toEqual(before)
    expect(authority.readClaudeAccountAuthority(account.accountUuid).status).toBe('ready')
  })
}

test('malformed legacy account check reports retryable unavailability', async () => {
  writeFileSync(join(dir, 'accounts/deleted.json'), '{malformed')
  expect(await pool.checkClaudeAccountSignIn(account.accountUuid)).toEqual({ status: 'temporarily_unavailable' })
})

test('malformed authority account check reports retryable unavailability', async () => {
  pool.appendClaudeAccount(account)
  writeFileSync(join(dir, 'authority-v1/deleted.json'), '{malformed')
  expect(await pool.checkClaudeAccountSignIn(account.accountUuid)).toEqual({ status: 'temporarily_unavailable' })
})

test('config-only observed account check and signout migrate metadata and preserve nickname', async () => {
  rmSync(join(dir, 'accounts/deleted.json'))
  pool.seedClaudeAccountPoolForTest({
    accounts: [{ ...account, alias: 'saved-nickname' }], activeAccountUuid: account.accountUuid,
  })
  expect(await pool.checkClaudeAccountSignIn(account.accountUuid)).toEqual({ status: 'ready' })
  expect(pool.signOutClaudeAccount(account.accountUuid, 0)).toBe(true)
  reloadIsolatedPool()
  expect(pool.getClaudeProfileInventory().signedOutProfiles[0]).toMatchObject({
    accountUuid: account.accountUuid, emailAddress: account.emailAddress, alias: 'saved-nickname',
  })
})

test('config-only observed account can sign out directly without a prior check', () => {
  rmSync(join(dir, 'accounts/deleted.json'))
  pool.seedClaudeAccountPoolForTest({
    accounts: [{ ...account, alias: 'saved-nickname' }], activeAccountUuid: account.accountUuid,
  })
  expect(pool.signOutClaudeAccount(account.accountUuid, 0)).toBe(true)
  reloadIsolatedPool()
  expect(pool.getClaudeProfileInventory().signedOutProfiles[0]?.alias).toBe('saved-nickname')
})

test('final deletion removes matching fallback and cannot resurrect through observation or init', () => {
  expect(pool.removeClaudeAccount('deleted')).toBe(true)
  expect(data.claudeAiOauth).toBeUndefined()
  expect(settings.oauthAccount).toBeUndefined()
  expect(data.otherProvider).toEqual({ token: 'keep' })
  expect(settings.codex).toBe('keep')
  expect(getClaudeAIOAuthTokens()).toBeNull()
  pool.loadClaudePoolForObservation()
  expect(pool.getClaudePoolStatus().accounts).toHaveLength(0)
  pool.initClaudeAccountPool()
  expect(pool.getClaudePoolStatus().accounts).toHaveLength(0)
  expect(existsSync(join(dir, 'accounts/deleted.json'))).toBe(false)
})

test('replacement fallback tokens and profile survive deletion', () => {
  data.claudeAiOauth.accountUuid = 'replacement'
  data.claudeAiOauth.accessToken = 'replacement-access'
  data.claudeAiOauth.refreshToken = 'replacement-refresh'
  settings.oauthAccount = { accountUuid: 'replacement', emailAddress: 'replacement@example.com' }
  expect(pool.removeClaudeAccount('deleted')).toBe(true)
  expect(data.claudeAiOauth.accessToken).toBe('replacement-access')
  expect(settings.oauthAccount.accountUuid).toBe('replacement')
  pool.loadClaudePoolForObservation()
  expect(pool.getClaudePoolStatus().accounts.map(a => a.accountUuid)).toEqual(['replacement'])
})

test('matching profile does not authorize deletion of different tokens', () => {
  data.claudeAiOauth.accessToken = 'unrelated-access'
  expect(pool.removeClaudeAccount('deleted')).toBe(true)
  expect(data.claudeAiOauth.accessToken).toBe('unrelated-access')
  expect(settings.oauthAccount).toBeUndefined()
})

test('active replacement remains available with its tokens intact', () => {
  const replacement = { ...account, accountUuid: 'replacement', accessToken: 'replacement-access', refreshToken: 'replacement-refresh' }
  pool.seedClaudeAccountPoolForTest({ accounts: [account, replacement], activeAccountUuid: 'deleted' })
  expect(pool.removeClaudeAccount('deleted')).toBe(true)
  expect(pool.getActiveClaudeAccount()?.accountUuid).toBe('replacement')
  expect(settings.activeClaudeAccountUuid).toBeUndefined()
  pool.syncClaudeAccountToStorage()
  clearOAuthTokenCache()
  expect(getClaudeAIOAuthTokens()?.accessToken).toBe('replacement-access')
})

test('externally managed OAuth environment token is unchanged', () => {
  const previous = process.env.CLAUDE_CODE_OAUTH_TOKEN
  try {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'external-token'
    expect(pool.removeClaudeAccount('deleted')).toBe(true)
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('external-token')
    expect(getClaudeAIOAuthTokens()?.accessToken).toBe('external-token')
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = previous
  }
})

test('unavailable credential read fails without deleting the vault', () => {
  data = null
  expect(pool.removeClaudeAccount('deleted')).toBe(false)
  expect(existsSync(join(dir, 'accounts/deleted.json'))).toBe(true)
})

test('confirmed absent plaintext fallback permits vault-only deletion', () => {
  spyOn(secure, 'removeMatchingClaudeOAuthCredentials').mockImplementation(tokens =>
    removeMatchingClaudeOAuthFromStores([plainTextStorage], tokens))
  expect(plainTextStorage.readFresh().status).toBe('missing')
  expect(pool.removeClaudeAccount('deleted')).toBe(true)
  expect(existsSync(join(dir, 'accounts/deleted.json'))).toBe(false)
})

test.each(['storage', 'config'])('%s cleanup failure keeps vault and pool retryable', failure => {
  failStorage = failure === 'storage'
  failConfig = failure === 'config'
  expect(pool.removeClaudeAccount('deleted')).toBe(false)
  expect(existsSync(join(dir, 'accounts/deleted.json'))).toBe(true)
  expect(pool.getClaudePoolStatus().accounts).toHaveLength(1)
  failStorage = false
  failConfig = false
  expect(pool.removeClaudeAccount('deleted')).toBe(true)
})

test('inactive deletion preserves another process default, profile and credentials', () => {
  const local = { ...account, accountUuid: 'local' }
  const shared = { ...account, accountUuid: 'shared', accessToken: 'shared-access', refreshToken: 'shared-refresh' }
  pool.seedClaudeAccountPoolForTest({
    accounts: [local, shared, { ...account, vaultFilePath: join(dir, 'accounts/deleted.json') }],
    activeAccountUuid: 'local',
  })
  settings.activeClaudeAccountUuid = 'shared'
  settings.oauthAccount = { accountUuid: 'shared', emailAddress: 'shared@example.com' }
  data.claudeAiOauth = { ...shared }
  const before = structuredClone({ settings, data })
  expect(pool.removeClaudeAccount('deleted')).toBe(true)
  expect(settings).toEqual(before.settings)
  expect(data).toEqual(before.data)
  expect(pool.getActiveClaudeAccount()?.accountUuid).toBe('local')
})

test('durable deletion fences a stale loaded process and an in-flight refresh', async () => {
  const stale = { ...account, vaultFilePath: join(dir, 'accounts/deleted.json') }
  // Retain the exact snapshot held before the other process deleted the account.
  expect(getClaudeAIOAuthTokens()?.accessToken).toBe(account.accessToken)
  const child = Bun.spawnSync([process.execPath, '--eval', `
    const pool = await import('./src/services/api/claudeAccountPool.ts')
    pool.setClaudeVaultPathForTest(${JSON.stringify(dir)})
    if (!pool.deleteClaudeVaultFile(${JSON.stringify(stale.vaultFilePath)})) process.exit(1)
  `], { cwd: process.cwd(), env: { ...process.env, CLAUDE_CONFIG_DIR: dir } })
  expect(child.exitCode).toBe(0)
  expect(getClaudeAIOAuthTokens()).toBeNull()
  expect(await getClaudeAIOAuthTokensAsync()).toBeNull()
  pool.seedClaudeAccountPoolForTest({ accounts: [stale], activeAccountUuid: 'deleted' })
  expect(pool.updateClaudeAccountTokens('deleted', {
    accessToken: 'late-refresh', refreshToken: 'late-refresh-secret',
  }, { accessToken: account.accessToken, refreshToken: account.refreshToken })).toBe('unavailable')
  expect(pool.retryClaudeAccountTokenPersistence('deleted')).toBe('pending')
  expect(existsSync(stale.vaultFilePath)).toBe(false)
  pool.resetClaudeAccountPoolForTest()
  pool.setClaudeVaultPathForTest(dir)
  clearOAuthTokenCache()
  expect(getClaudeAIOAuthTokens()).toBeNull()
  expect(await getClaudeAIOAuthTokensAsync()).toBeNull()
  pool.initClaudeAccountPool()
  expect(pool.getClaudePoolStatus().accounts).toHaveLength(0)
  expect(existsSync(stale.vaultFilePath)).toBe(false)
})

test('explicit re-login creates a new generation without admitting stale writers', () => {
  const stale = { ...account, vaultFilePath: join(dir, 'accounts/deleted.json') }
  expect(pool.removeClaudeAccount('deleted')).toBe(true)
  pool.appendClaudeAccount({ ...account, accessToken: 'login-access', refreshToken: 'login-refresh' })
  expect(pool.getActiveClaudeAccount()?.accessToken).toBe('login-access')
  pool.seedClaudeAccountPoolForTest({ accounts: [stale], activeAccountUuid: 'deleted' })
  expect(pool.updateClaudeAccountTokens('deleted', { accessToken: 'stale-refresh' })).toBe('unavailable')
  expect(pool.getActiveClaudeAccount()).toBeNull()
  pool.resetClaudeAccountPoolForTest()
  pool.setClaudeVaultPathForTest(dir)
  pool.loadClaudePoolForObservation()
  expect(pool.getActiveClaudeAccount()?.accessToken).toBe('login-access')
})

test('session admission block overrides cached credentials and clears without caching denial', async () => {
  expect(getClaudeAIOAuthTokens()?.accessToken).toBe(account.accessToken)
  blockSessionAccountRoute('anthropic', 'missing-account')
  expect(getClaudeAIOAuthTokens()).toBeNull()
  expect(await getClaudeAIOAuthTokensAsync()).toBeNull()
  clearSessionAccountRouteBlock('anthropic')
  expect(getClaudeAIOAuthTokens()?.accessToken).toBe(account.accessToken)
})

test('explicit default publication reports failed config persistence', () => {
  failConfig = true
  expect(() => pool.syncClaudeAccountToStorage()).toThrow('Failed to save Claude account selection')
})

test('deleting the shared default clears it without publishing the local chat identity', () => {
  const local = { ...account, accountUuid: 'local', accessToken: 'local-access' }
  pool.seedClaudeAccountPoolForTest({
    accounts: [local, { ...account, vaultFilePath: join(dir, 'accounts/deleted.json') }],
    activeAccountUuid: 'local',
  })
  expect(pool.removeClaudeAccount('deleted')).toBe(true)
  expect(settings.activeClaudeAccountUuid).toBeUndefined()
  expect(settings.oauthAccount).toBeUndefined()
  expect(data.claudeAiOauth).toBeUndefined()
  expect(pool.getActiveClaudeAccount()?.accountUuid).toBe('local')
})

test('deletion refuses a vault path now owned by an unknown account before clearing shared state', () => {
  const before = structuredClone({ settings, data })
  writeFileSync(join(dir, 'accounts/deleted.json'), JSON.stringify({
    profile: { account_uuid: 'unknown', email_address: 'unknown@example.com' },
    tokens: { access_token: 'unknown-access', refresh_token: 'unknown-refresh' },
  }))
  expect(pool.removeClaudeAccount('deleted')).toBe(false)
  expect(settings).toEqual(before.settings)
  expect(data).toEqual(before.data)
  expect(existsSync(join(dir, 'accounts/deleted.json'))).toBe(true)
})

test('explicit switching and rotation reject a stale healthy target deleted by another process', () => {
  const stale = { ...account, vaultFilePath: join(dir, 'accounts/deleted.json') }
  const local = { ...account, accountUuid: 'local', accessToken: 'local-access' }
  pool.seedClaudeAccountPoolForTest({ accounts: [local, stale], activeAccountUuid: 'local' })
  expect(pool.deleteClaudeVaultFile(stale.vaultFilePath)).toBe(true)
  const before = structuredClone(settings)
  expect(pool.getClaudePoolStatus().accounts[1]?.status).toBe('healthy')
  expect(pool.switchToClaudeAccount('deleted')).toBeNull()
  expect(pool.switchToClaudeAccount(null)).toBeNull()
  expect(pool.getActiveClaudeAccount()?.accountUuid).toBe('local')
  expect(settings).toEqual(before)
})

test.each(['healthy', 'dead'] as const)('an older chat adopts a new login generation only on explicit selection (%s)', status => {
  const stale = { ...account, status, vaultFilePath: join(dir, 'accounts/deleted.json') }
  expect(pool.removeClaudeAccount('deleted')).toBe(true)
  pool.appendClaudeAccount({ ...account, accessToken: 'new-login-access', refreshToken: 'new-login-refresh' })
  const generation = pool.getActiveClaudeAccount()!.lifecycleGeneration
  const other = { ...account, accountUuid: 'other', status: 'dead' as const }
  pool.seedClaudeAccountPoolForTest({ accounts: [stale, other], activeAccountUuid: 'deleted' })
  pool.reloadActiveClaudeAccountCredentials()
  expect(pool.getActiveClaudeAccount()).toBeNull()
  expect(pool.getClaudePoolStatus().accounts[0]?.accessToken).toBe(account.accessToken)
  const before = structuredClone(settings)
  const selected = pool.switchToClaudeAccount('deleted', { persistDefault: false })
  expect(selected?.accessToken).toBe('new-login-access')
  expect(selected?.lifecycleGeneration).toBe(generation)
  expect(pool.getActiveClaudeAccount()?.accessToken).toBe('new-login-access')
  expect(pool.getClaudePoolStatus().accounts[1]?.status).toBe('dead')
  expect(settings).toEqual(before)
})

test('explicit selection preserves a same-generation local health failure', () => {
  pool.seedClaudeAccountPoolForTest({ accounts: [{ ...account, status: 'dead' }], activeAccountUuid: 'deleted' })
  expect(pool.prepareClaudeAccountForSelection('deleted')).toBeNull()
  expect(pool.switchToClaudeAccount('deleted', { persistDefault: false })).toBeNull()
  expect(pool.getClaudePoolStatus().accounts[0]?.status).toBe('dead')
})

test('explicit re-login reports failure instead of publishing fallback when the deletion fence cannot be cleared', async () => {
  expect(pool.removeClaudeAccount('deleted')).toBe(true)
  const before = structuredClone({ settings, data })
  const original = atomic.writeFileAtomicDurableSync
  const write = spyOn(atomic, 'writeFileAtomicDurableSync').mockImplementation((path, contents, options) => {
    if (String(path).endsWith('.lifecycle')) throw new Error('synthetic lifecycle publication failure')
    return original(path, contents, options)
  })
  expect(() => pool.appendClaudeAccount({
    ...account, accessToken: 'login-after-delete', refreshToken: 'login-after-delete-refresh',
  })).toThrow('Restore vault access and retry saving')
  expect(settings).toEqual(before.settings)
  expect(data).toEqual(before.data)
  expect(pool.getActiveClaudeAccount()).toBeNull()
  expect(getClaudeAIOAuthTokens()).toBeNull()
  expect(await getClaudeAIOAuthTokensAsync()).toBeNull()
  pool.loadClaudePoolForObservation()
  expect(pool.getClaudePoolStatus().accounts).toHaveLength(0)
  write.mockRestore()
  pool.appendClaudeAccount({
    ...account, accessToken: 'retried-login', refreshToken: 'retried-login-refresh',
  })
  expect(pool.getActiveClaudeAccount()?.accessToken).toBe('retried-login')
})

test('interrupted migration during re-login retains only the original committed credentials', async () => {
  const before = structuredClone({ settings, data })
  const write = atomic.writeFileAtomicDurableSync
  spyOn(atomic, 'writeFileAtomicDurableSync').mockImplementation((path, contents, options) => {
    if (String(path).endsWith('.lifecycle')) throw new Error('synthetic lifecycle publication failure')
    return write(path, contents, options)
  })
  expect(() => pool.appendClaudeAccount({
    ...account, accessToken: 'partial-login-access', refreshToken: 'partial-login-refresh',
  })).toThrow('Restore vault access and retry saving')
  expect(settings).toEqual(before.settings)
  expect(data).toEqual(before.data)
  expect(pool.getActiveClaudeAccount()?.accessToken).toBe(account.accessToken)
  expect(pool.getClaudeCredentialGeneration(account.accountUuid)).toBe(0)
  expect(pool.captureClaudeCredentialGeneration(account.accountUuid, account.accessToken)).toBe(0)
  expect(pool.captureClaudeCredentialGeneration(account.accountUuid, 'partial-login-access')).toBeNull()
})

test.each(['sdk-retry', 'direct-cached', 'request-signing', 'storage-denied', 'unlock-after-send'] as const)('the production client fences each physical HTTP send: %s', async scenario => {
  spyOn(auth, 'isAnthropicAuthEnabled').mockReturnValue(true)
  spyOn(auth, 'getAnthropicApiKeyWithSource').mockReturnValue({ key: null, source: 'none' })
  const migrated = authority.migrateClaudeAccountAuthority(account.accountUuid)
  if (migrated.status !== 'ready') throw new Error('Expected isolated ready fixture')
  const { getAnthropicClient } = await import('./client.js')
  const http = await import('../../utils/http.js')
  spyOn(http, 'getUserAgent').mockReturnValue('synthetic-credential-test')
  spyOn(auth, 'isClaudeAISubscriber').mockReturnValue(true)
  spyOn(auth, 'checkAndRefreshOAuthTokenIfNeeded').mockResolvedValue(false)
  const prepare = spyOn(auth, 'prepareClaudeOAuthRequest').mockResolvedValue({
    status: 'ready', handle: migrated.handle, credentials: migrated.record.credentials!,
  })
  spyOn(auth, 'getClaudeAIOAuthTokens').mockReturnValue({
    ...account, scopes: ['user:inference'], subscriptionType: null, rateLimitTier: null,
  })
  let authorizationCalls = 0
  if (scenario === 'storage-denied') {
    spyOn(authority, 'withClaudeCredentialSend').mockImplementation(() => {
      authorizationCalls++
      throw new Error('synthetic storage access failure')
    })
  } else if (scenario === 'unlock-after-send') {
    const authorize = authority.withClaudeCredentialSend
    spyOn(authority, 'withClaudeCredentialSend').mockImplementation((handle, send) => {
      authorizationCalls++
      const started = authorize(handle, send)
      if (started !== null) throw new Error('synthetic unlock failure after send')
      return started
    })
  }
  let calls = 0
  const client = await getAnthropicClient({
    maxRetries: 1, model: 'claude-sonnet-4-6', provider: 'firstParty',
    fetchOverride: async () => {
      calls++
      if (calls === 1 && scenario === 'sdk-retry') {
        await Promise.resolve()
        expect(pool.deleteClaudeVaultFile(join(dir, 'accounts/deleted.json'))).toBe(true)
        return new Response(JSON.stringify({ error: { type: 'api_error', message: 'synthetic overload' } }), {
          status: 503, headers: { 'content-type': 'application/json', 'retry-after-ms': '1' },
        })
      }
      return new Response(JSON.stringify({
        id: 'synthetic', type: 'message', role: 'assistant', content: [],
        model: 'claude-sonnet-4-6', stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      }), { headers: { 'content-type': 'application/json' } })
    },
  })
  expect(client.authToken).toBe(account.accessToken)
  expect(prepare).toHaveBeenCalledTimes(1)
  if (scenario === 'direct-cached') expect(pool.deleteClaudeVaultFile(join(dir, 'accounts/deleted.json'))).toBe(true)
  if (scenario === 'request-signing') {
    const cch = await import('../../utils/cch.js')
    spyOn(cch, 'computeCch').mockImplementation(async () => {
      expect(pool.deleteClaudeVaultFile(join(dir, 'accounts/deleted.json'))).toBe(true)
      return '12345'
    })
  }
  let failure: unknown
  let response: unknown
  try {
    response = await client.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 1,
      ...(scenario === 'request-signing' ? { system: 'synthetic billing header cch=00000' } : {}),
      messages: [{ role: 'user', content: 'synthetic' }],
    })
  } catch (error) {
    failure = error
  }
  expect(calls).toBe(scenario === 'sdk-retry' || scenario === 'unlock-after-send' ? 1 : 0)
  if (scenario === 'storage-denied' || scenario === 'unlock-after-send') expect(authorizationCalls).toBeGreaterThan(0)
  if (scenario === 'unlock-after-send') {
    expect(failure).toBeUndefined()
    expect(response).toMatchObject({ id: 'synthetic' })
  } else {
    expect(failure).toBeDefined()
    if (scenario === 'storage-denied') {
      expect((failure as Error & { cause?: Error }).cause?.message).toContain('storage access')
    } else {
      expect(pool.getClaudeCredentialGeneration(account.accountUuid)).toBeNull()
    }
  }
})

test('client cannot send a captured old token after a newer login generation', async () => {
  spyOn(auth, 'isAnthropicAuthEnabled').mockReturnValue(true)
  spyOn(auth, 'getAnthropicApiKeyWithSource').mockReturnValue({ key: null, source: 'none' })
  const { getAnthropicClient } = await import('./client.js')
  const http = await import('../../utils/http.js')
  spyOn(http, 'getUserAgent').mockReturnValue('synthetic-credential-test')
  spyOn(auth, 'isClaudeAISubscriber').mockReturnValue(true)
  spyOn(auth, 'getAuthTokenSource').mockReturnValue({ source: 'claude.ai', hasToken: true })
  spyOn(auth, 'checkAndRefreshOAuthTokenIfNeeded').mockResolvedValue(false)
  const migrated = authority.migrateClaudeAccountAuthority(account.accountUuid)
  if (migrated.status !== 'ready') throw new Error('Expected isolated ready fixture')
  spyOn(auth, 'prepareClaudeOAuthRequest').mockImplementation(async () => {
    pool.appendClaudeAccount({
      ...account, accessToken: 'new-generation-access', refreshToken: 'new-generation-refresh',
    })
    return { status: 'ready', handle: migrated.handle, credentials: migrated.record.credentials! }
  })
  let sends = 0
  let failure: unknown
  try {
    const client = await getAnthropicClient({
      model: 'claude-sonnet-4-6', provider: 'firstParty', maxRetries: 0,
      fetchOverride: async () => { sends++; return new Response('{}') },
    })
    await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 1, messages: [{ role: 'user', content: 'synthetic' }] })
  } catch (error) {
    failure = error
  }
  expect(failure).toBeDefined()
  expect(sends).toBe(0)
  expect(pool.getActiveClaudeAccount()?.lifecycleGeneration).toBe(1)
})

test('a blocked route is rejected before refresh or fallback credential discovery', async () => {
  const { getAnthropicClient } = await import('./client.js')
  const http = await import('../../utils/http.js')
  spyOn(http, 'getUserAgent').mockReturnValue('synthetic-credential-test')
  blockSessionAccountRoute('anthropic', 'unavailable-saved-account')
  const refresh = spyOn(auth, 'checkAndRefreshOAuthTokenIfNeeded').mockResolvedValue(false)
  const key = spyOn(auth, 'getApiKeyFromApiKeyHelper').mockResolvedValue('synthetic-fallback')
  let failure: unknown
  try {
    await getAnthropicClient({ model: 'claude-sonnet-4-6', provider: 'firstParty', maxRetries: 0 })
  } catch (error) {
    failure = error
  }
  expect(failure).toBeDefined()
  expect((failure as Error).message).toContain('Open Accounts')
  expect(refresh).not.toHaveBeenCalled()
  expect(key).not.toHaveBeenCalled()
})
