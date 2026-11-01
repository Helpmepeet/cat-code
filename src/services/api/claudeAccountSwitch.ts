import { clearAuthRelatedCaches } from '../../commands/logout/logout.js'
import { clearOAuthTokenCache } from '../../utils/auth.js'
import { applyPostCodexAccountSwitchRefresh } from './codexAccountPool.js'
import { switchToClaudeAccount, type ClaudePoolAccount } from './claudeAccountPool.js'

/** Switch this process without changing credentials or defaults for other sessions. */
export async function commitClaudeAccountSwitch(
  idPrefix: string | null,
): Promise<ClaudePoolAccount | null> {
  const account = switchToClaudeAccount(idPrefix, { persistDefault: false })
  if (!account) return null
  clearOAuthTokenCache()
  await clearAuthRelatedCaches({ persistConfig: false })
  applyPostCodexAccountSwitchRefresh()
  return account
}
