import { clearAuthRelatedCaches } from '../logout/logout.js'
import {
  applyPostCodexAccountSwitchRefresh,
  getPoolStatus,
  removeCodexAccount,
} from '../../services/api/codexAccountPool.js'
import {
  getClaudePoolStatus,
  removeClaudeAccount,
  syncClaudeAccountToStorage,
} from '../../services/api/claudeAccountPool.js'
import {
  reassignCodexLeaseToActiveAccount,
  releaseCodexLease,
} from '../../services/api/codexAccountLeaseManager.js'
import { clearOAuthTokenCache } from '../../utils/auth.js'
import { resetCodexCacheContext } from '../../services/api/codex-fetch-adapter.js'
import { stripSignatureBlocks } from '../../utils/messages.js'
import type { LocalCommandCall } from '../../types/command.js'

function applyPostDeleteAccountStateRefresh(
  context: Parameters<LocalCommandCall>[1],
): void {
  context.onChangeAPIKey()
  context.setMessages(stripSignatureBlocks)
  applyPostCodexAccountSwitchRefresh()
  context.setAppState(prev => ({
    ...prev,
    authVersion: prev.authVersion + 1,
    statusLineRefreshKey: prev.statusLineRefreshKey + 1,
  }))
}

export const call: LocalCommandCall = async (args, context) => {
  const target = args.trim().toLowerCase()
  if (!target) {
    return {
      type: 'text',
      value: 'Usage: /delete-account <id-prefix|alias>\nExample: /delete-account backup2',
    }
  }

  const { accounts: codexAccounts, activeIndex: codexActiveIndex } = getPoolStatus()
  let codexAcct = codexAccounts.find((a) => a.alias?.toLowerCase() === target)
  if (!codexAcct) codexAcct = codexAccounts.find((a) => a.alias?.toLowerCase().startsWith(target))
  if (!codexAcct) codexAcct = codexAccounts.find((a) => a.accountId.toLowerCase().startsWith(target))

  if (codexAcct) {
    if (!codexAcct.vaultFilePath) {
      return {
        type: 'text',
        value: `Account ${codexAcct.alias ?? codexAcct.accountId.slice(0, 12)} is not a vault account and cannot be deleted.`,
      }
    }

    const wasActive = codexAccounts[codexActiveIndex]?.accountId === codexAcct.accountId
    const deletedLabel = codexAcct.alias ?? codexAcct.accountId.slice(0, 12)
    const ok = removeCodexAccount(codexAcct.accountId)
    if (!ok) {
      return { type: 'text', value: 'Failed to delete account. Check logs for details.' }
    }

    if (getPoolStatus().activeIndex >= 0) {
      reassignCodexLeaseToActiveAccount('main-thread')
    } else {
      releaseCodexLease('main-thread')
    }
    resetCodexCacheContext()
    await clearAuthRelatedCaches()
    applyPostDeleteAccountStateRefresh(context)

    const remaining = getPoolStatus()
    const newActive = remaining.activeIndex >= 0 ? remaining.accounts[remaining.activeIndex] : null
    if (wasActive && newActive) {
      const newLabel = newActive.alias ?? newActive.accountId.slice(0, 12)
      return { type: 'text', value: `Deleted ${deletedLabel}. Active Codex account is now ${newLabel}.` }
    }
    if (wasActive) {
      return { type: 'text', value: `Deleted ${deletedLabel}. No Codex accounts remain.` }
    }
    return { type: 'text', value: `Deleted ${deletedLabel}.` }
  }

  const { accounts: claudeAccounts, activeIndex: claudeActiveIndex } = getClaudePoolStatus()
  let claudeAcct = claudeAccounts.find((a) => a.alias?.toLowerCase() === target)
  if (!claudeAcct) claudeAcct = claudeAccounts.find((a) => a.alias?.toLowerCase().startsWith(target))
  if (!claudeAcct) claudeAcct = claudeAccounts.find((a) => a.emailAddress.toLowerCase().startsWith(target))
  if (!claudeAcct) claudeAcct = claudeAccounts.find((a) => a.accountUuid.toLowerCase().startsWith(target))

  if (claudeAcct) {
    if (!claudeAcct.vaultFilePath) {
      return {
        type: 'text',
        value: `Account ${claudeAcct.alias ?? claudeAcct.emailAddress} is not a vault account and cannot be deleted.`,
      }
    }

    const wasActive = claudeAccounts[claudeActiveIndex]?.accountUuid === claudeAcct.accountUuid
    const deletedLabel = claudeAcct.alias ?? claudeAcct.emailAddress
    const ok = removeClaudeAccount(claudeAcct.accountUuid)
    if (!ok) {
      return { type: 'text', value: 'Failed to delete account. Check logs for details.' }
    }

    if (getClaudePoolStatus().activeIndex >= 0) {
      syncClaudeAccountToStorage()
    } else {
      clearOAuthTokenCache()
    }
    await clearAuthRelatedCaches()
    applyPostDeleteAccountStateRefresh(context)

    const remaining = getClaudePoolStatus()
    const newActive = remaining.activeIndex >= 0 ? remaining.accounts[remaining.activeIndex] : null
    if (wasActive && newActive) {
      const newLabel = newActive.alias ?? newActive.emailAddress
      return { type: 'text', value: `Deleted ${deletedLabel}. Active Claude account is now ${newLabel}.` }
    }
    if (wasActive) {
      return { type: 'text', value: `Deleted ${deletedLabel}. No Claude accounts remain.` }
    }
    return { type: 'text', value: `Deleted ${deletedLabel}.` }
  }

  return {
    type: 'text',
    value: `No account matching "${target}". Run /accounts to see available accounts.`,
  }
}
