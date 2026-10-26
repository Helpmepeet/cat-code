import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const analytics = await import('../../services/analytics/index.js')
const debug = await import('../../utils/debug.js')
const log = await import('../../utils/log.js')
const config = await import('../../utils/config.js')
const secureStorage = await import('../../utils/secureStorage/index.js')
const portable = await import('../../utils/authPortable.js')
const execaModule = await import('execa')
const exec = await import('../../utils/execFileNoThrow.js')
const prefetch = await import('../../utils/secureStorage/keychainPrefetch.js')
const oauth = await import('../../services/oauth/client.js')
const profile = await import('../../services/oauth/getOauthProfile.js')
const firstToken = await import('../../services/api/firstTokenDate.js')
const auth = await import('../../utils/auth.js')
const pool = await import('../../services/api/claudeAccountPool.js')
const { installOAuthTokens } = await import('./auth.js')

const tokens = {
  accessToken: 'test-access', refreshToken: 'test-refresh', expiresAt: 123456,
  scopes: ['user:inference', 'user:profile'],
  tokenAccount: { uuid: 'test-account', emailAddress: 'test@example.com' },
}
let directory: string
let storageSuccess: boolean
let storageThrows: boolean
let staleRead: boolean
let stored: ReturnType<ReturnType<typeof secureStorage.getSecureStorage>['read']>
let savedConfig: ReturnType<typeof config.getGlobalConfig>

beforeEach(() => {
  spyOn(analytics, 'logEvent').mockImplementation(() => {})
  spyOn(debug, 'logForDebugging').mockImplementation(() => {})
  spyOn(log, 'logError').mockImplementation(() => {})
  spyOn(exec, 'execSyncWithDefaults_DEPRECATED').mockReturnValue('')
  spyOn(prefetch, 'getLegacyApiKeyPrefetchResult').mockReturnValue(null)
  pool.resetClaudeAccountPoolForTest()
  directory = mkdtempSync(join(tmpdir(), 'auth-persistence-'))
  pool.setClaudeVaultPathForTest(directory)
  auth.getApiKeyFromConfigOrMacOSKeychain.cache.clear()
  storageSuccess = false
  storageThrows = false
  staleRead = false
  stored = {}
  savedConfig = {} as ReturnType<typeof config.getGlobalConfig>
  spyOn(config, 'saveGlobalConfig').mockImplementation(update => {
    savedConfig = update(savedConfig)
    return true
  })
  spyOn(config, 'getGlobalConfig').mockImplementation(() => savedConfig)
  spyOn(secureStorage, 'getSecureStorage').mockReturnValue({
    name: 'test',
    read: () => structuredClone(stored),
    readAsync: async () => structuredClone(stored),
    delete: () => true,
    update: data => {
      if (storageThrows) throw new Error('Storage unavailable')
      if (storageSuccess && !staleRead) stored = structuredClone(data)
      return { success: storageSuccess }
    },
  })
  spyOn(portable, 'maybeRemoveApiKeyFromMacOSKeychainThrows').mockResolvedValue(undefined)
  spyOn(oauth, 'storeOAuthAccountInfo').mockImplementation(() => {})
  spyOn(oauth, 'fetchAndStoreUserRoles').mockResolvedValue(undefined)
  spyOn(profile, 'getOauthProfileFromOauthToken').mockResolvedValue(null)
  spyOn(firstToken, 'fetchAndStoreClaudeCodeFirstTokenDate').mockResolvedValue(undefined)
})

afterEach(() => {
  auth.getApiKeyFromConfigOrMacOSKeychain.cache.clear()
  mock.restore()
  pool.resetClaudeAccountPoolForTest()
  rmSync(directory, { recursive: true, force: true })
})

function failVault() {
  const blocked = join(directory, 'not-a-directory')
  writeFileSync(blocked, 'blocked')
  pool.setClaudeVaultPathForTest(blocked)
}

