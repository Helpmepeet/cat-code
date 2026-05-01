import { clearAuthRelatedCaches } from '../logout/logout.js'
import { applyPostCodexAccountSwitchRefresh, getPoolStatus, switchToAccount } from '../../services/api/codexAccountPool.js'
import { reassignCodexLeaseToActiveAccount } from '../../services/api/codexAccountLeaseManager.js'
import {
  getClaudePoolStatus,
  switchToClaudeAccount,
  syncClaudeAccountToStorage,
} from '../../services/api/claudeAccountPool.js'
import type { LocalCommandCall } from '../../types/command.js'
import { clearOAuthTokenCache } from '../../utils/auth.js'
import { stripSignatureBlocks } from '../../utils/messages.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { resetCodexCacheContext } from '../../services/api/codex-fetch-adapter.js'

function applyPostSwitchAccountStateRefresh(
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

async function performClaudeSwitch(
  idPrefix: string | null,
  context: Parameters<LocalCommandCall>[1],
): Promise<{ type: 'text'; value: string } | null> {
  const { accounts, activeIndex } = getClaudePoolStatus()
  const currentLabel = accounts[activeIndex]?.alias ?? accounts[activeIndex]?.emailAddress ?? '?'

  const result = switchToClaudeAccount(idPrefix)
  if (!result) return null

  // Sync keychain + config.oauthAccount for all existing consumers
  syncClaudeAccountToStorage()
  clearOAuthTokenCache()
  await clearAuthRelatedCaches()
  applyPostSwitchAccountStateRefresh(context)

  const toLabel = result.alias ?? result.emailAddress
  if (idPrefix) {
    return { type: 'text', value: `Switched to Claude account ${toLabel}` }
  }
  return { type: 'text', value: `Switched Claude account from ${currentLabel} to ${toLabel}` }
}

async function performCodexSwitch(
  idPrefix: string | null,
  context: Parameters<LocalCommandCall>[1],
): Promise<{ type: 'text'; value: string } | null> {
  const { accounts, activeIndex } = getPoolStatus()

  const result = switchToAccount(idPrefix)
  if (!result) return null

  // The main thread holds a persistent codex lease (see query.ts) that pins an
  // accountId at creation time. switchToAccount only updates pool.activeIndex,
  // so without this the lease (and therefore the status line + API routing)
  // stays on the previous account.
  reassignCodexLeaseToActiveAccount('main-thread')

  // Reset the Codex fetch cache context so the next request picks up the new
  // account's conversation routing instead of the old one.
  resetCodexCacheContext()

  // Mirror the Claude switch path: clear all auth-sensitive caches so stale
  // rate-limit state, memoized tokens, and tool schema caches don't carry over.
  await clearAuthRelatedCaches()
  applyPostSwitchAccountStateRefresh(context)

  if (idPrefix) {
    const label = result.alias ?? result.accountId.slice(0, 12)
    return { type: 'text', value: `Switched to ${label}` }
  }

  const current = accounts[activeIndex]
  const fromLabel = current?.alias ?? current?.accountId.slice(0, 12) ?? '?'
  const toLabel = result.alias ?? result.accountId.slice(0, 12)
  return { type: 'text', value: `Switched from ${fromLabel} to ${toLabel}` }
}

export const call: LocalCommandCall = async (args, context) => {
  const codexPool = getPoolStatus()
  const claudePool = getClaudePoolStatus()

  const codexHealthy = codexPool.initialized ? codexPool.accounts.filter((a) => a.status === 'healthy').length : 0
  const claudeHealthy = claudePool.initialized ? claudePool.accounts.filter((a) => a.status === 'healthy').length : 0

  if (codexHealthy <= 1 && claudeHealthy <= 1) {
    return { type: 'text', value: 'No other healthy accounts to switch to.' }
  }

  const prefix = args.trim().toLowerCase()

  if (prefix) {
    // Probe both pools before switching to detect cross-pool ambiguity
    const lower = prefix
    const claudeMatch = claudeHealthy > 1
      ? (() => {
          const accts = claudePool.accounts
          return accts.find((a) => a.alias?.toLowerCase() === lower && a.status === 'healthy')
            ?? accts.find((a) => a.alias?.toLowerCase().startsWith(lower) && a.status === 'healthy')
            ?? accts.find((a) => a.emailAddress.toLowerCase().startsWith(lower) && a.status === 'healthy')
            ?? accts.find((a) => a.accountUuid.toLowerCase().startsWith(lower) && a.status === 'healthy')
            ?? null
        })()
      : null
    const codexMatch = codexHealthy > 1
      ? (() => {
          const accts = codexPool.accounts
          return accts.find((a) => a.alias?.toLowerCase() === lower && a.status === 'healthy')
            ?? accts.find((a) => a.alias?.toLowerCase().startsWith(lower) && a.status === 'healthy')
            ?? accts.find((a) => a.accountId.toLowerCase().startsWith(lower) && a.status === 'healthy')
            ?? null
        })()
      : null

    if (claudeMatch && codexMatch) {
      const claudeLabel = claudeMatch.alias ?? claudeMatch.emailAddress
      const codexLabel = codexMatch.alias ?? codexMatch.accountId.slice(0, 12)
      return {
        type: 'text',
        value: `Ambiguous: "${prefix}" matches Claude account "${claudeLabel}" and Codex account "${codexLabel}". Be more specific.`,
      }
    }

    if (claudeMatch) {
      const result = await performClaudeSwitch(prefix, context)
      if (result) return result
    }
    if (codexMatch) {
      const result = await performCodexSwitch(prefix, context)
      if (result) return result
    }
    return {
      type: 'text',
      value: `No healthy account matching "${prefix}". Run /accounts to see available accounts.`,
    }
  }

  // No arg: rotate within the current provider
  const provider = getAPIProvider()
  const isClaudeProvider = provider === 'firstParty'

  if (isClaudeProvider && claudeHealthy > 1) {
    const result = await performClaudeSwitch(null, context)
    if (result) return result
    return { type: 'text', value: 'No other healthy Claude accounts to switch to.' }
  }

  if (!isClaudeProvider && codexHealthy > 1) {
    const result = await performCodexSwitch(null, context)
    if (result) return result
    return { type: 'text', value: 'No other healthy Codex accounts to switch to.' }
  }

  // Current provider has ≤1 account
  if (isClaudeProvider) {
    return { type: 'text', value: 'Only one Claude account. Use /switch-account <alias> to switch to a Codex account.' }
  }
  return { type: 'text', value: 'Only one Codex account. Use /switch-account <alias> to switch to a Claude account.' }
}
