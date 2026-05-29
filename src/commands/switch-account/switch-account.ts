import { clearAuthRelatedCaches } from '../logout/logout.js'
import {
  applyPostCodexAccountSwitchRefresh,
  getPoolStatus,
  resolveCodexAccountByPrefix,
  switchToAccount,
} from '../../services/api/codexAccountPool.js'
import { reassignCodexLeasesToActiveAccount } from '../../services/api/codexAccountLeaseManager.js'
import {
  getClaudePoolStatus,
  resolveClaudeAccountByPrefix,
  switchToClaudeAccount,
  syncClaudeAccountToStorage,
} from '../../services/api/claudeAccountPool.js'
import type { LocalCommandCall } from '../../types/command.js'
import { clearOAuthTokenCache } from '../../utils/auth.js'
import { stripSignatureBlocks } from '../../utils/messages.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { resetCodexCacheContext } from '../../services/api/codex-fetch-adapter.js'
import { emitAccountDiagnostic } from '../../services/api/accountDiagnostics.js'

function countStatuses(accounts: readonly { status: string }[]): Record<string, number> {
  const counts: Record<string, number> = { total: accounts.length }
  for (const account of accounts) {
    counts[account.status] = (counts[account.status] ?? 0) + 1
  }
  return counts
}

function emitManualSwitchDiagnostic({
  provider,
  pool,
  accountRef,
  counts,
  reason,
  severity = 'info',
}: {
  provider: 'openai' | 'anthropic' | 'unknown'
  pool?: string
  accountRef?: string
  counts?: Record<string, number>
  reason: string
  severity?: 'info' | 'warning'
}): void {
  emitAccountDiagnostic({
    code: 'account.manual_switch',
    severity,
    provider,
    recoverable: true,
    pool,
    account_ref: accountRef,
    counts,
    reason,
  })
}

function emitManualSwitchFailure(reason: string): void {
  emitManualSwitchDiagnostic({
    provider: 'unknown',
    reason: `manual switch failed: ${reason}`,
    severity: 'warning',
  })
}

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
  emitManualSwitchDiagnostic({
    provider: 'anthropic',
    pool: 'claude',
    accountRef: result.accountUuid,
    counts: countStatuses(getClaudePoolStatus().accounts),
    reason: 'manual switch succeeded',
  })
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
  const current = accounts[activeIndex]

  const result = switchToAccount(idPrefix)
  if (!result) return null

  if (
    idPrefix &&
    current?.accountId === result.accountId &&
    getAPIProvider() === 'openai'
  ) {
    const label = result.alias ?? result.accountId.slice(0, 12)
    emitManualSwitchDiagnostic({
      provider: 'openai',
      pool: 'codex',
      accountRef: result.accountId,
      counts: countStatuses(getPoolStatus().accounts),
      reason: 'manual switch no-op',
    })
    return { type: 'text', value: `Already on ${label}` }
  }

  // The main thread holds a persistent codex lease (see query.ts) that pins an
  // accountId at creation time. switchToAccount only updates pool.activeIndex,
  // so without this the lease (and therefore the status line + API routing)
  // stays on the previous account.
  reassignCodexLeasesToActiveAccount()

  // Reset the Codex fetch cache context so the next request picks up the new
  // account's conversation routing instead of the old one.
  resetCodexCacheContext()

  // Mirror the Claude switch path: clear all auth-sensitive caches so stale
  // rate-limit state, memoized tokens, and tool schema caches don't carry over.
  await clearAuthRelatedCaches()
  applyPostSwitchAccountStateRefresh(context)
  emitManualSwitchDiagnostic({
    provider: 'openai',
    pool: 'codex',
    accountRef: result.accountId,
    counts: countStatuses(getPoolStatus().accounts),
    reason: 'manual switch succeeded',
  })

  if (idPrefix) {
    const label = result.alias ?? result.accountId.slice(0, 12)
    return { type: 'text', value: `Switched to ${label}` }
  }

  const fromLabel = current?.alias ?? current?.accountId.slice(0, 12) ?? '?'
  const toLabel = result.alias ?? result.accountId.slice(0, 12)
  return { type: 'text', value: `Switched from ${fromLabel} to ${toLabel}` }
}

