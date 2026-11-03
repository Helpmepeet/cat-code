import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import * as authority from '../../services/api/claudeAccountAuthority.js'
import nodeHttp from 'node:http'
import nodeHttps from 'node:https'
import { Readable, Writable } from 'node:stream'

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
const httpUtils = await import('../../utils/http.js')
const pool = await import('../../services/api/claudeAccountPool.js')
const envUtils = await import('../../utils/envUtils.js')
const lockfile = await import('../../utils/lockfile.js')
const atomic = await import('../../utils/atomicFile.js')
const axios = (await import('axios')).default
const authFd = await import('../../utils/authFileDescriptor.js')
const logout = await import('../../commands/logout/logout.js')
const codexPool = await import('../../services/api/codexAccountPool.js')
const { commitClaudeAccountSwitch } = await import('../../services/api/claudeAccountSwitch.js')
const { authLogin, installOAuthTokens, installOAuthTokensAfterPolicyValidation } = await import('./auth.js')

const tokens = {
  accessToken: 'test-access', refreshToken: 'test-refresh', expiresAt: 123456,
  subscriptionType: null, rateLimitTier: null,
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
  auth.clearPendingOAuthCredentials()
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
  auth.clearPendingOAuthCredentials()
  auth.clearOAuthTokenCache()
  auth.getApiKeyFromConfigOrMacOSKeychain.cache.clear()
  mock.restore()
  pool.resetClaudeAccountPoolForTest()
  rmSync(directory, { recursive: true, force: true })
})

