import { expect, test } from 'bun:test'
import { completeClaudeOAuthControlInstallation, type ClaudeOAuthControlInstallation } from './print.js'
import { installOAuthTokensAfterPolicyValidation } from './handlers/auth.js'
import { ClaudeLoginInstallationError } from '../services/api/claudeAccountAuthority.js'
import type { OAuthTokens } from '../services/oauth/types.js'

const tokens: OAuthTokens = {
  accessToken: 'private-captured-access', refreshToken: 'private-captured-refresh',
  expiresAt: 1, scopes: ['user:inference'], subscriptionType: null, rateLimitTier: null,
}

test.each([false, true])('control completion reports pending, then retries the same captured installation without OAuth (typed error=%s)', async typedError => {
  const operations: string[] = []
  const responses: unknown[] = []
  let selected = 'account-a'
  let successEvents = 0
  let acquisitions = 0
  const acquireAndInstall = async () => {
    acquisitions++
    return installOAuthTokensAfterPolicyValidation(tokens, {
      validateOrg: async () => ({ valid: true }), createOperationId: () => 'original-control-operation',
      installTokens: async (captured, options) => {
        expect(captured).toBe(tokens)
        operations.push(options!.operationId!)
        if (typedError && operations.length === 1) throw new ClaudeLoginInstallationError({
          outcome: 'persistence_pending', operationId: options!.operationId!, restartRecoverable: false,
        })
        if (operations.length > 1) selected = 'account-b'
        return {
          outcome: operations.length === 1 ? 'persistence_pending' : 'committed',
          operationId: options!.operationId!, restartRecoverable: true,
          credentialCommitted: true, selectionCommitted: operations.length > 1,
          handle: { accountId: 'account-b', generation: 1, revision: 0 },
        }
      },
    })
  }
  const attempt: ClaudeOAuthControlInstallation = { flow: acquireAndInstall() }
  const complete = () => completeClaudeOAuthControlInstallation(attempt, () => { successEvents++ }).then(
    () => responses.push({ ok: true, accountId: selected }),
    error => responses.push({ ok: false, message: (error as Error).message }),
  )
  await complete()
  expect(selected).toBe('account-a')
  expect(successEvents).toBe(0)
  expect(responses).toEqual([{ ok: false, message: 'Sign-in is not fully saved. Request completion again to retry saving locally without signing in again.' }])
  await complete()
  expect(responses.at(-1)).toEqual({ ok: true, accountId: 'account-b' })
  expect(operations).toEqual(['original-control-operation', 'original-control-operation'])
  expect(acquisitions).toBe(1)
  expect(successEvents).toBe(1)
  await complete()
  expect(successEvents).toBe(1)
  expect(operations).toHaveLength(2)
  expect(JSON.stringify(responses)).not.toContain(tokens.accessToken)
  expect(JSON.stringify(responses)).not.toContain(tokens.refreshToken)
})

test('overlapping completion requests share one local persistence retry', async () => {
  let attempts = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const attempt: ClaudeOAuthControlInstallation = {
    flow: installOAuthTokensAfterPolicyValidation(tokens, {
      validateOrg: async () => ({ valid: true }),
      installTokens: async (_tokens, options) => {
        attempts++
        if (attempts > 1) await gate
        return { outcome: attempts === 1 ? 'persistence_pending' : 'committed',
          operationId: options!.operationId!, restartRecoverable: true }
      },
    }),
  }
  await expect(completeClaudeOAuthControlInstallation(attempt, () => {})).rejects.toThrow('not fully saved')
  const first = completeClaudeOAuthControlInstallation(attempt, () => {})
  const second = completeClaudeOAuthControlInstallation(attempt, () => {})
  release()
  await Promise.all([first, second])
  expect(attempts).toBe(2)
})

test.each(['policy', 'rejected', 'uncertain'] as const)('control completion never reports success for %s', async outcome => {
  let installations = 0
  let successEvents = 0
  const attempt: ClaudeOAuthControlInstallation = {
    flow: installOAuthTokensAfterPolicyValidation(tokens, {
      validateOrg: async () => outcome === 'policy' ? { valid: false, message: 'Wrong organization.' } : { valid: true },
      installTokens: async (_tokens, options) => {
        installations++
        return { outcome: outcome === 'uncertain' ? 'uncertain' : 'rejected',
          operationId: options!.operationId!, restartRecoverable: false }
      },
    }),
  }
  await expect(completeClaudeOAuthControlInstallation(attempt, () => { successEvents++ })).rejects.toThrow()
  expect(successEvents).toBe(0)
  expect(attempt.retry).toBeUndefined()
  expect(installations).toBe(outcome === 'policy' ? 0 : 1)
})
