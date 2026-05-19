import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  resetStateForTests,
  setIsInteractive,
} from '../../bootstrap/state.js'
import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { RESUME_AGENT_TOOL_NAME } from '../../tools/ResumeAgentTool/constants.js'
import { TASK_CREATE_TOOL_NAME } from '../../tools/TaskCreateTool/constants.js'
import { TASK_GET_TOOL_NAME } from '../../tools/TaskGetTool/constants.js'
import { TASK_LIST_TOOL_NAME } from '../../tools/TaskListTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from '../../tools/TaskUpdateTool/constants.js'
import { TODO_WRITE_TOOL_NAME } from '../../tools/TodoWriteTool/constants.js'
import { getTools } from '../../tools.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { resolveAgentTools } from './agentToolUtils.js'

function getAsyncWorkerToolNames(): string[] {
  const availableTools = getTools(getEmptyToolPermissionContext())
  return resolveAgentTools(
    {
      tools: ['*'],
      disallowedTools: [],
      source: 'built-in',
      permissionMode: 'default',
    },
    availableTools,
    true,
  ).resolvedTools.map(tool => tool.name)
}

describe('resolveAgentTools task-management availability for async workers', () => {
  beforeEach(() => {
    resetStateForTests()
    delete process.env.CLAUDE_CODE_ENABLE_TASKS
  })

  afterEach(() => {
    delete process.env.CLAUDE_CODE_ENABLE_TASKS
  })

  test('keeps v2 task tools available to async workers in interactive sessions', () => {
    setIsInteractive(true)

    const toolNames = getAsyncWorkerToolNames()

    expect(toolNames).toContain(TASK_CREATE_TOOL_NAME)
    expect(toolNames).toContain(TASK_GET_TOOL_NAME)
    expect(toolNames).toContain(TASK_LIST_TOOL_NAME)
    expect(toolNames).toContain(TASK_UPDATE_TOOL_NAME)
    expect(toolNames).not.toContain(TODO_WRITE_TOOL_NAME)
    expect(toolNames).not.toContain(RESUME_AGENT_TOOL_NAME)
  })

  test('keeps TodoWrite available to async workers in non-interactive sessions', () => {
    setIsInteractive(false)

    const toolNames = getAsyncWorkerToolNames()

    expect(toolNames).toContain(TODO_WRITE_TOOL_NAME)
    expect(toolNames).not.toContain(TASK_CREATE_TOOL_NAME)
    expect(toolNames).not.toContain(RESUME_AGENT_TOOL_NAME)
  })

  test('exposes ResumeAgent at top level but hides it behind a blanket Agent deny', () => {
    const baseContext = getEmptyToolPermissionContext()
    expect(getTools(baseContext).map(tool => tool.name)).toContain(
      RESUME_AGENT_TOOL_NAME,
    )

    const deniedContext = {
      ...baseContext,
      alwaysDenyRules: {
        session: [AGENT_TOOL_NAME],
      },
    }
    const deniedToolNames = getTools(deniedContext).map(tool => tool.name)

    expect(deniedToolNames).not.toContain(AGENT_TOOL_NAME)
    expect(deniedToolNames).not.toContain(RESUME_AGENT_TOOL_NAME)
  })
})
