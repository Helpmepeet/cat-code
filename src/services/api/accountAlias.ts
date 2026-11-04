import { getClaudeProfileInventory } from './claudeAccountPool.js'
import { getCodexProfileInventory } from './codexAccountPool.js'

export type AccountAliasValidation = { ok: true } | { ok: false; message: string }

/** Validate only newly assigned names; legacy saved names remain readable. */
export function validateAccountAlias(
  alias: string,
  provider: 'anthropic' | 'openai',
  excludeAccountId?: string,
): AccountAliasValidation {
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(alias)) {
    return { ok: false, message: 'Use 1–32 letters, numbers, underscores, or hyphens.' }
  }
  const claude = getClaudeProfileInventory()
  const codex = getCodexProfileInventory()
  const names = [
    ...claude.accounts.map(account => ({ provider: 'anthropic', id: account.accountUuid, alias: account.alias })),
    ...claude.signedOutProfiles.map(profile => ({ provider: 'anthropic', id: profile.accountUuid, alias: profile.alias })),
    ...codex.accounts.map(account => ({ provider: 'openai', id: account.accountId, alias: account.alias })),
    ...codex.signedOutProfiles.map(profile => ({ provider: 'openai', id: profile.accountId, alias: profile.alias })),
  ]
  const duplicate = names.some(account =>
    !(account.provider === provider && account.id === excludeAccountId) &&
    account.alias?.toLowerCase() === alias.toLowerCase(),
  )
  return duplicate
    ? { ok: false, message: 'That account name is already in use.' }
    : { ok: true }
}
