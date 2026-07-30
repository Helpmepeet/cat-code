import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  resetStateForTests,
  setIsInteractive,
  setSessionProvider,
} from '../../bootstrap/state.js'
import { FORK_WORKER_RESULT_TAG } from '../../constants/xml.js'
import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { FILE_PATCH_TOOL_NAME } from '../FilePatchTool/constants.js'
import { SKILL_TOOL_NAME } from '../SkillTool/constants.js'
import { TASK_OUTPUT_TOOL_NAME } from '../TaskOutputTool/constants.js'
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
import {
  filterToolsForAgent,
  formatForkWorkerResultForNotification,
  getAgentContinuationCapabilities,
  resolveAgentTools,
} from './agentToolUtils.js'

function getAsyncWorkerToolNames(tools: string[] = ['*']): string[] {
  const availableTools = getTools(getEmptyToolPermissionContext())
  return resolveAgentTools(
    {
      tools,
      disallowedTools: [],
      source: 'built-in',
      permissionMode: 'default',
    },
    availableTools,
    true,
  ).resolvedTools.map(tool => tool.name)
}

function fileEditToolsIn(toolNames: string[]): string[] {
  return toolNames.filter(
    name => name === FILE_EDIT_TOOL_NAME || name === FILE_PATCH_TOOL_NAME,
  )
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

describe('resolveAgentTools provider-aliased edit capability for async workers', () => {
  beforeEach(() => {
    resetStateForTests()
  })

  afterEach(() => {
    resetStateForTests()
  })

  // The pool carries exactly one file-edit tool per provider
  // (getProviderFileEditTool, tools.ts). The async allowlist used to name only
  // Edit, so an async worker on the OpenAI path got NO edit tool at all.
  test('gets Apply_patch and only Apply_patch on the OpenAI path', () => {
    setSessionProvider('openai')

    expect(fileEditToolsIn(getAsyncWorkerToolNames())).toEqual([
      FILE_PATCH_TOOL_NAME,
    ])
  })

  test('gets Edit and only Edit on the Anthropic path', () => {
    setSessionProvider('firstParty')

    expect(fileEditToolsIn(getAsyncWorkerToolNames())).toEqual([
      FILE_EDIT_TOOL_NAME,
    ])
  })

  test('keeps Agent Mode roles read-only or editing regardless of the alias', async () => {
    // Dynamic import: the role definitions live behind the same tool-constant
    // graph getTools() primes above, so import them after it has loaded.
    const { AGENT_MODE_CODING_WORKER, AGENT_MODE_VERIFIER } = await import(
      '../../agent-mode/rolePrompts.js'
    )
    const availableTools = getTools(getEmptyToolPermissionContext())

    for (const provider of ['firstParty', 'openai'] as const) {
      resetStateForTests()
      setSessionProvider(provider)
      const expectedEditTool =
        provider === 'openai' ? FILE_PATCH_TOOL_NAME : FILE_EDIT_TOOL_NAME

      const verifierNames = resolveAgentTools(
        AGENT_MODE_VERIFIER,
        availableTools,
        true,
      ).resolvedTools.map(tool => tool.name)
      expect(verifierNames).toContain('Read')
      expect(fileEditToolsIn(verifierNames)).toEqual([])
      expect(verifierNames).not.toContain('Write')

      const workerNames = resolveAgentTools(
        AGENT_MODE_CODING_WORKER,
        getTools(getEmptyToolPermissionContext()),
        true,
      ).resolvedTools.map(tool => tool.name)
      expect(fileEditToolsIn(workerNames)).toEqual([expectedEditTool])
    }
  })

  // A role that disallows one alias must not receive the other when the pool
  // swaps for the OpenAI path — these three name only Edit in disallowedTools.
  test('keeps read-only built-ins edit-free on the OpenAI path', async () => {
    const { EXPLORE_AGENT } = await import('./built-in/exploreAgent.js')
    const { PLAN_AGENT } = await import('./built-in/planAgent.js')

    for (const definition of [EXPLORE_AGENT, PLAN_AGENT, VERIFICATION_AGENT]) {
      for (const isAsync of [true, false]) {
        resetStateForTests()
        setSessionProvider('openai')
        const toolNames = resolveAgentTools(
          definition,
          getTools(getEmptyToolPermissionContext()),
          isAsync,
        ).resolvedTools.map(tool => tool.name)

        expect(fileEditToolsIn(toolNames)).toEqual([])
        expect(toolNames).not.toContain('Write')
      }
    }
  })

  test('names both edit aliases in the verifier disallow list', async () => {
    const { AGENT_MODE_VERIFIER } = await import(
      '../../agent-mode/rolePrompts.js'
    )

    expect(AGENT_MODE_VERIFIER.disallowedTools).toContain(FILE_EDIT_TOOL_NAME)
    expect(AGENT_MODE_VERIFIER.disallowedTools).toContain(FILE_PATCH_TOOL_NAME)
  })
})

describe('resolveAgentTools Skill policy is symmetric across spawn shapes', () => {
  beforeEach(() => {
    resetStateForTests()
  })

  afterEach(() => {
    resetStateForTests()
  })

  function resolveNames(tools: string[], isAsync: boolean): string[] {
    return resolveAgentTools(
      {
        tools,
        disallowedTools: [],
        source: 'built-in',
        permissionMode: 'default',
      },
      getTools(getEmptyToolPermissionContext()),
      isAsync,
    ).resolvedTools.map(tool => tool.name)
  }

  // Foreground vs background must not change a role's logical capabilities
  // (owner decision 2026-07-30). The async allowlist alone left Skill on every
  // sync subagent, which made the orchestrator doctrine false for foreground
  // spawns.
  test.each([
    ['sync', false],
    ['async', true],
  ] as const)('withholds Skill from a wildcard %s worker', (_shape, isAsync) => {
    expect(resolveNames(['*'], isAsync)).not.toContain(SKILL_TOOL_NAME)
  })

  test.each([
    ['sync', false],
    ['async', true],
  ] as const)(
    'grants Skill to a %s worker whose definition names it',
    (_shape, isAsync) => {
      expect(resolveNames(['Read', SKILL_TOOL_NAME], isAsync)).toContain(
        SKILL_TOOL_NAME,
      )
    },
  )

  test('leaves Skill selectable when asking which tools a definition could pick', () => {
    // The agent-creation picker passes no explicit list; hiding Skill there
    // would remove the only interactive way to grant it.
    const pickable = filterToolsForAgent({
      tools: getTools(getEmptyToolPermissionContext()),
      isBuiltIn: false,
      isAsync: false,
    }).map(tool => tool.name)

    expect(pickable).toContain(SKILL_TOOL_NAME)
  })
})

describe('resolveAgentTools Skill policy for async workers', () => {
  beforeEach(() => {
    resetStateForTests()
  })

  test('withholds Skill from a wildcard async worker', () => {
    expect(getTools(getEmptyToolPermissionContext()).map(t => t.name)).toContain(
      SKILL_TOOL_NAME,
    )

    expect(getAsyncWorkerToolNames()).not.toContain(SKILL_TOOL_NAME)
  })

  test('grants Skill when the agent definition names it', () => {
    const toolNames = getAsyncWorkerToolNames(['Read', SKILL_TOOL_NAME])

    expect(toolNames).toContain(SKILL_TOOL_NAME)
    expect(toolNames).toContain('Read')
  })

  test('does not let an explicit request reopen the recursion boundary', () => {
    const toolNames = getAsyncWorkerToolNames([
      'Read',
      AGENT_TOOL_NAME,
      TASK_OUTPUT_TOOL_NAME,
    ])

    expect(toolNames).toEqual(['Read'])
  })
})

describe('resolveAgentTools explicit in-process-teammate environment', () => {
  beforeEach(() => {
    resetStateForTests()
  })

  test('resolves an in-process-teammate tool pool consistent with getAgentContinuationCapabilities', () => {
    const availableTools = getTools(getEmptyToolPermissionContext())
    const inProcessTools = resolveAgentTools(
      {
        tools: ['*'],
        disallowedTools: [],
        source: 'built-in',
        permissionMode: 'default',
      },
      availableTools,
      false,
      'in-process-teammate',
    ).resolvedTools
    const inProcessNames = inProcessTools.map(tool => tool.name)
    expect(inProcessNames).not.toContain(AGENT_TOOL_NAME)
    expect(inProcessNames).not.toContain(RESUME_AGENT_TOOL_NAME)
    expect(getAgentContinuationCapabilities(inProcessTools)).toEqual({
      canSendMessage: true,
      canResumeAgent: false,
      canSpawnAgent: false,
    })
  })

  test('main-thread environment skips filtering like the historical isMainThread flag', () => {
    const availableTools = getTools(getEmptyToolPermissionContext())
    const resolved = resolveAgentTools(
      {
        tools: ['*'],
        disallowedTools: [],
        source: 'built-in',
        permissionMode: 'default',
      },
      availableTools,
      false,
      'main-thread',
    )
    // 'main-thread' bypasses filterToolsForAgent's sub-agent disallow lists
    // entirely, so Agent/ResumeAgent — normally stripped for every
    // subagent/teammate environment — survive here untouched.
    const toolNames = resolved.resolvedTools.map(tool => tool.name)
    expect(toolNames).toEqual(availableTools.map(tool => tool.name))
    expect(toolNames).toContain(AGENT_TOOL_NAME)
    expect(toolNames).toContain(RESUME_AGENT_TOOL_NAME)
  })
})

describe('formatForkWorkerResultForNotification provider branches', () => {
  const RESULT = {
    version: 1 as const,
    kind: 'fork_worker_result' as const,
    scope: 'add a regression test',
    result: 'done',
    key_files: ['src/tools/AgentTool/agentToolUtils.ts'],
    files_changed: ['src/tools/AgentTool/agentToolUtils.ts'],
    issues: [],
    commit_hash: null,
  }

  // The OpenAI branch referenced serializeForkWorkerResultForOpenAI without
  // importing it, so reaching it threw ReferenceError while the Claude branch
  // worked. Both branches are exercised here so an import regression cannot
  // hide on one provider.
  test('serializes raw JSON for OpenAI', () => {
    const formatted = formatForkWorkerResultForNotification(
      JSON.stringify(RESULT),
      'openai',
    )

    expect(JSON.parse(formatted)).toEqual(RESULT)
    expect(formatted).not.toContain(`<${FORK_WORKER_RESULT_TAG}>`)
  })

  test('wraps the payload in contract tags for the Claude path', () => {
    const formatted = formatForkWorkerResultForNotification(
      JSON.stringify(RESULT),
      'firstParty',
    )

    expect(formatted).toContain(`<${FORK_WORKER_RESULT_TAG}>`)
    expect(formatted).toContain('add a regression test')
  })
})
