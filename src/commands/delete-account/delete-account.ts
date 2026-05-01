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

function findCodexMatch(target: string) {
  const { accounts } = getPoolStatus()
  const exact = accounts.find(
    (a) => a.alias?.toLowerCase() === target || a.accountId.toLowerCase() === target,
  )
  if (exact) return { match: exact, ambiguous: false }

  const byAlias = accounts.filter((a) => a.alias?.toLowerCase().startsWith(target))
  if (byAlias.length > 1) return { match: null, ambiguous: true, matches: byAlias.map((a) => a.alias ?? a.accountId.slice(0, 12)) }
  if (byAlias.length === 1) return { match: byAlias[0]!, ambiguous: false }

  const byId = accounts.filter((a) => a.accountId.toLowerCase().startsWith(target))
  if (byId.length > 1) return { match: null, ambiguous: true, matches: byId.map((a) => a.alias ?? a.accountId.slice(0, 12)) }
  if (byId.length === 1) return { match: byId[0]!, ambiguous: false }

  return null
}

function findClaudeMatch(target: string) {
  const { accounts } = getClaudePoolStatus()
  const exact = accounts.find(
    (a) =>
      a.alias?.toLowerCase() === target ||
      a.emailAddress.toLowerCase() === target ||
      a.accountUuid.toLowerCase() === target,
  )
  if (exact) return { match: exact, ambiguous: false }

  const byAlias = accounts.filter((a) => a.alias?.toLowerCase().startsWith(target))
  if (byAlias.length > 1) return { match: null, ambiguous: true, matches: byAlias.map((a) => a.alias ?? a.emailAddress) }
  if (byAlias.length === 1) return { match: byAlias[0]!, ambiguous: false }

  const byEmail = accounts.filter((a) => a.emailAddress.toLowerCase().startsWith(target))
  if (byEmail.length > 1) return { match: null, ambiguous: true, matches: byEmail.map((a) => a.alias ?? a.emailAddress) }
  if (byEmail.length === 1) return { match: byEmail[0]!, ambiguous: false }

  const byUuid = accounts.filter((a) => a.accountUuid.toLowerCase().startsWith(target))
  if (byUuid.length > 1) return { match: null, ambiguous: true, matches: byUuid.map((a) => a.alias ?? a.emailAddress) }
  if (byUuid.length === 1) return { match: byUuid[0]!, ambiguous: false }

  return null
}

export const call: LocalCommandCall = async (args, context) => {
  const parts = args.trim().split(/\s+/)
  const confirmed = parts.includes('--confirm')
  const target = parts.filter((p) => p !== '--confirm').join(' ').toLowerCase()

  if (!target) {
    return {
      type: 'text',
      value: 'Usage: /delete-account <id-prefix|alias> [--confirm]\nExample: /delete-account backup2 --confirm',
    }
  }

  const codexResult = findCodexMatch(target)

  if (codexResult) {
    if ('ambiguous' in codexResult && codexResult.ambiguous) {
      const list = (codexResult.matches as string[]).map((m) => `  ${m}`).join('\n')
      return { type: 'text', value: `Multiple Codex accounts match "${target}":\n${list}\n\nUse a more specific name.` }
    }

    const codexAcct = codexResult.match!
    if (!codexAcct.vaultFilePath) {
      return {
        type: 'text',
        value: `Account "${codexAcct.alias ?? codexAcct.accountId.slice(0, 12)}" is config-only and cannot be deleted.\nUse /logout to clear session credentials, or restart after fixing profile storage.`,
      }
    }

    const { accounts: codexAccounts, activeIndex: codexActiveIndex } = getPoolStatus()
    const wasActive = codexAccounts[codexActiveIndex]?.accountId === codexAcct.accountId
    const deletedLabel = codexAcct.alias ?? codexAcct.accountId.slice(0, 12)

    if (!confirmed) {
      const remaining = codexAccounts.filter((a) => a.accountId !== codexAcct.accountId)
      const nextActive = remaining.find((a) => a.status === 'healthy')
      let impact: string
      if (wasActive && nextActive) {
        impact = `After deletion, active Codex account will become "${nextActive.alias ?? nextActive.accountId.slice(0, 12)}".`
      } else if (wasActive) {
        impact = 'After deletion, no Codex accounts will remain.'
      } else {
        impact = ''
      }
      const lines = [
        `Delete Codex account "${deletedLabel}"?`,
        'This removes the saved vault profile from disk.',
      ]
      if (impact) lines.push(impact)
      lines.push('', `Run: /delete-account ${deletedLabel} --confirm`)
      return { type: 'text', value: lines.join('\n') }
    }

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

    const after = getPoolStatus()
    const newActive = after.activeIndex >= 0 ? after.accounts[after.activeIndex] : null
    if (wasActive && newActive) {
      const newLabel = newActive.alias ?? newActive.accountId.slice(0, 12)
      return { type: 'text', value: `Deleted ${deletedLabel}. Active Codex account is now ${newLabel}.` }
    }
    if (wasActive) {
      return { type: 'text', value: `Deleted ${deletedLabel}. No Codex accounts remain.` }
    }
    return { type: 'text', value: `Deleted ${deletedLabel}.` }
  }

  const claudeResult = findClaudeMatch(target)

  if (claudeResult) {
    if ('ambiguous' in claudeResult && claudeResult.ambiguous) {
      const list = (claudeResult.matches as string[]).map((m) => `  ${m}`).join('\n')
      return { type: 'text', value: `Multiple Claude accounts match "${target}":\n${list}\n\nUse a more specific name.` }
    }

    const claudeAcct = claudeResult.match!
    if (!claudeAcct.vaultFilePath) {
      return {
        type: 'text',
        value: `Account "${claudeAcct.alias ?? claudeAcct.emailAddress}" is not a vault account and cannot be deleted.`,
      }
    }

    const { accounts: claudeAccounts, activeIndex: claudeActiveIndex } = getClaudePoolStatus()
    const wasActive = claudeAccounts[claudeActiveIndex]?.accountUuid === claudeAcct.accountUuid
    const deletedLabel = claudeAcct.alias ?? claudeAcct.emailAddress

    if (!confirmed) {
      const remaining = claudeAccounts.filter((a) => a.accountUuid !== claudeAcct.accountUuid)
      const nextActive = remaining.find((a) => a.status === 'healthy')
      let impact: string
      if (wasActive && nextActive) {
        impact = `After deletion, active Claude account will become "${nextActive.alias ?? nextActive.emailAddress}".`
      } else if (wasActive) {
        impact = 'After deletion, no Claude accounts will remain.'
      } else {
        impact = ''
      }
      const lines = [
        `Delete Claude account "${deletedLabel}"?`,
        'This removes the saved vault profile from disk.',
      ]
      if (impact) lines.push(impact)
      lines.push('', `Run: /delete-account ${deletedLabel} --confirm`)
      return { type: 'text', value: lines.join('\n') }
    }

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

    const after = getClaudePoolStatus()
    const newActive = after.activeIndex >= 0 ? after.accounts[after.activeIndex] : null
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
