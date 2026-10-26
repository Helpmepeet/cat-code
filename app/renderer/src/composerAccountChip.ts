import type { AnthropicAccountStatus } from '../../shared/protocol.js'
import { anthropicAccountCapped } from './accountsPageModel.js'

export function canSwitchAnthropicAccount(
  account: AnthropicAccountStatus,
  activeId: string,
): boolean {
  return account.id !== activeId &&
    account.status === 'healthy' &&
    account.loginStale !== true &&
    !anthropicAccountCapped(account)
}

export function listComposerAnthropicAccounts(
  accounts: AnthropicAccountStatus[],
  activeId?: string,
): AnthropicAccountStatus[] {
  return accounts.filter(account =>
    account.loginStale !== true ||
    account.id === activeId ||
    account.isDefault,
  )
}

/**
 * Toggle the account switcher, requesting a fresh global pool only as it opens.
 *
 * Keeping the request outside a React state updater avoids StrictMode's
 * development-only updater double invocation.
 */
export function toggleAccountChip(
  open: boolean,
  onOpen?: () => void,
): boolean {
  if (!open) onOpen?.()
  return !open
}
