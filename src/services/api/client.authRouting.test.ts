import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import * as auth from '../../utils/auth.js'
import * as providers from '../../utils/model/providers.js'
import * as debug from '../../utils/debug.js'
import * as http from '../../utils/http.js'
import * as credentialUse from './claudeCredentialUse.js'
import * as pool from './claudeAccountPool.js'
import { getAnthropicClient } from './client.js'

const envKeys = ['ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_BASE_URL'] as const
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))

describe('request-local Claude OAuth preparation', () => {
  beforeEach(() => {
    for (const key of envKeys) delete process.env[key]
    spyOn(debug, 'logForDebugging').mockImplementation(() => {})
    spyOn(http, 'getUserAgent').mockReturnValue('test-agent')
    spyOn(auth, 'isClaudeAISubscriber').mockReturnValue(true)
    spyOn(auth, 'getClaudeAIOAuthTokens').mockReturnValue({
      accessToken: 'test-access', refreshToken: 'test-refresh',
      expiresAt: Date.now() + 3_600_000, scopes: ['user:inference'],
    } as never)
    spyOn(auth, 'getAnthropicApiKey').mockReturnValue('test-key')
    spyOn(auth, 'isAnthropicAuthEnabled').mockReturnValue(true)
    spyOn(auth, 'getAnthropicApiKeyWithSource').mockReturnValue({ key: null, source: 'none' })
    spyOn(pool, 'getSelectedClaudeAccountIdentity').mockReturnValue({ accountId: 'test-account', generation: 2 })
    spyOn(auth, 'getAuthTokenSource').mockReturnValue({ source: 'claude.ai', hasToken: true })
    spyOn(auth, 'prepareClaudeOAuthRequest').mockResolvedValue({
      status: 'ready', handle: { accountId: 'test-account', generation: 2, revision: 3 },
      credentials: { accessToken: 'test-access', refreshToken: 'test-refresh', expiresAt: Date.now() + 3_600_000 },
    })
    spyOn(credentialUse, 'createClaudeCredentialFetch').mockImplementation(fetch => fetch)
    spyOn(auth, 'getApiKeyFromApiKeyHelper').mockResolvedValue(null)
  })

  afterEach(() => {
    mock.restore()
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
  })

  test('explicit API key does not refresh or select unrelated Claude OAuth', async () => {
    const client = await getAnthropicClient({ maxRetries: 0, provider: 'firstParty', apiKey: 'explicit-key' })
    expect(client.apiKey).toBe('explicit-key')
    expect(client.authToken).toBeNull()
    expect(auth.prepareClaudeOAuthRequest).not.toHaveBeenCalled()
    expect(auth.getClaudeAIOAuthTokens).not.toHaveBeenCalled()
  })

  test('custom Authorization does not refresh Claude OAuth', async () => {
    process.env.ANTHROPIC_CUSTOM_HEADERS = 'Authorization: Bearer external-token'
    const client = await getAnthropicClient({ maxRetries: 0, provider: 'firstParty' })
    expect(client.authToken).toBeNull()
    expect(auth.prepareClaudeOAuthRequest).not.toHaveBeenCalled()
  })

  test('a third-party endpoint never prepares Claude OAuth', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://example.invalid'
    const client = await getAnthropicClient({ maxRetries: 0, provider: 'firstParty' })
    expect(client.authToken).toBeNull()
    expect(auth.prepareClaudeOAuthRequest).not.toHaveBeenCalled()
  })

  test.each([
    'waiting', 'temporarily_unavailable', 'persistence_pending',
    'refresh_uncertain', 'sign_in_required', 'older_login',
  ] as const)('%s preparation blocks client construction', async status => {
    spyOn(auth, 'prepareClaudeOAuthRequest').mockResolvedValue({ status })
    await expect(getAnthropicClient({ maxRetries: 0, provider: 'firstParty' })).rejects.toThrow()
    expect(auth.prepareClaudeOAuthRequest).toHaveBeenCalledTimes(1)
  })

  test('ready preparation permits a Claude OAuth client', async () => {
    const client = await getAnthropicClient({ maxRetries: 0, provider: 'firstParty' })
    expect(client.authToken).toBe('test-access')
    expect(auth.prepareClaudeOAuthRequest).toHaveBeenCalledTimes(1)
    expect(credentialUse.createClaudeCredentialFetch).toHaveBeenCalledWith(
      globalThis.fetch, 'test-account', 2, 3,
    )
  })

  test('explicit OAuth tokens are used without refreshing an unrelated saved login', async () => {
    spyOn(auth, 'getAuthTokenSource').mockReturnValue({ source: 'CLAUDE_CODE_OAUTH_TOKEN', hasToken: true })
    const client = await getAnthropicClient({ maxRetries: 0, provider: 'firstParty' })
    expect(client.authToken).toBe('test-access')
    expect(auth.prepareClaudeOAuthRequest).not.toHaveBeenCalled()
  })

  test.each([
    'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CCR_OAUTH_TOKEN_FILE',
    'ANTHROPIC_AUTH_TOKEN', 'apiKeyHelper',
  ] as const)('%s does not prepare the selected stored login', async source => {
    spyOn(auth, 'getAuthTokenSource').mockReturnValue({ source, hasToken: true })
    await getAnthropicClient({ maxRetries: 0, provider: 'firstParty' })
    expect(auth.prepareClaudeOAuthRequest).not.toHaveBeenCalled()
  })

  test('an API-key helper source without a cached key never prepares stored OAuth', async () => {
    spyOn(auth, 'getAnthropicApiKeyWithSource').mockReturnValue({ key: null, source: 'apiKeyHelper' })
    await getAnthropicClient({ maxRetries: 0, provider: 'firstParty' })
    expect(auth.prepareClaudeOAuthRequest).not.toHaveBeenCalled()
  })

  test('GPT model routing bypasses Claude preparation even inside a Claude session', async () => {
    spyOn(providers, 'resolveRequestProvider').mockReturnValue('openai')
    // Abort before Codex resolution: no credentials or network are needed to
    // establish that the request did not enter Claude preparation.
    const pool = await import('./codexAccountPool.js')
    spyOn(pool, 'poolManagesCredentials').mockReturnValue(false)
    spyOn(pool, 'loadConfigAccount').mockReturnValue(null)
    await expect(getAnthropicClient({ maxRetries: 0, model: 'gpt-6.1-sol', provider: 'firstParty' })).rejects.toThrow()
    expect(auth.prepareClaudeOAuthRequest).not.toHaveBeenCalled()
    expect(auth.isClaudeAISubscriber).not.toHaveBeenCalled()
    expect(auth.getApiKeyFromApiKeyHelper).not.toHaveBeenCalled()
  })
})
