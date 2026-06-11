import { clearAuthRelatedCaches } from '../logout/logout.js'
import {
  applyPostCodexAccountSwitchRefresh,
  getPoolStatus,
  isCodexAccountSwitchable,
  removeCodexAccount,
  resolveCodexAccountByPrefix,
} from '../../services/api/codexAccountPool.js'
import {
  getClaudePoolStatus,
  removeClaudeAccount,
  resolveClaudeAccountByPrefix,
  syncClaudeAccountToStorage,
} from '../../services/api/claudeAccountPool.js'
import {
  reassignCodexLeaseToActiveAccount,
  releaseCodexLease,
  repairLeasesForDeletedAccount,
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
  const parts = args.trim().split(/\s+/)
  const confirmed = parts.includes('--confirm')
  const target = parts.filter((p) => p !== '--confirm').join(' ').toLowerCase()

  if (!target) {
    return {
      type: 'text',
      value: 'Usage: /delete-account <id-prefix|alias> [--confirm]\nExample: /delete-account backup2 --confirm',
    }
  }

  const codexResolution = resolveCodexAccountByPrefix(target)
  const claudeResolution = resolveClaudeAccountByPrefix(target)
  const codexExact =
    codexResolution.kind === 'unique' && codexResolution.matchType === 'exact'
      ? codexResolution.account
      : null
  const claudeExact =
    claudeResolution.kind === 'unique' && claudeResolution.matchType === 'exact'
      ? claudeResolution.account
      : null

  let selected:
    | { provider: 'codex'; account: NonNullable<typeof codexExact> }
    | { provider: 'claude'; account: NonNullable<typeof claudeExact> }
    | null = null

  if (codexExact && claudeExact) {
    const codexLabel = codexExact.alias ?? codexExact.accountId.slice(0, 12)
    const claudeLabel = claudeExact.alias ?? claudeExact.emailAddress
    return {
      type: 'text',
      value: `Ambiguous: "${target}" matches Codex account "${codexLabel}" and Claude account "${claudeLabel}". Use a more specific name.`,
    }
  }

  if (claudeExact) {
    selected = { provider: 'claude', account: claudeExact }
  } else if (codexExact) {
    selected = { provider: 'codex', account: codexExact }
  } else if (codexResolution.kind === 'ambiguous') {
    const list = codexResolution.matches
      .map((account) => `  ${account.alias ?? account.accountId.slice(0, 12)}`)
      .join('\n')
    return { type: 'text', value: `Multiple Codex accounts match "${target}":\n${list}\n\nUse a more specific name.` }
  } else if (claudeResolution.kind === 'ambiguous') {
    const list = claudeResolution.matches
      .map((account) => `  ${account.alias ?? account.emailAddress}`)
      .join('\n')
    return { type: 'text', value: `Multiple Claude accounts match "${target}":\n${list}\n\nUse a more specific name.` }
  } else if (codexResolution.kind === 'unique' && claudeResolution.kind === 'unique') {
    const codexLabel = codexResolution.account.alias ?? codexResolution.account.accountId.slice(0, 12)
    const claudeLabel = claudeResolution.account.alias ?? claudeResolution.account.emailAddress
    return {
      type: 'text',
      value: `Ambiguous: "${target}" matches Codex account "${codexLabel}" and Claude account "${claudeLabel}". Use a more specific name.`,
    }
  } else if (codexResolution.kind === 'unique') {
    selected = { provider: 'codex', account: codexResolution.account }
  } else if (claudeResolution.kind === 'unique') {
    selected = { provider: 'claude', account: claudeResolution.account }
  }

  if (selected?.provider === 'codex') {
    const codexAcct = selected.account
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
      const nextActive = remaining.find((a) => isCodexAccountSwitchable(a))
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

    const deletedAccountId = codexAcct.accountId
    const ok = removeCodexAccount(deletedAccountId)
    if (!ok) {
      return { type: 'text', value: 'Failed to delete account. Check logs for details.' }
    }

    // Repair every lease that was pointing at the deleted account (main or
    // subagent) before refreshing UI. Leases that cannot find a healthy
    // alternative are released.
    repairLeasesForDeletedAccount(deletedAccountId)

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

  if (selected?.provider === 'claude') {
    const claudeAcct = selected.account
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
