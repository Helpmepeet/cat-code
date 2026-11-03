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
