/**
 * Read-only, advisory observation of the Codex (ChatGPT/OpenAI) credential pool.
 *
 * Powers `cat-code codex status --json`. Emits ONE pool-wide, machine-readable
 * snapshot so an external agent can decide whether to delegate GPT work now,
 * wait, or require human recovery. It is ADVISORY only — never a reservation,
 * never a promise a profile will work.
 *
 * Hard safety contract (see the subcommand spec):
 *   - No OAuth token refresh, no rotation, no probe start, no periodic refresh.
 *   - No writes to cap state / routing hints / persisted active profile / leases.
 *   - `refresh: 'never'` makes ZERO outbound network requests (reads only the
 *     usage hints already present on the pool accounts).
 *   - `refresh: 'auto'` may make a bounded, coalesced usage GET, but only via the
 *     existing refresh-free 60s-cached `fetchPoolUsage` path with
 *     `updateRoutingHints: false` (never mutates cap state).
 *
 * Opacity: never emit raw accountId, alias, email, vault path, token, or raw
 * error strings. Profiles are keyed by a stable opaque `cp_<4hex>` hash of the
 * accountId; routing/block classification comes only from the closed
 * status/statusReason enums.
 */

import { createHash, randomUUID } from 'node:crypto'

import { logForDebugging } from '../../utils/debug.js'
import {
  getCodexAccountAvailability,
  getPoolAccountUsageScore,
  getPoolStatus,
  getRedemptionEligibility,
  hasFreshPoolAccountUsageHint,
  isCodexAccountSwitchable,
  loadPoolForObservation,
  type PoolAccount,
} from './codexAccountPool.js'
import {
  fetchPoolUsage,
  type AccountUsage,
  type FetchPoolUsageOptions,
  type PoolUsageSnapshot,
} from './codexUsage.js'

// ── Schema ───────────────────────────────────────────────────────────────────

export const CODEX_STATUS_SCHEMA = 'cat-code.codex.status'
export const CODEX_STATUS_VERSION = 1

export type CodexStatusRefreshMode = 'auto' | 'never'

export type CodexStatusUsageRefresh = 'live' | 'cached' | 'none'
export type CodexProfileUsageFreshness = 'live' | 'cached' | 'stale' | 'none'

export type CodexStatusDecisionAction =
  | 'delegate'
  | 'wait'
  | 'recheck'
  | 'attempt'
  | 'human_recovery'

export type CodexStatusReasonCode =
  | 'candidate_available'
  | 'quota_blocked_reset_known'
  | 'quota_blocked_no_reset'
  | 'observation_uncertain'
  | 'all_auth_blocked'
  | 'no_accounts'

export type CodexRoutingState =
  | 'candidate'
  | 'quota_blocked'
  | 'auth_blocked'
  | 'transient_blocked'
  | 'unknown'

export type CodexBlockCode =
  | 'usage_cap'
  | 'runtime_cap'
  | 'auth_dead'
  | 'probe_pending_transport'
  | 'unknown'
  | null

export interface CodexStatusUsageWindow {
  used_percent: number | null
  window_remaining_percent: number | null
  reset_at: string | null
}

export interface CodexStatusProfileUsage {
  freshness: CodexProfileUsageFreshness
  observed_at: string | null
  allowed: boolean | null
  limit_reached: boolean | null
  primary: CodexStatusUsageWindow
  secondary: CodexStatusUsageWindow | null
  reset_credits_available: number | null
}

export interface CodexStatusProfile {
  profile_ref: string
  is_persisted_active: boolean
  routing_state: CodexRoutingState
  block_code: CodexBlockCode
  usage: CodexStatusProfileUsage
  recovery: { redeem_eligible: boolean }
}

export interface CodexStatusObservation {
  scope: 'standalone_process'
  cap_state_shared_with_next_process: false
  reservation: false
  usage_refresh: CodexStatusUsageRefresh
  credential_refresh: 'not_attempted'
  next_probe_after: string | null
}

export interface CodexStatusDecision {
  action: CodexStatusDecisionAction
  reason_code: CodexStatusReasonCode
  not_before: string | null
  predicted_initial_profile_ref: string | null
  best_observed_candidate_profile_ref: string | null
}

export interface CodexStatusPool {
  profiles_total: number
  candidate: number
  quota_blocked: number
  auth_blocked: number
  transient_blocked: number
  unknown: number
  earliest_known_reset_at: string | null
}

export interface CodexStatus {
  ok: true
  schema: typeof CODEX_STATUS_SCHEMA
  version: typeof CODEX_STATUS_VERSION
  observed_at: string
  observation_id: string
  advisory: true
  observation: CodexStatusObservation
  decision: CodexStatusDecision
  pool: CodexStatusPool
  profiles: CodexStatusProfile[]
}

