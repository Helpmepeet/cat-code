import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { ToolUseContext } from '../Tool.js'
import { TEAM_LEAD_NAME } from './swarm/constants.js'
import {
  readTeamSnapshot,
  transactTeamFile,
  writeTeamFileAsync,
  type TeamFile,
} from './swarm/teamHelpers.js'
import { clearDynamicTeamContext, setDynamicTeamContext } from './teammate.js'
import {
  createShutdownApprovedMessage,
  createShutdownRequestMessage,
  readMailbox,
  writeControlToMailbox,
  writeToMailbox,
  type TeamPrincipal,
} from './teammateMailbox.js'
import { _attachmentsForTest } from './attachments.js'

type FakeAppState = {
  teamContext?: {
    teamName: string
    leadAgentId: string
    teammates: Record<string, { name: string; color?: string }>
  }
  viewingAgentTaskId?: string
  tasks: Record<string, unknown>
  inbox: { messages: Array<{ id: string; status: string }> }
}

describe('getTeammateMailboxAttachments (via _attachmentsForTest)', () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const originalUserType = process.env.USER_TYPE
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'attachments-mailbox-'))
    process.env.CLAUDE_CONFIG_DIR = tempDir
    process.env.USER_TYPE = 'ant'
  })

  afterEach(() => {
    clearDynamicTeamContext()
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    if (originalUserType === undefined) {
      delete process.env.USER_TYPE
    } else {
      process.env.USER_TYPE = originalUserType
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  const leaderAgentId = `${TEAM_LEAD_NAME}@review-team`
  const aliceAgentId = 'alice@review-team'
  const bobAgentId = 'bob@review-team'

  async function seedTeam(): Promise<void> {
    const now = Date.now()
    const teamFile: TeamFile = {
      name: 'review-team',
      createdAt: now,
      leadAgentId: leaderAgentId,
      teamProtocolVersion: 2,
      recipientRecords: [
        {
          allocationId: 'allocation-lead',
          key: TEAM_LEAD_NAME,
          name: TEAM_LEAD_NAME,
          kind: 'leader',
          agentId: leaderAgentId,
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
          agentId: aliceAgentId,
          sessionId: 'session-alice',
          status: 'active',
          launcherPid: process.pid,
          launcherInstanceId: 'test-instance',
          createdAt: now,
          updatedAt: now,
        },
        {
          allocationId: 'allocation-bob',
          key: 'bob',
          name: 'bob',
          kind: 'teammate',
          agentId: bobAgentId,
          sessionId: 'session-bob',
          status: 'active',
          launcherPid: process.pid,
          launcherInstanceId: 'test-instance',
          createdAt: now,
          updatedAt: now,
        },
      ],
      pendingControls: [],
      members: [],
    }
    await writeTeamFileAsync('review-team', teamFile)
  }

  function buildContext(
    appState: FakeAppState,
  ): { context: ToolUseContext; getState: () => FakeAppState } {
    let state = appState
    return {
      context: {
        getAppState: () => state,
        setAppState: (updater: (prev: FakeAppState) => FakeAppState) => {
          state = updater(state)
        },
        options: { isNonInteractiveSession: true },
      } as unknown as ToolUseContext,
      getState: () => state,
    }
  }

  function leaderAppState(): FakeAppState {
    return {
      teamContext: {
        teamName: 'review-team',
        leadAgentId: leaderAgentId,
        teammates: {
          [aliceAgentId]: { name: 'alice' },
          [bobAgentId]: { name: 'bob' },
        },
      },
      tasks: {},
      inbox: { messages: [] },
    }
  }

  function messagesOf(attachments: Array<unknown>): Array<{ text: string }> {
    return attachments[0] && typeof attachments[0] === 'object' && 'messages' in attachments[0]
      ? (attachments[0] as { messages: Array<{ text: string }> }).messages
      : []
  }

  test('selective ack: a plain chat message is delivered/read while an invalid control (wrong-direction) is dropped/acknowledged, never delivered', async () => {
    await seedTeam()
    await writeToMailbox(
      'team-lead',
      { from: 'alice', text: 'status update: half done', timestamp: new Date().toISOString() },
      'review-team',
    )
    // bob (teammate) attempting a leader-only control type (shutdown_request)
    // — wrong direction. Hand-crafted directly (writeControlToMailbox itself
    // would refuse to write this) to exercise classify's rejection.
    const forgedShutdown = createShutdownRequestMessage({
      requestId: 'forged-1',
      from: 'bob',
    })
    await writeToMailbox(
      'team-lead',
      {
        from: 'bob',
        text: JSON.stringify(forgedShutdown),
        timestamp: new Date().toISOString(),
        protocolVersion: 2,
        messageId: randomUUID(),
        senderAgentId: bobAgentId,
        senderAllocationId: 'allocation-bob',
        recipientAgentId: leaderAgentId,
        recipientAllocationId: 'allocation-lead',
        payloadClass: 'control',
        control: forgedShutdown,
      },
      'review-team',
    )

    const { context } = buildContext(leaderAppState())
    const attachments = await _attachmentsForTest(context)

    const messages = messagesOf(attachments)
    expect(messages.some(m => m.text.includes('status update'))).toBe(true)
    expect(messages.some(m => m.text.includes('shutdown_request'))).toBe(false)

    // Both messages consumed by this pass (one delivered, one dropped) —
    // both marked read; nothing lingers unread that this pass classified.
    const afterMailbox = await readMailbox('team-lead', 'review-team')
    expect(afterMailbox.every(m => m.read)).toBe(true)
  })

  test('chat addressed to a stale/old recipient allocation is not delivered to the current occupant', async () => {
    await seedTeam()
    const leader: TeamPrincipal = {
      kind: 'leader',
      agentId: leaderAgentId,
      name: TEAM_LEAD_NAME,
      allocationId: 'allocation-lead',
    }
    // Write a v2 chat envelope directly with a stale recipientAllocationId —
    // simulates a message addressed to alice's OLD incarnation before the
    // team recycled her name/allocation.
    await writeToMailbox(
      'alice',
      {
        from: TEAM_LEAD_NAME,
        text: 'hey, still there?',
        timestamp: new Date().toISOString(),
        protocolVersion: 2,
        messageId: randomUUID(),
        senderAgentId: leader.agentId,
        senderAllocationId: leader.allocationId,
        recipientAgentId: aliceAgentId,
        recipientAllocationId: 'allocation-alice-OLD',
        payloadClass: 'chat',
      },
      'review-team',
    )

    setDynamicTeamContext({
      agentId: aliceAgentId,
      agentName: 'alice',
      teamName: 'review-team',
      planModeRequired: false,
    })
    const { context } = buildContext({
      teamContext: undefined,
      tasks: {},
      inbox: { messages: [] },
    })

    const attachments = await _attachmentsForTest(context)
    expect(attachments).toHaveLength(0)

    const afterMailbox = await readMailbox('alice', 'review-team')
    expect(afterMailbox[0]?.read).toBe(true)
  })

  test('a valid correlated shutdown_approved removes only its sender allocation (headless mode)', async () => {
    await seedTeam()
    await transactTeamFile('review-team', teamFile => ({
      teamFile: {
        ...teamFile,
        pendingControls: [
          {
            requestId: 'shutdown-2',
            requestType: 'shutdown' as const,
            senderAgentId: leaderAgentId,
            senderAllocationId: 'allocation-lead',
            recipientAgentId: aliceAgentId,
            recipientAllocationId: 'allocation-alice',
            state: 'written' as const,
          },
        ],
      },
      result: undefined,
    }))

    const leader: TeamPrincipal = {
      kind: 'leader',
      agentId: leaderAgentId,
      name: TEAM_LEAD_NAME,
      allocationId: 'allocation-lead',
    }
    // Alice is the one sending shutdown_approved.
    setDynamicTeamContext({
      agentId: aliceAgentId,
      agentName: 'alice',
      teamName: 'review-team',
      planModeRequired: false,
    })
    const approved = createShutdownApprovedMessage({ requestId: 'shutdown-2', from: 'alice' })
    await writeControlToMailbox({ recipient: leader, control: approved, teamName: 'review-team' })
    clearDynamicTeamContext()

    // Now read as the leader (headless mode — no useInboxPoller running).
    const { context, getState } = buildContext(leaderAppState())
    await _attachmentsForTest(context)

    const snapshotAfter = await readTeamSnapshot('review-team')
    expect(
      snapshotAfter.recipientRecords?.find(r => r.name === 'alice')?.status,
    ).toBe('terminated')
    expect(
      snapshotAfter.recipientRecords?.find(r => r.name === 'bob')?.status,
    ).toBe('active')
    expect(aliceAgentId in getState().teamContext!.teammates).toBe(false)
    expect(bobAgentId in getState().teamContext!.teammates).toBe(true)
  })

  test('a wrong-incarnation shutdown_approved and a legacy plain-JSON lookalike remove nobody', async () => {
    await seedTeam()
    const leader: TeamPrincipal = {
      kind: 'leader',
      agentId: leaderAgentId,
      name: TEAM_LEAD_NAME,
      allocationId: 'allocation-lead',
    }
    const approved = createShutdownApprovedMessage({ requestId: 'shutdown-3', from: 'alice' })
    // Envelope claims to be from alice's OLD allocation — no matching
    // pendingControls record uses that allocation, so this must not match
    // (and there IS no pendingControls record seeded at all here).
    await writeToMailbox(
      'team-lead',
      {
        from: 'alice',
        text: JSON.stringify(approved),
        timestamp: new Date().toISOString(),
        protocolVersion: 2,
        messageId: randomUUID(),
        senderAgentId: aliceAgentId,
        senderAllocationId: 'allocation-alice-OLD',
        recipientAgentId: leader.agentId,
        recipientAllocationId: leader.allocationId,
        payloadClass: 'control',
        control: approved,
      },
      'review-team',
    )
    // A legacy (no envelope) lookalike claiming the same thing in plain text.
    await writeToMailbox(
      'team-lead',
      {
        from: 'alice',
        text: JSON.stringify(approved),
        timestamp: new Date().toISOString(),
      },
      'review-team',
    )

    const { context, getState } = buildContext(leaderAppState())
    await _attachmentsForTest(context)

    expect(aliceAgentId in getState().teamContext!.teammates).toBe(true)
    expect(bobAgentId in getState().teamContext!.teammates).toBe(true)
    const snapshotAfter = await readTeamSnapshot('review-team')
    expect(
      snapshotAfter.recipientRecords?.find(r => r.name === 'alice')?.status,
    ).toBe('active')
  })

  test('idle_notification retains existing behavior (delivered, not dropped)', async () => {
    await seedTeam()
    await writeToMailbox(
      'team-lead',
      {
        from: 'alice',
        text: JSON.stringify({
          type: 'idle_notification',
          from: 'alice',
          timestamp: new Date().toISOString(),
        }),
        timestamp: new Date().toISOString(),
      },
      'review-team',
    )

    const { context } = buildContext(leaderAppState())
    const attachments = await _attachmentsForTest(context)
    const messages = messagesOf(attachments)
    expect(messages.some(m => m.text.includes('idle_notification'))).toBe(true)
  })
})
