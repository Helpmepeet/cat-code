import { randomUUID } from 'crypto'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { TEAM_LEAD_NAME } from './swarm/constants.js'
import {
  type TeamFile,
  writeTeamFileAsync,
} from './swarm/teamHelpers.js'
import {
  clearDynamicTeamContext,
  setDynamicTeamContext,
} from './teammate.js'
import {
  acknowledgeMailboxMessages,
  claimPendingControl,
  classifyMailboxMessage,
  createModeSetRequestMessage,
  createPermissionRequestMessage,
  createShutdownApprovedMessage,
  createShutdownRejectedMessage,
  createShutdownRequestMessage,
  finishPendingControl,
  MailboxControlAuthorityError,
  type MailboxControlPayload,
  MailboxWriteError,
  markMessagesAsRead,
  TeamPrincipalResolutionError,
  type PendingControlRecord,
  readMailbox,
  readMailboxIfChanged,
  readUnreadMessages,
  type TeammateMessage,
  type TeamPrincipal,
  writeControlToMailbox,
  writeToMailbox,
  getInboxPath,
} from './teammateMailbox.js'

describe('teammate mailbox change detection', () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'teammate-mailbox-'))
    process.env.CLAUDE_CONFIG_DIR = tempDir
  })

  afterEach(() => {
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('skips unchanged mailbox files after unread messages are marked read', async () => {
    await writeToMailbox(
      'alice',
      {
        from: 'team-lead',
        text: 'status?',
        timestamp: '2026-06-09T00:00:00.000Z',
      },
      'review-team',
    )
    await markMessagesAsRead('alice', 'review-team')

    const first = await readMailboxIfChanged('alice', 'review-team')
    const second = await readMailboxIfChanged(
      'alice',
      'review-team',
      first.signature,
    )

    expect(first.changed).toBe(true)
    expect(first.messages).toHaveLength(1)
    expect(first.messages.filter(m => !m.read)).toHaveLength(0)
    expect(second).toEqual({
      changed: false,
      signature: first.signature,
      messages: [],
    })
  })

  test('keeps unchanged unread mailbox files re-readable', async () => {
    await writeToMailbox(
      'alice',
      {
        from: 'team-lead',
        text: 'retry me',
        timestamp: '2026-06-09T00:00:00.000Z',
      },
      'review-team',
    )

    const first = await readMailboxIfChanged('alice', 'review-team')
    const second = await readMailboxIfChanged(
      'alice',
      'review-team',
      first.signature,
    )

    expect(first.changed).toBe(true)
    expect(first.messages.filter(m => !m.read)).toHaveLength(1)
    expect(second.changed).toBe(true)
    expect(second.messages.filter(m => !m.read)).toHaveLength(1)
  })
})