describe('role persistence', () => {
  test('Console roles update the captured shared profile without a pool account', async () => {
    spyOn(oauth, 'fetchAndStoreUserRoles').mockRestore()
    savedConfig.oauthAccount = { accountUuid: 'console', emailAddress: 'console@example.com' }
    spyOn(axios, 'get').mockResolvedValue({
      status: 200,
      data: { organization_role: 'admin', workspace_role: null, organization_name: 'ConsoleOrg' },
    })
    await oauth.fetchAndStoreUserRoles('console-token', 'console')
    expect(savedConfig.oauthAccount.organizationName).toBe('ConsoleOrg')
    expect(savedConfig.oauthAccount.organizationRole).toBe('admin')
  })

  test('login roles reach the effective profile and survive vault reload', async () => {
    storageSuccess = true
    spyOn(oauth, 'storeOAuthAccountInfo').mockRestore()
    spyOn(oauth, 'fetchAndStoreUserRoles').mockRestore()
    spyOn(auth, 'isAnthropicAuthEnabled').mockReturnValue(true)
    spyOn(axios, 'get').mockResolvedValue({
      status: 200,
      data: { organization_role: 'admin', workspace_role: 'member', organization_name: 'TestOrg' },
    })
    await installOAuthTokens(tokens)
    expect(auth.getOauthAccountInfo()?.organizationRole).toBe('admin')
    expect(savedConfig.oauthAccount?.organizationName).toBe('TestOrg')
    pool.resetClaudeAccountPoolForTest()
    pool.setClaudeVaultPathForTest(directory)
    pool.loadClaudePoolForObservation()
    expect(pool.getActiveClaudeAccount()?.organizationName).toBe('TestOrg')
    expect(pool.getActiveClaudeAccount()?.workspaceRole).toBe('member')
  })

  test('late roles do not replace a newer organization for the same account', async () => {
    storageSuccess = true
    spyOn(oauth, 'storeOAuthAccountInfo').mockRestore()
    spyOn(oauth, 'fetchAndStoreUserRoles').mockRestore()
    let finish!: (response: unknown) => void
    let started!: () => void
    const starting = new Promise<void>(resolve => { started = resolve })
    spyOn(axios, 'get').mockImplementation(() => {
      started()
      return new Promise(resolve => { finish = resolve })
    })
    const pending = installOAuthTokens({
      ...tokens, tokenAccount: { ...tokens.tokenAccount, organizationUuid: 'org-a' },
    })
    await starting
    pool.appendClaudeAccount({
      ...tokens, accountUuid: 'test-account', emailAddress: 'test@example.com',
      accessToken: 'new-access', organizationUuid: 'org-b',
    })
    const path = join(directory, 'accounts', 'test-account.json')
    const before = readFileSync(path, 'utf8')
    finish({ status: 200, data: { organization_role: 'admin', organization_name: 'OldOrg' } })
    await pending
    expect(pool.getActiveClaudeAccount()?.organizationUuid).toBe('org-b')
    expect(pool.getActiveClaudeAccount()?.organizationRole).toBeUndefined()
    expect(savedConfig.oauthAccount?.organizationUuid).toBe('org-b')
    expect(savedConfig.oauthAccount?.organizationRole).toBeUndefined()
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  test.each([false, true])('late roles cannot overwrite B after switch (global=%s)', async persistDefault => {
    storageSuccess = true
    spyOn(oauth, 'storeOAuthAccountInfo').mockRestore()
    spyOn(oauth, 'fetchAndStoreUserRoles').mockRestore()
    let resolve!: (response: unknown) => void
    let started!: () => void
    const starting = new Promise<void>(r => { started = r })
    spyOn(axios, 'get').mockImplementation(() => {
      started()
      return new Promise(r => { resolve = r })
    })
    const login = installOAuthTokens(tokens)
    await starting
    pool.appendClaudeAccount({
      accountUuid: 'account-b', emailAddress: 'b@example.com',
      accessToken: 'access-b', refreshToken: 'refresh-b', expiresAt: 123456,
      scopes: tokens.scopes,
    })
    pool.updateClaudeAccountRoles('account-b', {
      organizationName: 'OrgB', organizationRole: null, workspaceRole: null,
    })
    pool.switchToClaudeAccount('account-b', { persistDefault })
    // Another process can publish B even when this process only switched locally.
    savedConfig.oauthAccount = { accountUuid: 'account-b', emailAddress: 'b@example.com', organizationName: 'OrgB' }
    const before = structuredClone(stored)
    const bPath = join(directory, 'authority-v1', 'account-b.json')
    const bVault = readFileSync(bPath, 'utf8')
    const aPath = join(directory, 'authority-v1', 'test-account.json')
    const refreshedA = JSON.parse(readFileSync(aPath, 'utf8'))
    refreshedA.credentials.accessToken = 'fresh-a'
    refreshedA.credentials.refreshToken = 'rotated-a'
    refreshedA.credentialRevision++
    refreshedA.stateSequence++
    writeFileSync(aPath, JSON.stringify(refreshedA))
    resolve({ status: 200, data: { organization_role: 'admin', workspace_role: {}, organization_name: 'OrgA' } })
    await login
    expect(savedConfig.oauthAccount.organizationName).toBe('OrgB')
    expect(stored).toEqual(before)
    expect(readFileSync(bPath, 'utf8')).toBe(bVault)
    expect(pool.getActiveClaudeAccount()?.organizationName).toBe('OrgB')
    const a = JSON.parse(readFileSync(aPath, 'utf8'))
    expect(a.profile.organization_role).toBe('admin')
    expect(a.profile.workspace_role).toBeNull()
    expect(a.profile.organization_name).toBe('OrgA')
    expect(a.credentials.accessToken).toBe('fresh-a')
    expect(a.credentials.refreshToken).toBe('rotated-a')
  })
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

  test('legacy roles are reused only for the same account and organization', () => {
    const { a, b } = seedAccounts()
    spyOn(auth, 'isAnthropicAuthEnabled').mockReturnValue(true)
    savedConfig.oauthAccount = {
      accountUuid: a.accountUuid, emailAddress: a.emailAddress,
      organizationUuid: a.organizationUuid, organizationRole: 'admin',
    }
    expect(auth.getOauthAccountInfo()?.organizationRole).toBe('admin')
    savedConfig.oauthAccount.organizationUuid = 'other-org'
    expect(auth.getOauthAccountInfo()?.organizationRole).toBeUndefined()
    savedConfig.oauthAccount = {
      accountUuid: b.accountUuid, emailAddress: b.emailAddress,
      organizationUuid: a.organizationUuid, organizationRole: 'admin',
    }
    expect(auth.getOauthAccountInfo()?.organizationRole).toBeUndefined()
    savedConfig.oauthAccount.accountUuid = a.accountUuid
    pool.getActiveClaudeAccount()!.organizationRole = null
    expect(auth.getOauthAccountInfo()?.organizationRole).toBeNull()
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

  function persistSeedAccounts() {
    const { a, b } = seedAccounts()
    pool.appendClaudeAccount(a)
    pool.appendClaudeAccount(b)
    pool.switchToClaudeAccount(a.accountUuid, { persistDefault: false })
    return { a, b }
  }

  test('refresh pending across a switch writes only the original vault account', async () => {
    const { a, b } = persistSeedAccounts()
    spyOn(envUtils, 'getClaudeConfigHomeDir').mockReturnValue(directory)
    stored = { claudeAiOauth: { ...b } }
    const before = structuredClone(stored)
    let resolveRefresh!: (value: typeof tokens) => void
    let started!: () => void
    const starting = new Promise<void>(resolve => { started = resolve })
    const refresh = spyOn(oauth, 'refreshOAuthToken').mockImplementation(async (_token, options) => options!.initiateRequest!(() => {
      started()
      return new Promise(resolve => { resolveRefresh = resolve as typeof resolveRefresh })
    }))
    const pending = auth.checkAndRefreshOAuthTokenIfNeeded()
    await starting
    pool.switchToClaudeAccount(b.accountUuid, { persistDefault: false })
    resolveRefresh({ ...tokens, accessToken: 'fresh-a', expiresAt: Date.now() + 3600_000 })
    expect(await pending).toBe(true)
    expect(refresh).toHaveBeenCalledWith(a.refreshToken, {
      persistProfile: false, skipProfile: true, scopes: a.scopes, initiateRequest: expect.any(Function),
    })
    expect(stored).toEqual(before)
    expect(savedConfig.oauthAccount?.accountUuid).toBe(b.accountUuid)
    expect(pool.getActiveClaudeAccount()?.accountUuid).toBe(b.accountUuid)
    expect(readAuthority(a.accountUuid).record.credentials?.accessToken).toBe('fresh-a')
  })

  test('deletion during token redemption denies the late refresh and retains the local identity hold', async () => {
    const { a, b } = persistSeedAccounts()
    expect(pool.updateClaudeAccountTokens(a.accountUuid, { accessToken: a.accessToken })).toBe('durable')
    const vaultFilePath = join(directory, 'accounts', `${a.accountUuid}.json`)
    spyOn(envUtils, 'getClaudeConfigHomeDir').mockReturnValue(directory)
    let finish!: (value: typeof tokens) => void
    let started!: () => void
    const starting = new Promise<void>(resolve => { started = resolve })
    spyOn(oauth, 'refreshOAuthToken').mockImplementation(async (_token, options) => options!.initiateRequest!(() => {
      started()
      return new Promise(resolve => { finish = resolve as typeof finish })
    }))
    const pending = auth.recoverOAuth401Error(a.accessToken, a.accountUuid)
    await starting
    expect(pool.deleteClaudeVaultFile(vaultFilePath)).toBe(true)
    finish({ ...tokens, accessToken: 'late-deleted-access', expiresAt: Date.now() + 3600_000 })
    expect((await pending).status).toBe('reauth_required')
    expect(pool.getClaudePoolStatus().accounts.find(account => account.accountUuid === b.accountUuid)?.status).toBe('healthy')
    expect(pool.getActiveClaudeAccount()).toBeNull()
    expect(auth.getClaudeAIOAuthTokens()).toBeNull()
    expect(await auth.getClaudeAIOAuthTokensAsync()).toBeNull()
    expect(readAuthority(a.accountUuid).status).toBe('deleted')
    expect(JSON.parse(readFileSync(vaultFilePath, 'utf8')).tokens).toBeUndefined()
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
    replaceAuthorityCredentials(account.accountUuid, 'other-process-fresh-a')
    spyOn(envUtils, 'getClaudeConfigHomeDir').mockReturnValue(directory)
    const refresh = spyOn(oauth, 'refreshOAuthToken').mockRejectedValue(new Error('Unexpected refresh'))
    auth.clearOAuthTokenCache()
    expect(await auth.checkAndRefreshOAuthTokenIfNeeded()).toBe(false)
    expect(refresh).not.toHaveBeenCalled()
    expect(auth.getClaudeAIOAuthTokens()?.accessToken).toBe('other-process-fresh-a')
    pool.reloadClaudeAccountCredentials(account.accountUuid)
    expect(pool.getActiveClaudeAccount()?.accountUuid).toBe(account.accountUuid)
  })
})

function readAuthority(accountId: string) {
  const read = authority.readClaudeAccountAuthority(accountId)
  if (!('record' in read)) throw new Error(`Missing isolated account authority: ${read.status}`)
  return read
}

function replaceAuthorityCredentials(accountId: string, accessToken = 'external-new') {
  const current = readAuthority(accountId)
  const intent = current.record.refreshIntent
  const claim = intent ? { handle: current.handle, operationId: intent.operationId, ownerNonce: intent.ownerNonce }
    : authority.claimClaudeRefresh(current.handle, randomUUID(), randomUUID()).claim!
  expect(claim).toBeDefined()
  if (!intent || intent.phase === 'prepared') expect(authority.startClaudeRefreshDispatch(claim, () => true).result.outcome).toBe('committed')
  expect(authority.completeClaudeRefresh(claim, {
    ...current.record.credentials!, accessToken, refreshToken: 'external-refresh', expiresAt: Date.now() + 10800_000,
  }).outcome).toBe('committed')
}

function failIssuedCredentials(code = 'ENOSPC', afterPublication = false) {
  const original = atomic.writeFileAtomicDurableSync
  return spyOn(atomic, 'writeFileAtomicDurableSync').mockImplementation((...args) => {
    const record = JSON.parse(String(args[1]))
    if (record.credentialRevision > 0 && /^(fresh-|pending-)/.test(record.credentials?.accessToken ?? '')) {
      if (afterPublication) original(...args)
      throw Object.assign(new Error('Isolated successor persistence failure'), { code })
    }
    return original(...args)
  })
}

describe('bound Claude OAuth recovery', () => {
  function setup() {
    storageSuccess = true
    pool.appendClaudeAccount({ ...tokens, accountUuid: 'test-account', emailAddress: 'test@example.com', expiresAt: Date.now() + 3600_000 })
    spyOn(envUtils, 'getClaudeConfigHomeDir').mockReturnValue(directory)
    auth.clearOAuthTokenCache()
    const refresh = spyOn(oauth, 'refreshOAuthToken').mockImplementation(async (_token, options) => options!.initiateRequest!(() => Promise.resolve({
      ...tokens, accessToken: 'fresh-access', refreshToken: 'fresh-refresh', expiresAt: Date.now() + 7200_000,
    })))
    return { account: pool.getActiveClaudeAccount()!, handle: readAuthority('test-account').handle, refresh }
  }
  function replaceDisk(account: NonNullable<ReturnType<typeof pool.getActiveClaudeAccount>>, accessToken = 'external-new') {
    replaceAuthorityCredentials(account.accountUuid, accessToken)
  }

  test('rejected future-expiry token refreshes exactly once for concurrent callers', async () => {
    const { refresh } = setup()
    const results = await Promise.all(Array.from({ length: 5 }, () => auth.recoverOAuth401Error(tokens.accessToken, 'test-account')))
    expect(results.map(result => result.status)).toEqual(Array(5).fill('refreshed'))
    expect(refresh).toHaveBeenCalledTimes(1)
    expect((await auth.getClaudeAIOAuthTokensAsync())?.accessToken).toBe('fresh-access')
  })

  test('preflight repairs the bound rejected account instead of borrowing the shared default', async () => {
    const { account, handle, refresh } = setup()
    pool.appendClaudeAccount({
      ...tokens, accountUuid: 'shared-default', emailAddress: 'shared@example.com', accessToken: 'shared-access',
    })
    pool.switchToClaudeAccount(account.accountUuid, { persistDefault: false })
    savedConfig.oauthAccount = { accountUuid: 'shared-default', emailAddress: 'shared@example.com' }
    expect(authority.rejectClaudeCredential(handle, randomUUID(), 'access_rejected').outcome).toBe('committed')
    expect(pool.getActiveClaudeAccount()).toBeNull()
    const prepared = await auth.prepareClaudeOAuthRequest()
    expect(prepared.status).toBe('ready')
    expect(prepared.handle?.accountId).toBe(account.accountUuid)
    expect(refresh).toHaveBeenCalledWith(tokens.refreshToken, expect.any(Object))
    expect(readAuthority('shared-default').record.credentials?.accessToken).toBe('shared-access')
  })

  test('preflight holds the selected older login rather than adopting the new generation', async () => {
    const { account, handle, refresh } = setup()
    expect(authority.commitClaudeLogin(account.accountUuid, randomUUID(), {
      accessToken: 'new-login', refreshToken: 'new-login-refresh', expiresAt: Date.now() + 3600_000,
    }, { account_uuid: account.accountUuid }).outcome).toBe('committed')
    expect(pool.getSelectedClaudeAccountIdentity()).toEqual({ accountId: handle.accountId, generation: handle.generation })
    expect((await auth.prepareClaudeOAuthRequest()).status).toBe('older_login')
    expect(refresh).not.toHaveBeenCalled()
    expect(auth.getClaudeAIOAuthTokens()).toBeNull()
  })

  test('persisted staged login remains persistence-pending when storage cannot commit it', async () => {
    const { account, handle, refresh } = setup()
    const original = atomic.writeFileAtomicDurableSync
    const writes = spyOn(atomic, 'writeFileAtomicDurableSync').mockImplementation((...args) => {
      const record = JSON.parse(String(args[1]))
      if (record.credentials?.accessToken === 'pending-login-new' && !record.pendingLogin) {
        throw Object.assign(new Error('Isolated staged login cannot commit'), { code: 'ENOSPC' })
      }
      return original(...args)
    })
    const operationId = randomUUID()
    try {
      expect(authority.commitClaudeLogin(account.accountUuid, operationId, {
        accessToken: 'pending-login-new', refreshToken: 'pending-login-refresh', expiresAt: Date.now() + 3600_000,
      }, { account_uuid: account.accountUuid }).outcome).toBe('persistence_pending')
      expect(authority.retryClaudeAuthorityPersistence(account.accountUuid, operationId).outcome).toBe('persistence_pending')
      const staged = readAuthority(account.accountUuid)
      expect(staged.status).toBe('persistence_pending')
      expect(staged.record.pendingLogin?.operationId).toBe(operationId)
      expect(staged.handle).toEqual(handle)
      expect((await auth.prepareClaudeOAuthRequest()).status).toBe('persistence_pending')
      expect(authority.isClaudeCredentialReady(handle)).toBe(false)
      expect(auth.getClaudeAIOAuthTokens()).toBeNull()
      expect(refresh).not.toHaveBeenCalled()
    } finally { writes.mockRestore() }
  })

  test('an initialized pool without a local selection never borrows the shared default', async () => {
    const { account, refresh } = setup()
    savedConfig.oauthAccount = { accountUuid: account.accountUuid, emailAddress: account.emailAddress }
    pool.seedClaudeAccountPoolForTest({ accounts: [] })
    expect((await auth.prepareClaudeOAuthRequest()).status).toBe('sign_in_required')
    expect(refresh).not.toHaveBeenCalled()
  })

  test.each(['revision', 'selection', 'login', 'api-key', 'pending-save'])(
    'delayed physical 401 keeps its sent credential identity across %s',
    async change => {
      const { account, handle, refresh } = setup()
      const sent: string[] = []
      let release!: () => void
      let started!: () => void
      const starting = new Promise<void>(resolve => { started = resolve })
      const physical = (options: nodeHttp.RequestOptions, callback: (response: nodeHttp.IncomingMessage) => void) => {
        const headers = options.headers as Record<string, string>
        sent.push(headers.Authorization ?? headers['x-api-key'])
        const request = new Writable({ autoDestroy: false, write(_chunk, _encoding, done) { done() } }) as Writable & Record<string, unknown>
        request.setTimeout = request.setNoDelay = request.setSocketKeepAlive = () => request
        request.on('finish', () => {
          const respond = (status: number) => {
            const response = Readable.from([JSON.stringify({ ok: status === 200 })]) as Readable & Record<string, unknown>
            response.statusCode = status
            response.headers = {}
            response.req = request
            callback(response as unknown as nodeHttp.IncomingMessage)
          }
          if (sent.length === 1) { release = () => respond(401); started() }
          else respond(200)
        })
        return request as unknown as nodeHttp.ClientRequest
      }
      spyOn(nodeHttp, 'request').mockImplementation(physical as typeof nodeHttp.request)
      spyOn(nodeHttps, 'request').mockImplementation(physical as typeof nodeHttps.request)
      const pending = httpUtils.withOAuth401Retry(
        captured => axios.get('https://isolated.invalid/account', { ...captured.requestConfig, headers: captured.headers }),
        { getAuthHeaders: () => change === 'api-key' ? { headers: { 'x-api-key': 'isolated-api-key' } }
          : httpUtils.getOAuthAuthHeaders({ accessToken: tokens.accessToken, accountUuid: account.accountUuid }) },
      )
      await Promise.race([starting, pending.then(() => { throw new Error('Request completed without reaching the physical gate') })])
      let failedWrite: ReturnType<typeof failIssuedCredentials> | undefined
      if (change === 'revision') replaceAuthorityCredentials(account.accountUuid, 'newer-revision')
      if (change === 'selection') pool.appendClaudeAccount({
        ...tokens, accountUuid: 'other', emailAddress: 'other@example.com', accessToken: 'other-access', refreshToken: 'other-refresh',
      })
      if (change === 'login') pool.appendClaudeAccount({
        ...tokens, accountUuid: account.accountUuid, emailAddress: account.emailAddress,
      })
      if (change === 'pending-save') failedWrite = failIssuedCredentials()
      release()
      try {
        if (['login', 'api-key', 'pending-save'].includes(change)) {
          await expect(pending).rejects.toMatchObject({ response: { status: 401 } })
          expect(sent).toHaveLength(1)
        } else {
          expect((await pending).status).toBe(200)
          expect(sent).toEqual([`Bearer ${tokens.accessToken}`, `Bearer ${change === 'revision' ? 'newer-revision' : 'fresh-access'}`])
        }
        const observed = readAuthority(account.accountUuid)
        expect(observed.handle.generation).toBe(change === 'login' ? handle.generation + 1 : handle.generation)
        expect(authority.isClaudeCredentialReady(observed.handle)).toBe(change !== 'pending-save')
        if (change === 'selection') {
          const other = readAuthority('other')
          expect(other.record.credentials?.accessToken).toBe('other-access')
          expect(authority.isClaudeCredentialReady(other.handle)).toBe(true)
          expect(refresh).toHaveBeenCalledWith(tokens.refreshToken, expect.any(Object))
        }
        expect(refresh).toHaveBeenCalledTimes(change === 'selection' || change === 'pending-save' ? 1 : 0)
      } finally { failedWrite?.mockRestore() }
    },
  )

  test('async header substitution cannot relabel the captured credential at the physical send', async () => {
    const { account, refresh } = setup()
    const physical = spyOn(nodeHttps, 'request').mockImplementation(() => { throw new Error('Unexpected physical send') })
    const interceptor = axios.interceptors.request.use(async config => {
      await Promise.resolve()
      config.headers.set('Authorization', 'Bearer unrelated')
      return config
    })
    try {
      await expect(httpUtils.withOAuth401Retry(
        captured => axios.get('https://isolated.invalid/account', { ...captured.requestConfig, headers: captured.headers }),
        { getAuthHeaders: () => httpUtils.getOAuthAuthHeaders({ accessToken: tokens.accessToken, accountUuid: account.accountUuid }) },
      )).rejects.toThrow('credential changed before send')
      expect(physical).not.toHaveBeenCalled()
      expect(refresh).not.toHaveBeenCalled()
    } finally { axios.interceptors.request.eject(interceptor) }
  })

  test('unbound recovery never adopts the newly selected unrelated account', async () => {
    const { account, refresh } = setup()
    pool.appendClaudeAccount({
      ...tokens, accountUuid: 'other', emailAddress: 'other@example.com',
      accessToken: 'other-access', expiresAt: Date.now() + 7200_000,
    })
    expect((await auth.recoverOAuth401Error(tokens.accessToken)).accountUuid).toBe(account.accountUuid)
    expect(refresh).toHaveBeenCalledWith(tokens.refreshToken, expect.any(Object))
    refresh.mockClear()
    expect((await auth.recoverOAuth401Error('unknown-rejected-token')).status).toBe('unavailable')
    expect(refresh).not.toHaveBeenCalled()
    expect(pool.getActiveClaudeAccount()?.accountUuid).toBe('other')
  })

  test('normal token checks retry pending local persistence without another refresh', async () => {
    const { account, refresh } = setup()
    const write = failIssuedCredentials()
    expect((await auth.recoverOAuth401Error(tokens.accessToken, account.accountUuid)).status).toBe('persistence_pending')
    write.mockRestore()
    await auth.checkAndRefreshOAuthTokenIfNeeded()
    expect(readAuthority(account.accountUuid).record.credentials?.accessToken).toBe('fresh-access')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  test.each(['login', 'removal'])('a late refresh cannot undo explicit %s', async operation => {
    const { account, refresh } = setup()
    let finish!: (value: typeof tokens) => void
    let started!: () => void
    const starting = new Promise<void>(resolve => { started = resolve })
    refresh.mockImplementation(async (_token, options) => options!.initiateRequest!(() => {
      started()
      return new Promise(resolve => { finish = resolve as typeof finish })
    }))
    const pending = auth.recoverOAuth401Error(tokens.accessToken, account.accountUuid)
    await starting
    if (operation === 'login') {
      pool.appendClaudeAccount({
        ...tokens, accountUuid: account.accountUuid, emailAddress: account.emailAddress,
        accessToken: 'new-login', expiresAt: Date.now() + 3600_000,
      })
    } else {
      expect(pool.removeClaudeAccount(account.accountUuid)).toBe(true)
    }
    finish({ ...tokens, accessToken: 'late-refresh', expiresAt: Date.now() + 7200_000 })
    expect((await pending).status).toBe('reauth_required')
    expect(pool.getActiveClaudeAccount()?.accessToken).toBe(operation === 'login' ? 'new-login' : undefined)
  })

  test.each([null, 'fresh-refresh'])('secure-storage mirror failure cannot lose authoritative refresh credentials with refresh token %s', async refreshToken => {
    spyOn(envUtils, 'getClaudeConfigHomeDir').mockReturnValue(directory)
    savedConfig.oauthAccount = { accountUuid: 'test-account', emailAddress: 'test@example.com' }
    stored = { claudeAiOauth: { ...tokens, accountUuid: 'test-account', expiresAt: Date.now() + 3600_000 } }
    pool.appendClaudeAccount({ ...tokens, accountUuid: 'test-account', emailAddress: 'test@example.com' })
    const refresh = spyOn(oauth, 'refreshOAuthToken').mockImplementation(async (_token, options) => options!.initiateRequest!(() =>
      Promise.resolve({ ...tokens, refreshToken, accessToken: 'fresh-shared', expiresAt: Date.now() + 7200_000 })))
    auth.clearOAuthTokenCache()
    expect((await auth.recoverOAuth401Error(tokens.accessToken, 'test-account')).status).toBe('refreshed')
    expect((await auth.getClaudeAIOAuthTokensAsync())?.accessToken).toBe('fresh-shared')
    expect(auth.getClaudeAIOAuthTokens()?.accessToken).toBe('fresh-shared')
    storageSuccess = true
    expect((await auth.prepareClaudeOAuthRequest()).status).toBe('ready')
    expect(stored?.claudeAiOauth?.accessToken).toBe(tokens.accessToken)
    expect(readAuthority('test-account').record.credentials?.refreshToken).toBe(refreshToken ?? tokens.refreshToken)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  test('logout tombstone discards pending issued credentials without secure-mirror resurrection', async () => {
    spyOn(envUtils, 'getClaudeConfigHomeDir').mockReturnValue(directory)
    savedConfig.oauthAccount = { accountUuid: 'test-account', emailAddress: 'test@example.com' }
    stored = { claudeAiOauth: { ...tokens, accountUuid: 'test-account', expiresAt: Date.now() + 3600_000 } }
    pool.appendClaudeAccount({ ...tokens, accountUuid: 'test-account', emailAddress: 'test@example.com' })
    spyOn(oauth, 'refreshOAuthToken').mockImplementation(async (_token, options) => options!.initiateRequest!(() => Promise.resolve({
      ...tokens, accessToken: 'pending-secure', expiresAt: Date.now() + 7200_000,
    })))
    const write = failIssuedCredentials()
    auth.clearOAuthTokenCache()
    expect((await auth.recoverOAuth401Error(tokens.accessToken, 'test-account')).status).toBe('persistence_pending')
    write.mockRestore()
    expect(pool.removeClaudeAccount('test-account')).toBe(true)
    stored = {}
    auth.clearPendingOAuthCredentials()
    auth.clearOAuthTokenCache()
    expect(await auth.getClaudeAIOAuthTokensAsync()).toBeNull()
  })

  test('same token in different accounts does not globally coalesce recovery', async () => {
    const { account, refresh } = setup()
    pool.appendClaudeAccount({ ...tokens, accountUuid: 'other', emailAddress: 'other@example.com', expiresAt: account.expiresAt })
    const results = await Promise.all([
      auth.recoverOAuth401Error(tokens.accessToken, account.accountUuid),
      auth.recoverOAuth401Error(tokens.accessToken, 'other'),
    ])
    expect(results.map(result => result.accountUuid)).toEqual([account.accountUuid, 'other'])
    expect(results.every(result => result.status === 'refreshed')).toBe(true)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  test.each(['before', 'fresh', 'locked'])('adopts external replacement at %s read without refresh', async phase => {
    const { account, handle, refresh } = setup()
    if (phase === 'before') replaceDisk(account)
    if (phase === 'fresh') {
      const read = authority.readClaudeAccountAuthority
      let reads = 0
      spyOn(authority, 'readClaudeAccountAuthority').mockImplementation(uuid => {
        if (++reads === 2) replaceDisk(account)
        return read(uuid)
      })
    }
    const realLock = lockfile.lock
    if (phase === 'locked') spyOn(lockfile, 'lock').mockImplementation(async (...args) => {
      const release = await realLock(...args)
      replaceDisk(account)
      return release
    })
    expect((await auth.recoverOAuth401Error(tokens.accessToken, account.accountUuid, handle)).status).toBe('adopted_newer')
    expect(refresh).not.toHaveBeenCalled()
    expect(readAuthority(account.accountUuid).record.credentials?.accessToken).toBe('external-new')
  })

  test.each(['ENOSPC', 'EACCES'])('%s retains fresh credentials and retries only local persistence', async code => {
    const { account, handle, refresh } = setup()
    const write = failIssuedCredentials(code)
    expect(await auth.recoverOAuth401Error(tokens.accessToken, account.accountUuid)).toEqual({ status: 'persistence_pending', accountUuid: account.accountUuid })
    expect((await auth.prepareClaudeOAuthRequest()).status).toBe('persistence_pending')
    expect(await auth.getClaudeAIOAuthTokensAsync()).toBeNull()
    expect(readAuthority(account.accountUuid).record.credentials?.accessToken).toBe(tokens.accessToken)
    expect((await auth.recoverOAuth401Error(tokens.accessToken, account.accountUuid)).status).toBe('persistence_pending')
    write.mockRestore()
    expect((await auth.recoverOAuth401Error(tokens.accessToken, account.accountUuid, handle)).status).toBe('adopted_newer')
    expect(readAuthority(account.accountUuid).record.credentials?.accessToken).toBe('fresh-access')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  test('pending recovery accepts newer external credentials instead of overwriting them', async () => {
    const { account, handle, refresh } = setup()
    const write = failIssuedCredentials()
    expect((await auth.recoverOAuth401Error(tokens.accessToken, account.accountUuid)).status).toBe('persistence_pending')
    write.mockRestore()
    replaceDisk(account)
    expect((await auth.recoverOAuth401Error(tokens.accessToken, account.accountUuid, handle)).status).toBe('adopted_newer')
    expect(readAuthority(account.accountUuid).record.credentials?.accessToken).toBe('external-new')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  test('malformed external credentials cannot displace a pending refresh', async () => {
    const { account, refresh } = setup()
    const write = failIssuedCredentials()
    expect((await auth.recoverOAuth401Error(tokens.accessToken, account.accountUuid)).status).toBe('persistence_pending')
    write.mockRestore()
    const authorityPath = join(directory, 'authority-v1', `${account.accountUuid}.json`)
    const valid = readFileSync(authorityPath, 'utf8')
    const data = JSON.parse(valid)
    data.credentials = { accessToken: 'malformed', expiresAt: Date.now() + 10800_000 }
    writeFileSync(authorityPath, JSON.stringify(data))
    expect((await auth.prepareClaudeOAuthRequest()).status).toBe('temporarily_unavailable')
    expect(JSON.parse(readFileSync(authorityPath, 'utf8')).credentials.accessToken).toBe('malformed')
    writeFileSync(authorityPath, valid)
    expect((await auth.prepareClaudeOAuthRequest()).status).toBe('ready')
    expect(readAuthority(account.accountUuid).record.credentials?.accessToken).toBe('fresh-access')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  test('explicit login supersedes pending credentials even with a shorter expiry', async () => {
    const { account, handle } = setup()
    const write = failIssuedCredentials()
    expect((await auth.recoverOAuth401Error(tokens.accessToken, account.accountUuid)).status).toBe('persistence_pending')
    write.mockRestore()
    pool.appendClaudeAccount({ ...tokens, accountUuid: account.accountUuid, emailAddress: account.emailAddress,
      accessToken: 'explicit-login', expiresAt: Date.now() + 60_000 })
    pool.loadClaudePoolForObservation()
    expect(pool.getActiveClaudeAccount()?.accessToken).toBe('explicit-login')
    expect(pool.retryClaudeAccountTokenPersistence(account.accountUuid)).toBe('durable')
    expect((await auth.recoverOAuth401Error(tokens.accessToken, account.accountUuid, handle)).status).toBe('reauth_required')
    expect(readAuthority(account.accountUuid).record.credentials?.accessToken).toBe('explicit-login')
  })

  test('confirmed removal clears pending credentials without profile resurrection', async () => {
    const { account } = setup()
    const write = failIssuedCredentials()
    expect((await auth.recoverOAuth401Error(tokens.accessToken, account.accountUuid)).status).toBe('persistence_pending')
    write.mockRestore()
    expect(pool.removeClaudeAccount(account.accountUuid)).toBe(true)
    pool.loadClaudePoolForObservation()
    expect(pool.getClaudePoolStatus().accounts).toHaveLength(0)
    expect(pool.retryClaudeAccountTokenPersistence(account.accountUuid)).toBe('pending')
  })

  test('incompatible legacy writer preserves pending credentials and is never ordered by expiry', async () => {
    const { account, refresh } = setup()
    const write = failIssuedCredentials()
    expect((await auth.recoverOAuth401Error(tokens.accessToken, account.accountUuid)).status).toBe('persistence_pending')
    write.mockRestore()
    const data = JSON.parse(readFileSync(account.vaultFilePath!, 'utf8'))
    const barrier = JSON.stringify(data)
    data.tokens = { access_token: 'ambiguous-external', expires_at: account.expiresAt }
    writeFileSync(account.vaultFilePath!, JSON.stringify(data))
    expect((await auth.prepareClaudeOAuthRequest()).status).toBe('temporarily_unavailable')
    expect(JSON.parse(readFileSync(account.vaultFilePath!, 'utf8')).tokens.access_token).toBe('ambiguous-external')
    expect(refresh).toHaveBeenCalledTimes(1)
    writeFileSync(account.vaultFilePath!, barrier)
    expect((await auth.prepareClaudeOAuthRequest()).status).toBe('ready')
    expect(readAuthority(account.accountUuid).record.credentials?.accessToken).toBe('fresh-access')
  })

  test('publication followed by an exception stays pending until a local durable retry', async () => {
    const { account, handle, refresh } = setup()
    const write = failIssuedCredentials('EIO', true)
    expect((await auth.recoverOAuth401Error(tokens.accessToken, account.accountUuid)).status).toBe('persistence_pending')
    expect((await auth.prepareClaudeOAuthRequest()).status).toBe('persistence_pending')
    write.mockRestore()
    expect((await auth.recoverOAuth401Error(tokens.accessToken, account.accountUuid, handle)).status).toBe('adopted_newer')
    expect(readAuthority(account.accountUuid).record.credentials?.accessToken).toBe('fresh-access')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  test.each(['network', 'lock', 'invalid_grant'])('classifies %s without mistaking future expiry for recovery', async failure => {
    const { account, refresh } = setup()
    let release: (() => Promise<void>) | undefined
    if (failure === 'lock') release = await lockfile.lock(authority.getClaudeRefreshLockPath(account.accountUuid), { realpath: false })
    else refresh.mockImplementation(async (_token, options) => options!.initiateRequest!(() =>
      Promise.reject(failure === 'invalid_grant' ? { response: { data: { error: 'invalid_grant' } } } : new Error('timeout'))))
    try {
      expect((await auth.recoverOAuth401Error(tokens.accessToken, account.accountUuid)).status)
        .toBe(failure === 'invalid_grant' ? 'reauth_required' : failure === 'network' ? 'refresh_uncertain' : 'transient_failure')
      expect(readAuthority(account.accountUuid).record.credentials?.accessToken).toBe(tokens.accessToken)
      expect(authority.isClaudeCredentialReady(readAuthority(account.accountUuid).handle)).toBe(false)
    } finally { await release?.() }
  }, 15_000)

  test.each([false, true])('pending refresh stays bound while account changes (global=%s)', async persistDefault => {
    const { account, handle, refresh } = setup()
    pool.appendClaudeAccount({ ...tokens, accountUuid: 'other', emailAddress: 'other@example.com', accessToken: 'other-access' })
    let finish!: (value: typeof tokens) => void
    let start!: () => void
    const started = new Promise<void>(resolve => { start = resolve })
    refresh.mockImplementation(async (_token, options) => options!.initiateRequest!(() => {
      start(); return new Promise(resolve => { finish = resolve as typeof finish })
    }))
    const pending = auth.recoverOAuth401Error(tokens.accessToken, account.accountUuid)
    await started
    pool.switchToClaudeAccount('other', { persistDefault })
    const write = failIssuedCredentials()
    finish({ ...tokens, accessToken: 'fresh-access', expiresAt: Date.now() + 7200_000 })
    expect((await pending).status).toBe('persistence_pending')
    expect(pool.getActiveClaudeAccount()?.accessToken).toBe('other-access')
    expect(authority.isClaudeCredentialReady(readAuthority(account.accountUuid).handle)).toBe(false)
    write.mockRestore()
    expect((await auth.recoverOAuth401Error(tokens.accessToken, account.accountUuid, handle)).status).toBe('adopted_newer')
    expect(readAuthority(account.accountUuid).record.credentials?.accessToken).toBe('fresh-access')
    expect(pool.getActiveClaudeAccount()?.accountUuid).toBe('other')
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
    expect(() => pool.appendClaudeAccount({ ...tokens, ...tokens.tokenAccount, accountUuid: tokens.tokenAccount.uuid })).toThrow('Failed to save Claude sign-in')
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
  test('real precommit vault failure stays pending and retries captured installation after local storage repair', async () => {
    storageSuccess = true
    const vault = join(directory, 'unavailable-vault')
    writeFileSync(vault, 'not a directory')
    pool.setClaudeVaultPathForTest(vault)
    const lookup = spyOn(profile, 'getOauthProfileFromOauthToken').mockResolvedValue(null)
    const exchange = spyOn(oauth, 'refreshOAuthToken').mockRejectedValue(new Error('OAuth exchange forbidden during local retry'))
    let validations = 0
    const pending = await installOAuthTokensAfterPolicyValidation(tokens, {
      validateOrg: async () => { validations++; return { valid: true } },
      createOperationId: () => 'precommit-local-retry',
    })
    expect(pending).toMatchObject({
      valid: true, installation: 'persistence_pending', operationId: 'precommit-local-retry',
    })
    expect(savedConfig.activeClaudeAccountUuid).not.toBe(tokens.tokenAccount.uuid)
    if (!pending.valid || pending.installation !== 'persistence_pending' || !pending.retry) throw new Error('Missing captured local retry')
    rmSync(vault)
    mkdirSync(vault)
    expect(await pending.retry()).toEqual({ valid: true, installation: 'committed' })
    expect(savedConfig.activeClaudeAccountUuid).toBe(tokens.tokenAccount.uuid)
    expect(authority.readClaudeAccountAuthority(tokens.tokenAccount.uuid)).toMatchObject({
      handle: { generation: 1, revision: 0 },
      record: { operations: { 'precommit-local-retry': { kind: 'login', generation: 1 } } },
    })
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(validations).toBe(1)
    expect(exchange).not.toHaveBeenCalled()
  })

  test('policy wrapper keeps a failed new-account pointer pending, then retries locally with the same operation', async () => {
    storageSuccess = true
    pool.appendClaudeAccount({ ...tokens, accountUuid: 'previous', emailAddress: 'previous@example.com',
      accessToken: 'previous-access', refreshToken: 'previous-refresh' })
    const save = spyOn(config, 'saveGlobalConfig').mockReturnValue(false)
    const lookup = spyOn(profile, 'getOauthProfileFromOauthToken').mockResolvedValue(null)
    const pending = await installOAuthTokensAfterPolicyValidation(tokens, {
      validateOrg: async () => ({ valid: true }), createOperationId: () => 'terminal-local-retry',
    })
    expect(pending).toMatchObject({ valid: true, installation: 'persistence_pending', operationId: 'terminal-local-retry' })
    expect(savedConfig.activeClaudeAccountUuid).toBe('previous')
    if (!pending.valid || pending.installation !== 'persistence_pending' || !pending.retry) throw new Error('Missing local retry')
    save.mockImplementation(update => { savedConfig = update(savedConfig); return true })
    const completed = await pending.retry()
    expect(completed).toEqual({ valid: true, installation: 'committed' })
    expect(savedConfig.activeClaudeAccountUuid).toBe(tokens.tokenAccount.uuid)
    expect(authority.readClaudeAccountAuthority(tokens.tokenAccount.uuid)).toMatchObject({ handle: { generation: 1 } })
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  test.each(['refresh-env', 'browser'] as const)('terminal %s login never prints success or exits zero for pending installation', async mode => {
    const { OAuthService } = await import('../../services/oauth/index.js')
    const oldRefresh = process.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN
    const oldScopes = process.env.CLAUDE_CODE_OAUTH_SCOPES
    const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
    if (mode === 'refresh-env') {
      process.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN = 'synthetic-refresh'
      process.env.CLAUDE_CODE_OAUTH_SCOPES = 'user:inference'
    } else {
      delete process.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN
    }
    const stdout: string[] = [], stderr: string[] = [], exits: number[] = []
    spyOn(process.stdout, 'write').mockImplementation(value => { stdout.push(String(value)); return true })
    spyOn(process.stderr, 'write').mockImplementation(value => { stderr.push(String(value)); return true })
    spyOn(process, 'exit').mockImplementation(code => { exits.push(Number(code)); throw new Error('isolated-cli-exit') })
    spyOn(auth, 'validateForceLoginOrgForToken').mockResolvedValue({ valid: true })
    spyOn(oauth, 'refreshOAuthToken').mockResolvedValue(tokens)
    spyOn(OAuthService.prototype, 'startOAuthFlow').mockResolvedValue(tokens)
    spyOn(pool, 'appendClaudeAccount').mockReturnValue({
      outcome: 'persistence_pending', operationId: 'pending-cli', restartRecoverable: true,
      credentialCommitted: true, selectionCommitted: false,
    })
    try {
      await expect(authLogin({ claudeai: true })).rejects.toThrow('isolated-cli-exit')
      expect(exits.length).toBeGreaterThan(0)
      expect(exits.every(code => code === 1)).toBe(true)
      expect(stdout.join('')).not.toContain('Login successful')
      expect(stderr.join('')).toContain('Retry saving locally without signing in again')
    } finally {
      if (oldRefresh === undefined) delete process.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN
      else process.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN = oldRefresh
      if (oldScopes === undefined) delete process.env.CLAUDE_CODE_OAUTH_SCOPES
      else process.env.CLAUDE_CODE_OAUTH_SCOPES = oldScopes
      if (tty) Object.defineProperty(process.stdin, 'isTTY', tty)
      else delete (process.stdin as { isTTY?: boolean }).isTTY
    }
  })

  test('committed credentials with a failed default pointer retry the same operation without another generation', async () => {
    storageSuccess = true
    pool.appendClaudeAccount({ ...tokens, accountUuid: 'previous', emailAddress: 'previous@example.com',
      accessToken: 'previous-access', refreshToken: 'previous-refresh' })
    const save = spyOn(config, 'saveGlobalConfig').mockReturnValue(false)
    const pending = await installOAuthTokens(tokens, { operationId: 'selection-retry' })
    expect(pending).toMatchObject({ outcome: 'persistence_pending', credentialCommitted: true,
      selectionCommitted: false, operationId: 'selection-retry', handle: { generation: 1 } })
    expect(savedConfig.activeClaudeAccountUuid).toBe('previous')
    pool.resetClaudeAccountPoolForTest()
    pool.setClaudeVaultPathForTest(directory)
    pool.loadClaudePoolForObservation()
    expect(pool.getActiveClaudeAccount()?.accountUuid).toBe('previous')
    save.mockImplementation(update => { savedConfig = update(savedConfig); return true })
    const retried = await installOAuthTokens(tokens, { operationId: 'selection-retry' })
    expect(retried).toMatchObject({ outcome: 'committed', selectionCommitted: true, handle: { generation: 1 } })
    pool.resetClaudeAccountPoolForTest()
    pool.setClaudeVaultPathForTest(directory)
    pool.loadClaudePoolForObservation()
    expect(auth.getClaudeAIOAuthTokens()?.accountUuid).toBe(tokens.tokenAccount.uuid)
  })
  test('committed authority remains usable when secure storage throws', async () => {
    storageThrows = true
    await expect(installOAuthTokens(tokens)).resolves.toMatchObject({ outcome: 'committed', handle: { accountId: tokens.tokenAccount.uuid } })
    expect(pool.getActiveClaudeAccount()?.accessToken).toBe(tokens.accessToken)
    expect(auth.getClaudeAIOAuthTokens()?.accessToken).toBe(tokens.accessToken)
  })
  for (const hasVaultAccount of [false, true]) {
    test(`does not publish mirror-only login when authority fails (existing vault: ${hasVaultAccount})`, async () => {
      storageSuccess = true
      if (hasVaultAccount) {
        pool.appendClaudeAccount({
          ...tokens, accountUuid: 'previous', emailAddress: 'previous@example.com',
          accessToken: 'previous-access', refreshToken: 'previous-refresh',
        })
      }
      const before = structuredClone(stored)
      failVault()
      await expect(installOAuthTokens(tokens)).rejects.toThrow('Failed to save Claude sign-in')
      expect(stored).toEqual(before)
      pool.setClaudeVaultPathForTest(directory)
      pool.loadClaudePoolForObservation()
      expect(pool.getActiveClaudeAccount()?.accountUuid).toBe(hasVaultAccount ? 'previous' : undefined)
    })
  }
  test('rejects when all durable writes fail', async () => {
    failVault()
    await expect(installOAuthTokens(tokens)).rejects.toThrow('Failed to save Claude sign-in')
  })
  test('committed authority is readable despite a stale secure-storage mirror', async () => {
    storageSuccess = true
    staleRead = true
    stored = { claudeAiOauth: { ...tokens, accessToken: 'old-access', refreshToken: 'old-refresh' } }
    expect(auth.saveOAuthTokensIfNeeded(tokens)).toEqual({
      success: false, warning: 'Saved OAuth tokens could not be read back',
    })
    await expect(installOAuthTokens(tokens)).resolves.toMatchObject({ outcome: 'committed' })
    expect(stored?.claudeAiOauth?.accessToken).toBe('old-access')
    expect(auth.getClaudeAIOAuthTokens()?.accessToken).toBe(tokens.accessToken)
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
    failVault()
    await expect(installOAuthTokens(tokens)).rejects.toThrow('Failed to save Claude sign-in')
    pool.setClaudeVaultPathForTest(directory)
    expect(savedConfig).toEqual(previous)
    expect(pool.getActiveClaudeAccount()?.accountUuid).toBe('existing')
    expect(pool.getClaudePoolStatus().accounts).toHaveLength(1)
    expect(oauth.storeOAuthAccountInfo).not.toHaveBeenCalled()
    expect(profile.getOauthProfileFromOauthToken).toHaveBeenCalledWith(tokens.accessToken)
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
