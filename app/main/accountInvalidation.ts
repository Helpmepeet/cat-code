import type {
  AccountProfileDeletedMessage,
  AccountProfileSignedOutMessage,
  AccountSignOutOutcome,
  AccountSignOutReceipt,
  SessionId,
} from '../shared/protocol.js'
import type { SidecarStatus } from '../supervisor/supervisor.js'

export type AccountInvalidationNotice =
  | AccountProfileDeletedMessage
  | AccountProfileSignedOutMessage

export type AccountInvalidationSession = {
  sessionId: SessionId
  status: SidecarStatus
}

export type AccountInvalidationDispatcher = {
  notifyDeletion(
    accountId: string,
    requestId: string,
    sessions: readonly AccountInvalidationSession[],
  ): void
  notifySignOut(
    notice: AccountProfileSignedOutMessage,
    sessions: readonly AccountInvalidationSession[],
  ): void
  flush(sessionId: SessionId): void
  clear(sessionId: SessionId): void
  clearAll(): void
  pendingForTest(sessionId: SessionId): {
    deletionAccountIds: string[]
    signOutNotices: AccountProfileSignedOutMessage[]
  }
}

type NoticeSender = (
  sessionId: SessionId,
  notice: AccountInvalidationNotice,
) => boolean

export function accountProfileSignedOutNoticeForReceipt(
  requestId: string,
  receipt: AccountSignOutReceipt,
): AccountProfileSignedOutMessage | null {
  const outcome: Extract<
    AccountSignOutOutcome,
    'committed' | 'already_committed' | 'cleanup_pending'
  > | null =
    receipt.outcome === 'committed' ||
    receipt.outcome === 'already_committed' ||
    receipt.outcome === 'cleanup_pending'
      ? receipt.outcome
      : null
  const expected = receipt.expectedCredentialGeneration
  const observed = receipt.observedCredentialGeneration
  if (
    outcome === null ||
    receipt.lifecycleState !== 'signed_out' ||
    typeof expected !== 'number' ||
    !Number.isSafeInteger(expected) ||
    expected < 0 ||
    typeof observed !== 'number' ||
    !Number.isSafeInteger(observed) ||
    observed < 0 ||
    observed !== expected + 1 ||
    receipt.operationId.length === 0
  ) {
    return null
  }
  return {
    type: 'account.profileSignedOut',
    requestId,
    operationId: receipt.operationId,
    accountId: receipt.accountId,
    oldCredentialGeneration: expected,
    signedOutLifecycleGeneration: observed,
    outcome,
    lifecycleState: 'signed_out',
  }
}

function isUnavailable(status: SidecarStatus): boolean {
  return status === 'failed' || status === 'exited'
}

function queueNotice(
  pending: Map<SessionId, Map<string, AccountInvalidationNotice>>,
  sessionId: SessionId,
  notice: AccountInvalidationNotice,
): void {
  const sessionPending = pending.get(sessionId) ?? new Map()
  if (notice.type === 'account.profileSignedOut') {
    const existing = sessionPending.get(notice.accountId)
    if (
      existing?.type === 'account.profileSignedOut' &&
      existing.signedOutLifecycleGeneration >
        notice.signedOutLifecycleGeneration
    ) {
      return
    }
  }
  sessionPending.set(notice.accountId, notice)
  pending.set(sessionId, sessionPending)
}

export function createAccountInvalidationDispatcher(options: {
  send: NoticeSender
}): AccountInvalidationDispatcher {
  const pending = new Map<
    SessionId,
    Map<string, AccountInvalidationNotice>
  >()

  const sendToSession = (
    sessionId: SessionId,
    notice: AccountInvalidationNotice,
  ): boolean => options.send(sessionId, notice)

  const notify = (
    notice: AccountInvalidationNotice,
    sessions: readonly AccountInvalidationSession[],
  ): void => {
    for (const session of sessions) {
      if (isUnavailable(session.status)) {
        continue
      }
      if (session.status === 'ready' && sendToSession(session.sessionId, notice)) {
        continue
      }
      queueNotice(pending, session.sessionId, notice)
    }
  }

  return {
    notifyDeletion(accountId, requestId, sessions) {
      notify(
        {
          type: 'account.profileDeleted',
          requestId,
          accountId,
        },
        sessions,
      )
    },

    notifySignOut(notice, sessions) {
      notify(notice, sessions)
    },

    flush(sessionId) {
      const sessionPending = pending.get(sessionId)
      if (!sessionPending) return
      for (const [accountId, notice] of sessionPending) {
        if (!sendToSession(sessionId, notice)) return
        sessionPending.delete(accountId)
      }
      if (sessionPending.size === 0) pending.delete(sessionId)
    },

    clear(sessionId) {
      pending.delete(sessionId)
    },

    clearAll() {
      pending.clear()
    },

    pendingForTest(sessionId) {
      const sessionPending = pending.get(sessionId)
      if (!sessionPending) {
        return { deletionAccountIds: [], signOutNotices: [] }
      }
      return {
        deletionAccountIds: [...sessionPending.values()]
          .filter(
            (notice): notice is AccountProfileDeletedMessage =>
              notice.type === 'account.profileDeleted',
          )
          .map(notice => notice.accountId),
        signOutNotices: [...sessionPending.values()].filter(
          (notice): notice is AccountProfileSignedOutMessage =>
            notice.type === 'account.profileSignedOut',
        ),
      }
    },
  }
}
