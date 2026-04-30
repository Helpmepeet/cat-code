import { getPoolStatus, setAccountAlias } from '../../services/api/codexAccountPool.js'
import { getClaudePoolStatus, setClaudeAccountAlias } from '../../services/api/claudeAccountPool.js'
import type { LocalCommandCall } from '../../types/command.js'

export const call: LocalCommandCall = async (args) => {
  const parts = args.trim().split(/\s+/)
  if (parts.length < 2) {
    return {
      type: 'text',
      value: 'Usage: /rename-account <id-prefix|current-alias> <new-alias>\nExample: /rename-account ca88 main',
    }
  }

  const [target, newAlias] = parts
  if (!target || !newAlias) {
    return { type: 'text', value: 'Usage: /rename-account <id-prefix|current-alias> <new-alias>' }
  }

  const lower = target.toLowerCase()

  // Search Codex pool first
  const { accounts: codexAccounts } = getPoolStatus()
  let codexAcct = codexAccounts.find((a) => a.alias?.toLowerCase() === lower)
  if (!codexAcct) codexAcct = codexAccounts.find((a) => a.alias?.toLowerCase().startsWith(lower))
  if (!codexAcct) codexAcct = codexAccounts.find((a) => a.accountId.toLowerCase().startsWith(lower))

  if (codexAcct) {
    if (!codexAcct.vaultFilePath) {
      return {
        type: 'text',
        value: `Account ${codexAcct.alias ?? codexAcct.accountId.slice(0, 12)} is not a vault account and cannot be renamed.`,
      }
    }
    const ok = setAccountAlias(codexAcct.accountId, newAlias)
    if (!ok) {
      return { type: 'text', value: `Failed to rename account. Check logs for details.` }
    }
    const oldLabel = codexAcct.alias ?? codexAcct.accountId.slice(0, 12)
    return { type: 'text', value: `Renamed ${oldLabel} → ${newAlias}` }
  }

  // Search Claude pool
  const { accounts: claudeAccounts } = getClaudePoolStatus()
  let claudeAcct = claudeAccounts.find((a) => a.alias?.toLowerCase() === lower)
  if (!claudeAcct) claudeAcct = claudeAccounts.find((a) => a.alias?.toLowerCase().startsWith(lower))
  if (!claudeAcct) claudeAcct = claudeAccounts.find((a) => a.emailAddress.toLowerCase().startsWith(lower))
  if (!claudeAcct) claudeAcct = claudeAccounts.find((a) => a.accountUuid.toLowerCase().startsWith(lower))

  if (claudeAcct) {
    if (!claudeAcct.vaultFilePath) {
      return {
        type: 'text',
        value: `Account ${claudeAcct.alias ?? claudeAcct.emailAddress} is not a vault account and cannot be renamed.`,
      }
    }
    const ok = setClaudeAccountAlias(claudeAcct.accountUuid, newAlias)
    if (!ok) {
      return { type: 'text', value: `Failed to rename account. Check logs for details.` }
    }
    const oldLabel = claudeAcct.alias ?? claudeAcct.emailAddress
    return { type: 'text', value: `Renamed ${oldLabel} → ${newAlias}` }
  }

  return {
    type: 'text',
    value: `No account matching "${target}". Run /accounts to see available accounts.`,
  }
}
