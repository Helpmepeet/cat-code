import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
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
const envUtils = await import('../../utils/envUtils.js')
const lockfile = await import('../../utils/lockfile.js')
const axios = (await import('axios')).default
const authFd = await import('../../utils/authFileDescriptor.js')
const logout = await import('../../commands/logout/logout.js')
const codexPool = await import('../../services/api/codexAccountPool.js')
const { commitClaudeAccountSwitch } = await import('../../services/api/claudeAccountSwitch.js')
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
  auth.clearOAuthTokenCache()
  auth.getApiKeyFromConfigOrMacOSKeychain.cache.clear()
  mock.restore()
  pool.resetClaudeAccountPoolForTest()
  rmSync(directory, { recursive: true, force: true })
})

describe('Claude process account isolation', () => {
  function seedAccounts() {
    const a = {
      ...tokens, accountUuid: 'account-a', emailAddress: 'a@example.com',
      organizationUuid: 'org-a', status: 'healthy' as const,
    }
    const b = {
      ...a, accountUuid: 'account-b', emailAddress: 'b@example.com',
      organizationUuid: 'org-b', accessToken: 'access-b', refreshToken: 'refresh-b',
    }
    pool.seedClaudeAccountPoolForTest({ accounts: [a, b], activeAccountUuid: a.accountUuid })
    savedConfig.oauthAccount = {
      accountUuid: b.accountUuid, emailAddress: b.emailAddress, organizationUuid: b.organizationUuid,
    }
    savedConfig.activeClaudeAccountUuid = b.accountUuid
    auth.clearOAuthTokenCache()
    return { a, b }
  }

  test('metadata and organization follow the selected token, not the shared profile', async () => {
    seedAccounts()
    spyOn(auth, 'isAnthropicAuthEnabled').mockReturnValue(true)
    expect(auth.getOauthAccountInfo()?.emailAddress).toBe('a@example.com')
    expect(await oauth.getOrganizationUUID()).toBe('org-a')
    pool.switchToClaudeAccount('account-b', { persistDefault: false })
    expect(auth.getOauthAccountInfo()?.accountUuid).toBe('account-b')
    expect(auth.getClaudeAIOAuthTokens()?.accessToken).toBe('access-b')
  })

  test('an exhausted local pool never borrows another account from shared credentials', async () => {
    const { a, b } = seedAccounts()
    pool.seedClaudeAccountPoolForTest({
      accounts: [{ ...a, status: 'dead' }],
      activeAccountUuid: a.accountUuid,
    })
    stored = { claudeAiOauth: { ...b } }
    auth.clearOAuthTokenCache()
    expect(pool.shouldUseClaudePoolTokenSource()).toBe(true)
    expect(auth.getClaudeAIOAuthTokens()).toBeNull()
    expect(await auth.getClaudeAIOAuthTokensAsync()).toBeNull()
    expect(secureStorage.getSecureStorage).not.toHaveBeenCalled()
  })

  test('env tokens and Console scopes never inherit pool identity', () => {
    seedAccounts()
    spyOn(auth, 'isAnthropicAuthEnabled').mockReturnValue(true)
    const original = process.env.CLAUDE_CODE_OAUTH_TOKEN
    try {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'external-token'
      auth.clearOAuthTokenCache()
      expect(auth.getOauthAccountInfo()).toBeUndefined()
    } finally {
      if (original === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = original
    }
    pool.getActiveClaudeAccount()!.scopes = ['org:create_api_key']
    auth.clearOAuthTokenCache()
    expect(auth.getOauthAccountInfo()).toBeUndefined()
  })

  test('FD and external API-key auth do not inherit selected account metadata', () => {
    seedAccounts()
    spyOn(auth, 'isAnthropicAuthEnabled').mockReturnValue(true)
    spyOn(authFd, 'getOAuthTokenFromFileDescriptor').mockReturnValue('fd-token')
    auth.clearOAuthTokenCache()
    expect(auth.getClaudeAIOAuthTokens()?.accessToken).toBe('fd-token')
    expect(auth.getOauthAccountInfo()).toBeUndefined()
    spyOn(auth, 'isAnthropicAuthEnabled').mockReturnValue(false)
    expect(auth.getOauthAccountInfo()).toBeUndefined()
  })

  test('managed Console API-key login retains its own profile without adopting pool identity', async () => {
    seedAccounts()
    spyOn(auth, 'isAnthropicAuthEnabled').mockReturnValue(true)
    savedConfig.primaryApiKey = 'managed-console-key'
    pool.getActiveClaudeAccount()!.scopes = ['org:create_api_key']
    auth.clearOAuthTokenCache()
    expect(auth.getOauthAccountInfo()?.accountUuid).toBe('account-b')
    expect(await oauth.getOrganizationUUID()).toBe('org-b')

    pool.resetClaudeAccountPoolForTest()
    auth.clearOAuthTokenCache()
    expect(auth.getOauthAccountInfo()?.accountUuid).toBe('account-b')
  })

  test('external tokens retain explicitly supplied SDK identity instead of the shared profile', () => {
    seedAccounts()
    spyOn(auth, 'isAnthropicAuthEnabled').mockReturnValue(true)
    const variables = {
      CLAUDE_CODE_OAUTH_TOKEN: 'sdk-token',
      CLAUDE_CODE_ACCOUNT_UUID: 'sdk-account',
      CLAUDE_CODE_USER_EMAIL: 'sdk@example.com',
      CLAUDE_CODE_ORGANIZATION_UUID: 'sdk-org',
    }
    const previous = Object.fromEntries(Object.keys(variables).map(key => [key, process.env[key]]))
    try {
      Object.assign(process.env, variables)
      expect(auth.getOauthAccountInfo()).toEqual({
        accountUuid: 'sdk-account', emailAddress: 'sdk@example.com', organizationUuid: 'sdk-org',
      })
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  test('session switch leaves the shared default, credentials and profile unchanged', async () => {
    const { a, b } = seedAccounts()
    savedConfig.activeClaudeAccountUuid = a.accountUuid
    const before = structuredClone(savedConfig)
    const clear = spyOn(logout, 'clearAuthRelatedCaches').mockResolvedValue(undefined)
    const refresh = spyOn(codexPool, 'applyPostCodexAccountSwitchRefresh').mockImplementation(() => {})
    expect((await commitClaudeAccountSwitch(b.accountUuid))?.accountUuid).toBe(b.accountUuid)
    expect(savedConfig).toEqual(before)
    expect(secureStorage.getSecureStorage).not.toHaveBeenCalled()
    expect(clear).toHaveBeenCalledWith({ persistConfig: false })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  test('refresh pending across a switch writes only the original vault account', async () => {
    const { a, b } = seedAccounts()
    spyOn(envUtils, 'getClaudeConfigHomeDir').mockReturnValue(directory)
    spyOn(lockfile, 'lock').mockResolvedValue(async () => {})
    stored = { claudeAiOauth: { ...b } }
    const before = structuredClone(stored)
    let resolveRefresh!: (value: typeof tokens) => void
    let started!: () => void
    const starting = new Promise<void>(resolve => { started = resolve })
    const refresh = spyOn(oauth, 'refreshOAuthToken').mockImplementation(async () => {
      started()
      return new Promise(resolve => { resolveRefresh = resolve as typeof resolveRefresh })
    })
    const pending = auth.checkAndRefreshOAuthTokenIfNeeded()
    await starting
    pool.switchToClaudeAccount(b.accountUuid, { persistDefault: false })
    resolveRefresh({ ...tokens, accessToken: 'fresh-a', expiresAt: Date.now() + 3600_000 })
    expect(await pending).toBe(true)
    expect(refresh).toHaveBeenCalledWith(a.refreshToken, { persistProfile: false, scopes: undefined })
    expect(stored).toEqual(before)
    expect(savedConfig.oauthAccount?.accountUuid).toBe(b.accountUuid)
    expect(pool.getActiveClaudeAccount()?.accountUuid).toBe(b.accountUuid)
    expect(pool.getClaudePoolStatus().accounts.find(account => account.accountUuid === a.accountUuid)?.accessToken).toBe('fresh-a')
  })

  test('pool refresh suppresses shared profile writes inside the OAuth client', async () => {
    seedAccounts()
    spyOn(auth, 'isAnthropicAuthEnabled').mockReturnValue(true)
    const before = structuredClone(savedConfig)
    spyOn(axios, 'post').mockResolvedValue({
      status: 200, data: { access_token: 'fresh-a', expires_in: 3600, scope: 'user:inference user:profile' },
    })
    spyOn(profile, 'getOauthProfileFromOauthToken').mockResolvedValue({
      account: { uuid: 'account-a', display_name: 'Account A' },
      organization: { uuid: 'org-a', organization_type: 'claude_pro', billing_type: 'stripe_subscription' },
    } as never)
    await oauth.refreshOAuthToken('refresh-a', { persistProfile: false })
    expect(savedConfig).toEqual(before)
    expect(profile.getOauthProfileFromOauthToken).toHaveBeenCalledWith('fresh-a')
  })

  test('refresh check reuses same-account credentials refreshed by another process', async () => {
    storageSuccess = true
    pool.appendClaudeAccount({
      ...tokens, accountUuid: 'account-a', emailAddress: 'a@example.com',
    })
    const account = pool.getActiveClaudeAccount()!
    const vault = JSON.parse(readFileSync(account.vaultFilePath!, 'utf8'))
    vault.tokens.access_token = 'other-process-fresh-a'
    vault.tokens.expires_at = Date.now() + 3600_000
    writeFileSync(account.vaultFilePath!, JSON.stringify(vault))
    spyOn(envUtils, 'getClaudeConfigHomeDir').mockReturnValue(directory)
    const refresh = spyOn(oauth, 'refreshOAuthToken').mockRejectedValue(new Error('Unexpected refresh'))
    auth.clearOAuthTokenCache()
    expect(await auth.checkAndRefreshOAuthTokenIfNeeded()).toBe(false)
    expect(refresh).not.toHaveBeenCalled()
    expect(auth.getClaudeAIOAuthTokens()?.accessToken).toBe('other-process-fresh-a')
    expect(pool.getActiveClaudeAccount()).toBe(account)
  })
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
    storageSuccess = true
    pool.appendClaudeAccount({ ...tokens, ...tokens.tokenAccount, accountUuid: tokens.tokenAccount.uuid })
    expect(pool.getActiveClaudeAccount()?.vaultFilePath).toBeUndefined()
  })
})

describe('Claude credential mirror', () => {
  for (const failure of ['write', 'exception', 'stale read'] as const) {
    test(`does not publish a new profile after a credential ${failure} failure`, () => {
      storageSuccess = failure !== 'write'
      storageThrows = failure === 'exception'
      staleRead = failure === 'stale read'
      stored = { claudeAiOauth: { ...tokens, accessToken: 'previous-access' } }
      savedConfig.oauthAccount = { accountUuid: 'previous', emailAddress: 'previous@example.com' }
      const previous = structuredClone(savedConfig)
      pool.seedClaudeAccountPoolForTest({
        activeAccountUuid: tokens.tokenAccount.uuid,
        accounts: [{ ...tokens, accountUuid: tokens.tokenAccount.uuid, emailAddress: 'test@example.com', status: 'healthy' }],
      })

      expect(() => pool.syncClaudeAccountToStorage()).toThrow('Failed to save Claude account credentials')
      expect(savedConfig).toEqual(previous)
    })
  }

  test('saves the credential identity and refuses a config-only profile with a different binding', async () => {
    storageSuccess = true
    pool.seedClaudeAccountPoolForTest({
      activeAccountUuid: tokens.tokenAccount.uuid,
      accounts: [{ ...tokens, accountUuid: tokens.tokenAccount.uuid, emailAddress: 'test@example.com', status: 'healthy' }],
    })
    pool.syncClaudeAccountToStorage()
    expect(stored?.claudeAiOauth?.accountUuid).toBe(tokens.tokenAccount.uuid)

    savedConfig.oauthAccount = { accountUuid: 'different', emailAddress: 'different@example.com' }
    pool.loadClaudePoolForObservation()
    expect(pool.getClaudePoolStatus().accounts).toHaveLength(0)
    auth.clearOAuthTokenCache()
    expect(auth.getClaudeAIOAuthTokens()).toBeNull()
    expect(await auth.getClaudeAIOAuthTokensAsync()).toBeNull()
  })
})

describe('OAuth installation', () => {
  test('rejects unusable vault-only recovery when secure storage throws', async () => {
    storageThrows = true
    await expect(installOAuthTokens(tokens)).rejects.toThrow('Failed to save OAuth tokens')
    expect(pool.getActiveClaudeAccount()).toBeNull()
  })
  for (const hasVaultAccount of [false, true]) {
    test(`accepts bound plaintext fallback when the vault fails (existing vault: ${hasVaultAccount})`, async () => {
      storageSuccess = true
      if (hasVaultAccount) {
        pool.appendClaudeAccount({
          ...tokens, accountUuid: 'previous', emailAddress: 'previous@example.com',
          accessToken: 'previous-access', refreshToken: 'previous-refresh',
        })
      }
      failVault()
      await expect(installOAuthTokens(tokens)).resolves.toBeUndefined()
      expect(stored?.claudeAiOauth?.accessToken).toBe(tokens.accessToken)
      expect(stored?.claudeAiOauth?.refreshToken).toBe(tokens.refreshToken)
      pool.setClaudeVaultPathForTest(directory)
      pool.loadClaudePoolForObservation()
      expect(pool.getActiveClaudeAccount()?.accountUuid).toBe(tokens.tokenAccount.uuid)
      expect(pool.getActiveClaudeAccount()?.accessToken).toBe(tokens.accessToken)
    })
  }
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