export const call: LocalCommandCall = async (args, context) => {
  const codexPool = getPoolStatus()
  const claudePool = getClaudePoolStatus()

  const codexHealthy = codexPool.initialized ? codexPool.accounts.filter((a) => a.status === 'healthy').length : 0
  const claudeHealthy = claudePool.initialized ? claudePool.accounts.filter((a) => a.status === 'healthy').length : 0

  const prefix = args.trim().toLowerCase()
  emitManualSwitchDiagnostic({
    provider: 'unknown',
    reason: 'manual switch started',
  })

  if (prefix) {
    // Resolve in each pool with ambiguity awareness before switching.
    const claudeResolution = claudeHealthy > 0
      ? resolveClaudeAccountByPrefix(prefix, { onlyHealthy: true })
      : { kind: 'none' as const }
    const codexResolution = codexHealthy > 0
      ? resolveCodexAccountByPrefix(prefix, { onlyHealthy: true })
      : { kind: 'none' as const }

    const claudeExact =
      claudeResolution.kind === 'unique' && claudeResolution.matchType === 'exact'
        ? claudeResolution.account
        : null
    const codexExact =
      codexResolution.kind === 'unique' && codexResolution.matchType === 'exact'
        ? codexResolution.account
        : null

    if (claudeExact && codexExact) {
      const claudeLabel = claudeExact.alias ?? claudeExact.emailAddress
      const codexLabel = codexExact.alias ?? codexExact.accountId.slice(0, 12)
      emitManualSwitchFailure('ambiguous cross-provider account prefix')
      return {
        type: 'text',
        value: `Ambiguous: "${prefix}" matches Claude account "${claudeLabel}" and Codex account "${codexLabel}". Be more specific.`,
      }
    }

    if (claudeExact) {
      const result = await performClaudeSwitch(prefix, context)
      if (result) return result
    }
    if (codexExact) {
      const result = await performCodexSwitch(prefix, context)
      if (result) return result
    }

    if (claudeResolution.kind === 'ambiguous') {
      const list = claudeResolution.matches
        .map((a) => `  ${a.alias ?? a.emailAddress}`)
        .join('\n')
      emitManualSwitchFailure('ambiguous Claude account prefix')
      return {
        type: 'text',
        value: `Multiple Claude accounts match "${prefix}":\n${list}\n\nBe more specific.`,
      }
    }
    if (codexResolution.kind === 'ambiguous') {
      const list = codexResolution.matches
        .map((a) => `  ${a.alias ?? a.accountId.slice(0, 12)}`)
        .join('\n')
      emitManualSwitchFailure('ambiguous Codex account prefix')
      return {
        type: 'text',
        value: `Multiple Codex accounts match "${prefix}":\n${list}\n\nBe more specific.`,
      }
    }

    const claudeMatch = claudeResolution.kind === 'unique' ? claudeResolution.account : null
    const codexMatch = codexResolution.kind === 'unique' ? codexResolution.account : null

    if (claudeMatch && codexMatch) {
      const claudeLabel = claudeMatch.alias ?? claudeMatch.emailAddress
      const codexLabel = codexMatch.alias ?? codexMatch.accountId.slice(0, 12)
      emitManualSwitchFailure('ambiguous cross-provider account prefix')
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
    emitManualSwitchFailure('no matching healthy account')
    return {
      type: 'text',
      value: `No healthy account matching "${prefix}". Run /accounts to see available accounts.`,
    }
  }

  if (codexHealthy <= 1 && claudeHealthy <= 1) {
    emitManualSwitchFailure('no other healthy account')
    return { type: 'text', value: 'No other healthy accounts to switch to.' }
  }

  // No arg: rotate within the current provider
  const provider = getAPIProvider()
  const isClaudeProvider = provider === 'firstParty'

  if (isClaudeProvider && claudeHealthy > 1) {
    const result = await performClaudeSwitch(null, context)
    if (result) return result
    emitManualSwitchFailure('no other healthy Claude account')
    return { type: 'text', value: 'No other healthy Claude accounts to switch to.' }
  }

  if (!isClaudeProvider && codexHealthy > 1) {
    const result = await performCodexSwitch(null, context)
    if (result) return result
    emitManualSwitchFailure('no other healthy Codex account')
    return { type: 'text', value: 'No other healthy Codex accounts to switch to.' }
  }

  // Current provider has ≤1 account
  if (isClaudeProvider) {
    emitManualSwitchFailure('only one Claude account')
    return { type: 'text', value: 'Only one Claude account. Use /switch-account <alias> to switch to a Codex account.' }
  }
  emitManualSwitchFailure('only one Codex account')
  return { type: 'text', value: 'Only one Codex account. Use /switch-account <alias> to switch to a Claude account.' }
}
