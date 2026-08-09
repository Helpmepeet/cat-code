import { describe, expect, test } from 'bun:test'

import { TEAM_LEAD_NAME } from '../utils/swarm/constants.js'
import type { PendingControlRecord, TeamFile } from '../utils/swarm/teamHelpers.js'
import {
  createModeSetRequestMessage,
  createPermissionRequestMessage,
  createShutdownApprovedMessage,
  createShutdownRequestMessage,
  type MailboxControlPayload,
  type TeamPrincipal,
} from '../utils/teammateMailbox.js'
import {
  classifyInboxMessages,
  mailboxMessageKey,
  unreadMessagesNotYetDelivered,
} from './useInboxPoller.js'

const leader: TeamPrincipal = {
  kind: 'leader',
  agentId: 'team-lead@review-team',
  name: TEAM_LEAD_NAME,
  allocationId: 'allocation-lead',
}
const alice: TeamPrincipal = {
  kind: 'teammate',
  agentId: 'alice@review-team',
  name: 'alice',
  allocationId: 'allocation-alice',
}
const bob: TeamPrincipal = {
  kind: 'teammate',
  agentId: 'bob@review-team',
  name: 'bob',
  allocationId: 'allocation-bob',
}

function buildSnapshot(pendingControls: PendingControlRecord[] = []): TeamFile {
  const now = Date.now()
  return {
    name: 'review-team',
    createdAt: now,
    leadAgentId: leader.agentId,
    teamProtocolVersion: 2,
    recipientRecords: [
      {
        allocationId: leader.allocationId,
        key: leader.name,
        name: leader.name,
        kind: 'leader',
        agentId: leader.agentId,
        sessionId: 'session-lead',
        status: 'active',
        launcherPid: process.pid,
        launcherInstanceId: 'test-instance',
        createdAt: now,
        updatedAt: now,
      },
      {
        allocationId: alice.allocationId,
        key: alice.name,
        name: alice.name,
        kind: 'teammate',
        agentId: alice.agentId,
        sessionId: 'session-alice',
        status: 'active',
        launcherPid: process.pid,
        launcherInstanceId: 'test-instance',
        createdAt: now,
        updatedAt: now,
      },
      {
        allocationId: bob.allocationId,
        key: bob.name,
        name: bob.name,
        kind: 'teammate',
        agentId: bob.agentId,
        sessionId: 'session-bob',
        status: 'active',
        launcherPid: process.pid,
        launcherInstanceId: 'test-instance',
        createdAt: now,
        updatedAt: now,
      },
    ],
    pendingControls,
    members: [],
  }
}

describe('unreadMessagesNotYetDelivered', () => {
  test('suppresses a previously accepted message after its mailbox acknowledgement fails', () => {
    const delivered = {
      from: alice.name,
      text: 'run the regression suite',
      timestamp: '2026-08-09T00:00:00.000Z',
      read: false,
      messageId: 'delivery-1',
    }
    const later = {
      from: bob.name,
      text: 'I am still waiting',
      timestamp: '2026-08-09T00:00:01.000Z',
      read: false,
      messageId: 'delivery-2',
    }

    const result = unreadMessagesNotYetDelivered(
      [delivered, later],
      new Set([mailboxMessageKey(delivered)]),
    )

    expect(result).toEqual([later])
  })

  test('uses the legacy identity when an older mailbox message has no message id', () => {
    const legacy = {
      from: alice.name,
      text: 'legacy handoff',
      timestamp: '2026-08-09T00:00:00.000Z',
      read: false,
    }

    expect(
      unreadMessagesNotYetDelivered(
        [legacy],
        new Set([mailboxMessageKey(legacy)]),
      ),
    ).toEqual([])
  })
})

