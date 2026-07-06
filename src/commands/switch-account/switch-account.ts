import { clearAuthRelatedCaches } from '../logout/logout.js'
import {
  applyPostCodexAccountSwitchRefresh,
  describeCodexAccountAvailability,
  getCodexAccountAvailability,
  getPoolStatus,
  isCodexAccountSwitchable,
  resolveCodexAccountByPrefix,
  switchToAccount,
  updateAccountUsageHints,
} from '../../services/api/codexAccountPool.js'
import { fetchAccountUsage } from '../../services/api/codexUsage.js'
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

  // Resolve the candidate WITHOUT mutating pool.activeIndex yet, so a live-usage
  // check can refuse a capped target before we commit the switch (no revert).
  const candidate =
    idPrefix !== null
      ? (() => {
          const resolution = resolveCodexAccountByPrefix(idPrefix, { onlySwitchable: true })
          return resolution.kind === 'unique' ? resolution.account : null
        })()
      : null

  if (idPrefix !== null) {
    if (!candidate) return null

    if (current?.accountId === candidate.accountId && getAPIProvider() === 'openai') {
      const label = candidate.alias ?? candidate.accountId.slice(0, 12)
      emitManualSwitchDiagnostic({
        provider: 'openai',
        pool: 'codex',
        accountRef: candidate.accountId,
        counts: countStatuses(getPoolStatus().accounts),
        reason: 'manual switch no-op',
      })
      return { type: 'text', value: `Already on ${label}` }
    }

    // The named target only carries soft plan-metadata warnings (e.g. plan
    // expired / free). The warning text promises "live usage decides
    // availability" — so consult it now. A fresh capped hint flips
    // getCodexAccountAvailability to 'blocked' and we refuse the switch instead
    // of reporting a false success that silently fails over on the next request.
    const preCheck = getCodexAccountAvailability(candidate)
    if (preCheck.kind === 'warned') {
      const blocked = await liveUsageIsBlocked(candidate)
      if (blocked) {
        emitManualSwitchFailure('target capped per live usage')
        return {
          type: 'text',
          value: formatCodexSwitchRefusal(candidate, current),
        }
      }
    }
  }

  const result = switchToAccount(idPrefix)
  if (!result) return null

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
    const availability = getCodexAccountAvailability(result)
    const warningLines =
      availability.kind === 'warned'
        ? availability.warnings.map((warning) => `Warning: ${warning.message}`)
        : []
    return { type: 'text', value: [`Switched to ${label}`, ...warningLines].join('\n') }
  }

  const fromLabel = current?.alias ?? current?.accountId.slice(0, 12) ?? '?'
  const toLabel = result.alias ?? result.accountId.slice(0, 12)
  return { type: 'text', value: `Switched from ${fromLabel} to ${toLabel}` }
}

export const call: LocalCommandCall = async (args, context) => {
  const codexPool = getPoolStatus()
  const claudePool = getClaudePoolStatus()

  const codexHealthy = codexPool.initialized ? codexPool.accounts.filter((a) => isCodexAccountSwitchable(a)).length : 0
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
      ? resolveCodexAccountByPrefix(prefix, { onlySwitchable: true })
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
    const codexAnyResolution = resolveCodexAccountByPrefix(prefix)
    if (codexAnyResolution.kind === 'unique' && !isCodexAccountSwitchable(codexAnyResolution.account)) {
      emitManualSwitchFailure('matching Codex account is not switchable')
      return {
        type: 'text',
        value: formatCodexSwitchRefusal(
          codexAnyResolution.account,
          codexPool.accounts[codexPool.activeIndex],
        ),
      }
    }
    if (codexAnyResolution.kind === 'ambiguous') {
      const list = codexAnyResolution.matches
        .map((a) => `  ${a.alias ?? a.accountId.slice(0, 12)}`)
        .join('\n')
      emitManualSwitchFailure('ambiguous Codex account prefix')
      return {
        type: 'text',
        value: `Multiple Codex accounts match "${prefix}":\n${list}\n\nBe more specific.`,
      }
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

type CodexPoolAccount = ReturnType<typeof getPoolStatus>['accounts'][number]

/** Unified refusal message shared by every "can't switch to this Codex account" path. */
function formatCodexSwitchRefusal(
  target: CodexPoolAccount,
  current: CodexPoolAccount | undefined,
): string {
  const targetLabel = target.alias ?? target.accountId.slice(0, 12)
  const stayLabel = current?.alias ?? current?.accountId.slice(0, 12) ?? 'current account'
  return `Cannot switch to ${targetLabel} — ${describeCodexAccountAvailability(target)}. Staying on ${stayLabel}.`
}

/**
 * Fetch live usage for a warned account and fold it into the pool's usage
 * hints, then re-check availability. Returns true when the fresh hint flips the
 * account to 'blocked' (e.g. a free/expired account the backend would reject),
 * false when usage is fine or unreachable (an unreachable usage endpoint must
 * never block a switch).
 */
async function liveUsageIsBlocked(account: CodexPoolAccount): Promise<boolean> {
  const usage = await fetchAccountUsage(account)
  if (!usage) return false

  updateAccountUsageHints([
    {
      accountId: usage.accountId,
      primaryPercent: usage.primaryWindow.usedPercent,
      weeklyPercent: usage.secondaryWindow.usedPercent,
      allowed: usage.allowed,
      limitReached: usage.limitReached,
      resetAt: usage.primaryWindow.resetAt,
      fetchedAt: usage.fetchedAt,
    },
  ])

  return getCodexAccountAvailability(account).kind === 'blocked'
}
