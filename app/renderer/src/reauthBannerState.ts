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
 *
 * P4-15 revision (operator findings #1/#2/#8 — revises `decisions/STARTUP-GATES.md
 * §3` and its 2026-07-12 P4-24 revision note). Three defects, one redesign:
 *   (1) MERGE — when EVERY account is dead the old code emitted one banner per
 *       dead account, each repeating the identical pool-level "no healthy account
 *       remains" sentence (five stacked walls). The all-dead case now derives a
 *       SINGLE consolidated wall (`selectReauthWall`): the pool sentence stated
 *       ONCE, then a row per dead account keeping its OWN real reason + a
 *       per-account re-authenticate affordance. `selectReauthBanners` now covers
 *       only the NON-blocking (per-account, dismissable) case.
 *   (2) PERSIST-ACKNOWLEDGE — the Codex pool is process-global, so every session
 *       re-derives the same wall; the wall id is keyed to the pool-dead STATE
 *       (the sorted dead-account id set), never a session, so a persisted
 *       acknowledge (caller-owned, mirroring the dismissed-id set) survives
 *       session switches and does not re-nag — yet a genuinely different dead set
 *       re-nags.
 *   (3) COLLAPSE, not hide — acknowledging COLLAPSES the wall to a minimal
 *       persistent indicator (caller presentation) rather than hiding it; turns
 *       are genuinely still blocked, so the reason must stay discoverable.
 * `selectAuthSubmitBlocked` is UNCHANGED: submit stays blocked at zero-healthy
 * regardless of acknowledge/collapse.
 */

import type { BannerNotice } from './BannerStack.js'
import type { AccountsSnapshot, AccountStatus } from '../../shared/protocol.js'

/** Stable id prefix so re-deriving the same dead account updates in place. */
export const REAUTH_BANNER_PREFIX = 'reauth:'

/**
 * Stable id prefix for the merged all-dead wall (P4-15 revision). The rest of
 * the id is the sorted dead-account id set, so the id is keyed to the pool-dead
 * STATE and NOT a session: the global pool re-derives the same wall id in every
 * session (a persisted acknowledge suppresses the re-nag) while a different dead
 * set produces a different id (a genuinely new episode re-nags).
 */
export const REAUTH_WALL_PREFIX = 'reauth:wall:'

/** Stable action key the caller switches on to launch the OAuth flow. */
export const REAUTH_ACTION_KEY = 'reauthenticate'

/**
 * The pool's own reason for an account's death — `lastError`, else the
 * normalized `statusReason`, else a generic line. Never a renderer-fabricated
 * cause.
 */
function reasonText(account: AccountStatus): string {
  return (
    account.lastError ??
    (account.statusReason ? account.statusReason.replace(/_/g, ' ') : null) ??
    'the stored token can no longer be refreshed'
  )
}

/** Human copy for a dead account's reason, prefixed with its label. */
function reasonDetail(account: AccountStatus): string {
  const label = account.alias ?? account.id
  return `${label} · ${reasonText(account)}`
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
 * Derive the NON-blocking reauth banners: one dismissable banner per dead
 * account while at least one healthy account remains. The engine pool simply
 * fails over, so each is an independent "never show again"-able nudge (the
 * caller persists dismissals and filters via `selectVisibleReauthBanners`).
 *
 * The BLOCKING (all-dead) case returns `[]` here — it is MERGED into a single
 * consolidated surface by `selectReauthWall` (P4-15 revision, finding #1), so
 * the pool-level "new turns are blocked" sentence is stated once, not once per
 * dead account.
 */
export function selectReauthBanners(
  snapshot: AccountsSnapshot | null,
): BannerNotice[] {
  if (selectAuthSubmitBlocked(snapshot)) return []
  const dead = selectDeadAccounts(snapshot)
  if (dead.length === 0) return []
  return dead.map(account => {
    const label = account.alias ?? account.id
    return {
      id: `${REAUTH_BANNER_PREFIX}${account.id}`,
      tone: 'danger',
      title: `${label} needs re-authentication`,
      detail: reasonDetail(account),
      actions: [
        { key: REAUTH_ACTION_KEY, label: 'Re-authenticate', primary: true },
      ],
      // Non-blocking (failover covers you) → dismissable.
      dismissable: true,
    }
  })
}

/**
 * The NON-blocking reauth banners MINUS any the operator dismissed for good
 * ("never show again" — the caller persists the id set). Only dismissable
 * per-account banners reach here now; the all-dead wall is a separate merged
 * surface (`selectReauthWall`) that is never in this list, so a dismissed id
 * simply hides its per-account banner.
 */
export function selectVisibleReauthBanners(
  snapshot: AccountsSnapshot | null,
  dismissedIds: ReadonlySet<string>,
): BannerNotice[] {
  return selectReauthBanners(snapshot).filter(
    banner => !dismissedIds.has(banner.id),
  )
}

/** One dead account's row inside the merged all-dead wall. */
export type ReauthWallAccountRow = {
  /** Account id — stable React key + honest per-account identity. */
  id: string
  /** `alias ?? id`. */
  label: string
  /** The pool's own reason for this account's death (never fabricated). */
  reason: string
  /** Per-account re-authenticate action key (`reauthenticate:<id>`). */
  actionKey: string
}

/**
 * The merged all-dead wall (P4-15 revision, findings #1/#2/#8). Present only when
 * `selectAuthSubmitBlocked` — one consolidated surface stating the pool-level
 * block ONCE plus a row per dead account carrying its OWN preserved reason.
 */
export type ReauthWall = {
  /**
   * Stable id keyed to the pool-dead STATE (sorted dead-account ids), NOT a
   * session — so a persisted acknowledge survives session switches without
   * re-nagging, yet a genuinely different dead set re-nags. See
   * `REAUTH_WALL_PREFIX`.
   */
  id: string
  /** The pool-level headline, stated ONCE. */
  title: string
  /** The pool-level "new turns are blocked" sentence, stated ONCE (not per row). */
  summary: string
  /** Each dead account with its own preserved reason + re-auth affordance. */
  accounts: ReauthWallAccountRow[]
  /** Compact label for the collapsed (acknowledged) minimal indicator. */
  collapsedLabel: string
}

/**
 * Derive the merged wall for the fully-exhausted pool, or `null` when the pool
 * is not blocked (`selectAuthSubmitBlocked === false`). `selectAuthSubmitBlocked`
 * guarantees at least one dead account, so `accounts` is non-empty. The pool
 * sentence lives on the wall itself (once); each row carries only its account's
 * own reason.
 */
export function selectReauthWall(
  snapshot: AccountsSnapshot | null,
): ReauthWall | null {
  if (!selectAuthSubmitBlocked(snapshot)) return null
  const dead = selectDeadAccounts(snapshot)
  const sortedIds = dead.map(a => a.id).sort()
  return {
    id: `${REAUTH_WALL_PREFIX}${sortedIds.join(',')}`,
    title: 'Sign in again to continue',
    summary:
      'No healthy account remains — new turns are blocked until you re-link.',
    accounts: dead.map(account => ({
      id: account.id,
      label: account.alias ?? account.id,
      reason: reasonText(account),
      actionKey: `${REAUTH_ACTION_KEY}:${account.id}`,
    })),
    collapsedLabel:
      dead.length === 1
        ? 'New turns blocked — re-authenticate to continue'
        : `New turns blocked — ${dead.length} accounts need re-authentication`,
  }
}
