import { afterEach, describe, expect, mock, test } from 'bun:test'

// fetchUtilization used to bail to `null` the moment the Claude OAuth token was
// expired, without attempting a refresh. These tests pin the service behavior:
// expired tokens are refreshed through the shared entry point, and null is only
// returned if the refresh genuinely fails.

const NOW = Date.now()
const EXPIRED = NOW - 1000
const FRESH = NOW + 60 * 60 * 1000 // well beyond the 5-minute expiry buffer

let subscriber = true
let profileScope = true
let tokenQueue: Array<{ expiresAt: number } | null> = []
let refreshCalls = 0
const axiosGet =
  mock<(url: string, opts: unknown) => Promise<{ data: unknown }>>()

async function installMocks() {
  const actualAuth = await import('../../utils/auth.js')
  await mock.module('src/utils/auth.js', () => ({
    ...actualAuth,
    isClaudeAISubscriber: () => subscriber,
    hasProfileScope: () => profileScope,
    getClaudeAIOAuthTokens: () =>
      tokenQueue.length > 1 ? tokenQueue.shift() : tokenQueue[0],
    checkAndRefreshOAuthTokenIfNeeded: async () => {
      refreshCalls++
      return true
    },
  }))
  await mock.module('src/utils/http.js', () => ({
    getAuthHeaders: () => ({ headers: {} }),
  }))
  await mock.module('src/utils/userAgent.js', () => ({
    getClaudeCodeUserAgent: () => 'test-agent',
  }))
  await mock.module('src/constants/oauth.js', () => ({
    getOauthConfig: () => ({ BASE_API_URL: 'https://example.test' }),
  }))
  await mock.module('axios', () => ({ default: { get: axiosGet } }))
}

afterEach(() => {
  mock.restore()
  subscriber = true
  profileScope = true
  tokenQueue = []
  refreshCalls = 0
  axiosGet.mockReset()
})

describe('fetchUtilization expired-token handling', () => {
  test('refreshes an expired token and proceeds instead of returning null', async () => {
    // First read: expired. After refresh: fresh. Then axios should run.
    tokenQueue = [{ expiresAt: EXPIRED }, { expiresAt: FRESH }]
    axiosGet.mockResolvedValue({ data: { five_hour: null } })
    await installMocks()

    const { fetchUtilization } = await import('./usage.js')
    const result = await fetchUtilization()

    expect(refreshCalls).toBe(1)
    expect(axiosGet).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ five_hour: null })
  })

  test('returns null (not a hang) when refresh cannot produce a usable token', async () => {
    // Expired before AND after refresh: refresh was attempted but failed.
    tokenQueue = [{ expiresAt: EXPIRED }]
    await installMocks()

    const { fetchUtilization } = await import('./usage.js')
    const result = await fetchUtilization()

    expect(refreshCalls).toBe(1)
    expect(axiosGet).not.toHaveBeenCalled()
    expect(result).toBeNull()
  })

  test('does not attempt a refresh when the token is already fresh', async () => {
    tokenQueue = [{ expiresAt: FRESH }]
    axiosGet.mockResolvedValue({ data: { seven_day: null } })
    await installMocks()

    const { fetchUtilization } = await import('./usage.js')
    const result = await fetchUtilization()

    expect(refreshCalls).toBe(0)
    expect(axiosGet).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ seven_day: null })
  })
})
