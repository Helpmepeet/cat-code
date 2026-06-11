import { describe, expect, test } from 'bun:test'
import { createTaskStateBase } from '../../Task.js'
import { TaskStopTool } from './TaskStopTool.js'

describe('TaskStopTool', () => {
  test('uses the friendly agent name when stopping a named local agent', async () => {
    const agentId = 'agent-stop'
    let appState = {
      tasks: {
        [agentId]: {
          ...createTaskStateBase(
            agentId,
            'local_agent',
            'review backend integration',
          ),
          type: 'local_agent',
          status: 'running',
          agentId,
          agentName: 'Ada',
          agentType: 'general-purpose',
          prompt: 'review backend integration',
          retrieved: false,
          lastReportedToolCount: 0,
          lastReportedTokenCount: 0,
          isBackgrounded: true,
          pendingMessages: [],
          retain: false,
          diskLoaded: false,
        },
      },
    }
    const context = {
      getAppState: () => appState,
      setAppState: (update: (next: typeof appState) => typeof appState) => {
        appState = update(appState)
      },
    }

    const result = await TaskStopTool.call(
      { task_id: agentId },
      context as never,
    )

    expect(result.data).toMatchObject({
      message: 'Successfully stopped task: agent-stop (@Ada · general-purpose)',
      task_id: agentId,
      task_type: 'local_agent',
      command: '@Ada · general-purpose',
    })
    expect(appState.tasks[agentId]?.status).toBe('killed')
  })
})
