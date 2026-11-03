import { getAnthropicApiKeyWithSource, getAuthTokenSource, isAnthropicAuthEnabled } from '../../utils/auth.js'
import { getSelectedClaudeAccountIdentity } from './claudeAccountPool.js'

/** A rejected access token does not change the selected account's auth method. */
export function hasSelectedStoredClaudeOAuthRoute(): boolean {
  if (process.env.ANTHROPIC_AUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN ||
      process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR || process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR) return false
  if (!isAnthropicAuthEnabled() || !getSelectedClaudeAccountIdentity()) return false
  const source = getAuthTokenSource().source
  if (source !== 'none' && source !== 'claude.ai') return false
  const apiKey = getAnthropicApiKeyWithSource({ skipRetrievingKeyFromApiKeyHelper: true })
  // Console login keys may outlive a later subscription login. Unlike external
  // keys, their presence does not override a bound Claude OAuth account.
  return apiKey.source === '/login managed key' || (!apiKey.key && apiKey.source === 'none')
}
