import {
  resolveCodexAccountByPrefix,
  setAccountAlias,
  validateCodexAccountAlias,
} from '../../services/api/codexAccountPool.js'
import {
  resolveClaudeAccountByPrefix,
  setClaudeAccountAlias,
} from '../../services/api/claudeAccountPool.js'
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

  if (codexExact && claudeExact) {
    const codexLabel = codexExact.alias ?? codexExact.accountId.slice(0, 12)
    const claudeLabel = claudeExact.alias ?? claudeExact.emailAddress
    return {
      type: 'text',
      value: `Ambiguous: "${target}" matches Codex account "${codexLabel}" and Claude account "${claudeLabel}". Be more specific.`,
    }
  }

  if (claudeExact) {
    return renameClaudeAccount(claudeExact, newAlias)
  }
  if (codexExact) {
    return renameCodexAccount(codexExact, newAlias)
  }

  if (codexResolution.kind === 'ambiguous') {
    const list = codexResolution.matches
      .map((a) => `  ${a.alias ?? a.accountId.slice(0, 12)}`)
      .join('\n')
    return {
      type: 'text',
      value: `Multiple Codex accounts match "${target}":\n${list}\n\nBe more specific.`,
    }
  }

  if (claudeResolution.kind === 'ambiguous') {
    const list = claudeResolution.matches
      .map((a) => `  ${a.alias ?? a.emailAddress}`)
      .join('\n')
    return {
      type: 'text',
      value: `Multiple Claude accounts match "${target}":\n${list}\n\nBe more specific.`,
    }
  }

  if (codexResolution.kind === 'unique' && claudeResolution.kind === 'unique') {
    if (
      codexResolution.matchType === claudeResolution.matchType ||
      (codexResolution.matchType !== 'exact' && claudeResolution.matchType !== 'exact')
    ) {
      const codexLabel = codexResolution.account.alias ?? codexResolution.account.accountId.slice(0, 12)
      const claudeLabel = claudeResolution.account.alias ?? claudeResolution.account.emailAddress
      return {
        type: 'text',
        value: `Ambiguous: "${target}" matches Codex account "${codexLabel}" and Claude account "${claudeLabel}". Be more specific.`,
      }
    }
    if (claudeResolution.matchType === 'exact') {
      return renameClaudeAccount(claudeResolution.account, newAlias)
    }
    return renameCodexAccount(codexResolution.account, newAlias)
  }

  if (codexResolution.kind === 'unique') {
    return renameCodexAccount(codexResolution.account, newAlias)
  }

  if (claudeResolution.kind === 'unique') {
    return renameClaudeAccount(claudeResolution.account, newAlias)
  }

  return {
    type: 'text',
    value: `No account matching "${target}". Run /accounts to see available accounts.`,
  }
}

function renameCodexAccount(
  codexAcct: Extract<ReturnType<typeof resolveCodexAccountByPrefix>, { kind: 'unique' }>['account'],
  newAlias: string,
): { type: 'text'; value: string } {
  if (!codexAcct.vaultFilePath) {
    return {
      type: 'text',
      value: `Account ${codexAcct.alias ?? codexAcct.accountId.slice(0, 12)} is not a vault account and cannot be renamed.`,
    }
  }
  const validation = validateCodexAccountAlias(newAlias, codexAcct.accountId)
  if (!validation.ok) {
    return { type: 'text', value: validation.message }
  }
  const ok = setAccountAlias(codexAcct.accountId, newAlias, 'rename-account')
  if (!ok) {
    return { type: 'text', value: `Failed to rename account. Check logs for details.` }
  }
  const oldLabel = codexAcct.alias ?? codexAcct.accountId.slice(0, 12)
  return { type: 'text', value: `Renamed ${oldLabel} → ${newAlias}` }
}

function renameClaudeAccount(
  claudeAcct: Extract<ReturnType<typeof resolveClaudeAccountByPrefix>, { kind: 'unique' }>['account'],
  newAlias: string,
): { type: 'text'; value: string } {
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
