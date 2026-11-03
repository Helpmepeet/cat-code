import { describe, expect, test } from 'bun:test'

import type { OAuthTokens } from '../../services/oauth/types.js'
import { ClaudeLoginInstallationError } from '../../services/api/claudeAccountAuthority.js'
import {
  installCodexOAuthTokens,
  installOAuthTokensAfterPolicyValidation,
  finishTerminalOAuthInstallation,
} from './auth.js'

const tokens: OAuthTokens = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresAt: 1,
  scopes: ['user:inference'],
}

describe('installOAuthTokensAfterPolicyValidation', () => {
  test.each(['persistence_pending', 'rejected'] as const)('typed precommit %s receipt retains its classification', async outcome => {
    const result = await installOAuthTokensAfterPolicyValidation(tokens, {
      validateOrg: async () => ({ valid: true }), createOperationId: () => 'captured-precommit',
      installTokens: async () => { throw new ClaudeLoginInstallationError({
        outcome, operationId: 'captured-precommit', restartRecoverable: false,
      }) },
    })
    expect(result).toMatchObject({ valid: true, installation: outcome, operationId: 'captured-precommit' })
    if (!result.valid || result.installation === 'committed') throw new Error('Unexpected installation success')
    expect(typeof result.retry).toBe(outcome === 'persistence_pending' ? 'function' : 'undefined')
  })

  test.each(['profile', 'policy', 'foreign-operation'] as const)('does not turn %s errors into pending installation', async failure => {
    const error = failure === 'foreign-operation'
      ? new ClaudeLoginInstallationError({ outcome: 'persistence_pending', operationId: 'another-operation', restartRecoverable: true })
      : new Error(`${failure} failed`)
    await expect(installOAuthTokensAfterPolicyValidation(tokens, {
      validateOrg: async () => {
        if (failure === 'policy') throw error
        return { valid: true }
      },
      createOperationId: () => 'original-operation',
      installTokens: async () => { throw error },
    })).rejects.toBe(error)
  })

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

    expect(result).toEqual({ valid: true, installation: 'committed' })
    expect(calls).toEqual(['validate', 'install'])
  })

  test('pending installation retains captured tokens and operation for local retry', async () => {
    const calls: string[] = []
    let validations = 0
    const result = await installOAuthTokensAfterPolicyValidation(tokens, {
      validateOrg: async () => { validations++; return { valid: true } },
      createOperationId: () => 'captured-operation',
      installTokens: async (received, options) => {
        expect(received).toBe(tokens)
        calls.push(options!.operationId!)
        return {
          outcome: calls.length === 1 ? 'persistence_pending' : 'committed',
          operationId: options!.operationId!, restartRecoverable: true,
          credentialCommitted: true, selectionCommitted: calls.length > 1,
        }
      },
    })
    expect(result).toMatchObject({ valid: true, installation: 'persistence_pending', operationId: 'captured-operation' })
    expect(await finishTerminalOAuthInstallation(result, async () => false)).toBe(result)
    const completed = await finishTerminalOAuthInstallation(result, async () => true)
    expect(completed).toEqual({ valid: true, installation: 'committed' })
    expect(calls).toEqual(['captured-operation', 'captured-operation'])
    expect(validations).toBe(1)
  })

  test('a new OAuth acquisition has a fresh operation, not account-ID reuse', async () => {
    const operations: string[] = []
    for (let i = 0; i < 2; i++) {
      await installOAuthTokensAfterPolicyValidation(tokens, {
        validateOrg: async () => ({ valid: true }),
        installTokens: async (_tokens, options) => { operations.push(options!.operationId!) },
      })
    }
    expect(new Set(operations).size).toBe(2)
  })

  test.each(['uncertain', 'rejected'] as const)('unresolved %s installation never becomes terminal success', async outcome => {
    const result = await installOAuthTokensAfterPolicyValidation(tokens, {
      validateOrg: async () => ({ valid: true }),
      installTokens: async () => ({ outcome, operationId: 'unresolved', restartRecoverable: false }),
    })
    expect(result).toMatchObject({ valid: true, installation: outcome })
    expect(await finishTerminalOAuthInstallation(result, async () => { throw new Error('Must not retry a rejected operation') })).toBe(result)
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
