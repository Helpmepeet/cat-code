import { clearAuthRelatedCaches } from '../../commands/logout/logout.js'
import {
  applyPostCodexAccountSwitchRefresh,
  switchToAccount,
  type PoolAccount,
} from './codexAccountPool.js'
import { reassignCodexLeasesToActiveAccount } from './codexAccountLeaseManager.js'
import { resetCodexCacheContext } from './codex-fetch-adapter.js'

/**
 * The engine-state half of a manual Codex account switch, as one transaction.
 *
 * `switchToAccount` alone only moves `pool.activeIndex`; every other step here
 * is what makes the rest of the process agree with it. Callers that ran
 * `switchToAccount` on its own kept live `follow-main` leases (and therefore
 * API routing and the status line) on the previous account, and carried the
 * previous account's auth/sticky-fallback caches into the next request.
 *
 * Engine state only. UI/context effects (`onChangeAPIKey`, message rewrites,
 * app state, provider switching, diagnostics) belong to the caller, so the
 * terminal command and the desktop executor can share this without sharing a
 * UI plane.
 */
export async function commitCodexAccountSwitch(
  idPrefix: string | null,
): Promise<PoolAccount | null> {
  const account = switchToAccount(idPrefix)
  if (!account) return null

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
  applyPostCodexAccountSwitchRefresh()

  return account
}
