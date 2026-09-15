import { describe, expect, test } from 'bun:test'

import {
  getCodexAliasPrompt,
  getInitialLoginState,
  isLoginDialogCancelActive,
  persistCodexOAuthLoginFromConsole,
} from './ConsoleOAuthFlow.js'

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
