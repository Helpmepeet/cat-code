import { describe, expect, test } from 'bun:test'

import type { OAuthTokens } from '../../services/oauth/types.js'
import { installOAuthTokensAfterPolicyValidation } from './auth.js'

const tokens: OAuthTokens = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresAt: 1,
  scopes: ['user:inference'],
}

describe('installOAuthTokensAfterPolicyValidation', () => {
  test('does not install a token rejected by managed organization policy', async () => {
    let installed = false
    const result = await installOAuthTokensAfterPolicyValidation(tokens, {
      validateOrg: async accessToken => {
        expect(accessToken).toBe('access-token')
        return { valid: false, message: 'Wrong organization.' }
      },
      installTokens: async () => {
        installed = true
      },
    })

    expect(result).toEqual({ valid: false, message: 'Wrong organization.' })
    expect(installed).toBe(false)
  })

  test('installs a token only after managed organization policy accepts it', async () => {
    const calls: string[] = []
    const result = await installOAuthTokensAfterPolicyValidation(tokens, {
      validateOrg: async () => {
        calls.push('validate')
        return { valid: true }
      },
      installTokens: async received => {
        expect(received).toBe(tokens)
        calls.push('install')
      },
    })

    expect(result).toEqual({ valid: true })
    expect(calls).toEqual(['validate', 'install'])
  })
})
