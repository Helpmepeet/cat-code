import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

import { getSessionId, getSessionProjectDir, switchSession } from '../../bootstrap/state.js'
import { clearDynamicTeamContext, setDynamicTeamContext } from '../../utils/teammate.js'
import { readTeamSnapshot, writeTeamFileAsync, type TeamFile } from '../../utils/swarm/teamHelpers.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import { readUnreadMessages } from '../../utils/teammateMailbox.js'
import { ExitPlanModeV2Tool } from './ExitPlanModeV2Tool.js'

describe('ExitPlanModeV2Tool teammate plan-approval-request delivery', () => {
  const originalSessionId = getSessionId()
  const originalProjectDir = getSessionProjectDir()
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'exit-plan-mode-'))
    process.env.CLAUDE_CONFIG_DIR = tempDir
    switchSession(randomUUID(), tempDir)
  })

  afterEach(() => {
    clearDynamicTeamContext()
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    switchSession(originalSessionId, originalProjectDir)
    rmSync(tempDir, { recursive: true, force: true })
  })

  async function seedTeam(): Promise<void> {
    const now = Date.now()
    const teamFile: TeamFile = {
      name: 'review-team',
      createdAt: now,
      leadAgentId: `${TEAM_LEAD_NAME}@review-team`,
      teamProtocolVersion: 2,
      recipientRecords: [
        {
          allocationId: 'allocation-lead',
          key: TEAM_LEAD_NAME,
          name: TEAM_LEAD_NAME,
          kind: 'leader',
          agentId: `${TEAM_LEAD_NAME}@review-team`,
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
          agentId: 'alice@review-team',
          sessionId: 'session-alice',
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

  function buildContext() {
    return {
      agentId: undefined,
      getAppState: () => ({ tasks: {} }),
      setAppState: () => {},
      options: {},
    } as never
  }

  test('a valid version-2 team: sends a plan_approval_request to the leader and records a pending control', async () => {
    await seedTeam()
    setDynamicTeamContext({
      agentId: 'alice@review-team',
      agentName: 'alice',
      teamName: 'review-team',
      planModeRequired: true,
    })

    const result = await ExitPlanModeV2Tool.call(
      { plan: 'Step 1: do the thing' } as never,
      buildContext(),
      undefined as never,
      undefined as never,
    )

    expect(result.data.awaitingLeaderApproval).toBe(true)
    expect(result.data.planApprovalError).toBeUndefined()
    expect(typeof result.data.requestId).toBe('string')

    const leaderInbox = await readUnreadMessages(TEAM_LEAD_NAME, 'review-team')
    expect(leaderInbox).toHaveLength(1)
    expect(leaderInbox[0]?.control).toMatchObject({
      type: 'plan_approval_request',
      from: 'alice',
    })

    const snapshot = await readTeamSnapshot('review-team')
    expect(snapshot.pendingControls).toHaveLength(1)
    expect(snapshot.pendingControls?.[0]).toMatchObject({
      requestType: 'plan',
      state: 'written',
      senderAgentId: 'alice@review-team',
    })
  })

  test('delivery failure (no team file at all): reports planApprovalError, not awaitingLeaderApproval', async () => {
    // No seedTeam() call — readTeamSnapshot has nothing to read.
    setDynamicTeamContext({
      agentId: 'alice@review-team',
      agentName: 'alice',
      teamName: 'review-team',
      planModeRequired: true,
    })

    const result = await ExitPlanModeV2Tool.call(
      { plan: 'Step 1: do the thing' } as never,
      buildContext(),
      undefined as never,
      undefined as never,
    )

    expect(result.data.awaitingLeaderApproval).toBe(false)
    expect(typeof result.data.planApprovalError).toBe('string')

    // mapToolResultToToolResultBlockParam must render the failure, not a
    // silent "approved" message.
    const rendered = ExitPlanModeV2Tool.mapToolResultToToolResultBlockParam?.(
      result.data,
      'tool-use-1',
    )
    expect(rendered).toBeDefined()
    const content = (rendered as { content: string }).content
    expect(content).toContain('Failed to submit your plan')
    expect(content).not.toContain('User has approved')
  })

  test('a legacy (non-version-2) team file: also reports planApprovalError', async () => {
    await writeTeamFileAsync('legacy-team', {
      name: 'legacy-team',
      createdAt: Date.now(),
      leadAgentId: 'team-lead@legacy-team',
      members: [],
    })
    setDynamicTeamContext({
      agentId: 'alice@legacy-team',
      agentName: 'alice',
      teamName: 'legacy-team',
      planModeRequired: true,
    })

    const result = await ExitPlanModeV2Tool.call(
      { plan: 'Step 1: do the thing' } as never,
      buildContext(),
      undefined as never,
      undefined as never,
    )

    expect(result.data.awaitingLeaderApproval).toBe(false)
    expect(result.data.planApprovalError).toContain('Cannot verify team roster')
  })
})