// ── Options ──────────────────────────────────────────────────────────────────

export interface BuildCodexStatusOptions {
  /** Wall-clock reference for availability/reset math. Defaults to Date.now(). */
  now?: number
  /** 'auto' (default) permits the cached, refresh-free usage GET; 'never' fetches nothing. */
  refresh?: CodexStatusRefreshMode
  /**
   * When true (default), populate the pool via the read-only `loadPoolForObservation`.
   * Tests seed the pool directly and pass false.
   */
  loadPool?: boolean
  /**
   * Injectable usage fetcher (defaults to the real refresh-free `fetchPoolUsage`).
   * Only ever called in 'auto' mode. Tests pass a mock so no network is hit.
   */
  fetchUsage?: (options: FetchPoolUsageOptions) => Promise<PoolUsageSnapshot>
}

// ── Opaque profile reference ─────────────────────────────────────────────────

/** Stable, opaque short id derived from the raw accountId. Never reversible to the id. */
function toProfileRef(accountId: string): string {
  return `cp_${createHash('sha256').update(accountId).digest('hex').slice(0, 4)}`
}

// ── Timestamp helpers ────────────────────────────────────────────────────────

/** Convert epoch milliseconds to an RFC3339 UTC string, or null when unusable. */
function isoFromMs(ms: number | undefined | null): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null
  return new Date(ms).toISOString()
}

/** Convert a wham/usage reset_at (Unix *seconds*, 0 = unknown) to RFC3339, or null. */
function isoFromSeconds(seconds: number | undefined | null): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null
  return new Date(seconds * 1000).toISOString()
}

function remainingPercent(usedPercent: number | null): number | null {
  if (usedPercent === null) return null
  return Math.min(100, Math.max(0, 100 - usedPercent))
}

// ── Classification ───────────────────────────────────────────────────────────

interface ProfileClassification {
  routing_state: CodexRoutingState
  block_code: CodexBlockCode
}

/**
 * Map a pool account to a coarse routing bucket + a specific block code, using
 * ONLY the closed status/statusReason enums (never lastError). `candidate` means
 * the account is currently switchable per `getCodexAccountAvailability`.
 */
function classifyProfile(account: PoolAccount, now: number): ProfileClassification {
  if (getCodexAccountAvailability(account, now).kind !== 'blocked') {
    return { routing_state: 'candidate', block_code: null }
  }

  const reason = account.statusReason

  if (account.status === 'dead' || reason === 'auth_dead') {
    return { routing_state: 'auth_blocked', block_code: 'auth_dead' }
  }

  if (account.status === 'quarantined' || reason === 'probe_pending_transport') {
    return { routing_state: 'transient_blocked', block_code: 'probe_pending_transport' }
  }

  if (account.status === 'capped') {
    if (reason === 'usage_cap') return { routing_state: 'quota_blocked', block_code: 'usage_cap' }
    if (reason === 'runtime_cap') return { routing_state: 'quota_blocked', block_code: 'runtime_cap' }
    return { routing_state: 'quota_blocked', block_code: reason ?? 'unknown' }
  }

  // Healthy status but blocked by a fresh usage-poll hint reporting a cap.
  if (account.usageAllowed === false || account.usageLimitReached === true) {
    return { routing_state: 'quota_blocked', block_code: 'usage_cap' }
  }

  return { routing_state: 'unknown', block_code: reason ?? 'unknown' }
}

// ── Best-candidate selection (read-only replica of findLRUHealthy(-1)) ────────

/**
 * Read-only replica of the pool's internal `findLRUHealthy(-1)` ranking:
 * prefer clean (`available`) switchable accounts, rank by usage score when fresh
 * usage exists, else fall back to LRU. Emits nothing and mutates nothing.
 */
function findBestCandidate(accounts: readonly PoolAccount[], now: number): PoolAccount | null {
  const candidates = accounts.filter((a) => isCodexAccountSwitchable(a, now))
  if (candidates.length === 0) return null

  const clean = candidates.filter(
    (a) => getCodexAccountAvailability(a, now).kind === 'available',
  )
  const rankable = clean.length > 0 ? clean : candidates

  const hasFreshUsage = rankable.some((a) => hasFreshPoolAccountUsageHint(a, now))
  if (hasFreshUsage) {
    return [...rankable].sort(
      (a, b) => getPoolAccountUsageScore(a, now) - getPoolAccountUsageScore(b, now),
    )[0]!
  }

  let best: PoolAccount | null = null
  let bestTime = Infinity
  for (const a of rankable) {
    if (a.lastUsedAt < bestTime) {
      bestTime = a.lastUsedAt
      best = a
    }
  }
  return best
}

