import { describe, expect, test } from 'bun:test'

import {
  getCodexAliasPrompt,
  getInitialLoginState,
  isLoginDialogCancelActive,
  persistCodexOAuthLoginFromConsole,
  applyAnthropicLoginInstallation,
} from './ConsoleOAuthFlow.js'
import { installOAuthTokensAfterPolicyValidation } from '../cli/handlers/auth.js'
import { ClaudeLoginInstallationError } from '../services/api/claudeAccountAuthority.js'
import type { OAuthTokens } from '../services/oauth/types.js'

describe('getCodexAliasPrompt', () => {
  test('tells relogin users they can keep the existing account name', () => {
    expect(
      getCodexAliasPrompt(
        [{ accountId: 'acct-1', alias: 'yoxrent' }],
        'acct-1',
      ),
    ).toBe('Already saved as yoxrent. Press Enter to keep this name, or type a new name.')
  })
})

test.each([false, true])('Anthropic UI keeps pending installation local and never notifies success before commit (typed error=%s)', async typedError => {
  const states: Parameters<typeof applyAnthropicLoginInstallation>[1] extends (status: infer T) => void ? T[] : never = []
  let notified = 0
  let installations = 0
  let exchanges = 0
  const tokens: OAuthTokens = {
    accessToken: 'captured-access', refreshToken: 'captured-refresh', expiresAt: 1,
    scopes: ['user:inference'], subscriptionType: null, rateLimitTier: null,
  }
  const acquireAndInstall = async () => {
    exchanges++
    return installOAuthTokensAfterPolicyValidation(tokens, {
      validateOrg: async () => ({ valid: true }), createOperationId: () => 'ui-operation',
      installTokens: async (_tokens, options) => {
        expect(options!.operationId).toBe('ui-operation')
        installations++
        if (typedError && installations === 1) throw new ClaudeLoginInstallationError({
          outcome: 'persistence_pending', operationId: 'ui-operation', restartRecoverable: false,
        })
        return { outcome: installations === 1 ? 'persistence_pending' : 'committed',
          operationId: 'ui-operation', restartRecoverable: true, selectionCommitted: installations > 1 }
      },
    })
  }
  await applyAnthropicLoginInstallation(acquireAndInstall, state => states.push(state), () => { notified++ })
  expect(states.at(-1)).toMatchObject({ state: 'error', toRetry: { state: 'retrying_installation' } })
  expect(notified).toBe(0)
  const pending = states.at(-1)
  if (pending?.state !== 'error' || pending.toRetry?.state !== 'retrying_installation') throw new Error('Missing local retry')
  await applyAnthropicLoginInstallation(pending.toRetry.retry, state => states.push(state), () => { notified++ })
  expect(states.at(-1)).toEqual({ state: 'success', provider: 'anthropic' })
  expect(notified).toBe(1)
  expect(exchanges).toBe(1)
  expect(installations).toBe(2)
})

test('policy rejection never enters the Anthropic success state or notification path', async () => {
  const states: unknown[] = []
  let notifications = 0
  await applyAnthropicLoginInstallation(
    async () => ({ valid: false, message: 'Wrong organization.' }),
    state => states.push(state), () => { notifications++ },
  )
  expect(states).toEqual([{ state: 'error', message: 'Wrong organization.', toRetry: { state: 'idle' } }])
  expect(notifications).toBe(0)
})

describe('persistCodexOAuthLoginFromConsole', () => {
  test('delegates Codex credential installation to the lifecycle path', async () => {
    const calls: Array<{
      accountId: string
      alias?: string
      operationId: string
      credentialGeneration?: number
    }> = []

    await persistCodexOAuthLoginFromConsole(
      {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: 1,
        accountId: 'acct-1',
      },
      'work',
      {
        createOperationId: () => 'console-login-operation',
        persistLogin: async (received, options) => {
          calls.push({
            accountId: received.accountId,
            alias: options.alias,
            operationId: options.operationId,
            credentialGeneration: received.credentialGeneration,
          })
          return {
            accountId: received.accountId,
            credentialGeneration: 4,
            source: 'vault',
          }
        },
      },
    )

    expect(calls).toEqual([
      {
        accountId: 'acct-1',
        alias: 'work',
        operationId: 'console-login-operation',
        credentialGeneration: undefined,
      },
    ])
  })
})

describe('getInitialLoginState', () => {
  test('starts OpenAI-only login directly in the Codex flow', () => {
    expect(getInitialLoginState('login', undefined, true)).toEqual({
      oauthStatus: { state: 'ready_to_start' },
      loginWithClaudeAi: false,
      loginWithCodex: true,
    })
  })

  test('keeps the shared login picker for callers without OpenAI-only mode', () => {
    expect(getInitialLoginState('login', undefined, false)).toEqual({
      oauthStatus: { state: 'idle' },
      loginWithClaudeAi: false,
      loginWithCodex: false,
    })
  })
})

describe('isLoginDialogCancelActive', () => {
  test('disables dialog cancel while alias input is active', () => {
    expect(
      isLoginDialogCancelActive(
        {
          state: 'waiting_for_alias',
          codexTokens: {
            accessToken: 'a',
            refreshToken: 'r',
            expiresAt: 1,
            accountId: 'acct',
          },
        },
        false,
      ),
    ).toBe(false)
  })

  test('disables dialog cancel while manual code input is visible', () => {
    expect(
      isLoginDialogCancelActive(
        { state: 'waiting_for_login', url: 'https://example.com' },
        true,
      ),
    ).toBe(false)
  })

  test('keeps dialog cancel active when no text field is being edited', () => {
    expect(isLoginDialogCancelActive({ state: 'idle' }, false)).toBe(true)
    expect(
      isLoginDialogCancelActive(
        { state: 'waiting_for_login', url: 'https://example.com' },
        false,
      ),
    ).toBe(true)
  })
})
