/**
 * Reauth banner derivation (P4-15) — the D4/Q2 ruling made concrete.
 *
 * Token death surfaces as a NON-BLOCKING, persistent banner (the prototype's
 * blocking `ReauthGate` modal is CUT — `decisions/STARTUP-GATES.md §5-Q2`). The
 * banner is DERIVED from the P4-5 accounts read-seam (`AccountsSnapshot`, the
 * real redacted Codex pool), never pushed imperatively — it re-derives every
 * render and mounts into the P4-1 `BannerStack`. Its "Re-authenticate" action
 * launches the existing `account.login` OAuth flow (P4-5 verb; the re-linked
 * account re-appears on the next `accounts.snapshot`); the caller owns dispatch.
 *
 * Submit-block threshold (the real-only rule the prototype lacks): new turns are
 * blocked ONLY when the pool is initialized, non-empty, and ZERO healthy
 * accounts remain (`readyCount === 0`) — one dead account among healthy ones
 * never walls the window (the pool's multi-account failover is the engine's job:
 * `codexAccountPool.ts`). Reason surfaced honestly from the redacted
 * `statusReason` / `lastError` the pool already computed — the renderer invents
 * no error text.
 */

import type { BannerNotice } from './BannerStack.js'
import type { AccountsSnapshot, AccountStatus } from '../../shared/protocol.js'

/** Stable id prefix so re-deriving the same dead account updates in place. */
export const REAUTH_BANNER_PREFIX = 'reauth:'

/** Stable action key the caller switches on to launch the OAuth flow. */
export const REAUTH_ACTION_KEY = 'reauthenticate'

/**
 * Human copy for a dead account's reason. Falls back to the pool's own
 * `lastError`, then its `statusReason`, then a generic line — never a
 * renderer-fabricated cause.
 */
function reasonDetail(account: AccountStatus): string {
  const label = account.alias ?? account.id
  const reason =
    account.lastError ??
    (account.statusReason ? account.statusReason.replace(/_/g, ' ') : null) ??
    'the stored token can no longer be refreshed'
  return `${label} · ${reason}`
}

/**
 * The dead (auth-failed) accounts, in pool order. `status: 'dead'` is the pool's
 * terminal auth state (`statusReason: 'auth_dead'`); capped/quarantined accounts
 * are transient and NEVER produce a reauth banner (they recover on their own).
 */
export function selectDeadAccounts(
  snapshot: AccountsSnapshot | null,
): AccountStatus[] {
  if (!snapshot) return []
  return snapshot.accounts.filter(a => a.status === 'dead')
}

/**
 * TRUE only when new turns must be blocked: the pool is initialized, holds at
 * least one account, none are ready (`readyCount === 0`), AND at least one
 * account is auth-DEAD. The block is the death wall (Q2/G5) — the state the
 * reauth banner explains. A zero-ready pool with only TRANSIENT caps/quarantines
 * (no dead) is deliberately NOT walled here: it falls through to the engine's
 * own loud quota-exhausted error + failover (`STARTUP-GATES.md §6`), which is
 * more informative than a silent renderer block. Zero-account / uninitialized
 * pools are first-run (OAuth surface), not a reauth block.
 */
export function selectAuthSubmitBlocked(
  snapshot: AccountsSnapshot | null,
): boolean {
  if (!snapshot || !snapshot.initialized) return false
  if (snapshot.poolCount === 0 || snapshot.readyCount > 0) return false
  return snapshot.accounts.some(a => a.status === 'dead')
}

/**
 * Derive the reauth banners for the active session's pool. One banner per dead
 * account (its alias + real reason); when the pool is fully exhausted
 * (`selectAuthSubmitBlocked`) the copy also says submit is blocked. Empty when
 * the pool has no dead accounts. Banners are non-dismissable (persist until
 * acted on — the prototype's Dismiss is CUT, `STARTUP-GATES.md §3`).
 */
export function selectReauthBanners(
  snapshot: AccountsSnapshot | null,
): BannerNotice[] {
  const dead = selectDeadAccounts(snapshot)
  if (dead.length === 0) return []
  const blocked = selectAuthSubmitBlocked(snapshot)
  return dead.map(account => {
    const label = account.alias ?? account.id
    return {
      id: `${REAUTH_BANNER_PREFIX}${account.id}`,
      tone: 'danger',
      title: blocked
        ? `Sign in again to continue — ${label} can’t be refreshed`
        : `${label} needs re-authentication`,
      detail: blocked
        ? `${reasonDetail(account)}. No healthy account remains, so new turns are blocked until you re-link.`
        : reasonDetail(account),
      actions: [
        { key: REAUTH_ACTION_KEY, label: 'Re-authenticate', primary: true },
      ],
      dismissable: false,
    }
  })
}