// ── Usage projection ─────────────────────────────────────────────────────────

function buildProfileUsage(
  account: PoolAccount,
  usage: AccountUsage | undefined,
  usageRefresh: CodexStatusUsageRefresh,
): CodexStatusProfileUsage {
  if (usage) {
    const primaryUsed = usage.primaryWindow.usedPercent
    const secondaryUsed = usage.secondaryWindow.usedPercent
    return {
      // 'none' can only occur in 'never' mode where `usage` is always undefined,
      // so a present snapshot entry is always 'live' or 'cached'.
      freshness: usageRefresh === 'cached' ? 'cached' : 'live',
      observed_at: isoFromMs(usage.fetchedAt),
      allowed: usage.allowed,
      limit_reached: usage.limitReached,
      primary: {
        used_percent: primaryUsed,
        window_remaining_percent: remainingPercent(primaryUsed),
        reset_at: isoFromSeconds(usage.primaryWindow.resetAt),
      },
      secondary:
        usage.hasSecondaryWindow === false
          ? null
          : {
              used_percent: secondaryUsed,
              window_remaining_percent: remainingPercent(secondaryUsed),
              reset_at: isoFromSeconds(usage.secondaryWindow.resetAt),
            },
      reset_credits_available: usage.resetCreditsAvailable ?? null,
    }
  }

  // No live/cached snapshot entry — fall back to the hints stamped on the account.
  if (account.usageFetchedAt != null) {
    const primaryUsed = account.usagePrimary ?? null
    const secondaryUsed = account.usageWeekly ?? null
    return {
      freshness: 'stale',
      observed_at: isoFromMs(account.usageFetchedAt),
      allowed: account.usageAllowed ?? null,
      limit_reached: account.usageLimitReached ?? null,
      primary: {
        used_percent: primaryUsed,
        window_remaining_percent: remainingPercent(primaryUsed),
        reset_at: isoFromSeconds(account.usageResetAt),
      },
      secondary: {
        used_percent: secondaryUsed,
        window_remaining_percent: remainingPercent(secondaryUsed),
        reset_at: null,
      },
      reset_credits_available: null,
    }
  }

  return {
    freshness: 'none',
    observed_at: null,
    allowed: null,
    limit_reached: null,
    primary: { used_percent: null, window_remaining_percent: null, reset_at: null },
    secondary: { used_percent: null, window_remaining_percent: null, reset_at: null },
    reset_credits_available: null,
  }
}

/** Earliest quota reset (Unix seconds) among quota-blocked accounts, or null. */
function quotaResetSeconds(
  account: PoolAccount,
  usage: AccountUsage | undefined,
): number | null {
  const primaryReset = usage ? usage.primaryWindow.resetAt : account.usageResetAt
  if (typeof primaryReset === 'number' && Number.isFinite(primaryReset) && primaryReset > 0) {
    return primaryReset
  }
  return null
}

// ── Decision ─────────────────────────────────────────────────────────────────

function decide(
  pool: CodexStatusPool,
): { action: CodexStatusDecisionAction; reason_code: CodexStatusReasonCode } {
  if (pool.profiles_total === 0) {
    return { action: 'human_recovery', reason_code: 'no_accounts' }
  }
  if (pool.candidate >= 1) {
    return { action: 'delegate', reason_code: 'candidate_available' }
  }
  // All profiles are blocked.
  if (pool.transient_blocked > 0 || pool.unknown > 0) {
    // A live request is more authoritative than a transient/unknown observation.
    return { action: 'attempt', reason_code: 'observation_uncertain' }
  }
  if (pool.quota_blocked > 0) {
    return pool.earliest_known_reset_at
      ? { action: 'wait', reason_code: 'quota_blocked_reset_known' }
      : { action: 'recheck', reason_code: 'quota_blocked_no_reset' }
  }
  // Remaining blocked profiles are all auth-blocked.
  return { action: 'human_recovery', reason_code: 'all_auth_blocked' }
}

// ── Builder ──────────────────────────────────────────────────────────────────

/**
 * Build the pool-wide advisory observation. Read-only: no refresh, no rotation,
 * no probe, no cap-state/lease/active-profile writes.
 */
