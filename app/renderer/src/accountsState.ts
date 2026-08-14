import type {
  AccountResultFrame,
  AccountsSnapshot,
  AccountStatus,
  AnthropicAccountStatus,
  OAuthLoginProgress,
  ServerFrame,
  SessionId,
  UsageStatsRange,
  UsageStatsSnapshot,
} from '../../shared/protocol.js'

/**
 * Renderer projection of the P4-5 accounts read-seam.
 *
 * TWO feeds, deliberately:
 *  - `pool` is the GLOBAL one (accounts owner,
 *    `docs/migration/decisions/ACCOUNTS-OWNERSHIP.md`): main polls a disposable
 *    worker and delivers an `accounts-pool` HOST EVENT, so it exists with no
 *    session open and refreshes on a timer. The Accounts page reads THIS.
 *  - `sessions` keeps each sidecar's own `accounts.snapshot`, which in-session
 *    surfaces (reauth banner, composer account chip) still read. It is emitted
 *    at attach and after that session's own pool-mutating verbs, so it is
 *    session-scoped and refresh-poor by construction — never treat it as the
 *    global pool view.
 *
 * `lastResult` carries the most recent `account.result` so the page can toast +
 * dismiss a dialog on the verb's real outcome (never an optimistic guess).
 * Read-only: no token is ever present on any field the reducer stores
 * (secretGuard-clean by construction).
 */
export type AccountsState = {
  /**
   * The global pool from the host event. Null until main's first worker run
   * lands; a failed run keeps the last good value rather than blanking it.
   */
  pool: AccountsSnapshot | null
  sessions: Record<SessionId, AccountsSnapshot | null>
  /**
   * What each session's sidecar last reported, KEPT after its engine goes away,
   * for the composer rail's account face. `sessions` still nulls on lifecycle so
   * nothing treats a dead session as a live pool feed. Every field here is
   * already secretGuard-clean, so retaining it holds no credential material that
   * the live map did not.
   */
  lastSessions: Record<SessionId, AccountsSnapshot>
  lastResult: AccountResultFrame | null
  /**
   * P4-15 — the live OAuth login progress per session (the first-run surface +
   * reauth banner drive their sub-states from it). Transient: set by the
   * `oauth.login.progress` frame, cleared by `oauthReset` (cancel/back) and when
   * the session tears down.
   */
  oauthProgress: Record<SessionId, OAuthLoginProgress | null>
  /**
   * Real usage statistics aggregated from session transcript logs.
   */
  usageStats: Record<UsageStatsRange, UsageStatsSnapshot | null>
  latestUsageStats: UsageStatsSnapshot | null
  activeStatsRange: UsageStatsRange
}

export type AccountsAction =
  | { type: 'frame'; frame: ServerFrame }
  /** Cancel/back cleared the OAuth surface locally (also sends the cancel verb). */
  | { type: 'oauthReset'; sessionId: SessionId }
  /** The global `accounts-pool` host event (accounts owner). Session-independent. */
  | { type: 'pool'; pool: AccountsSnapshot }
  /** The row is gone for good — drop its retained snapshot (see `lastSessions`). */
  | { type: 'session-removed'; sessionId: SessionId }
  | { type: 'set-stats-range'; range: UsageStatsRange }

export function createAccountsState(): AccountsState {
  return {
    pool: null,
    sessions: {},
    lastSessions: {},
    lastResult: null,
    oauthProgress: {},
    usageStats: {
      '7d': null,
      '30d': null,
    },
    latestUsageStats: null,
    activeStatsRange: '7d',
  }
}

export function reduceAccountsState(
  state: AccountsState,
  action: AccountsAction,
): AccountsState {
  if (action.type === 'pool') {
    return { ...state, pool: action.pool }
  }

  if (action.type === 'session-removed') {
    const { sessionId } = action
    if (
      !(sessionId in state.sessions) &&
      !(sessionId in state.lastSessions) &&
      !(sessionId in state.oauthProgress)
    ) {
      return state
    }
    const sessions = { ...state.sessions }
    const lastSessions = { ...state.lastSessions }
    const oauthProgress = { ...state.oauthProgress }
    delete sessions[sessionId]
    delete lastSessions[sessionId]
    delete oauthProgress[sessionId]
    return { ...state, sessions, lastSessions, oauthProgress }
  }

  if (action.type === 'set-stats-range') {
    return { ...state, activeStatsRange: action.range }
  }

  if (action.type === 'oauthReset') {
    if (state.oauthProgress[action.sessionId] == null) return state
    return {
      ...state,
      oauthProgress: { ...state.oauthProgress, [action.sessionId]: null },
    }
  }

  const { frame } = action

  if (frame.kind === 'accounts.snapshot') {
    return {
      ...state,
      sessions: { ...state.sessions, [frame.sessionId]: frame.accounts },
      lastSessions: { ...state.lastSessions, [frame.sessionId]: frame.accounts },
    }
  }

  if (frame.kind === 'oauth.login.progress') {
    return {
      ...state,
      oauthProgress: { ...state.oauthProgress, [frame.sessionId]: frame.progress },
    }
  }

  if (frame.kind === 'account.result') {
    return { ...state, lastResult: frame }
  }

  if (frame.kind === 'stats.usage.snapshot') {
    return {
      ...state,
      usageStats: {
        ...state.usageStats,
        [frame.stats.range]: frame.stats,
      },
      latestUsageStats: frame.stats,
    }
  }

  if (frame.kind === 'lifecycle') {
    if (!(frame.sessionId in state.sessions)) return state
    return {
      ...state,
      sessions: { ...state.sessions, [frame.sessionId]: null },
      oauthProgress: { ...state.oauthProgress, [frame.sessionId]: null },
    }
  }

  return state
}

