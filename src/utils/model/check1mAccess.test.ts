import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import * as auth from '../auth.js'
import * as config from '../config.js'
import * as context from '../context.js'
import {
  resetClaudeAccountPoolForTest,
  seedClaudeAccountPoolForTest,
  switchToClaudeAccount,
} from '../../services/api/claudeAccountPool.js'
import { checkOpus1mAccess, checkSonnet1mAccess } from './check1mAccess.js'

afterEach(() => {
  auth.clearOAuthTokenCache()
  resetClaudeAccountPoolForTest()
  mock.restore()
})

for (const check of [checkOpus1mAccess, checkSonnet1mAccess]) {
  test(`${check.name} uses selected-account provisioning, not another account's cache`, () => {
    spyOn(auth, 'isAnthropicAuthEnabled').mockReturnValue(true)
    spyOn(context, 'is1mContextDisabled').mockReturnValue(false)
    const shared = { cachedExtraUsageDisabledReason: 'overage_not_provisioned' } as ReturnType<typeof config.getGlobalConfig>
    spyOn(config, 'getGlobalConfig').mockImplementation(() => shared)
    seedClaudeAccountPoolForTest({
      activeAccountUuid: 'a',
      accounts: [false, true].map((enabled, index) => ({
        accountUuid: index === 0 ? 'a' : 'b',
        emailAddress: `${index}@example.com`,
        accessToken: `access-${index}`, refreshToken: `refresh-${index}`,
        expiresAt: Date.now() + 3_600_000, scopes: ['user:inference', 'user:profile'],
        status: 'healthy' as const, hasExtraUsageEnabled: enabled,
      })),
    })
    auth.clearOAuthTokenCache()
    expect(check()).toBe(false)
    switchToClaudeAccount('b', { persistDefault: false })
    expect(check()).toBe(true)
    shared.cachedExtraUsageDisabledReason = null
    switchToClaudeAccount('a', { persistDefault: false })
    expect(check()).toBe(false)
  })

  test(`${check.name} preserves the context-disable override and non-subscriber access`, () => {
    spyOn(auth, 'isClaudeAISubscriber').mockReturnValue(false)
    const disabled = spyOn(context, 'is1mContextDisabled').mockReturnValue(false)
    expect(check()).toBe(true)
    disabled.mockReturnValue(true)
    expect(check()).toBe(false)
  })
}
