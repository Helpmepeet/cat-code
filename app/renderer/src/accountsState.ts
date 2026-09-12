import type {
  AccountResultFrame,
  AccountsSnapshot,
  AccountStatus,
  AccountSignOutReceipt,
  AnthropicAccountStatus,
  OAuthLoginProgress,
  ServerFrame,
  SessionId,
  SignedOutCodexProfileStatus,
  UsageStatsByRange,
  UsageStatsRange,
  UsageStatsSnapshot,
} from '../../shared/protocol.js'

export type AccountSignOutOverlayPhase =
  | 'signed_out'
  | 'reconciling'
  | 'checking'
  | 'refreshing'

export type AccountSignOutOverlay = {
  accountId: string
  expectedCredentialGeneration: number
  observedCredentialGeneration: number | null
  operationId: string
  phase: AccountSignOutOverlayPhase
  account: AccountStatus | null
  targetWasActive: boolean
  replacementActiveAccountId: string | null
  sequence: number
}

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
  signOutOverlays: Record<string, AccountSignOutOverlay>
  nextSignOutOverlaySequence: number
  /**
   * P4-15 — the live OAuth login progress per session (the first-run surface +
   * reauth banner drive their sub-states from it). Transient: set by the
   * `oauth.login.progress` frame, cleared by `oauthReset` (cancel/back) and when
   * the session tears down.
   */
  oauthProgress: Record<SessionId, OAuthLoginProgress | null>
  /**
   * Real usage statistics aggregated from session transcript logs.
   *
   * `null` means NOT LOADED, and is never the same thing as a snapshot whose
   * totals are zero. Readers must keep the two apart: a zero snapshot is a
   * measured fact about the user's history, a null is the absence of any
   * measurement, and rendering the second as the first is what made this page
   * tell users with 33k messages that they had no session activity.
   *
   * Two feeds, mirroring `pool` / `sessions` above:
   *  - the `usage-stats` HOST EVENT (accounts owner) fills BOTH ranges from
   *    main's timer and exists with no session open. This is the primary feed.
   *  - a session's own `stats.usage.snapshot` frame fills ONE range, in answer to
   *    a range toggle, and only while a sidecar is attached.
   *
   * Both write the same slots and last-write-wins. They run the same engine
   * aggregation but not at the same MOMENT, so a host event carrying data
   * measured at the start of a worker run can overwrite a fresher session-plane
   * snapshot and briefly walk the numbers backwards. Bounded by the refresh
   * period and self-healing on the next run; do not read a decrease here as
   * usage being reclaimed.
   */
  usageStats: Record<UsageStatsRange, UsageStatsSnapshot | null>
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
  /** The global `usage-stats` host event (accounts owner). Session-independent. */
  | { type: 'usage-stats'; stats: UsageStatsByRange }
  | { type: 'set-stats-range'; range: UsageStatsRange }

export function createAccountsState(): AccountsState {
  return {
    pool: null,
    sessions: {},
    lastSessions: {},
    lastResult: null,
    signOutOverlays: {},
    nextSignOutOverlaySequence: 1,
    oauthProgress: {},
    usageStats: {
      '7d': null,
      '30d': null,
    },
    activeStatsRange: '7d',
  }
}

function findKnownAccount(
  state: AccountsState,
  accountId: string,
): AccountStatus | null {
  const fromPool = state.pool?.accounts.find(account => account.id === accountId)
  if (fromPool) return fromPool
  for (const snapshot of Object.values(state.lastSessions)) {
    const account = snapshot.accounts.find(candidate => candidate.id === accountId)
    if (account) return account
  }
  return state.signOutOverlays[accountId]?.account ?? null
}

function withoutOverlay(
  overlays: Record<string, AccountSignOutOverlay>,
  accountId: string,
): Record<string, AccountSignOutOverlay> {
  if (!(accountId in overlays)) return overlays
  const next = { ...overlays }
  delete next[accountId]
  return next
}

function reduceAccountSignOutResult(
  state: AccountsState,
  frame: AccountResultFrame,
  receipt: AccountSignOutReceipt,
): AccountsState {
  if (receipt.outcome === 'superseded') {
    if (
      receipt.observedCredentialGeneration === null ||
      receipt.observedCredentialGeneration <=
        receipt.expectedCredentialGeneration
    ) {
      return {
        ...state,
        lastResult: frame,
        signOutOverlays: withoutOverlay(
          state.signOutOverlays,
          receipt.accountId,
        ),
      }
    }
    const overlay: AccountSignOutOverlay = {
      accountId: receipt.accountId,
      expectedCredentialGeneration: receipt.expectedCredentialGeneration,
      observedCredentialGeneration: receipt.observedCredentialGeneration,
      operationId: receipt.operationId,
      phase: 'refreshing',
      account: findKnownAccount(state, receipt.accountId),
      targetWasActive: false,
      replacementActiveAccountId: null,
      sequence: state.nextSignOutOverlaySequence,
    }
    return {
      ...state,
      lastResult: frame,
      signOutOverlays: {
        ...state.signOutOverlays,
        [receipt.accountId]: overlay,
      },
      nextSignOutOverlaySequence: state.nextSignOutOverlaySequence + 1,
    }
  }

  const phase: AccountSignOutOverlayPhase =
    receipt.outcome === 'cleanup_pending'
      ? 'reconciling'
      : receipt.outcome === 'retryable_unknown'
        ? 'checking'
        : 'signed_out'
  const overlay: AccountSignOutOverlay = {
    accountId: receipt.accountId,
    expectedCredentialGeneration: receipt.expectedCredentialGeneration,
    observedCredentialGeneration: receipt.observedCredentialGeneration,
    operationId: receipt.operationId,
    phase,
    account: findKnownAccount(state, receipt.accountId),
    targetWasActive: receipt.targetWasActive,
    replacementActiveAccountId: receipt.replacementActiveAccountId,
    sequence: state.nextSignOutOverlaySequence,
  }
  return {
    ...state,
    lastResult: frame,
    signOutOverlays: {
      ...state.signOutOverlays,
      [receipt.accountId]: overlay,
    },
    nextSignOutOverlaySequence: state.nextSignOutOverlaySequence + 1,
  }
}