export function selectAccountsSnapshot(
  state: AccountsState,
  sessionId: SessionId | null,
): AccountsSnapshot | null {
  const snapshot = sessionId ? state.sessions[sessionId] : undefined
  return snapshot ?? null
}

/**
 * A session's own accounts view, INCLUDING one whose engine has gone away —
 * what it was running on, for the composer rail's read-only account face.
 *
 * Display only. Never read it to decide whether an account may be SWITCHED:
 * that needs a sidecar, which is exactly what this outlives.
 */
export function selectLastAccountsSnapshot(
  state: AccountsState,
  sessionId: SessionId | null,
): AccountsSnapshot | null {
  if (!sessionId) return null
  return state.sessions[sessionId] ?? state.lastSessions[sessionId] ?? null
}

/** The active session's live OAuth login progress, or null when no flow is running. */
export function selectOAuthProgress(
  state: AccountsState,
  sessionId: SessionId | null,
): OAuthLoginProgress | null {
  const progress = sessionId ? state.oauthProgress[sessionId] : undefined
  return progress ?? null
}

/**
 * The first available pool snapshot across any session (P4-17 Welcome). The
 * Codex pool is process-GLOBAL, so any reporting session's snapshot represents
 * it — the same "any session's snapshot is a valid source" precedent the
 * sessions catalog uses. The launcher renders at empty-state (often no ACTIVE
 * session), so it reads this rather than the active-only selector, and grows no
 * new feed. Returns null on a true cold start (no session has reported yet).
 */
export function selectFirstAccountsSnapshot(
  state: AccountsState,
): AccountsSnapshot | null {
  for (const snapshot of Object.values(state.sessions)) {
    if (snapshot) return snapshot
  }
  return null
}

/**
 * The session-INDEPENDENT pool view (accounts owner). Prefers the polled global
 * snapshot from the `accounts-pool` host event; falls back to any session's own
 * snapshot only to cover the launch gap before main's first worker run lands, so
 * a session that is already attached fills the page immediately instead of
 * showing an empty state for the first few seconds. Null only when neither feed
 * has reported.
 *
 * Surfaces that must work with NO session open (the Accounts page, the launcher)
 * read this. It never consults `activeSessionId` — that coupling is the defect
 * ACCOUNTS-OWNERSHIP removed.
 */
export function selectGlobalAccountsSnapshot(
  state: AccountsState,
): AccountsSnapshot | null {
  return state.pool ?? selectFirstAccountsSnapshot(state)
}

/** The rows in pool order (the active account is flagged via `isDefault`). */
export function selectAccountRows(snapshot: AccountsSnapshot | null): AccountStatus[] {
  return snapshot?.accounts ?? []
}

/** The persisted active/default account, or null. */
export function selectActiveAccount(snapshot: AccountsSnapshot | null): AccountStatus | null {
  if (!snapshot) return null
  return snapshot.accounts.find(a => a.isDefault) ?? null
}

/** The active Anthropic subscription account, or null for non-pool routes. */
export function selectActiveAnthropicAccount(
  snapshot: AccountsSnapshot | null,
): AnthropicAccountStatus | null {
  if (!snapshot) return null
  return snapshot.anthropicAccounts.find(account => account.isDefault) ?? null
}

/** "N of M ready" header stat. */
export function selectReadyLabel(snapshot: AccountsSnapshot | null): string {
  if (!snapshot) return '0 of 0 ready'
  return `${snapshot.readyCount} of ${snapshot.poolCount} ready`
}

/** The first capped / usage-limited account, if any — drives the cap banner. */
export function selectCapAccount(snapshot: AccountsSnapshot | null): AccountStatus | null {
  if (!snapshot) return null
  return (
    snapshot.accounts.find(
      a => a.status === 'capped' || a.usageLimitReached,
    ) ?? null
  )
}

/** Aliases already in use (for the rename dialog's client-side uniqueness hint). */
export function selectTakenAliases(snapshot: AccountsSnapshot | null): string[] {
  if (!snapshot) return []
  return snapshot.accounts
    .map(a => a.alias)
    .filter((alias): alias is string => alias !== null)
}

/** Would deleting `accountId` leave another switchable account? (delete-dialog warning). */
export function selectHasOtherSwitchable(
  snapshot: AccountsSnapshot | null,
  accountId: string,
): boolean {
  if (!snapshot) return false
  return snapshot.accounts.some(
    a =>
      a.id !== accountId &&
      a.status === 'healthy' &&
      !a.usageLimitReached,
  )
}

/** Resolves usage statistics for the given range ('7d' | '30d') or the active range. */
export function selectUsageStatsForRange(
  state: AccountsState,
  range?: UsageStatsRange,
): UsageStatsSnapshot | null {
  const targetRange = range ?? state.activeStatsRange
  return (
    state.usageStats[targetRange] ??
    (state.latestUsageStats?.range === targetRange
      ? state.latestUsageStats
      : null)
  )
}
