import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as config from '../../utils/config.js'
import * as secure from '../../utils/secureStorage/index.js'
import { removeMatchingClaudeOAuthFromStores } from '../../utils/secureStorage/crossProcessStorage.js'
import { plainTextStorage } from '../../utils/secureStorage/plainTextStorage.js'
import { clearOAuthTokenCache, getClaudeAIOAuthTokens } from '../../utils/auth.js'
import * as pool from './claudeAccountPool.js'

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
  writeFileSync(join(dir, 'accounts/deleted.json'), JSON.stringify(account))
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
  expect(settings.activeClaudeAccountUuid).toBe('replacement')
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