function observedProfileGeneration(
  profile: SignedOutCodexProfileStatus | undefined,
): number | null {
  return profile?.lifecycleGeneration ?? profile?.credentialGeneration ?? null
}

function reconcileSignOutOverlays(
  overlays: Record<string, AccountSignOutOverlay>,
  snapshot: AccountsSnapshot,
): Record<string, AccountSignOutOverlay> {
  let next = overlays
  for (const overlay of Object.values(overlays)) {
    const account = snapshot.accounts.find(row => row.id === overlay.accountId)
    const profile = snapshot.signedOutProfiles.find(
      row => row.id === overlay.accountId,
    )
    const profileGeneration = observedProfileGeneration(profile)
    const requiredSignedOutGeneration =
      overlay.observedCredentialGeneration ??
      overlay.expectedCredentialGeneration + 1
    const signedOutObserved =
      profileGeneration !== null &&
      profileGeneration >= requiredSignedOutGeneration
    const credentialedObserved =
      account !== undefined &&
      (overlay.phase === 'refreshing'
        ? overlay.observedCredentialGeneration !== null &&
          account.credentialGeneration >= overlay.observedCredentialGeneration
        : account.credentialGeneration >
          (overlay.observedCredentialGeneration ??
            overlay.expectedCredentialGeneration))
    if (signedOutObserved || credentialedObserved) {
      next = withoutOverlay(next, overlay.accountId)
    }
  }
  return next
}

function syntheticSignedOutProfile(
  overlay: AccountSignOutOverlay,
): SignedOutCodexProfileStatus | null {
  if (
    !overlay.account?.hasVaultProfile ||
    overlay.observedCredentialGeneration === null
  ) {
    return null
  }
  return {
    id: overlay.accountId,
    alias: overlay.account.alias,
    state: overlay.phase === 'reconciling' ? 'recovery_required' : 'signed_out',
    credentialGeneration: overlay.observedCredentialGeneration,
    lifecycleGeneration: overlay.observedCredentialGeneration,
    credentialGenerationState: 'lifecycle_bound',
    lifecycleState: 'signed_out',
    lifecycleReadStatus: 'valid',
  }
}

function applySignOutOverlays(
  snapshot: AccountsSnapshot,
  overlays: Record<string, AccountSignOutOverlay>,
): AccountsSnapshot {
  const hidden = Object.values(overlays).filter(
    overlay =>
      overlay.phase === 'signed_out' || overlay.phase === 'reconciling',
  )
  if (hidden.length === 0) return snapshot

  const hiddenIds = new Set(hidden.map(overlay => overlay.accountId))
  const latestActive = hidden
    .filter(overlay => overlay.targetWasActive)
    .sort((a, b) => b.sequence - a.sequence)[0]
  const activeAccountId = latestActive
    ? latestActive.replacementActiveAccountId
    : snapshot.activeAccountId
  const accounts = snapshot.accounts
    .filter(account => !hiddenIds.has(account.id))
    .map(account => ({
      ...account,
      isDefault: account.id === activeAccountId,
      switchable:
        account.id === activeAccountId ? false : account.switchable,
    }))
  const signedOutProfiles = [...snapshot.signedOutProfiles]
  for (const overlay of hidden) {
    if (signedOutProfiles.some(profile => profile.id === overlay.accountId)) {
      continue
    }
    const profile = syntheticSignedOutProfile(overlay)
    if (profile) signedOutProfiles.push(profile)
  }
  return {
    ...snapshot,
    accounts,
    signedOutProfiles,
    activeAccountId,
    readyCount: accounts.filter(
      account => account.status === 'healthy' && !account.usageLimitReached,
    ).length,
    poolCount: accounts.length,
  }
}

export function reduceAccountsState(
  state: AccountsState,
  action: AccountsAction,
): AccountsState {
  if (action.type === 'pool') {
    return {
      ...state,
      pool: action.pool,
      signOutOverlays: reconcileSignOutOverlays(
        state.signOutOverlays,
        action.pool,
      ),
    }
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

  if (action.type === 'usage-stats') {
    return {
      ...state,
      usageStats: { '7d': action.stats['7d'], '30d': action.stats['30d'] },
    }
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
    if (frame.verb !== 'account.logout' || !frame.signOut) {
      return { ...state, lastResult: frame }
    }
    return reduceAccountSignOutResult(state, frame, frame.signOut)
  }

  if (frame.kind === 'stats.usage.snapshot') {
    return {
      ...state,
      usageStats: {
        ...state.usageStats,
        [frame.stats.range]: frame.stats,
      },
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
  const snapshot = state.pool ?? selectFirstAccountsSnapshot(state)
  if (!snapshot) return null
  return applySignOutOverlays(snapshot, state.signOutOverlays)
}

export function selectAccountSignOutOverlay(
  state: AccountsState,
  accountId: string,
): AccountSignOutOverlay | null {
  return state.signOutOverlays[accountId] ?? null
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
  return state.usageStats[targetRange]
}
