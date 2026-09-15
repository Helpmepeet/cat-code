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

  // switchToAccount only updates pool.activeIndex; a lease pins its accountId at
  // creation time. So reassign whatever is live: the main-thread lease if a turn
  // is running right now, plus every `follow-main` subagent lease.
  //
  // The two have very different lifetimes, and the difference is why the desktop
  // path looked fine for so long. The main lease is per-TURN — registered at
  // `query.ts:422` and released in the `finally` at `:2137` — so a switch between
  // turns needs no reassignment at all: the next turn registers a fresh lease on
  // the new active account. A `follow-main` subagent lease outlives the turn, so
  // without this an async worker keeps spending the account the user switched off.
  reassignCodexLeasesToActiveAccount()

  // Hygiene, not routing. The conversation id is already keyed by
  // `${accountId}:${model}` (`codex-fetch-adapter.ts`), so B never inherits A's
  // entry and clearing it changes no account selection. What this actually drops
  // is the sticky-HTTP-fallback state, which is transport behavior carried over
  // from the account we just left.
  resetCodexCacheContext()

  // Mirror the Claude switch path: clear all auth-sensitive caches so stale
  // rate-limit state, memoized tokens, and tool schema caches don't carry over.
  await clearAuthRelatedCaches()
  applyPostCodexAccountSwitchRefresh()

  return account
}
