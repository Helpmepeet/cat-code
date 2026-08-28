import { describeCodexAccountAvailability, getPoolStatus } from '../../services/api/codexAccountPool.js'
import { getCodexLeaseSnapshot } from '../../services/api/codexAccountLeaseManager.js'
import { getClaudePoolStatus } from '../../services/api/claudeAccountPool.js'
import { fetchPoolUsage, formatPoolUsage } from '../../services/api/codexUsage.js'
import type { LocalCommandCall } from '../../types/command.js'

export const call: LocalCommandCall = async () => {
  const lines: string[] = []

  // ── Claude accounts ──
  const claudePool = getClaudePoolStatus()
  if (claudePool.initialized && claudePool.accounts.length > 0) {
    lines.push('Anthropic Accounts:')
    lines.push('')
    for (let i = 0; i < claudePool.accounts.length; i++) {
      const acct = claudePool.accounts[i]!
      const isActive = i === claudePool.activeIndex
      const dot = isActive ? '● ' : '  '
      const label = acct.alias ?? acct.emailAddress
      const statusTag = acct.status === 'healthy' ? '' : '  [dead]'
      lines.push(`${dot}${label}${statusTag}`)
    }
    const claudeHealthy = claudePool.accounts.filter((a) => a.status === 'healthy').length
    lines.push('')
    lines.push(`Total: ${claudePool.accounts.length} (${claudeHealthy} healthy)`)
  }

  // ── Codex accounts ──
  const { accounts, activeIndex, initialized } = getPoolStatus()
  const leaseSnapshot = getCodexLeaseSnapshot()
  if (initialized && accounts.length > 0) {
    if (lines.length > 0) lines.push('', '---', '')

    // /accounts is an explicit request for current usage, not a cached summary.
    const snapshot = await fetchPoolUsage({ forceRefresh: true, updateRoutingHints: true })

    if (snapshot.accounts.length > 0) {
      lines.push(formatPoolUsage(snapshot))
      lines.push('')
      lines.push(
        `Pool: ${accounts.length} accounts (${accounts.filter((a) => describeCodexAccountAvailability(a) === 'Ready').length} Ready)`,
      )
    } else {
      lines.push('Codex Account Pool:')
      lines.push('')

      let hasConfigOnly = false
      const activeAccountId = leaseSnapshot.mainLease?.accountId ?? accounts[activeIndex]?.accountId
      for (const acct of accounts) {
        const isActive = acct.accountId === activeAccountId
        const dot = isActive ? '● ' : '  '
        const label = acct.alias ?? acct.accountId.slice(0, 12)
        const statusTag = `  ${describeCodexAccountAvailability(acct, { format: 'bracket' })}`
        const sourceTag = acct.source === 'vault' ? '  vault' : '  config'
        if (acct.source !== 'vault') hasConfigOnly = true

        let line = `${dot}${label}${statusTag}${sourceTag}`
        if (acct.lastError) {
          line += `\n    warning: ${acct.lastError}`
        }
        if (acct.status === 'dead' && acct.statusReason === 'auth_dead') {
          line += `\n    fix: run /login (OpenAI) to re-authenticate this account`
        }
        lines.push(line)
      }

      const availabilityCounts = countCodexAvailabilityLabels(accounts)
      const totalSummary = ['Ready', 'Limit reached', 'Connection issue (retrying)', 'Needs re-login']
        .map(label => [label, availabilityCounts.get(label) ?? 0] as const)
        .filter(([, count]) => count > 0)
        .map(([label, count]) => `${count} ${label}`)
        .join(', ')

      lines.push('')
      lines.push(`Total: ${accounts.length}${totalSummary ? ` (${totalSummary})` : ''}`)
      if (hasConfigOnly) {
        lines.push('Note: config-only accounts cannot be deleted with /delete-account.')
      }
    }

    lines.push('')
    lines.push(`Main lease: ${formatLeaseAccountLabel(leaseSnapshot.mainLease, accounts)}`)
    lines.push(`Subagent strategy: ${leaseSnapshot.strategy}`)
    lines.push('')
    for (const leaseAccount of leaseSnapshot.accounts) {
      const acct = accounts.find((a) => a.accountId === leaseAccount.accountId)
      if (!acct) continue
      const label = acct.alias ?? acct.accountId.slice(0, 12)
      const holders = leaseAccount.holders.length > 0 ? `   holders: ${leaseAccount.holders.join(', ')}` : ''
      lines.push(`  ${label}   leases: ${leaseAccount.leaseCount}${holders}`)
    }
  }

  if (lines.length === 0) {
    return { type: 'text', value: 'No account pools active. Using single account from config.\n\nAdd an account: /login' }
  }

  lines.push('')
  lines.push('Add account: /login')

  return { type: 'text', value: lines.join('\n') }
}

function formatLeaseAccountLabel(
  mainLease: ReturnType<typeof getCodexLeaseSnapshot>['mainLease'],
  accounts: ReturnType<typeof getPoolStatus>['accounts'],
): string {
  if (!mainLease) return 'none'
  const acct = accounts.find((a) => a.accountId === mainLease.accountId)
  return acct?.alias ?? mainLease.accountId.slice(0, 12)
}

function countCodexAvailabilityLabels(
  accounts: ReturnType<typeof getPoolStatus>['accounts'],
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const account of accounts) {
    const availability = describeCodexAccountAvailability(account)
    const label = availability.startsWith('Limit reached') ? 'Limit reached' : availability
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return counts
}
