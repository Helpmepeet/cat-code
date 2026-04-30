import { describe, expect, test } from 'bun:test'

import { isLoginDialogCancelActive } from './ConsoleOAuthFlow.js'

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
