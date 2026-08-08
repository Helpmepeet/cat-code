import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { TaskUpdateTool } from './TaskUpdateTool.js'
import { createTask } from '../../utils/tasks.js'
import { clearDynamicTeamContext, setDynamicTeamContext } from '../../utils/teammate.js'
import { readMailbox } from '../../utils/teammateMailbox.js'

describe('TaskUpdateTool', () => {
  test('writes owner notifications to the team mailbox instead of the task-list mailbox', async () => {
    const configDir = await mkdtemp('/tmp/cat-code-task-update-')
    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    const originalUserType = process.env.USER_TYPE
    const originalTaskListId = process.env.CLAUDE_CODE_TASK_LIST_ID
    const teamName = 'review-team'
    const taskListId = 'separate-task-list'

    try {
      process.env.CLAUDE_CONFIG_DIR = configDir
      process.env.USER_TYPE = 'ant'
      process.env.CLAUDE_CODE_TASK_LIST_ID = taskListId
      setDynamicTeamContext({
        agentId: 'lead@review-team',
        agentName: 'lead',
        teamName,
        planModeRequired: false,
      })
      const taskId = await createTask(taskListId, {
        subject: 'Review remediation',
        description: 'Verify owner notification routing.',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      })
      let appState: { expandedView: 'none' | 'tasks' } = { expandedView: 'none' }

      const result = await TaskUpdateTool.call(
        { taskId, owner: 'alice' },
        {
          getAppState: () => appState,
          setAppState: (updater: (previous: typeof appState) => typeof appState) => {
            appState = updater(appState)
          },
        } as never,
      )

      expect(result.data.success).toBe(true)
      expect(await readMailbox('alice', teamName)).toHaveLength(1)
      expect(await readMailbox('alice', taskListId)).toEqual([])
    } finally {
      clearDynamicTeamContext()
      if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
      if (originalUserType === undefined) delete process.env.USER_TYPE
      else process.env.USER_TYPE = originalUserType
      if (originalTaskListId === undefined) delete process.env.CLAUDE_CODE_TASK_LIST_ID
      else process.env.CLAUDE_CODE_TASK_LIST_ID = originalTaskListId
      await rm(configDir, { recursive: true, force: true })
    }
  })
})
