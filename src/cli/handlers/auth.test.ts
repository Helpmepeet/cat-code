import { describe, expect, test } from 'bun:test'

import type { OAuthTokens } from '../../services/oauth/types.js'
import {
  installCodexOAuthTokens,
  installOAuthTokensAfterPolicyValidation,
} from './auth.js'

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

describe('installCodexOAuthTokens', () => {
  test('delegates fresh Codex credentials to the lifecycle installer', async () => {
    const calls: Array<{
      accountId: string
      operationId: string
      credentialGeneration?: number
    }> = []

    await installCodexOAuthTokens(
      {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: 1,
        scopes: [],
        subscriptionType: null,
        rateLimitTier: null,
        tokenAccount: { uuid: 'acct-1' },
      },
      {
        createOperationId: () => 'cli-login-operation',
        persistLogin: async (received, options) => {
          calls.push({
            accountId: received.accountId,
            operationId: options.operationId,
            credentialGeneration: received.credentialGeneration,
          })
          return {
            accountId: received.accountId,
            credentialGeneration: 2,
            source: 'config',
          }
        },
      },
    )

    expect(calls).toEqual([
      {
        accountId: 'acct-1',
        operationId: 'cli-login-operation',
        credentialGeneration: undefined,
      },
    ])
  })
})
