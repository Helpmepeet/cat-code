import { getPoolStatus } from '../../services/api/codexAccountPool.js'
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

    // Fetch live usage from wham/usage
    const snapshot = await fetchPoolUsage()

    if (snapshot.accounts.length > 0) {
      lines.push(formatPoolUsage(snapshot))
      lines.push('')
      lines.push(
        `Pool: ${accounts.length} accounts (${accounts.filter((a) => a.status === 'healthy').length} healthy)`,
      )
    } else {
      lines.push('Codex Account Pool:')
      lines.push('')

      let hasConfigOnly = false
      for (let i = 0; i < accounts.length; i++) {
        const acct = accounts[i]!
        const isActive = i === activeIndex
        const dot = isActive ? '● ' : '  '
        const label = acct.alias ?? acct.accountId.slice(0, 12)
        const statusTag =
          acct.status === 'healthy'
            ? ''
            : acct.status === 'capped'
              ? '  [capped]'
              : '  [dead]'
        const sourceTag = acct.source === 'vault' ? '  vault' : '  config'
        if (acct.source !== 'vault') hasConfigOnly = true

        let line = `${dot}${label}${statusTag}${sourceTag}`
        if (acct.lastError) {
          line += `\n    warning: ${acct.lastError}`
        }
        lines.push(line)
      }

      const healthy = accounts.filter((a) => a.status === 'healthy').length
      const capped = accounts.filter((a) => a.status === 'capped').length
      const dead = accounts.filter((a) => a.status === 'dead').length

      lines.push('')
      lines.push(
        `Total: ${accounts.length} (${healthy} healthy${capped ? `, ${capped} capped` : ''}${dead ? `, ${dead} dead` : ''})`,
      )
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

function formatTokenAge(lastRefreshIso?: string): string {
  if (!lastRefreshIso) return '?'
  const ageMs = Date.now() - new Date(lastRefreshIso).getTime()
  const ageDays = ageMs / (1000 * 60 * 60 * 24)
  if (ageDays < 1) {
    const hours = Math.round(ageDays * 24)
    return `${hours}h`
  }
  const tag = ageDays > 7 ? ' CRITICAL' : ageDays > 5 ? ' WARN' : ''
  return `${ageDays.toFixed(1)}d${tag}`
}
