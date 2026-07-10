import type {
  AccountResultFrame,
  AccountsSnapshot,
  AccountStatus,
  ServerFrame,
  SessionId,
} from '../../shared/protocol.js'

/**
 * Renderer projection of the P4-5 accounts read-seam. The Codex pool is
 * process-GLOBAL, but each session's sidecar reports it addressed to that
 * session, so snapshots are kept per session (uniform with the other domains);
 * the Accounts page reads the ACTIVE session's snapshot. `lastResult` carries the
 * most recent `account.result` so the page can toast + dismiss a dialog on the
 * verb's real outcome (never an optimistic guess). Read-only: no token is ever
 * present on any field the reducer stores (secretGuard-clean by construction).
 */
export type AccountsState = {
  sessions: Record<SessionId, AccountsSnapshot | null>
  lastResult: AccountResultFrame | null
}

export type AccountsAction = { type: 'frame'; frame: ServerFrame }

export function createAccountsState(): AccountsState {
  return { sessions: {}, lastResult: null }
}

export function reduceAccountsState(
  state: AccountsState,
  action: AccountsAction,
): AccountsState {
  const { frame } = action

  if (frame.kind === 'accounts.snapshot') {
    return {
      ...state,
      sessions: { ...state.sessions, [frame.sessionId]: frame.accounts },
    }
  }

  if (frame.kind === 'account.result') {
    return { ...state, lastResult: frame }
  }

  if (frame.kind === 'lifecycle') {
    if (!(frame.sessionId in state.sessions)) return state
    return {
      ...state,
      sessions: { ...state.sessions, [frame.sessionId]: null },
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

/** The rows in pool order (the active account is flagged via `isDefault`). */
export function selectAccountRows(snapshot: AccountsSnapshot | null): AccountStatus[] {
  return snapshot?.accounts ?? []
}

/** The persisted active/default account, or null. */
export function selectActiveAccount(snapshot: AccountsSnapshot | null): AccountStatus | null {
  if (!snapshot) return null
  return snapshot.accounts.find(a => a.isDefault) ?? null
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
