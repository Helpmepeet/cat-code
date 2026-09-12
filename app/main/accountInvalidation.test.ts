import { expect, test } from 'bun:test'

import {
  accountProfileSignedOutNoticeForReceipt,
  createAccountInvalidationDispatcher,
} from './accountInvalidation.js'
import type {
  AccountProfileSignedOutMessage,
  AccountSignOutReceipt,
} from '../shared/protocol.js'

function receipt(
  outcome: AccountSignOutReceipt['outcome'],
  overrides: Partial<AccountSignOutReceipt> = {},
): AccountSignOutReceipt {
  return {
    outcome,
    accountId: 'account-a',
    expectedCredentialGeneration: 3,
    observedCredentialGeneration:
      outcome === 'superseded' || outcome === 'retryable_unknown' ? null : 4,
    lifecycleState:
      outcome === 'superseded' || outcome === 'retryable_unknown'
        ? null
        : 'signed_out',
    operationId: 'operation-a',
    targetWasActive: false,
    replacementActiveAccountId: null,
    ...overrides,
  }
}

function notice(
  signedOutLifecycleGeneration: number,
  overrides: Partial<AccountProfileSignedOutMessage> = {},
): AccountProfileSignedOutMessage {
  return {
    type: 'account.profileSignedOut',
    requestId: `request-${signedOutLifecycleGeneration}`,
    operationId: 'operation-a',
    accountId: 'account-a',
    oldCredentialGeneration: signedOutLifecycleGeneration - 1,
    signedOutLifecycleGeneration,
    outcome: 'committed',
    lifecycleState: 'signed_out',
    ...overrides,
  }
}

test('committed, already-committed, and cleanup-pending receipts produce notices', () => {
  for (const outcome of ['committed', 'already_committed', 'cleanup_pending'] as const) {
    expect(accountProfileSignedOutNoticeForReceipt(
      'request-a',
      receipt(outcome),
    )).toMatchObject({
      type: 'account.profileSignedOut',
      requestId: 'request-a',
      operationId: 'operation-a',
      accountId: 'account-a',
      oldCredentialGeneration: 3,
      signedOutLifecycleGeneration: 4,
      outcome,
      lifecycleState: 'signed_out',
    })
  }
})

test('superseded, unknown, and inconsistent receipts do not produce notices', () => {
  expect(accountProfileSignedOutNoticeForReceipt(
    'request-a',
    receipt('superseded'),
  )).toBeNull()
  expect(accountProfileSignedOutNoticeForReceipt(
    'request-a',
    receipt('retryable_unknown'),
  )).toBeNull()
  expect(accountProfileSignedOutNoticeForReceipt(
    'request-a',
    receipt('cleanup_pending', { lifecycleState: 'credentialed' }),
  )).toBeNull()
  expect(accountProfileSignedOutNoticeForReceipt(
    'request-a',
    receipt('committed', { observedCredentialGeneration: 5 }),
  )).toBeNull()
})

test('ready sessions receive invalidations immediately and failed or exited sessions are skipped', () => {
  const sent: Array<{ sessionId: string; type: string }> = []
  const dispatcher = createAccountInvalidationDispatcher({
    send: (sessionId, message) => {
      sent.push({ sessionId, type: message.type })
      return true
    },
  })

  dispatcher.notifySignOut(notice(4), [
    { sessionId: 'ready', status: 'ready' },
    { sessionId: 'failed', status: 'failed' },
    { sessionId: 'exited', status: 'exited' },
  ])
  dispatcher.notifyDeletion('account-b', 'delete-b', [
    { sessionId: 'ready', status: 'ready' },
    { sessionId: 'failed', status: 'failed' },
    { sessionId: 'exited', status: 'exited' },
  ])

  expect(sent).toEqual([
    { sessionId: 'ready', type: 'account.profileSignedOut' },
    { sessionId: 'ready', type: 'account.profileDeleted' },
  ])
})

test('starting sessions queue notices and flush them when ready', () => {
  const sent: Array<{ sessionId: string; message: AccountInvalidationNoticeForTest }> = []
  const dispatcher = createAccountInvalidationDispatcher({
    send: (sessionId, message) => {
      sent.push({ sessionId, message })
      return true
    },
  })
  const sessions = [{ sessionId: 'starting', status: 'connecting' as const }]

  dispatcher.notifySignOut(notice(4), sessions)
  dispatcher.notifyDeletion('account-b', 'delete-b', sessions)
  expect(sent).toHaveLength(0)
  expect(dispatcher.pendingForTest('starting')).toMatchObject({
    deletionAccountIds: ['account-b'],
    signOutNotices: [notice(4)],
  })

  dispatcher.flush('starting')
  expect(sent.map(item => item.message.type)).toEqual([
    'account.profileSignedOut',
    'account.profileDeleted',
  ])
  expect(dispatcher.pendingForTest('starting')).toEqual({
    deletionAccountIds: [],
    signOutNotices: [],
  })
})

test('queued sign-out notices retain the newest generation and deduplicate duplicates', () => {
  const sent: AccountInvalidationNoticeForTest[] = []
  const dispatcher = createAccountInvalidationDispatcher({
    send: (_sessionId, message) => {
      sent.push(message)
      return true
    },
  })
  const sessions = [{ sessionId: 'starting', status: 'spawning' as const }]

  dispatcher.notifySignOut(notice(2), sessions)
  dispatcher.notifySignOut(notice(6), sessions)
  dispatcher.notifySignOut(notice(4), sessions)
  dispatcher.notifySignOut(notice(6, { requestId: 'replacement-request' }), sessions)

  expect(dispatcher.pendingForTest('starting').signOutNotices).toEqual([
    notice(6, { requestId: 'replacement-request' }),
  ])
  dispatcher.flush('starting')
  expect(sent).toEqual([
    notice(6, { requestId: 'replacement-request' }),
  ])
})

test('the latest committed mutation replaces an older queued invalidation', () => {
  const dispatcher = createAccountInvalidationDispatcher({
    send: () => true,
  })
  const sessions = [{ sessionId: 'starting', status: 'connecting' as const }]

  dispatcher.notifySignOut(notice(4), sessions)
  dispatcher.notifyDeletion('account-a', 'delete-a', sessions)
  expect(dispatcher.pendingForTest('starting')).toEqual({
    deletionAccountIds: ['account-a'],
    signOutNotices: [],
  })

  dispatcher.notifySignOut(notice(6), sessions)

  expect(dispatcher.pendingForTest('starting')).toEqual({
    deletionAccountIds: [],
    signOutNotices: [notice(6)],
  })
})

type AccountInvalidationNoticeForTest =
  | { type: 'account.profileDeleted'; requestId: string; accountId: string }
  | AccountProfileSignedOutMessage