describe('API key persistence', () => {
  test.skipIf(process.platform !== 'darwin')('falls back to readable config on a nonzero security exit', async () => {
    spyOn(execaModule, 'execa').mockResolvedValue({ exitCode: 1 } as never)
    await auth.saveApiKey('sk-test-key')
    expect(savedConfig.primaryApiKey).toBe('sk-test-key')
    expect(auth.getApiKeyFromConfigOrMacOSKeychain()?.key).toBe('sk-test-key')
  })

  test.skipIf(process.platform !== 'darwin')('rejects when both Keychain and config fail', async () => {
    spyOn(execaModule, 'execa').mockResolvedValue({ exitCode: 1 } as never)
    spyOn(config, 'saveGlobalConfig').mockReturnValue(false)
    await expect(auth.saveApiKey('sk-test-key')).rejects.toThrow('Failed to save API key')
  })

  test.skipIf(process.platform !== 'darwin')('accepts a Keychain save even when config cannot be written', async () => {
    spyOn(execaModule, 'execa').mockResolvedValue({ exitCode: 0 } as never)
    spyOn(config, 'saveGlobalConfig').mockReturnValue(false)
    await expect(auth.saveApiKey('sk-test-key')).resolves.toBeUndefined()
  })

  test.skipIf(process.platform !== 'darwin')('rejects config fallback shadowed by a retained old Keychain key', async () => {
    spyOn(execaModule, 'execa').mockResolvedValue({ exitCode: 1 } as never)
    spyOn(exec, 'execSyncWithDefaults_DEPRECATED').mockReturnValue('sk-old-key')
    expect(auth.getApiKeyFromConfigOrMacOSKeychain()?.key).toBe('sk-old-key')
    await expect(auth.saveApiKey('sk-test-key')).rejects.toThrow('Failed to activate saved API key')
    expect(savedConfig.primaryApiKey).toBe('sk-test-key')
    expect(auth.getApiKeyFromConfigOrMacOSKeychain()?.key).toBe('sk-old-key')
  })
})

describe('Claude account vault path', () => {
  test('does not invent a vault path on failed writes', () => {
    failVault()
    pool.appendClaudeAccount({ ...tokens, ...tokens.tokenAccount, accountUuid: tokens.tokenAccount.uuid })
    expect(pool.getActiveClaudeAccount()?.vaultFilePath).toBeUndefined()
  })
})

describe('OAuth installation', () => {
  test('rejects unusable vault-only recovery when secure storage throws', async () => {
    storageThrows = true
    await expect(installOAuthTokens(tokens)).rejects.toThrow('Failed to save OAuth tokens')
    expect(pool.getActiveClaudeAccount()).toBeNull()
  })
  test('accepts effective plaintext fallback even when the vault fails', async () => {
    failVault()
    storageSuccess = true
    await expect(installOAuthTokens(tokens)).resolves.toBeUndefined()
    expect(stored?.claudeAiOauth?.accessToken).toBe(tokens.accessToken)
    expect(stored?.claudeAiOauth?.refreshToken).toBe(tokens.refreshToken)
  })
  test('rejects when all durable writes fail', async () => {
    failVault()
    await expect(installOAuthTokens(tokens)).rejects.toThrow('Failed to save OAuth tokens')
  })
  test('rejects a reported successful write with stale effective credentials', async () => {
    storageSuccess = true
    staleRead = true
    stored = { claudeAiOauth: { ...tokens, accessToken: 'old-access', refreshToken: 'old-refresh' } }
    expect(auth.saveOAuthTokensIfNeeded(tokens)).toEqual({
      success: false, warning: 'Saved OAuth tokens could not be read back',
    })
    await expect(installOAuthTokens(tokens)).rejects.toThrow('Failed to save OAuth tokens')
    expect(stored?.claudeAiOauth?.accessToken).toBe('old-access')
  })
  test('compares the refresh token as well as the access token', () => {
    storageSuccess = true
    staleRead = true
    stored = { claudeAiOauth: { ...tokens, refreshToken: 'old-refresh' } }
    expect(auth.saveOAuthTokensIfNeeded(tokens).success).toBe(false)
  })
  test('preserves existing profile and pool on rejected installation', async () => {
    const account = { ...tokens, accountUuid: 'existing', emailAddress: 'existing@example.com', status: 'healthy' as const }
    pool.seedClaudeAccountPoolForTest({ activeAccountUuid: 'existing', accounts: [account] })
    savedConfig.oauthAccount = { accountUuid: 'existing', emailAddress: 'existing@example.com' }
    const previous = structuredClone(savedConfig)
    await expect(installOAuthTokens(tokens)).rejects.toThrow('Failed to save OAuth tokens')
    expect(savedConfig).toEqual(previous)
    expect(pool.getActiveClaudeAccount()?.accountUuid).toBe('existing')
    expect(pool.getClaudePoolStatus().accounts).toHaveLength(1)
    expect(oauth.storeOAuthAccountInfo).not.toHaveBeenCalled()
    expect(profile.getOauthProfileFromOauthToken).not.toHaveBeenCalled()
  })
  test('leaves inference-only tokens unpersisted', async () => {
    const update = spyOn(secureStorage, 'getSecureStorage')
    await expect(installOAuthTokens({ ...tokens, refreshToken: null, expiresAt: null })).resolves.toBeUndefined()
    expect(update).not.toHaveBeenCalled()
    expect(pool.getActiveClaudeAccount()).toBeNull()
  })
  test('does not persist Codex tokens through Claude secure storage', () => {
    expect(auth.saveOAuthTokensIfNeeded({ ...tokens, scopes: ['openid'] }).success).toBe(true)
    expect(secureStorage.getSecureStorage).not.toHaveBeenCalled()
  })
})
