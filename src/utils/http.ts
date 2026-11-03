/**
 * HTTP utility constants and helpers
 */

import axios from 'axios'
import http from 'node:http'
import https from 'node:https'
import {
  captureClaudeCredentialHandle, readClaudeAccountAuthority, withClaudeCredentialSend,
  type ClaudeCredentialHandle,
} from '../services/api/claudeAccountAuthority.js'
import { OAUTH_BETA_HEADER } from '../constants/oauth.js'
import {
  getAnthropicApiKey,
  getClaudeAIOAuthTokens,
  recoverOAuth401Error,
  isClaudeAISubscriber,
} from './auth.js'
import { getClaudeCodeUserAgent } from './userAgent.js'
import { getWorkload } from './workloadContext.js'

// WARNING: We rely on `claude-cli` in the user agent for log filtering.
// Please do NOT change this without making sure that logging also gets updated!
export function getUserAgent(): string {
  const agentSdkVersion = process.env.CLAUDE_AGENT_SDK_VERSION
    ? `, agent-sdk/${process.env.CLAUDE_AGENT_SDK_VERSION}`
    : ''
  // SDK consumers can identify their app/library via CLAUDE_AGENT_SDK_CLIENT_APP
  // e.g., "my-app/1.0.0" or "my-library/2.1"
  const clientApp = process.env.CLAUDE_AGENT_SDK_CLIENT_APP
    ? `, client-app/${process.env.CLAUDE_AGENT_SDK_CLIENT_APP}`
    : ''
  // Turn-/process-scoped workload tag for cron-initiated requests. 1P-only
  // observability — proxies strip HTTP headers; QoS routing uses cc_workload
  // in the billing-header attribution block instead (see constants/system.ts).
  // getAnthropicClient (client.ts:98) calls this per-request inside withRetry,
  // so the read picks up the same setWorkload() value as getAttributionHeader.
  const workload = getWorkload()
  const workloadSuffix = workload ? `, workload/${workload}` : ''
  return `claude-cli/${MACRO.VERSION} (${process.env.USER_TYPE}, ${process.env.CLAUDE_CODE_ENTRYPOINT ?? 'cli'}${agentSdkVersion}${clientApp}${workloadSuffix})`
}

export function getMCPUserAgent(): string {
  const parts: string[] = []
  if (process.env.CLAUDE_CODE_ENTRYPOINT) {
    parts.push(process.env.CLAUDE_CODE_ENTRYPOINT)
  }
  if (process.env.CLAUDE_AGENT_SDK_VERSION) {
    parts.push(`agent-sdk/${process.env.CLAUDE_AGENT_SDK_VERSION}`)
  }
  if (process.env.CLAUDE_AGENT_SDK_CLIENT_APP) {
    parts.push(`client-app/${process.env.CLAUDE_AGENT_SDK_CLIENT_APP}`)
  }
  const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : ''
  return `claude-code/${MACRO.VERSION}${suffix}`
}

// User-Agent for WebFetch requests to arbitrary sites. `Claude-User` is
// Anthropic's publicly documented agent for user-initiated fetches (what site
// operators match in robots.txt); the claude-code suffix lets them distinguish
// local CLI traffic from claude.ai server-side fetches.
export function getWebFetchUserAgent(): string {
  return `Claude-User (${getClaudeCodeUserAgent()}; +https://support.anthropic.com/)`
}

export type AuthHeaders = {
  headers: Record<string, string>
  error?: string
  credential?: Readonly<{ accessToken: string; handle: ClaudeCredentialHandle }>
  requestConfig?: { maxRedirects: number; transport: unknown }
}

export function getOAuthAuthHeaders(tokens: { accessToken: string; accountUuid?: string }): AuthHeaders {
  const handle = tokens.accountUuid ? captureClaudeCredentialHandle(tokens.accountUuid, tokens.accessToken) : null
  const auth: AuthHeaders = {
    headers: { Authorization: `Bearer ${tokens.accessToken}`, 'anthropic-beta': OAUTH_BETA_HEADER },
  }
  if (handle) auth.credential = Object.freeze({ accessToken: tokens.accessToken, handle })
  return auth
}

