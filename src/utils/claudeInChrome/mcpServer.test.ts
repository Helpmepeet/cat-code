import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import * as auth from '../auth.js'
import * as config from '../config.js'
import * as debug from '../debug.js'
import * as growthbook from '../../services/analytics/growthbook.js'
import {
  resetClaudeAccountPoolForTest,
  seedClaudeAccountPoolForTest,
  switchToClaudeAccount,
} from '../../services/api/claudeAccountPool.js'
import { createChromeContext } from './mcpServer.js'

afterEach(() => {
  auth.clearOAuthTokenCache()
  resetClaudeAccountPoolForTest()
  mock.restore()
})

test('Chrome bridge identity and token follow local selection without adopting shared identity', async () => {
  spyOn(auth, 'isAnthropicAuthEnabled').mockReturnValue(true)
  spyOn(growthbook, 'getFeatureValue_CACHED_MAY_BE_STALE').mockReturnValue(true)
  spyOn(debug, 'logForDebugging').mockImplementation(() => {})
  const shared = {
    oauthAccount: { accountUuid: 'b', emailAddress: 'b@example.com' },
  } as ReturnType<typeof config.getGlobalConfig>
  spyOn(config, 'getGlobalConfig').mockReturnValue(shared)
  seedClaudeAccountPoolForTest({
    activeAccountUuid: 'a',
    accounts: ['a', 'b'].map(id => ({
      accountUuid: id, emailAddress: `${id}@example.com`,
      accessToken: `access-${id}`, refreshToken: `refresh-${id}`,
      expiresAt: Date.now() + 3_600_000, scopes: ['user:inference', 'user:profile'],
      status: 'healthy' as const,
    })),
  })
  auth.clearOAuthTokenCache()
  const bridge = createChromeContext().bridgeConfig!
  expect(await bridge.getUserId()).toBe('a')
  expect(await bridge.getOAuthToken()).toBe('access-a')
  switchToClaudeAccount('b', { persistDefault: false })
  expect(await bridge.getUserId()).toBe('b')
  expect(await bridge.getOAuthToken()).toBe('access-b')
  expect(shared.oauthAccount?.accountUuid).toBe('b')
  resetClaudeAccountPoolForTest()
  seedClaudeAccountPoolForTest({ accounts: [], activeAccountUuid: undefined })
  // No authenticated account must not be labeled with a leftover shared profile.
  spyOn(auth, 'getClaudeAIOAuthTokens').mockReturnValue(null)
  spyOn(auth, 'getOauthAccountInfo').mockReturnValue(undefined)
  expect(await bridge.getUserId()).toBeUndefined()
  expect(await bridge.getOAuthToken()).toBe('')
})