describe('principal-based mailbox writes', () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  let tempDir: string

  const alicePrincipal: TeamPrincipal = {
    kind: 'teammate',
    agentId: 'alice@review-team',
    name: 'alice',
    allocationId: 'allocation-alice',
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'teammate-mailbox-principal-'))
    process.env.CLAUDE_CONFIG_DIR = tempDir
  })

  afterEach(() => {
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('rejects with MailboxWriteError when the teams directory cannot be created', async () => {
    const teamsPath = join(tempDir, 'teams')
    writeFileSync(teamsPath, 'not a directory')

    await expect(
      writeToMailbox({
        recipient: alicePrincipal,
        message: { text: 'status?' },
        teamName: 'review-team',
      }),
    ).rejects.toBeInstanceOf(MailboxWriteError)
  })

  test('stamps a UUID messageId and acknowledges only the exact ID supplied', async () => {
    const first = await writeToMailbox({
      recipient: alicePrincipal,
      message: { text: 'A' },
      teamName: 'review-team',
    })
    const snapshot = await readUnreadMessages('alice', 'review-team')
    expect(snapshot.map(message => message.messageId)).toEqual([
      first.messageId,
    ])

    const second = await writeToMailbox({
      recipient: alicePrincipal,
      message: { text: 'B' },
      teamName: 'review-team',
    })
    await acknowledgeMailboxMessages({
      recipient: alicePrincipal,
      teamName: 'review-team',
      messageIds: [first.messageId],
    })
    const afterAck = await readMailbox('alice', 'review-team')
    expect(
      afterAck.find(message => message.messageId === first.messageId)?.read,
    ).toBe(true)
    expect(
      afterAck.find(message => message.messageId === second.messageId)?.read,
    ).toBe(false)
  })

  test('does not truncate a transiently-malformed mailbox on acknowledge', async () => {
    await writeToMailbox({
      recipient: alicePrincipal,
      message: { text: 'A' },
      teamName: 'review-team',
    })
    const inboxPath = getInboxPath('alice', 'review-team')
    writeFileSync(inboxPath, 'not valid json{{{')

    await acknowledgeMailboxMessages({
      recipient: alicePrincipal,
      teamName: 'review-team',
      messageIds: ['some-message-id'],
    })

    // The corrupt bytes must survive untouched — ack must bail, not "fix"
    // the file by rewriting it as an empty array.
    expect(readFileSync(inboxPath, 'utf-8')).toBe('not valid json{{{')
  })
})