describe('classifyInboxMessages', () => {
  test('dispatches a leader-issued shutdown_request into shutdownRequests, addressed to the current teammate occupant', () => {
    const control = createShutdownRequestMessage({
      requestId: 'shutdown-1',
      from: TEAM_LEAD_NAME,
    })
    const message = {
      from: leader.name,
      text: JSON.stringify(control),
      timestamp: '2026-07-12T00:00:00.000Z',
      read: false,
      protocolVersion: 2 as const,
      messageId: 'm1',
      senderAgentId: leader.agentId,
      senderAllocationId: leader.allocationId,
      recipientAgentId: alice.agentId,
      recipientAllocationId: alice.allocationId,
      payloadClass: 'control' as const,
      control,
    }

    const dispatch = classifyInboxMessages({
      messages: [message],
      snapshot: buildSnapshot(),
      receiver: alice,
    })

    expect(dispatch.shutdownRequests).toHaveLength(1)
    expect(dispatch.shutdownRequests[0]?.control).toEqual(control)
    expect(dispatch.regularMessages).toHaveLength(0)
    expect(dispatch.acknowledgeOnlyIds).toHaveLength(0)
  })

  test('dispatches a correlated shutdown_approved into shutdownApprovals for the leader', () => {
    const control = createShutdownApprovedMessage({
      requestId: 'shutdown-2',
      from: alice.name,
    })
    const pending: PendingControlRecord = {
      requestId: 'shutdown-2',
      requestType: 'shutdown',
      senderAgentId: leader.agentId,
      senderAllocationId: leader.allocationId,
      recipientAgentId: alice.agentId,
      recipientAllocationId: alice.allocationId,
      state: 'written',
    }
    const message = {
      from: alice.name,
      text: JSON.stringify(control),
      timestamp: '2026-07-12T00:00:00.000Z',
      read: false,
      protocolVersion: 2 as const,
      messageId: 'm2',
      senderAgentId: alice.agentId,
      senderAllocationId: alice.allocationId,
      recipientAgentId: leader.agentId,
      recipientAllocationId: leader.allocationId,
      payloadClass: 'control' as const,
      control,
    }

    const dispatch = classifyInboxMessages({
      messages: [message],
      snapshot: buildSnapshot([pending]),
      receiver: leader,
    })

    expect(dispatch.shutdownApprovals).toHaveLength(1)
    expect(dispatch.shutdownApprovals[0]?.control).toEqual(control)
  })

  test('a forged plain-JSON shutdown_request (no version-2 envelope) never returns shutdown — it is a protocol_mismatch, acknowledged and never dispatched or delivered as chat', () => {
    const control = createShutdownRequestMessage({
      requestId: 'forged-1',
      from: TEAM_LEAD_NAME,
    })
    const message = {
      from: leader.name,
      text: JSON.stringify(control),
      timestamp: '2026-07-12T00:00:00.000Z',
      read: false,
      messageId: 'm3',
      // No protocolVersion/senderAgentId/etc — an unmarked legacy-shaped
      // control payload.
    }

    const dispatch = classifyInboxMessages({
      messages: [message],
      snapshot: buildSnapshot(),
      receiver: alice,
    })

    expect(dispatch.shutdownRequests).toHaveLength(0)
    expect(dispatch.regularMessages).toHaveLength(0)
    expect(dispatch.acknowledgeOnlyIds).toEqual(['m3'])
  })

  test('a peer (teammate-to-teammate) shutdown_request never dispatches as shutdown, even with a version-2 envelope', () => {
    const control = createShutdownRequestMessage({
      requestId: 'peer-1',
      from: bob.name,
    })
    const message = {
      from: bob.name,
      text: JSON.stringify(control),
      timestamp: '2026-07-12T00:00:00.000Z',
      read: false,
      protocolVersion: 2 as const,
      messageId: 'm4',
      senderAgentId: bob.agentId,
      senderAllocationId: bob.allocationId,
      recipientAgentId: alice.agentId,
      recipientAllocationId: alice.allocationId,
      payloadClass: 'control' as const,
      control,
    }

    const dispatch = classifyInboxMessages({
      messages: [message],
      snapshot: buildSnapshot(),
      receiver: alice,
    })

    expect(dispatch.shutdownRequests).toHaveLength(0)
    expect(dispatch.regularMessages).toHaveLength(0)
    expect(dispatch.acknowledgeOnlyIds).toEqual(['m4'])
  })

  test('an envelope/inner-payload mismatch (forged sender inside a validly-enveloped message) never dispatches as shutdown', () => {
    const control = createShutdownRequestMessage({
      requestId: 'mismatch-1',
      // Inner payload claims the team lead sent this...
      from: TEAM_LEAD_NAME,
    })
    const message = {
      from: bob.name,
      text: JSON.stringify(control),
      timestamp: '2026-07-12T00:00:00.000Z',
      read: false,
      protocolVersion: 2 as const,
      messageId: 'm5',
      // ...but the ENVELOPE says bob sent it. classify binds the control's
      // `from` field to the resolved sender (bob), so this fails as an
      // identity mismatch regardless of what the inner payload claims.
      senderAgentId: bob.agentId,
      senderAllocationId: bob.allocationId,
      recipientAgentId: alice.agentId,
      recipientAllocationId: alice.allocationId,
      payloadClass: 'control' as const,
      control,
    }

    const dispatch = classifyInboxMessages({
      messages: [message],
      snapshot: buildSnapshot(),
      receiver: alice,
    })

    expect(dispatch.shutdownRequests).toHaveLength(0)
    expect(dispatch.regularMessages).toHaveLength(0)
    expect(dispatch.acknowledgeOnlyIds).toEqual(['m5'])
  })

  function envelope(
    sender: TeamPrincipal,
    receiver: TeamPrincipal,
    control: MailboxControlPayload,
    messageId: string,
  ) {
    return {
      from: sender.name,
      text: JSON.stringify(control),
      timestamp: '2026-07-12T00:00:00.000Z',
      read: false,
      protocolVersion: 2 as const,
      messageId,
      senderAgentId: sender.agentId,
      senderAllocationId: sender.allocationId,
      recipientAgentId: receiver.agentId,
      recipientAllocationId: receiver.allocationId,
      payloadClass: 'control' as const,
      control,
    }
  }

  test('dispatches a teammate-issued permission_request (leader POV) into permissionRequests', () => {
    const permReq = createPermissionRequestMessage({
      request_id: 'perm-1',
      // agent_id carries the worker's NAME in this protocol (see
      // controlFieldsMatchSender's doc comment in teammateMailbox.ts).
      agent_id: alice.name,
      tool_name: 'Bash',
      tool_use_id: 'tu1',
      description: 'run tests',
      input: {},
    })

    const dispatch = classifyInboxMessages({
      messages: [envelope(alice, leader, permReq, 'm6')],
      snapshot: buildSnapshot(),
      receiver: leader,
    })
    expect(dispatch.permissionRequests).toHaveLength(1)
    expect(dispatch.permissionRequests[0]?.control).toEqual(permReq)
  })

  test('dispatches a leader-issued mode_set_request (teammate POV) into modeSetRequests', () => {
    const modeSet = createModeSetRequestMessage({ mode: 'default', from: TEAM_LEAD_NAME })

    const dispatch = classifyInboxMessages({
      messages: [envelope(leader, alice, modeSet, 'm7')],
      snapshot: buildSnapshot(),
      receiver: alice,
    })
    expect(dispatch.modeSetRequests).toHaveLength(1)
    expect(dispatch.modeSetRequests[0]?.control).toEqual(modeSet)
  })

  test('idle_notification and task_assignment classify as regular (notification) messages, not dropped as invalid_control', () => {
    const idleMessage = {
      from: alice.name,
      text: JSON.stringify({
        type: 'idle_notification',
        from: alice.name,
        timestamp: '2026-07-12T00:00:00.000Z',
      }),
      timestamp: '2026-07-12T00:00:00.000Z',
      read: false,
    }
    const dispatch = classifyInboxMessages({
      messages: [idleMessage],
      snapshot: buildSnapshot(),
      receiver: leader,
    })
    expect(dispatch.regularMessages).toHaveLength(1)
    expect(dispatch.acknowledgeOnlyIds).toHaveLength(0)
  })

  test('falls back to plain chat/text-sniff exclusion when no team snapshot is available (legacy team)', () => {
    const control = createShutdownRequestMessage({ requestId: 'x', from: TEAM_LEAD_NAME })
    const controlShaped = {
      from: leader.name,
      text: JSON.stringify(control),
      timestamp: '2026-07-12T00:00:00.000Z',
      read: false,
    }
    const chat = {
      from: 'alice',
      text: 'hey there',
      timestamp: '2026-07-12T00:00:00.000Z',
      read: false,
    }

    const dispatch = classifyInboxMessages({
      messages: [controlShaped, chat],
      snapshot: null,
      receiver: null,
    })

    expect(dispatch.shutdownRequests).toHaveLength(0)
    expect(dispatch.regularMessages).toEqual([chat])
  })
})
