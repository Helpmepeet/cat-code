import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import axios from 'axios'
import * as auth from '../../utils/auth.js'
import * as providers from '../../utils/model/providers.js'
import * as userAgent from '../../utils/userAgent.js'
import * as debug from '../../utils/debug.js'
import * as pool from '../api/claudeAccountPool.js'
import { loadRemoteManagedSettings, stopBackgroundPolling } from './index.js'
import { resetSyncCache, isRemoteManagedSettingsEligible, refreshRemoteManagedSettingsEligibility } from './syncCache.js'
import * as cache from './syncCacheState.js'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const configDir = mkdtempSync(join(tmpdir(), 'remote-settings-auth-routing-'))
process.env.CLAUDE_CONFIG_DIR = configDir

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

describe('remote settings request auth selection', () => {
  beforeEach(() => {
    resetSyncCache()
    spyOn(providers, 'getAPIProvider').mockReturnValue('firstParty')
    spyOn(providers, 'isFirstPartyAnthropicBaseUrl').mockReturnValue(true)
    spyOn(auth, 'getAnthropicApiKeyWithSource').mockReturnValue({ key: 'test-key', source: 'ANTHROPIC_API_KEY' } as never)
    spyOn(auth, 'getClaudeAIOAuthTokens').mockReturnValue({ accessToken: 'test-oauth', scopes: ['user:inference'], subscriptionType: 'team' } as never)
    spyOn(auth, 'prepareClaudeOAuthRequest').mockResolvedValue({ status: 'waiting' })
    spyOn(auth, 'getAuthTokenSource').mockReturnValue({ source: 'claude.ai', hasToken: true })
    spyOn(auth, 'isAnthropicAuthEnabled').mockReturnValue(true)
    spyOn(pool, 'getSelectedClaudeAccountIdentity').mockReturnValue({ accountId: 'test-account', generation: 2 })
    spyOn(cache, 'getRemoteManagedSettingsSyncFromCache').mockReturnValue({})
    spyOn(userAgent, 'getClaudeCodeUserAgent').mockReturnValue('test-agent')
    spyOn(debug, 'logForDebugging').mockImplementation(() => {})
    spyOn(axios, 'get').mockResolvedValue({ status: 304 })
  })
  afterEach(() => { stopBackgroundPolling(); resetSyncCache(); mock.restore() })

  test('API key requests never prepare unrelated Claude OAuth', async () => {
    await loadRemoteManagedSettings()
    expect(auth.prepareClaudeOAuthRequest).not.toHaveBeenCalled()
    expect(axios.get).toHaveBeenCalledTimes(1)
    expect((axios.get as any).mock.calls[0][1].headers['x-api-key']).toBe('test-key')
  })

  test.each(['openai', 'bedrock', 'vertex', 'foundry'] as const)('%s skips refresh and send', async provider => {
    spyOn(providers, 'getAPIProvider').mockReturnValue(provider)
    await loadRemoteManagedSettings()
    expect(auth.prepareClaudeOAuthRequest).not.toHaveBeenCalled()
    expect(axios.get).not.toHaveBeenCalled()
  })

  test('a custom endpoint skips refresh and send', async () => {
    spyOn(providers, 'isFirstPartyAnthropicBaseUrl').mockReturnValue(false)
    await loadRemoteManagedSettings()
    expect(auth.prepareClaudeOAuthRequest).not.toHaveBeenCalled()
    expect(axios.get).not.toHaveBeenCalled()
  })

  test('settled route rechecks eligibility without discarding cached security settings', () => {
    const cachedSettings = { permissions: { deny: ['Bash(rm:*)'] } }
    cache.setSessionCache(cachedSettings)
    spyOn(providers, 'getAPIProvider').mockReturnValue('openai')
    expect(isRemoteManagedSettingsEligible()).toBe(false)
    spyOn(providers, 'getAPIProvider').mockReturnValue('firstParty')
    expect(refreshRemoteManagedSettingsEligibility()).toBe(true)
    // Observe the real leaf selector rather than the fetch fixture.
    spyOn(cache, 'getRemoteManagedSettingsSyncFromCache').mockRestore()
    expect(cache.getRemoteManagedSettingsSyncFromCache()).toBe(cachedSettings)
  })

  test.each(['waiting', 'temporarily_unavailable', 'persistence_pending', 'refresh_uncertain', 'sign_in_required', 'older_login'] as const)('%s OAuth preparation prevents send', async status => {
    spyOn(auth, 'getAnthropicApiKeyWithSource').mockReturnValue({ key: null, source: 'none' } as never)
    spyOn(auth, 'getClaudeAIOAuthTokens').mockReturnValue(null)
    spyOn(auth, 'getAuthTokenSource').mockReturnValue({ source: 'none', hasToken: false })
    spyOn(auth, 'prepareClaudeOAuthRequest').mockResolvedValue({ status })
    await loadRemoteManagedSettings()
    expect(auth.prepareClaudeOAuthRequest).toHaveBeenCalledTimes(1)
    expect(axios.get).not.toHaveBeenCalled()
  })
})