export async function buildCodexStatus(
  options: BuildCodexStatusOptions = {},
): Promise<CodexStatus> {
  const now = options.now ?? Date.now()
  const refresh: CodexStatusRefreshMode = options.refresh === 'never' ? 'never' : 'auto'
  const loadPool = options.loadPool !== false
  const fetchUsage = options.fetchUsage ?? fetchPoolUsage

  if (loadPool) {
    await loadPoolForObservation()
  }

  // Usage refresh: 'never' touches no network; 'auto' uses the refresh-free,
  // 60s-cached fetch with routing-hint mutation disabled.
  let snapshot: PoolUsageSnapshot | null = null
  let usageRefresh: CodexStatusUsageRefresh = 'none'
  if (refresh === 'auto') {
    const callStart = Date.now()
    snapshot = await fetchUsage({ forceRefresh: false, updateRoutingHints: false })
    // A freshly-polled snapshot is stamped at/after callStart; an older
    // fetchedAt means the 60s cache satisfied the request.
    usageRefresh = snapshot.fetchedAt >= callStart ? 'live' : 'cached'
  }

  const usageByAccount = new Map<string, AccountUsage>(
    (snapshot?.accounts ?? []).map((u) => [u.accountId, u] as const),
  )

  const { accounts, activeIndex } = getPoolStatus()
  const activeAccountId = activeIndex >= 0 ? accounts[activeIndex]?.accountId : undefined

  const poolCounts: CodexStatusPool = {
    profiles_total: accounts.length,
    candidate: 0,
    quota_blocked: 0,
    auth_blocked: 0,
    transient_blocked: 0,
    unknown: 0,
    earliest_known_reset_at: null,
  }

  let earliestResetSeconds: number | null = null

  const profiles: CodexStatusProfile[] = accounts.map((account) => {
    const usage = usageByAccount.get(account.accountId)
    const classification = classifyProfile(account, now)

    switch (classification.routing_state) {
      case 'candidate':
        poolCounts.candidate += 1
        break
      case 'quota_blocked':
        poolCounts.quota_blocked += 1
        break
      case 'auth_blocked':
        poolCounts.auth_blocked += 1
        break
      case 'transient_blocked':
        poolCounts.transient_blocked += 1
        break
      case 'unknown':
        poolCounts.unknown += 1
        break
    }

    if (classification.routing_state === 'quota_blocked') {
      const resetSeconds = quotaResetSeconds(account, usage)
      if (resetSeconds !== null && (earliestResetSeconds === null || resetSeconds < earliestResetSeconds)) {
        earliestResetSeconds = resetSeconds
      }
    }

    return {
      profile_ref: toProfileRef(account.accountId),
      is_persisted_active: account.accountId === activeAccountId,
      routing_state: classification.routing_state,
      block_code: classification.block_code,
      usage: buildProfileUsage(account, usage, usageRefresh),
      recovery: { redeem_eligible: getRedemptionEligibility(account).eligible },
    }
  })

  poolCounts.earliest_known_reset_at = isoFromSeconds(earliestResetSeconds)

  const { action, reason_code } = decide(poolCounts)

  const best = findBestCandidate(accounts, now)
  const persistedActive = activeIndex >= 0 ? (accounts[activeIndex] ?? null) : null
  const predicted =
    persistedActive && isCodexAccountSwitchable(persistedActive, now) ? persistedActive : best

  return {
    ok: true,
    schema: CODEX_STATUS_SCHEMA,
    version: CODEX_STATUS_VERSION,
    observed_at: new Date().toISOString(),
    observation_id: `obs_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
    advisory: true,
    observation: {
      scope: 'standalone_process',
      cap_state_shared_with_next_process: false,
      reservation: false,
      usage_refresh: usageRefresh,
      credential_refresh: 'not_attempted',
      next_probe_after: null,
    },
    decision: {
      action,
      reason_code,
      not_before: action === 'wait' ? poolCounts.earliest_known_reset_at : null,
      predicted_initial_profile_ref: predicted ? toProfileRef(predicted.accountId) : null,
      best_observed_candidate_profile_ref: best ? toProfileRef(best.accountId) : null,
    },
    pool: poolCounts,
    profiles,
  }
}

/** Shape of the error object emitted on internal command failure (nonzero exit). */
export interface CodexStatusError {
  ok: false
  schema: typeof CODEX_STATUS_SCHEMA
  version: typeof CODEX_STATUS_VERSION
  observed_at: string
  advisory: true
  error: string
}

/**
 * Build a valid-JSON error observation for the malformed/internal-failure path.
 * The message is intentionally generic — never leak raw error strings (which may
 * carry vault paths or ids). Real detail goes to the debug log.
 */
export function buildCodexStatusError(err: unknown): CodexStatusError {
  logForDebugging(
    `[codex-status] observation failed: ${err instanceof Error ? err.message : String(err)}`,
    { level: 'warn' },
  )
  return {
    ok: false,
    schema: CODEX_STATUS_SCHEMA,
    version: CODEX_STATUS_VERSION,
    observed_at: new Date().toISOString(),
    advisory: true,
    error: 'failed to build codex status observation',
  }
}
