import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import * as auth from './auth.js'
import * as config from './config.js'
import {
  resetClaudeAccountPoolForTest,
  seedClaudeAccountPoolForTest,
  switchToClaudeAccount,
} from '../services/api/claudeAccountPool.js'
import { hasClaudeAiBillingAccess, setMockBillingAccessOverride } from './billing.js'

afterEach(() => {
  auth.clearOAuthTokenCache()
  resetClaudeAccountPoolForTest()
  setMockBillingAccessOverride(null)
  mock.restore()
})

for (const subscriptionType of ['team', 'enterprise']) {
  test(`${subscriptionType} billing follows the selected account's role`, () => {
    spyOn(auth, 'isAnthropicAuthEnabled').mockReturnValue(true)
    spyOn(config, 'getGlobalConfig').mockReturnValue({
      oauthAccount: { accountUuid: 'admin', emailAddress: 'admin@example.com', organizationRole: 'admin' },
    } as ReturnType<typeof config.getGlobalConfig>)
    seedClaudeAccountPoolForTest({
      activeAccountUuid: 'member',
      accounts: ['member', 'admin'].map(role => ({
        accountUuid: role, emailAddress: `${role}@example.com`,
        accessToken: `access-${role}`, refreshToken: `refresh-${role}`,
        expiresAt: Date.now() + 3_600_000, scopes: ['user:inference', 'user:profile'],
        status: 'healthy' as const, subscriptionType, organizationRole: role,
      })),
    })
    auth.clearOAuthTokenCache()
    expect(hasClaudeAiBillingAccess()).toBe(false)
    switchToClaudeAccount('admin', { persistDefault: false })
    expect(hasClaudeAiBillingAccess()).toBe(true)
    switchToClaudeAccount('member', { persistDefault: false })
    expect(hasClaudeAiBillingAccess()).toBe(false)
  })
}

test('individual plans and mock-limit overrides retain their billing behavior', () => {
  spyOn(auth, 'isClaudeAISubscriber').mockReturnValue(true)
  const plan = spyOn(auth, 'getSubscriptionType').mockReturnValue('max')
  expect(hasClaudeAiBillingAccess()).toBe(true)
  plan.mockReturnValue('pro')
  expect(hasClaudeAiBillingAccess()).toBe(true)
  setMockBillingAccessOverride(false)
  expect(hasClaudeAiBillingAccess()).toBe(false)
})