/**
 * Get authentication headers for API requests
 * Returns either OAuth headers for Max/Pro users or API key headers for regular users
 */
export function getAuthHeaders(): AuthHeaders {
  if (isClaudeAISubscriber()) {
    const oauthTokens = getClaudeAIOAuthTokens()
    if (!oauthTokens?.accessToken) {
      return {
        headers: {},
        error: 'No OAuth token available',
      }
    }
    return getOAuthAuthHeaders(oauthTokens)
  }
  // TODO: this will fail if the API key is being set to an LLM Gateway key
  // should we try to query keychain / credentials for a valid Anthropic key?
  const apiKey = getAnthropicApiKey()
  if (!apiKey) {
    return {
      headers: {},
      error: 'No API key available',
    }
  }
  return {
    headers: {
      'x-api-key': apiKey,
    },
  }
}

/**
 * Wrapper that handles OAuth 401 errors by force-refreshing the token and
 * retrying once. Addresses clock drift scenarios where the local expiration
 * check disagrees with the server.
 *
 * Each attempt receives its bound headers and physical-send configuration.
 * Callers must use these rather than resolving another credential in the closure.
 *
 * Note: bridgeApi.ts has its own DI-injected version — handleOAuth401Error
 * transitively pulls in config.ts (~1300 modules), which breaks the SDK bundle.
 *
 * @param opts.also403Revoked - Also retry on 403 with "OAuth token has been
 *   revoked" body (some endpoints signal revocation this way instead of 401).
 */
export async function withOAuth401Retry<T>(
  request: (auth: AuthHeaders) => Promise<T>,
  opts?: { also403Revoked?: boolean; getAuthHeaders?: () => AuthHeaders },
): Promise<T> {
  const attempt = (auth: AuthHeaders) => {
    const credential = auth.credential
    if (credential) {
      auth.requestConfig = {
        maxRedirects: 0,
        transport: {
          request(options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) {
            const headers = options.headers as Record<string, unknown> | undefined
            const bearer = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'authorization')?.[1]
            if (bearer !== `Bearer ${credential.accessToken}`) throw new Error('OAuth request credential changed before send')
            const started = withClaudeCredentialSend(credential.handle, () =>
              (options.protocol === 'https:' ? https : http).request(options, callback))
            if (!started) throw new Error('OAuth request credential is no longer available')
            return started
          },
        },
      }
    }
    return request(auth)
  }
  const sent = (opts?.getAuthHeaders ?? getAuthHeaders)()
  const failed = sent.credential ? Object.freeze({
    accessToken: sent.credential.accessToken,
    handle: Object.freeze({ ...sent.credential.handle }),
  }) : undefined
  try {
    return await attempt(sent)
  } catch (err) {
    if (!axios.isAxiosError(err)) throw err
    const status = err.response?.status
    const isAuthError =
      status === 401 ||
      (opts?.also403Revoked &&
        status === 403 &&
        typeof err.response?.data === 'string' &&
        err.response.data.includes('OAuth token has been revoked'))
    if (!isAuthError) throw err
    if (!failed) throw err
    const rejectedHeader = err.config?.headers?.get?.('Authorization') ??
      (err.config?.headers as Record<string, unknown> | undefined)?.Authorization
    if (rejectedHeader !== `Bearer ${failed.accessToken}`) throw err
    const recovered = await recoverOAuth401Error(failed.accessToken, failed.handle.accountId, failed.handle)
    if (recovered.status !== 'refreshed' && recovered.status !== 'adopted_newer') throw err
    const successor = readClaudeAccountAuthority(failed.handle.accountId)
    if (successor.status !== 'ready' || successor.handle.generation !== failed.handle.generation ||
        successor.handle.revision <= failed.handle.revision || !successor.record.credentials) throw err
    return await attempt({
      headers: {
        Authorization: `Bearer ${successor.record.credentials.accessToken}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
      },
      credential: Object.freeze({ accessToken: successor.record.credentials.accessToken, handle: successor.handle }),
    })
  }
}
