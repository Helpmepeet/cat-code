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
import { VERIFICATION_AGENT } from './built-in/verificationAgent.js'
import { IMPLEMENTOR_AGENT } from './built-in/implementorAgent.js'
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

describe('resolveAgentTools built-in normal-mode agents', () => {
  beforeEach(() => {
    resetStateForTests()
  })

  test('resolves implementor tools without recursive or orchestrator routing tools', () => {
    const availableTools = getTools(getEmptyToolPermissionContext())
    const resolved = resolveAgentTools(IMPLEMENTOR_AGENT, availableTools, true)
    const toolNames = resolved.resolvedTools.map(tool => tool.name)

    expect(toolNames).toContain('Bash')
    expect(toolNames).toContain('Read')
    expect(toolNames).toContain('Write')
    expect(toolNames.some(name => name === 'Edit' || name === 'Apply_patch')).toBe(
      true,
    )
    expect(toolNames).not.toContain('Agent')
    expect(toolNames).not.toContain('ask_orchestrator')
    expect(toolNames).not.toContain('SendMessage')
    expect(toolNames).not.toContain('TeamCreate')
    expect(toolNames).not.toContain('TeamDelete')
    expect(toolNames).not.toContain('ListWorkers')
    expect(toolNames).not.toContain('WaitWorkers')
    expect(toolNames).not.toContain('GetWorkerResult')
    expect(toolNames).not.toContain('CancelWorker')
  })

  test('resolves verification tools as read-only and caller-oriented', () => {
    const availableTools = getTools(getEmptyToolPermissionContext())
    const resolved = resolveAgentTools(VERIFICATION_AGENT, availableTools, true)
    const toolNames = resolved.resolvedTools.map(tool => tool.name)

    expect(toolNames).toContain('Bash')
    expect(toolNames).toContain('Read')
    expect(toolNames).not.toContain('Agent')
    expect(toolNames).not.toContain('Edit')
    expect(toolNames).not.toContain('Apply_patch')
    expect(toolNames).not.toContain('Write')
    expect(toolNames).not.toContain('NotebookEdit')
    expect(toolNames).not.toContain('ask_orchestrator')
    expect(toolNames).not.toContain('ListWorkers')
    expect(toolNames).not.toContain('WaitWorkers')
    expect(toolNames).not.toContain('GetWorkerResult')
    expect(toolNames).not.toContain('CancelWorker')
  })
})
