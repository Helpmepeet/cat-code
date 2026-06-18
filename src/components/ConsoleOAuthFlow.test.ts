import { describe, expect, test } from 'bun:test'

import {
  getCodexAliasPrompt,
  isLoginDialogCancelActive,
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
