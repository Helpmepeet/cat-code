import { describe, expect, test } from 'bun:test'

import { exchangeCodexCode, startCodexCallbackServer } from './codex-client.js'

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${encodedPayload}.signature`
}

describe('Codex OAuth callback page', () => {
  test('extracts the authenticated email from the token response when available', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          access_token: createJwt({
            'https://api.openai.com/auth': { chatgpt_account_id: 'acct_123' },
          }),
          refresh_token: 'refresh-token',
          expires_in: 3600,
          id_token: createJwt({ email: 'person@example.com' }),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as typeof globalThis.fetch

    try {
      const tokens = await exchangeCodexCode('auth-code', 'verifier')
      expect(tokens.accountEmail).toBe('person@example.com')
      expect(tokens.idToken).toBe(createJwt({ email: 'person@example.com' }))
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('shows the authenticated account and close fallback after token exchange', async () => {
    const server = await startCodexCallbackServer('expected-state')

    try {
      const pagePromise = fetch(
        'http://127.0.0.1:1455/auth/callback?code=auth-code&state=expected-state',
      ).then((response) => response.text())

      const callback = await server.waitForCode()
      expect(callback?.code).toBe('auth-code')

      callback?.showComplete?.({
        accountEmail: 'person@example.com',
        accountId: 'acct_123',
      })

      const page = await pagePromise
      expect(page).toContain('person@example.com')
      expect(page).toContain('You can close this tab now.')
    } finally {
      server.close()
    }
  })

  test('does not claim authentication completed if closed before token exchange finishes', async () => {
    const server = await startCodexCallbackServer('expected-state')

    try {
      const pagePromise = fetch(
        'http://127.0.0.1:1455/auth/callback?code=auth-code&state=expected-state',
      ).then((response) => response.text())

      const callback = await server.waitForCode()
      expect(callback?.code).toBe('auth-code')

      server.close()

      const page = await pagePromise
      expect(page).toContain('Return to terminal.')
      expect(page).not.toContain('Authentication complete')
    } finally {
      server.close()
    }
  })

  test('resolves duplicate callback pages when closed before token exchange finishes', async () => {
    const server = await startCodexCallbackServer('expected-state')

    try {
      const firstPagePromise = fetch(
        'http://127.0.0.1:1455/auth/callback?code=auth-code&state=expected-state',
      ).then((response) => response.text())

      const callback = await server.waitForCode()
      expect(callback?.code).toBe('auth-code')

      const secondPagePromise = fetch(
        'http://127.0.0.1:1455/auth/callback?code=auth-code&state=expected-state',
      ).then((response) => response.text())

      await new Promise((resolve) => setTimeout(resolve, 10))
      server.close()

      const pages = await Promise.race([
        Promise.all([firstPagePromise, secondPagePromise]),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('duplicate callback pages did not resolve')), 100)
        }),
      ])

      expect(pages).toEqual(['Return to terminal.', 'Return to terminal.'])
    } finally {
      server.close()
    }
  })
})
