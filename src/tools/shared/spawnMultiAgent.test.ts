import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const realRegistry = await import('../../utils/swarm/backends/registry.js')
mock.module('../../utils/swarm/backends/registry.js', () => ({
  ...realRegistry,
  isInProcessEnabled: () => true,
}))

let nextSpawnResult: {
  success: boolean
  agentId: string
  taskId?: string
  error?: string
} = { success: true, agentId: 'unused@unused', taskId: 'task-1' }

const realSpawnInProcess = await import('../../utils/swarm/spawnInProcess.js')
mock.module('../../utils/swarm/spawnInProcess.js', () => ({
  ...realSpawnInProcess,
  spawnInProcessTeammate: async () => nextSpawnResult,
}))

const realInProcessRunner = await import('../../utils/swarm/inProcessRunner.js')
mock.module('../../utils/swarm/inProcessRunner.js', () => ({
  ...realInProcessRunner,
  startInProcessTeammate: () => {},
}))

const { spawnTeammate } = await import('./spawnMultiAgent.js')
const { allocateTeamRecipient, readTeamSnapshot, writeTeamFileAsync } =
  await import('../../utils/swarm/teamHelpers.js')

describe('spawnTeammate allocation lifecycle', () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'spawn-multi-agent-'))
    process.env.CLAUDE_CONFIG_DIR = tempDir
    nextSpawnResult = { success: true, agentId: 'unused@unused', taskId: 'task-1' }
  })

  afterEach(() => {
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  async function seedTeam(teamName: string) {
    await writeTeamFileAsync(teamName, {
      name: teamName,
      createdAt: Date.now(),
      leadAgentId: `team-lead@${teamName}`,
      teamProtocolVersion: 2,
      recipientRecords: [],
      members: [],
    })
  }

  function makeContext(overrides: Record<string, unknown> = {}) {
    let appState: Record<string, unknown> = {
      mainLoopModel: null,
      toolPermissionContext: { mode: 'default' },
      ...overrides,
    }
    return {
      context: {
        getAppState: () => appState,
        setAppState: (updater: (prev: typeof appState) => typeof appState) => {
          appState = updater(appState)
        },
        options: { agentDefinitions: { activeAgents: [] } },
        toolUseId: 'tool-use-1',
      } as never,
      getAppState: () => appState,
    }
  }

  test('promotes the allocation to active after a successful in-process spawn', async () => {
    await seedTeam('review-team')
    const allocation = await allocateTeamRecipient({
      teamName: 'review-team',
      requestedName: 'researcher',
      kind: 'teammate',
      conflict: 'error',
      forbiddenKeys: new Set(),
      agentId: 'researcher@review-team',
      sessionId: 'session-1',
    })

    const { context } = makeContext()
    await spawnTeammate(
      {
        name: allocation.name,
        prompt: 'do the thing',
        team_name: 'review-team',
        allocationId: allocation.allocationId,
      },
      context,
    )

    const snapshot = await readTeamSnapshot('review-team')
    const record = snapshot.recipientRecords!.find(
      r => r.allocationId === allocation.allocationId,
    )
    expect(record?.status).toBe('active')
    expect(snapshot.members.some(m => m.agentId === 'researcher@review-team')).toBe(
      true,
    )
  })

  test('tombstones the allocation when the in-process spawn fails', async () => {
    await seedTeam('review-team')
    const allocation = await allocateTeamRecipient({
      teamName: 'review-team',
      requestedName: 'researcher',
      kind: 'teammate',
      conflict: 'error',
      forbiddenKeys: new Set(),
      agentId: 'researcher@review-team',
      sessionId: 'session-1',
    })
    nextSpawnResult = { success: false, agentId: 'unused@unused', error: 'boom' }

    const { context } = makeContext()
    await expect(
      spawnTeammate(
        {
          name: allocation.name,
          prompt: 'do the thing',
          team_name: 'review-team',
          allocationId: allocation.allocationId,
        },
        context,
      ),
    ).rejects.toThrow('boom')

    const snapshot = await readTeamSnapshot('review-team')
    const record = snapshot.recipientRecords!.find(
      r => r.allocationId === allocation.allocationId,
    )
    expect(record?.status).toBe('terminated')
    expect(snapshot.members).toHaveLength(0)
  })
})
