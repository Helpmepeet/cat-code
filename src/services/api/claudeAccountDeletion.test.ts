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
import * as atomic from '../../utils/atomicFile.js'
import { blockSessionAccountRoute, clearSessionAccountRouteBlock } from './sessionAccountRouting.js'

let dir: string
let data: any
let settings: any
let failStorage: boolean
let failConfig: boolean
let previousConfigDir: string | undefined
const account = {
  accountUuid: 'deleted', emailAddress: 'deleted@example.com',
  accessToken: 'access-deleted', refreshToken: 'refresh-deleted',
  expiresAt: Date.now() + 3600000, status: 'healthy' as const,
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-delete-'))
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
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
  rmSync(dir, { recursive: true, force: true })
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
  })).toThrow('Restore vault access and sign in again')
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
