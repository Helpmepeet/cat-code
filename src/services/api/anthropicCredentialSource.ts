import {
  getAnthropicApiKeyWithSource,
  getAuthTokenSource,
  isClaudeAISubscriber,
} from '../../utils/auth.js'
import { getConfiguredAnthropicProvider } from '../../utils/model/providers.js'
import { hasSelectedStoredClaudeOAuthRoute } from './claudeStoredOAuthRoute.js'

export type AnthropicCredentialSource = {
  kind: 'claude_subscription' | 'environment_api_key' | 'api_key_helper' |
    'bedrock' | 'vertex' | 'foundry' | 'environment_token' |
    'file_descriptor' | 'managed_api_key' | 'none'
  variableName?: string
}

const defaultRouting = {
  getProvider: getConfiguredAnthropicProvider,
  getAuthTokenSource,
  getApiKeySource: () => getAnthropicApiKeyWithSource({ skipRetrievingKeyFromApiKeyHelper: true }),
  isSubscriber: isClaudeAISubscriber,
  hasStoredRoute: hasSelectedStoredClaudeOAuthRoute,
  env: process.env as Readonly<Record<string, string | undefined>>,
}

/** Describes the configured Anthropic route, not credential validity or freshness.
 * Uses source readers only: never executes an API-key helper or refreshes a token.
 * Routing readers can be injected for isolated callers/tests. No values leave this selector.
 */
export function resolveAnthropicCredentialSource(
  routing: typeof defaultRouting = defaultRouting,
): AnthropicCredentialSource {
  const provider = routing.getProvider()
  if (provider !== 'firstParty') return { kind: provider }

  // The client resolves a bound subscription before legacy Console login keys.
  if (routing.hasStoredRoute() || routing.isSubscriber()) {
    const source = routing.getAuthTokenSource().source
    if (source === 'CLAUDE_CODE_OAUTH_TOKEN') {
      return { kind: 'environment_token', variableName: source }
    }
    if (source === 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR') {
      return { kind: 'file_descriptor', variableName: source }
    }
    if (source === 'CCR_OAUTH_TOKEN_FILE') return { kind: 'file_descriptor' }
    return { kind: 'claude_subscription' }
  }

  // configureApiKeyHeaders selects a bearer token before the API-key fallback.
  const token = routing.getAuthTokenSource().source
  if (token === 'ANTHROPIC_AUTH_TOKEN') {
    return { kind: 'environment_token', variableName: token }
  }
  if (token === 'apiKeyHelper') return { kind: 'api_key_helper' }

  const api = routing.getApiKeySource()
  if (api.source === 'apiKeyHelper') return { kind: 'api_key_helper' }
  if (api.source === '/login managed key') return { kind: 'managed_api_key' }
  if (api.source === 'ANTHROPIC_API_KEY') {
    // The legacy reader labels FD keys as ANTHROPIC_API_KEY too. A selected
    // environment key must match the env value; mere presence is insufficient.
    if (routing.env.ANTHROPIC_API_KEY && api.key === routing.env.ANTHROPIC_API_KEY) {
      return { kind: 'environment_api_key', variableName: 'ANTHROPIC_API_KEY' }
    }
    return routing.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
      ? { kind: 'file_descriptor', variableName: 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR' }
      : { kind: 'file_descriptor' }
  }
  return { kind: 'none' }
}