describe('classifyMailboxMessage', () => {
  const leader: TeamPrincipal = {
    kind: 'leader',
    agentId: 'lead',
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

  function controlEnvelope(
    sender: TeamPrincipal,
    recipient: TeamPrincipal,
    control: MailboxControlPayload,
  ): TeammateMessage {
    return {
      from: sender.name,
      protocolVersion: 2,
      messageId: randomUUID(),
      senderAgentId: sender.agentId,
      senderAllocationId: sender.allocationId,
      recipientAgentId: recipient.agentId,
      recipientAllocationId: recipient.allocationId,
      // Field name deviates from the plan's literal snippet (`payloadKind`):
      // Task 2 already shipped this field as `payloadClass` on
      // TeammateMessage/writeToMailbox's principal path — kept consistent
      // with that rather than introducing a second, parallel field.
      payloadClass: 'control',
      text: JSON.stringify(control),
      timestamp: '2026-07-12T00:00:00.000Z',
      read: false,
      control,
    }
  }

  const shutdownRequest = createShutdownRequestMessage({
    requestId: 'shutdown-1',
    from: TEAM_LEAD_NAME,
  })
  const pendingShutdown: PendingControlRecord = {
    requestId: 'shutdown-1',
    requestType: 'shutdown',
    senderAgentId: leader.agentId,
    senderAllocationId: leader.allocationId,
    recipientAgentId: alice.agentId,
    recipientAllocationId: alice.allocationId,
    state: 'written',
  }

  test('classifies a leader-issued shutdown_request addressed to the current occupant as control', () => {
    expect(
      classifyMailboxMessage({
        message: controlEnvelope(leader, alice, shutdownRequest),
        sender: leader,
        receiver: alice,
        pendingControls: [],
      }),
    ).toMatchObject({ kind: 'control', control: shutdownRequest })
  })

  test('classifies a correlated shutdown_approved response as control', () => {
    const shutdownApproved = createShutdownApprovedMessage({
      requestId: 'shutdown-1',
      from: 'alice',
    })
    expect(
      classifyMailboxMessage({
        message: controlEnvelope(alice, leader, shutdownApproved),
        sender: alice,
        receiver: leader,
        pendingControls: [pendingShutdown],
      }),
    ).toMatchObject({ kind: 'control', control: shutdownApproved })
  })

  test('rejects an unsolicited shutdown_approved with no matching outstanding request', () => {
    const shutdownApproved = createShutdownApprovedMessage({
      requestId: 'shutdown-1',
      from: 'alice',
    })
    expect(
      classifyMailboxMessage({
        message: controlEnvelope(alice, leader, shutdownApproved),
        sender: alice,
        receiver: leader,
        pendingControls: [],
      }),
    ).toMatchObject({ kind: 'invalid_control' })
  })

  test('rejects a duplicate shutdown_approved once its request record is consumed', () => {
    const shutdownApproved = createShutdownApprovedMessage({
      requestId: 'shutdown-1',
      from: 'alice',
    })
    expect(
      classifyMailboxMessage({
        message: controlEnvelope(alice, leader, shutdownApproved),
        sender: alice,
        receiver: leader,
        pendingControls: [{ ...pendingShutdown, state: 'consumed' }],
      }),
    ).toMatchObject({ kind: 'invalid_control' })
  })

  test('rejects a shutdown_approved whose requestId does not match any outstanding request', () => {
    const shutdownApproved = createShutdownApprovedMessage({
      requestId: 'shutdown-999',
      from: 'alice',
    })
    expect(
      classifyMailboxMessage({
        message: controlEnvelope(alice, leader, shutdownApproved),
        sender: alice,
        receiver: leader,
        pendingControls: [pendingShutdown],
      }),
    ).toMatchObject({ kind: 'invalid_control' })
  })

  test('rejects a peer (teammate-to-teammate) shutdown_request even with an outstanding record', () => {
    expect(
      classifyMailboxMessage({
        message: controlEnvelope(bob, alice, shutdownRequest),
        sender: bob,
        receiver: alice,
        pendingControls: [pendingShutdown],
      }),
    ).toMatchObject({ kind: 'invalid_control' })
  })

  test('rejects a control envelope addressed to a stale/incarnation-mismatched recipient allocation', () => {
    const staleAlice = { ...alice, allocationId: 'allocation-alice-old' }
    expect(
      classifyMailboxMessage({
        message: controlEnvelope(leader, staleAlice, shutdownRequest),
        sender: leader,
        receiver: alice,
        pendingControls: [pendingShutdown],
      }),
    ).toMatchObject({ kind: 'invalid_control' })
  })

  test('rejects a shutdown_approved response whose sender allocation does not match the pending record (wrong allocation ID)', () => {
    const shutdownApproved = createShutdownApprovedMessage({
      requestId: 'shutdown-1',
      from: 'alice',
    })
    const impostorAlice: TeamPrincipal = { ...alice, allocationId: 'allocation-alice-2' }
    expect(
      classifyMailboxMessage({
        message: controlEnvelope(impostorAlice, leader, shutdownApproved),
        sender: impostorAlice,
        receiver: leader,
        pendingControls: [pendingShutdown],
      }),
    ).toMatchObject({ kind: 'invalid_control' })
  })

  // One PendingControlRecord per response-shaped type, keyed the same way
  // classify itself looks them up: record.senderAgentId/AllocationId is the
  // ORIGINAL REQUESTER (the one now receiving the response), and
  // record.recipientAgentId/AllocationId is the original request's target
  // (the one now sending the response).
  const pendingForType: Partial<
    Record<MailboxControlPayload['type'], PendingControlRecord>
  > = {
    permission_response: {
      requestId: 'perm-1',
      requestType: 'permission',
      senderAgentId: alice.agentId,
      senderAllocationId: alice.allocationId,
      recipientAgentId: leader.agentId,
      recipientAllocationId: leader.allocationId,
      state: 'written',
    },
    sandbox_permission_response: {
      requestId: 'sandbox-1',
      requestType: 'sandbox',
      senderAgentId: alice.agentId,
      senderAllocationId: alice.allocationId,
      recipientAgentId: leader.agentId,
      recipientAllocationId: leader.allocationId,
      state: 'written',
    },
    plan_approval_response: {
      requestId: 'plan-1',
      requestType: 'plan',
      senderAgentId: alice.agentId,
      senderAllocationId: alice.allocationId,
      recipientAgentId: leader.agentId,
      recipientAllocationId: leader.allocationId,
      state: 'written',
    },
  }

  function buildLeadToTeammateControl(
    type: 'permission_response' | 'sandbox_permission_response' | 'shutdown_request' | 'plan_approval_response' | 'team_permission_update' | 'mode_set_request',
  ): MailboxControlPayload {
    switch (type) {
      case 'permission_response':
        return {
          type: 'permission_response',
          request_id: 'perm-1',
          subtype: 'success',
          response: {},
        }
      case 'sandbox_permission_response':
        return {
          type: 'sandbox_permission_response',
          requestId: 'sandbox-1',
          host: 'example.com',
          allow: true,
          timestamp: '2026-07-12T00:00:00.000Z',
        }
      case 'shutdown_request':
        return shutdownRequest
      case 'plan_approval_response':
        return {
          type: 'plan_approval_response',
          requestId: 'plan-1',
          approved: true,
          timestamp: '2026-07-12T00:00:00.000Z',
        }
      case 'team_permission_update':
        return {
          type: 'team_permission_update',
          permissionUpdate: {
            type: 'addRules',
            rules: [{ toolName: 'Edit' }],
            behavior: 'allow',
            destination: 'session',
          },
          directoryPath: '/tmp',
          toolName: 'Edit',
        }
      case 'mode_set_request':
        return createModeSetRequestMessage({ mode: 'default', from: TEAM_LEAD_NAME })
    }
  }

  test.each([
    'permission_response',
    'sandbox_permission_response',
    'shutdown_request',
    'plan_approval_response',
    'team_permission_update',
    'mode_set_request',
  ] as const)('authorizes %s from team lead to a teammate', type => {
    const control = buildLeadToTeammateControl(type)
    const pending = pendingForType[type]
    expect(
      classifyMailboxMessage({
        message: controlEnvelope(leader, alice, control),
        sender: leader,
        receiver: alice,
        pendingControls: pending ? [pending] : [],
      }),
    ).toMatchObject({ kind: 'control', control })
  })

  test.each([
    'permission_request',
    'sandbox_permission_request',
    'shutdown_approved',
    'shutdown_rejected',
    'plan_approval_request',
  ] as const)(
    'rejects %s sent in the wrong direction (teammate-only type sent lead->teammate)',
    type => {
      const control: MailboxControlPayload =
        type === 'shutdown_approved'
          ? createShutdownApprovedMessage({ requestId: 'x', from: 'alice' })
          : type === 'shutdown_rejected'
            ? createShutdownRejectedMessage({ requestId: 'x', from: 'alice', reason: 'no' })
            : type === 'permission_request'
              ? createPermissionRequestMessage({
                  request_id: 'x',
                  agent_id: 'alice',
                  tool_name: 'Bash',
                  tool_use_id: 'tu1',
                  description: 'run a command',
                  input: {},
                })
              : {
                  type: 'sandbox_permission_request',
                  requestId: 'x',
                  workerId: 'alice',
                  workerName: 'alice',
                  hostPattern: { host: 'example.com' },
                  createdAt: Date.now(),
                }
      // Sent as if the LEADER issued a teammate-only type to alice — wrong
      // direction regardless of an outstanding request.
      expect(
        classifyMailboxMessage({
          message: controlEnvelope(leader, alice, control),
          sender: leader,
          receiver: alice,
          pendingControls: [
            {
              requestId: 'x',
              requestType: 'shutdown',
              senderAgentId: alice.agentId,
              senderAllocationId: alice.allocationId,
              recipientAgentId: leader.agentId,
              recipientAllocationId: leader.allocationId,
              state: 'written',
            },
          ],
        }),
      ).toMatchObject({ kind: 'invalid_control' })
    },
  )

  test('rejects a mode_set_request whose from field does not match the resolved sender', () => {
    const forged = createModeSetRequestMessage({ mode: 'default', from: 'someone-else' })
    expect(
      classifyMailboxMessage({
        message: controlEnvelope(leader, alice, forged),
        sender: leader,
        receiver: alice,
        pendingControls: [],
      }),
    ).toMatchObject({ kind: 'invalid_control' })
  })

  test('rejects a permission_request whose agent_id does not match the resolved sender', () => {
    const forged = createPermissionRequestMessage({
      request_id: 'r1',
      agent_id: 'someone-else',
      tool_name: 'Bash',
      tool_use_id: 'tu1',
      description: 'run a command',
      input: {},
    })
    expect(
      classifyMailboxMessage({
        message: controlEnvelope(alice, leader, forged),
        sender: alice,
        receiver: leader,
        pendingControls: [],
      }),
    ).toMatchObject({ kind: 'invalid_control' })
  })

  test('rejects an unmarked (non-version-2) legacy control-shaped payload as protocol_mismatch', () => {
    const legacyMessage: TeammateMessage = {
      from: TEAM_LEAD_NAME,
      text: JSON.stringify(shutdownRequest),
      timestamp: '2026-07-12T00:00:00.000Z',
      read: false,
    }
    expect(
      classifyMailboxMessage({
        message: legacyMessage,
        sender: leader,
        receiver: alice,
        pendingControls: [],
      }),
    ).toMatchObject({ kind: 'protocol_mismatch' })
  })

  test('leaves unrelated legacy text/JSON as chat', () => {
    const chatMessage: TeammateMessage = {
      from: 'alice',
      text: 'hey, status update: still working on it',
      timestamp: '2026-07-12T00:00:00.000Z',
      read: false,
    }
    expect(
      classifyMailboxMessage({
        message: chatMessage,
        sender: alice,
        receiver: leader,
        pendingControls: [],
      }),
    ).toMatchObject({ kind: 'chat' })

    const jsonChatMessage: TeammateMessage = {
      from: 'alice',
      text: JSON.stringify({ foo: 'bar' }),
      timestamp: '2026-07-12T00:00:00.000Z',
      read: false,
    }
    expect(
      classifyMailboxMessage({
        message: jsonChatMessage,
        sender: alice,
        receiver: leader,
        pendingControls: [],
      }),
    ).toMatchObject({ kind: 'chat' })
  })

  test('classifies idle_notification and task_assignment as notification, not chat or invalid_control', () => {
    const idleMessage: TeammateMessage = {
      from: 'alice',
      text: JSON.stringify({
        type: 'idle_notification',
        from: 'alice',
        timestamp: '2026-07-12T00:00:00.000Z',
      }),
      timestamp: '2026-07-12T00:00:00.000Z',
      read: false,
    }
    expect(
      classifyMailboxMessage({
        message: idleMessage,
        sender: alice,
        receiver: leader,
        pendingControls: [],
      }),
    ).toMatchObject({ kind: 'notification' })

    const taskAssignmentMessage: TeammateMessage = {
      from: TEAM_LEAD_NAME,
      text: JSON.stringify({
        type: 'task_assignment',
        taskId: 't1',
        subject: 'do the thing',
        description: 'details',
        assignedBy: TEAM_LEAD_NAME,
        timestamp: '2026-07-12T00:00:00.000Z',
      }),
      timestamp: '2026-07-12T00:00:00.000Z',
      read: false,
    }
    expect(
      classifyMailboxMessage({
        message: taskAssignmentMessage,
        sender: leader,
        receiver: alice,
        pendingControls: [],
      }),
    ).toMatchObject({ kind: 'notification' })
  })
})

describe('writeControlToMailbox / writeControlRequestToMailbox authority', () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'teammate-mailbox-control-'))
    process.env.CLAUDE_CONFIG_DIR = tempDir
  })

  afterEach(() => {
    clearDynamicTeamContext()
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  async function seedTeam(teamName: string): Promise<void> {
    const now = Date.now()
    const teamFile: TeamFile = {
      name: teamName,
      createdAt: now,
      leadAgentId: `team-lead@${teamName}`,
      teamProtocolVersion: 2,
      recipientRecords: [
        {
          allocationId: 'allocation-lead',
          key: TEAM_LEAD_NAME,
          name: TEAM_LEAD_NAME,
          kind: 'leader',
          agentId: `team-lead@${teamName}`,
          sessionId: 'session-lead',
          status: 'active',
          launcherPid: process.pid,
          launcherInstanceId: 'test-instance',
          createdAt: now,
          updatedAt: now,
        },
        {
          allocationId: 'allocation-alice',
          key: 'alice',
          name: 'alice',
          kind: 'teammate',
          agentId: 'alice@' + teamName,
          sessionId: 'session-alice',
          status: 'active',
          launcherPid: process.pid,
          launcherInstanceId: 'test-instance',
          createdAt: now,
          updatedAt: now,
        },
      ],
      pendingControls: [],
      members: [
        {
          agentId: `team-lead@${teamName}`,
          name: TEAM_LEAD_NAME,
          joinedAt: now,
          tmuxPaneId: '',
          cwd: tempDir,
          subscriptions: [],
          allocationId: 'allocation-lead',
        },
        {
          agentId: 'alice@' + teamName,
          name: 'alice',
          joinedAt: now,
          tmuxPaneId: '',
          cwd: tempDir,
          subscriptions: [],
          allocationId: 'allocation-alice',
        },
      ],
    }
    await writeTeamFileAsync(teamName, teamFile)
  }

  test('a teammate runtime identity cannot send a leader-only control (writeControlToMailbox rejects the inner-leader-identity attack)', async () => {
    await seedTeam('review-team')
    setDynamicTeamContext({
      agentId: 'alice@review-team',
      agentName: 'alice',
      teamName: 'review-team',
      planModeRequired: false,
    })

    const shutdownMessage = createShutdownRequestMessage({
      requestId: 'shutdown-1',
      // Runtime identity is 'alice' (a teammate); claiming `from: TEAM_LEAD_NAME`
      // inside the payload must not grant leader authority — there is no
      // caller-authored sender argument on writeControlToMailbox at all, so
      // this can only ever be checked against the RESOLVED sender (alice).
      from: TEAM_LEAD_NAME,
    })

    await expect(
      writeControlToMailbox({
        recipient: {
          kind: 'teammate',
          agentId: 'bob@review-team',
          name: 'bob',
          allocationId: 'allocation-bob',
        },
        control: shutdownMessage,
        teamName: 'review-team',
      }),
    ).rejects.toBeInstanceOf(MailboxControlAuthorityError)
  })

  test('an unknown nonempty runtime identity cannot inherit leader authority', async () => {
    await seedTeam('review-team')
    setDynamicTeamContext({
      agentId: 'mallory@review-team',
      agentName: 'mallory',
      teamName: 'review-team',
      planModeRequired: false,
    })

    await expect(
      writeControlToMailbox({
        recipient: {
          kind: 'teammate',
          agentId: 'alice@review-team',
          name: 'alice',
          allocationId: 'allocation-alice',
        },
        control: createShutdownRequestMessage({
          requestId: 'shutdown-unknown',
          from: TEAM_LEAD_NAME,
        }),
        teamName: 'review-team',
      }),
    ).rejects.toBeInstanceOf(TeamPrincipalResolutionError)
  })

  test('a stale terminated runtime identity cannot inherit leader authority', async () => {
    await seedTeam('review-team')
    const { transactTeamFile } = await import('./swarm/teamHelpers.js')
    await transactTeamFile('review-team', teamFile => ({
      teamFile: {
        ...teamFile,
        recipientRecords: teamFile.recipientRecords!.map(record =>
          record.agentId === 'alice@review-team'
            ? { ...record, status: 'terminated' as const }
            : record,
        ),
      },
      result: undefined,
    }))
    setDynamicTeamContext({
      agentId: 'alice@review-team',
      agentName: 'alice',
      teamName: 'review-team',
      planModeRequired: false,
    })

    await expect(
      writeControlToMailbox({
        recipient: {
          kind: 'teammate',
          agentId: 'alice@review-team',
          name: 'alice',
          allocationId: 'allocation-alice',
        },
        control: createShutdownRequestMessage({
          requestId: 'shutdown-stale',
          from: TEAM_LEAD_NAME,
        }),
        teamName: 'review-team',
      }),
    ).rejects.toBeInstanceOf(TeamPrincipalResolutionError)
  })

  test('the team lead can send an authorized shutdown_request to a rostered teammate', async () => {
    await seedTeam('review-team')
    // No dynamic team context set — matches how the team lead process runs
    // (no CLAUDE_CODE_AGENT_ID), per resolveCurrentTeamPrincipal's fallback.

    const shutdownMessage = createShutdownRequestMessage({
      requestId: 'shutdown-2',
      from: TEAM_LEAD_NAME,
    })

    const result = await writeControlToMailbox({
      recipient: {
        kind: 'teammate',
        agentId: 'alice@review-team',
        name: 'alice',
        allocationId: 'allocation-alice',
      },
      control: shutdownMessage,
      teamName: 'review-team',
    })

    expect(result.written).toBe(true)
    const inbox = await readUnreadMessages('alice', 'review-team')
    expect(inbox).toHaveLength(1)
    expect(inbox[0]?.control).toMatchObject({ type: 'shutdown_request' })
  })

  test('claimPendingControl only lets one caller claim a response, and finishPendingControl finalizes it', async () => {
    await seedTeam('review-team')
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

    const shutdownMessage = createShutdownRequestMessage({
      requestId: 'shutdown-3',
      from: TEAM_LEAD_NAME,
    })
    await writeControlToMailbox({
      recipient: alice,
      control: shutdownMessage,
      teamName: 'review-team',
    })

    // Simulate the leader's write side creating the pending record directly
    // (writeControlRequestToMailbox does this; exercised end-to-end via
    // sendShutdownRequestToMailbox elsewhere) — here we test claim/finish in
    // isolation given a `written` record.
    const { transactTeamFile } = await import('./swarm/teamHelpers.js')
    await transactTeamFile('review-team', teamFile => ({
      teamFile: {
        ...teamFile,
        pendingControls: [
          {
            requestId: 'shutdown-3',
            requestType: 'shutdown' as const,
            senderAgentId: leader.agentId,
            senderAllocationId: leader.allocationId,
            recipientAgentId: alice.agentId,
            recipientAllocationId: alice.allocationId,
            state: 'written' as const,
          },
        ],
      },
      result: undefined,
    }))

    const shutdownApproved = createShutdownApprovedMessage({
      requestId: 'shutdown-3',
      from: 'alice',
    })
    const responseEnvelope: TeammateMessage = {
      from: 'alice',
      text: JSON.stringify(shutdownApproved),
      timestamp: new Date().toISOString(),
      read: false,
      protocolVersion: 2,
      messageId: randomUUID(),
      senderAgentId: alice.agentId,
      senderAllocationId: alice.allocationId,
      recipientAgentId: leader.agentId,
      recipientAllocationId: leader.allocationId,
      payloadClass: 'control',
      control: shutdownApproved,
    }

    const firstClaim = await claimPendingControl({
      teamName: 'review-team',
      response: responseEnvelope,
      control: shutdownApproved,
    })
    expect(firstClaim?.state).toBe('processing')

    const secondClaim = await claimPendingControl({
      teamName: 'review-team',
      response: responseEnvelope,
      control: shutdownApproved,
    })
    expect(secondClaim).toBeNull()

    await finishPendingControl({
      teamName: 'review-team',
      requestId: 'shutdown-3',
      outcome: 'consumed',
    })

    const thirdClaim = await claimPendingControl({
      teamName: 'review-team',
      response: responseEnvelope,
      control: shutdownApproved,
    })
    expect(thirdClaim).toBeNull()
  })
})
