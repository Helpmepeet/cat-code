import axios from 'axios'
import http from 'node:http'
import https from 'node:https'
import { logForDebugging } from '../../utils/debug.js'
import { withClaudeCredentialGeneration } from './claudeAccountPool.js'
import { getOauthConfig, OAUTH_BETA_HEADER } from '../../constants/oauth.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getClaudeAIOAuthTokens,
  hasProfileScope,
  isClaudeAISubscriber,
} from '../../utils/auth.js'
import { getAuthHeaders } from '../../utils/http.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'
import { isOAuthTokenExpired } from '../oauth/client.js'

export type RateLimit = {
  utilization: number | null // a percentage from 0 to 100
  resets_at: string | null // ISO 8601 timestamp
}

export type ExtraUsage = {
  is_enabled: boolean
  monthly_limit: number | null
  used_credits: number | null
  utilization: number | null
}

export type Utilization = {
  five_hour?: RateLimit | null
  seven_day?: RateLimit | null
  seven_day_oauth_apps?: RateLimit | null
  seven_day_opus?: RateLimit | null
  seven_day_sonnet?: RateLimit | null
  extra_usage?: ExtraUsage | null
}

/**
 * Read utilization for one specific Claude subscription token, independent of
 * which account is active. Never refreshes the token; callers skip expired ones.
 */
export async function fetchUtilizationForToken(
  accessToken: string,
  credential: { accountUuid: string; lifecycleGeneration: number },
): Promise<Utilization> {
  const response = await axios.get<Utilization>(
    `${getOauthConfig().BASE_API_URL}/api/oauth/usage`,
    {
      // The HTTP adapter may defer after interceptors. Authorize request()
      // itself, not axios.get() or adapter entry. Do not follow redirects with
      // credentials outside this boundary.
      adapter: 'http',
      maxRedirects: 0,
      transport: {
        request(options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) {
          let started: http.ClientRequest | undefined
          try {
            withClaudeCredentialGeneration(
              credential.accountUuid,
              credential.lifecycleGeneration,
              () => {
                started = (options.protocol === 'https:' ? https : http).request(options, callback)
                return started
              },
            )
          } catch (error) {
            // Unlock failure must not turn an already initiated send into a
            // failed attempt that a caller might repeat.
            if (!started) throw error
            logForDebugging(`Claude usage credential lock cleanup failed after send: ${error instanceof Error ? error.message : String(error)}`, { level: 'warn' })
          }
          if (!started) throw new Error('Claude usage credential is no longer available')
          return started
        },
      },
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': getClaudeCodeUserAgent(),
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
      },
      timeout: 5000,
    },
  )
  return response.data
}

export async function fetchUtilization(): Promise<Utilization | null> {
  if (!isClaudeAISubscriber() || !hasProfileScope()) {
    return {}
  }

  // The token can lapse after a long stretch of non-Anthropic requests (e.g.
  // routing everything through gpt-*/Codex), because the Claude-token refresh
  // normally piggybacks on the Anthropic request path. Refresh through the same
  // entry point every other authenticated surface uses (mcp/client,
  // teamMemorySync, policyLimits, voiceStreamSTT) instead of bailing, so /usage
  // self-heals rather than hanging on a stale token.
  const tokens = getClaudeAIOAuthTokens()
  if (tokens && isOAuthTokenExpired(tokens.expiresAt)) {
    await checkAndRefreshOAuthTokenIfNeeded()
    const refreshed = getClaudeAIOAuthTokens()
    if (!refreshed || isOAuthTokenExpired(refreshed.expiresAt)) {
      return null
    }
  }

  const authResult = getAuthHeaders()
  if (authResult.error) {
    throw new Error(`Auth error: ${authResult.error}`)
  }

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': getClaudeCodeUserAgent(),
    ...authResult.headers,
  }

  const url = `${getOauthConfig().BASE_API_URL}/api/oauth/usage`

  const response = await axios.get<Utilization>(url, {
    headers,
    timeout: 5000, // 5 second timeout
  })

  return response.data
}
