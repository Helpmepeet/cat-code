import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { randomUUID } from 'crypto'
import { mkdtempSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough } from 'stream'
import stripAnsi from 'strip-ansi'
import * as React from 'react'
import { resetStateForTests, switchSession } from '../../bootstrap/state.js'
import { readSessionState } from '../../utils/workerState.js'
import {
  allocateWorkerName,
  resetWorkerNamesForTests,
} from '../../utils/workerNames.js'
import { render, ThemeProvider } from '../../ink.js'
import { AppStateProvider, getDefaultAppState } from '../../state/AppState.js'
import type { McpRuntimeSnapshot, Tool, ToolUseContext } from '../../Tool.js'
import { getBuiltInAgents } from './builtInAgents.js'
import type { Message } from '../../types/message.js'
import {
  getCodexLeaseForOwner,
  resetCodexLeaseManagerForTest,
} from '../../services/api/codexAccountLeaseManager.js'
import {
  resetCodexAccountPoolForTest,
  seedCodexAccountPoolForTest,
  type PoolAccount,
} from '../../services/api/codexAccountPool.js'
import { createAssistantMessage } from '../../utils/messages.js'
import { renderGroupedAgentToolUse, renderToolResultMessage } from './UI.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import type { ScopedMcpServerConfig } from '../../services/mcp/types.js'

const realRunAgentModule = await import('./runAgent.js')
let capturedRunAgentParams:
  | Parameters<typeof realRunAgentModule.runAgent>[0]
  | undefined
mock.module('./runAgent.js', () => ({
  ...realRunAgentModule,
  runAgent: (params: Parameters<typeof realRunAgentModule.runAgent>[0]) => {
    capturedRunAgentParams = params
    return (async function* () {
      yield createAssistantMessage({ content: 'fixture complete' })
    })()
  },
}))

const realSleepModule = await import('../../utils/sleep.js')
let resolvePendingMcpPoll: (() => void) | undefined
mock.module('../../utils/sleep.js', () => ({
  ...realSleepModule,
  sleep: async (...args: Parameters<typeof realSleepModule.sleep>) => {
    const resolve = resolvePendingMcpPoll
    if (resolve) {
      resolvePendingMcpPoll = undefined
      resolve()
      return
    }
    await realSleepModule.sleep(...args)
  },
}))

const {
  AgentTool,
  buildAgentSessionStateTracking,
  continueAgentIterator,
  deriveSessionStateTrackingObjective,
  finalizeFailedAgentLaunch,
  inputSchema,
  registerWorkerCodexLease,
  reportableAccount,
  resolveSystemSubagentName,
} = await import('./AgentTool.js')

async function renderToPlainText(node: React.ReactNode): Promise<string> {
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream & {
    columns: number
  }
  stdout.columns = 120
  let output = ''
  ;(stdout as unknown as PassThrough).on('data', chunk => {
    output += chunk.toString()
  })
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & {
    isTTY: boolean
    setRawMode: (enabled: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => undefined
  stdin.ref = () => undefined
  stdin.unref = () => undefined
  const stderr = new PassThrough() as unknown as NodeJS.WriteStream

  const instance = await render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        AppStateProvider,
        { initialState: getDefaultAppState() },
        node,
      ),
    ),
    {
      stdout,
      stdin,
      stderr,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )

  await new Promise(resolve => setTimeout(resolve, 30))
  instance.unmount()
  return stripAnsi(output)
}

const originalRandom = Math.random
const originalCoordinatorMode = process.env.CLAUDE_CODE_COORDINATOR_MODE
const originalSdkDisableBuiltins =
  process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS

afterEach(() => {
  Math.random = originalRandom
  capturedRunAgentParams = undefined
  resolvePendingMcpPoll = undefined
  resetWorkerNamesForTests()
  if (originalCoordinatorMode === undefined) {
    delete process.env.CLAUDE_CODE_COORDINATOR_MODE
  } else {
    process.env.CLAUDE_CODE_COORDINATOR_MODE = originalCoordinatorMode
  }
  if (originalSdkDisableBuiltins === undefined) {
    delete process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS
  } else {
    process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS =
      originalSdkDisableBuiltins
  }
  resetStateForTests()
})

describe('AgentTool effort input', () => {
  const baseInput = { description: 'do a thing', prompt: 'go' }

  test('accepts Astra as an explicit model override', () => {
    const parsed = inputSchema().safeParse({
      ...baseInput,
      model: 'gpt-6-astra',
    })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.model).toBe('gpt-6-astra')
  })

  test('accepts a named effort level from the calling agent', () => {
    const parsed = inputSchema().safeParse({ ...baseInput, effort: 'max' })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.effort).toBe('max')
  })

  test('leaves effort unset when the caller omits it', () => {
    const parsed = inputSchema().safeParse(baseInput)
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.effort).toBeUndefined()
  })

  // Numeric effort values are model-specific token budgets (effort.ts), not
  // something a calling agent has any basis to pick.
  test('rejects values that are not named effort levels', () => {
    expect(inputSchema().safeParse({ ...baseInput, effort: 8000 }).success).toBe(
      false,
    )
    expect(
      inputSchema().safeParse({ ...baseInput, effort: 'turbo' }).success,
    ).toBe(false)
  })
})

test('required MCP availability rejects an authentication pseudo-tool', async () => {
  const config = {
    type: 'stdio',
    command: 'fixture',
    args: [],
    scope: 'user',
  } as ScopedMcpServerConfig
  const agent = {
    agentType: 'mcp-agent',
    source: 'userSettings',
    whenToUse: 'Use MCP',
    requiredMcpServers: ['linear'],
    getSystemPrompt: () => 'Use MCP',
  } as AgentDefinition
  const authTool = {
    name: 'mcp__linear__authenticate',
    mcpInfo: { serverName: 'linear', toolName: 'authenticate' },
  } as Tool
  const appState = {
    ...getDefaultAppState(),
    mcp: {
      ...getDefaultAppState().mcp,
      clients: [{ name: 'linear', type: 'needs-auth', config }],
      tools: [authTool],
    },
  }
  const mcpRuntimeSnapshot = {
    clients: appState.mcp.clients,
    tools: appState.mcp.tools,
    commands: [],
    resources: {},
  }
  const context = {
    options: {
      agentDefinitions: {
        allAgents: [agent],
        activeAgents: [agent],
      },
      getMcpRuntimeSnapshot: () => mcpRuntimeSnapshot,
    },
    getAppState: () => appState,
  } as unknown as ToolUseContext

  await expect(
    AgentTool.call(
      {
        prompt: 'Use the integration',
        description: 'Use MCP',
        subagent_type: 'mcp-agent',
      },
      context,
      undefined as never,
      undefined as never,
    ),
  ).rejects.toThrow(
    "Agent 'mcp-agent' requires MCP servers matching: linear. MCP servers with tools: none.",
  )
})

test('waits for a required MCP server then launches the agent with its fresh snapshot', async () => {
  const config = {
    type: 'stdio',
    command: 'fixture',
    args: [],
    scope: 'user',
  } as ScopedMcpServerConfig
  const agent = {
    agentType: 'mcp-agent',
    source: 'userSettings',
    whenToUse: 'Use MCP',
    requiredMcpServers: ['fixture'],
    getSystemPrompt: () => 'Use MCP',
  } as AgentDefinition
  const freshTool = {
    name: 'mcp__fixture__lookup',
    mcpInfo: { serverName: 'fixture', toolName: 'lookup' },
  } as Tool
  const staleTurnStartTool = {
    name: 'mcp__stale__lookup',
    mcpInfo: { serverName: 'stale', toolName: 'lookup' },
  } as Tool
  const freshSnapshot = {
    clients: [
      {
        name: 'fixture',
        type: 'connected',
        config,
        capabilities: {},
        cleanup: async () => {},
        client: { onclose: undefined },
      },
    ],
    tools: [freshTool],
    commands: [{ name: 'mcp__fixture__command' }],
    resources: {
      fixture: [{ server: 'fixture', uri: 'fixture://resource', name: 'resource' }],
    },
  } as unknown as McpRuntimeSnapshot
  const turnStartClients = [{ name: 'stale', type: 'pending', config }]
  const turnStartCommands = [{ name: 'mcp__stale__command' }]
  const turnStartResources = {
    stale: [{ server: 'stale', uri: 'stale://resource', name: 'stale resource' }],
  }
  const initialState = getDefaultAppState()
  let appState = {
    ...initialState,
    mcp: {
      ...initialState.mcp,
      clients: [{ name: 'fixture', type: 'pending', config }],
      tools: [],
    },
  }
  let snapshotReads = 0
  let snapshotReadAfterConnection = false
  resolvePendingMcpPoll = () => {
    appState = {
      ...appState,
      mcp: {
        ...appState.mcp,
        clients: freshSnapshot.clients,
        tools: freshSnapshot.tools,
      },
    }
  }
  const context = {
    toolUseId: 'agent-mcp-handoff',
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: (update: (previous: typeof appState) => typeof appState) => {
      appState = update(appState)
    },
    options: {
      agentDefinitions: {
        allAgents: [agent],
        activeAgents: [agent],
      },
      commands: turnStartCommands,
      debug: false,
      mainLoopModel: 'claude-sonnet-4-5',
      tools: [staleTurnStartTool],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: turnStartClients,
      mcpResources: turnStartResources,
      isNonInteractiveSession: true,
      getMcpRuntimeSnapshot: () => {
        snapshotReads += 1
        snapshotReadAfterConnection =
          appState.mcp.clients[0]?.type === 'connected'
        if (!snapshotReadAfterConnection) {
          throw new Error('AgentTool read the MCP snapshot before the required server connected')
        }
        return freshSnapshot
      },
    },
  } as unknown as ToolUseContext

  await AgentTool.call(
    {
      prompt: 'Use the fixture integration',
      description: 'Use MCP',
      subagent_type: 'mcp-agent',
    },
    context,
    undefined as never,
    undefined as never,
  )

  const invocation = capturedRunAgentParams
  expect(snapshotReads).toBe(1)
  expect(snapshotReadAfterConnection).toBe(true)
  expect(invocation).toBeDefined()
  expect(invocation?.mcpRuntimeSnapshot).toBe(freshSnapshot)
  expect(invocation?.mcpRuntimeSnapshot?.clients).toBe(freshSnapshot.clients)
  expect(invocation?.mcpRuntimeSnapshot?.tools).toBe(freshSnapshot.tools)
  expect(invocation?.mcpRuntimeSnapshot?.commands).toBe(freshSnapshot.commands)
  expect(invocation?.mcpRuntimeSnapshot?.resources).toBe(freshSnapshot.resources)
  expect(invocation?.mcpRuntimeSnapshot?.clients).not.toBe(turnStartClients)
  expect(invocation?.mcpRuntimeSnapshot?.commands).not.toBe(turnStartCommands)
  expect(invocation?.mcpRuntimeSnapshot?.resources).not.toBe(turnStartResources)
  expect(invocation?.availableTools).toContain(freshTool)
  expect(invocation?.availableTools).not.toContain(staleTurnStartTool)
})

test('background transfer continues the same live iterator from its in-flight next result', async () => {
  const first = { type: 'progress', toolUseID: 'one' } as unknown as Message
  const second = { type: 'progress', toolUseID: 'two' } as unknown as Message
  let nextCalls = 0
  const iterator: AsyncIterator<Message, void> = {
    async next() {
      nextCalls += 1
      return nextCalls === 1
        ? { done: false, value: second }
        : { done: true, value: undefined }
    },
  }
  const received: Message[] = []

  await continueAgentIterator(
    iterator,
    Promise.resolve({ done: false, value: first }),
    message => received.push(message),
  )

  expect(received).toEqual([first, second])
  expect(nextCalls).toBe(2)
})

describe('AgentTool UI', () => {
  test('single async launch result introduces the resolved friendly agent name', async () => {
    const node = renderToolResultMessage(
      {
        status: 'async_launched',
        agentId: 'agent-a',
        agentName: 'Ada',
        agentType: 'general-purpose',
        description: 'review backend integration',
        prompt: 'review backend integration',
        outputFile: '/tmp/agent-a',
        canCheckProgress: true,
      },
      [],
      {
        tools: [],
        verbose: false,
        theme: 'dark' as never,
      },
    )

    expect(await renderToPlainText(node)).toContain('Backgrounded agent @Ada')
  })

  test('async launch result frames TaskOutput as optional manual retrieval', () => {
    const block = AgentTool.mapToolResultToToolResultBlockParam(
      {
        status: 'async_launched',
        agentId: 'agent-a',
        agentName: 'Ada',
        agentType: 'Explore',
        description: 'inspect sessions page',
        prompt: 'inspect sessions page',
        outputFile: '/tmp/agent-a.output',
        canCheckProgress: true,
      },
      'tool-a',
    )

    const text = Array.isArray(block.content)
      ? block.content
          .map(part => (part.type === 'text' ? part.text : ''))
          .join('\n')
      : block.content

    expect(text).toContain(
      'TaskOutput is available for explicit status checks, manual retrieval, or intentional waits',
    )
    expect(text).toContain('not the default background-agent result handoff')
    expect(text).not.toContain('block: true')
    expect(text).not.toContain('call TaskOutput')
    expect(text).toContain('automatic completion notification')
    expect(text).toContain('end your response')
    expect(text).toContain('yield the turn')
    expect(text).toContain('output_file: /tmp/agent-a.output')
    expect(text).toContain('debug transcript path only')
    expect(text).toContain('do not read it for progress or results')
    expect(text).toContain('raw transcript forensics')
    expect(text).not.toContain('Read on the output file')
    expect(text).not.toContain('raw stdout')
  })

  test('grouped async launch rows introduce resolved friendly agent names', async () => {
    const node = renderGroupedAgentToolUse(
      [
        {
          param: {
            type: 'tool_use',
            id: 'tool-a',
            name: 'Agent',
            input: {
              description: 'review backend integration',
              prompt: 'review backend integration',
              subagent_type: 'general-purpose',
              run_in_background: true,
            },
          },
          isResolved: true,
          isError: false,
          isInProgress: false,
          progressMessages: [],
          result: {
            param: {
              type: 'tool_result',
              tool_use_id: 'tool-a',
              content: [{ type: 'text', text: '' }],
            },
            output: {
              status: 'async_launched',
              agentId: 'agent-a',
              agentName: 'Ada',
              agentType: 'general-purpose',
              description: 'review backend integration',
              prompt: 'review backend integration',
              outputFile: '/tmp/agent-a',
              canCheckProgress: true,
            },
          },
        },
        {
          param: {
            type: 'tool_use',
            id: 'tool-b',
            name: 'Agent',
            input: {
              description: 'review UI integration',
              prompt: 'review UI integration',
              subagent_type: 'general-purpose',
              run_in_background: true,
            },
          },
          isResolved: true,
          isError: false,
          isInProgress: false,
          progressMessages: [],
          result: {
            param: {
              type: 'tool_result',
              tool_use_id: 'tool-b',
              content: [{ type: 'text', text: '' }],
            },
            output: {
              status: 'async_launched',
              agentId: 'agent-b',
              agentName: 'Katherine',
              agentType: 'general-purpose',
              description: 'review UI integration',
              prompt: 'review UI integration',
              outputFile: '/tmp/agent-b',
              canCheckProgress: true,
            },
          },
        },
      ],
      { shouldAnimate: false, tools: [] },
    )

    const text = await renderToPlainText(node)
    expect(text).toContain('2 background agents launched')
    expect(text).toContain('@Ada: review backend integration')
    expect(text).toContain('@Katherine: review UI integration')
  })
})

describe('getBuiltInAgents in normal mode', () => {
  test('registers normal implementor and verification agents without coordinator gates', () => {
    delete process.env.CLAUDE_CODE_COORDINATOR_MODE
    delete process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS

    const agentTypes = getBuiltInAgents().map(agent => agent.agentType)

    expect(agentTypes).toContain('implementor')
    expect(agentTypes).toContain('verification')
  })

})

describe('resolveSystemSubagentName', () => {
  test('allocates a friendly name for unnamed ordinary subagents', async () => {
    Math.random = () => 0

    await expect(
      resolveSystemSubagentName({
        agentType: 'general-purpose',
        appState: {
          agentNameRegistry: new Map(),
        } as never,
        sessionId: randomUUID(),
        agentId: 'agent-123',
      }),
    ).resolves.toEqual({
      agentName: 'Ada',
      processReservationName: 'Ada',
    })
  })

  test('respects explicit subagent names', async () => {
    Math.random = () => 0

    await expect(
      resolveSystemSubagentName({
        explicitName: 'custom-worker',
        agentType: 'general-purpose',
        appState: {
          agentNameRegistry: new Map(),
        } as never,
        sessionId: randomUUID(),
        agentId: 'agent-123',
      }),
    ).resolves.toEqual({
      agentName: 'custom-worker',
      processReservationName: 'custom-worker',
    })
  })

  test('trims explicit subagent names before reserving them', async () => {
    await expect(
      resolveSystemSubagentName({
        explicitName: '  custom-worker  ',
        agentType: 'general-purpose',
        appState: {
          agentNameRegistry: new Map(),
        } as never,
        sessionId: randomUUID(),
        agentId: 'agent-123',
      }),
    ).resolves.toEqual({
      agentName: 'custom-worker',
      processReservationName: 'custom-worker',
    })
  })

  test('rejects explicit names already used by running subagents', async () => {
    await expect(
      resolveSystemSubagentName({
        explicitName: 'worker-one',
        agentType: 'general-purpose',
        appState: {
          agentNameRegistry: new Map([['worker-one', 'agent-existing']]),
        } as never,
        sessionId: randomUUID(),
        agentId: 'agent-123',
      }),
    ).rejects.toThrow('Subagent name "worker-one" is already in use')
  })

  test('rejects explicit names that would render as invalid displayed aliases', async () => {
    await expect(
      resolveSystemSubagentName({
        explicitName: '@worker-one',
        agentType: 'general-purpose',
        appState: {
          agentNameRegistry: new Map(),
        } as never,
        sessionId: randomUUID(),
        agentId: 'agent-123',
      }),
    ).rejects.toThrow('Subagent name must not include @')
  })

  test('rejects explicit names that conflict with SendMessage address syntax', async () => {
    const baseInput = {
      agentType: 'general-purpose',
      appState: {
        agentNameRegistry: new Map(),
      } as never,
      sessionId: randomUUID(),
      agentId: 'agent-123',
    }

    await expect(
      resolveSystemSubagentName({
        ...baseInput,
        explicitName: 'bridge:worker-one',
      }),
    ).rejects.toThrow('Subagent name must not include :')

    await expect(
      resolveSystemSubagentName({
        ...baseInput,
        explicitName: '*',
      }),
    ).rejects.toThrow('Subagent name must not be "*"')
  })
})

describe('buildAgentSessionStateTracking', () => {
  test('tracks coordinator worker state without goal-specific fields', () => {
    expect(
      buildAgentSessionStateTracking({
        sessionMode: 'coordinator',
        sessionId: 'session-123',
      }),
    ).toEqual({
      sessionId: 'session-123',
      mode: 'coordinator',
      statePath: expect.any(String),
    })
  })

  test('returns undefined outside coordinator mode', () => {
    expect(
      buildAgentSessionStateTracking({
        sessionMode: 'normal',
        sessionId: 'session-123',
      }),
    ).toBeUndefined()
  })
})

describe('finalizeFailedAgentLaunch', () => {
  test('records failed launch state and returns structured error output', async () => {
    const spawnCalls: Array<Record<string, unknown>> = []
    const terminalCalls: Array<Record<string, unknown>> = []
    const sessionId = randomUUID()
    const statePath = join(tmpdir(), `${sessionId}.worker-state.json`)
    Math.random = () => 0

    const result = await finalizeFailedAgentLaunch(
      {
        prompt: 'Investigate the report flow',
        description: 'Map workspace for report flow',
        agentId: 'agent-123',
        agentType: 'Explore',
        model: 'gpt-5.6-terra',
        error: new ReferenceError('store is not defined'),
        durationMs: 42,
        spawnedAt: '2026-05-02T10:00:00.000Z',
        worktreePath: null,
        sessionStateTracking: {
          sessionId,
          mode: 'coordinator',
          statePath,
        },
      },
      {
        recordSpawn: async call => {
          spawnCalls.push(call as unknown as Record<string, unknown>)
        },
        recordTerminal: async call => {
          terminalCalls.push(call as unknown as Record<string, unknown>)
        },
      },
    )

    expect(spawnCalls).toEqual([
      {
        sessionId,
        mode: 'coordinator',
        statePath,
        handle: 'Ada',
        agentId: 'agent-123',
        role: 'Explore',
        description: 'Map workspace for report flow',
        worktreePath: null,
        spawnedAt: '2026-05-02T10:00:00.000Z',
      },
    ])
    expect(terminalCalls).toEqual([
      {
        sessionId,
        agentId: 'agent-123',
        status: 'failed',
        createStateIfMissing: {
          sessionId,
          mode: 'coordinator',
          statePath,
        },
      },
    ])
    expect(result).toEqual({
      data: {
        status: 'completed_with_error',
        prompt: 'Investigate the report flow',
        agentId: 'agent-123',
        agentType: 'Explore',
        model: 'gpt-5.6-terra',
        content: [
          {
            type: 'text',
            text:
              'Worker launch failed before initialization for Explore (Map workspace for report flow).\n' +
              'Error: store is not defined',
          },
        ],
        error: 'store is not defined',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: null,
          service_tier: null,
          cache_creation: null,
        },
        totalToolUseCount: 0,
        totalDurationMs: 42,
        totalTokens: 0,
      },
    })
  })

  test('provides usage so completed_with_error launch failures serialize safely', async () => {
    const result = await finalizeFailedAgentLaunch({
      prompt: 'Investigate the report flow',
      description: 'Map workspace for report flow',
      agentId: 'agent-123',
      agentType: 'Explore',
      error: new ReferenceError('store is not defined'),
      durationMs: 42,
    })

    expect(() =>
      AgentTool.mapToolResultToToolResultBlockParam(
        result.data,
        'toolu_123',
        'assistant-msg-123',
      ),
    ).not.toThrow()
  })

  test('serializes completed_with_error results when usage is missing', () => {
    expect(() =>
      AgentTool.mapToolResultToToolResultBlockParam(
        {
          status: 'completed_with_error',
          prompt: 'Investigate websocket close',
          agentId: 'agent-123',
          agentType: 'Explore',
          content: [{ type: 'text', text: 'partial result before stream error' }],
          error: 'websocket closed by server before response.completed',
          totalToolUseCount: 0,
          totalDurationMs: 42,
          totalTokens: 0,
        },
        'toolu_123',
        'assistant-msg-123',
      ),
    ).not.toThrow()
  })

  test('omits post-completion ResumeAgent hint for async one-shot built-ins', () => {
    const result = AgentTool.mapToolResultToToolResultBlockParam(
      {
        status: 'async_launched',
        agentId: 'agent-123',
        agentType: 'Explore',
        description: 'Explore auth flow',
        prompt: 'Map auth flow',
        outputFile: '/tmp/agent-123.out',
        canCheckProgress: false,
      },
      'toolu_123',
    )

    const text = Array.isArray(result.content)
      ? result.content.map(block => ('text' in block ? block.text : '')).join('\n')
      : result.content
    expect(text).not.toContain('ResumeAgent')
    expect(text).not.toContain('After it completes or is stopped')
  })

  test('keeps running and stopped continuation hints for normal async agents', () => {
    const result = AgentTool.mapToolResultToToolResultBlockParam(
      {
        status: 'async_launched',
        agentId: 'agent-123',
        agentType: 'general-purpose',
        description: 'Implement auth flow',
        prompt: 'Implement auth flow',
        outputFile: '/tmp/agent-123.out',
        canCheckProgress: false,
        continuationCapabilities: {
          canSendMessage: true,
          canResumeAgent: true,
          canSpawnAgent: false,
        },
      },
      'toolu_123',
    )

    const text = Array.isArray(result.content)
      ? result.content.map(block => ('text' in block ? block.text : '')).join('\n')
      : result.content
    expect(text).toContain("use SendMessage with to: 'agent-123'")
    expect(text).toContain("use ResumeAgent({ agentId: 'agent-123', prompt })")
  })

  test('omits ResumeAgent hint but keeps SendMessage hint when the invoker cannot resume', () => {
    const result = AgentTool.mapToolResultToToolResultBlockParam(
      {
        status: 'async_launched',
        agentId: 'agent-123',
        agentType: 'general-purpose',
        description: 'Implement auth flow',
        prompt: 'Implement auth flow',
        outputFile: '/tmp/agent-123.out',
        canCheckProgress: false,
        continuationCapabilities: {
          canSendMessage: true,
          canResumeAgent: false,
          canSpawnAgent: false,
        },
      },
      'toolu_123',
    )

    const text = Array.isArray(result.content)
      ? result.content.map(block => ('text' in block ? block.text : '')).join('\n')
      : result.content
    expect(text).toContain("use SendMessage with to: 'agent-123'")
    expect(text).not.toContain('ResumeAgent')
    expect(text).not.toContain('After it completes or is stopped')
  })

  test('emits no continuation literal for historical results missing continuationCapabilities', () => {
    const result = AgentTool.mapToolResultToToolResultBlockParam(
      {
        status: 'async_launched',
        agentId: 'agent-123',
        agentType: 'general-purpose',
        description: 'Implement auth flow',
        prompt: 'Implement auth flow',
        outputFile: '/tmp/agent-123.out',
        canCheckProgress: false,
      },
      'toolu_123',
    )

    const text = Array.isArray(result.content)
      ? result.content.map(block => ('text' in block ? block.text : '')).join('\n')
      : result.content
    expect(text).not.toContain('SendMessage')
    expect(text).not.toContain('ResumeAgent')
  })

  test('uses system-assigned names for normal async continuation hints', () => {
    const result = AgentTool.mapToolResultToToolResultBlockParam(
      {
        status: 'async_launched',
        agentId: 'agent-123',
        agentName: 'Ada',
        agentType: 'general-purpose',
        description: 'Implement auth flow',
        prompt: 'Implement auth flow',
        outputFile: '/tmp/agent-123.out',
        canCheckProgress: false,
        continuationCapabilities: {
          canSendMessage: true,
          canResumeAgent: true,
          canSpawnAgent: false,
        },
      },
      'toolu_123',
    )

    const text = Array.isArray(result.content)
      ? result.content.map(block => ('text' in block ? block.text : '')).join('\n')
      : result.content
    expect(text).toContain("use SendMessage with to: '@Ada'")
    expect(text).toContain("use ResumeAgent({ agentId: '@Ada', prompt })")
    expect(text).toContain('agentName: Ada')
  })

  test('uses system-assigned names for completed continuation hints', () => {
    const result = AgentTool.mapToolResultToToolResultBlockParam(
      {
        status: 'completed',
        prompt: 'Implement auth flow',
        agentId: 'agent-123',
        agentName: 'Ada',
        agentType: 'general-purpose',
        model: 'gpt-5.6-terra',
        content: [{ type: 'text', text: 'finished' }],
        totalToolUseCount: 0,
        totalDurationMs: 42,
        totalTokens: 10,
        continuationCapabilities: {
          canSendMessage: true,
          canResumeAgent: true,
          canSpawnAgent: false,
        },
      },
      'toolu_123',
    )

    const text = Array.isArray(result.content)
      ? result.content.map(block => ('text' in block ? block.text : '')).join('\n')
      : result.content
    expect(text).toContain("agentName: Ada")
    expect(text).toContain("use ResumeAgent({ agentId: '@Ada', prompt })")
  })

  test('omits ResumeAgent hint for completed results when canResumeAgent is false', () => {
    const result = AgentTool.mapToolResultToToolResultBlockParam(
      {
        status: 'completed',
        prompt: 'Implement auth flow',
        agentId: 'agent-123',
        agentName: 'Ada',
        agentType: 'general-purpose',
        model: 'gpt-5.5',
        content: [{ type: 'text', text: 'finished' }],
        totalToolUseCount: 0,
        totalDurationMs: 42,
        totalTokens: 10,
        continuationCapabilities: {
          canSendMessage: true,
          canResumeAgent: false,
          canSpawnAgent: false,
        },
      },
      'toolu_123',
    )

    const text = Array.isArray(result.content)
      ? result.content.map(block => ('text' in block ? block.text : '')).join('\n')
      : result.content
    expect(text).toContain('agentName: Ada')
    expect(text).not.toContain('ResumeAgent')
  })

  test('records failed worker state when tracking is available before later launch steps fail', async () => {
    const spawnCalls: Array<Record<string, unknown>> = []
    const terminalCalls: Array<Record<string, unknown>> = []

    await finalizeFailedAgentLaunch(
      {
        prompt: 'Investigate the report flow',
        description: 'Map workspace for report flow',
        agentId: 'agent-123',
        agentType: 'Explore',
        error: new Error('worktree setup failed'),
        durationMs: 42,
        sessionStateTracking: buildAgentSessionStateTracking({
          sessionMode: 'coordinator',
          sessionId: 'session-123',
          threadGoalObjective: 'Deliver the report',
          description: 'Map workspace for report flow',
        }),
      },
      {
        recordSpawn: async call => {
          spawnCalls.push(call as unknown as Record<string, unknown>)
        },
        recordTerminal: async call => {
          terminalCalls.push(call as unknown as Record<string, unknown>)
        },
      },
    )

    expect(spawnCalls).toHaveLength(1)
    expect(terminalCalls).toHaveLength(1)
  })

  test('persists generic handles for tracked launch failures and advances allocation', async () => {
    const tempProjectDir = mkdtempSync(join(tmpdir(), 'agent-tool-failed-launch-'))
    const sessionId = 'session-123'
    Math.random = () => 0
    resetStateForTests()
    switchSession(sessionId as never, tempProjectDir)

    try {
      await finalizeFailedAgentLaunch({
        prompt: 'Investigate the report flow',
        description: 'Map workspace for report flow',
        agentId: 'agent-123',
        agentType: 'Explore',
        error: new Error('worktree setup failed'),
        durationMs: 42,
        sessionStateTracking: buildAgentSessionStateTracking({
          sessionMode: 'coordinator',
          sessionId,
          threadGoalObjective: 'Deliver the report',
          description: 'Map workspace for report flow',
        }),
      })

      const state = await readSessionState(sessionId)
      const failedWorker = state?.knownWorkers['agent-123']

      expect(failedWorker?.handle).toBe('Ada')
      expect(failedWorker?.handle).not.toBe('agent-123')
      expect(allocateWorkerName('Explore')).toBe('Katherine')
    } finally {
      await rm(tempProjectDir, { recursive: true, force: true })
    }
  })
})


describe('reportableAccount', () => {
  const account = { accountId: 'acct-1', accountAlias: 'scout' }

  test('withholds the account from a worker that is not on the Codex path', () => {
    // Second gate on the same routing function that registerWorkerCodexLease
    // uses: registration decides whether to TAKE an account, this decides
    // whether the run SPENT one, and only the second is what the transcript
    // claims.
    expect(reportableAccount(account, 'claude-sonnet-5', 'firstParty')).toBeUndefined()
  })

  test('reports it for a gpt model whatever the session provider is', () => {
    // The model string decides the request's provider, so the gate has to read
    // it and not the session default.
    expect(reportableAccount(account, 'gpt-5.6-luna', 'firstParty')).toEqual(account)
  })

  test('reports nothing when no lease was held, even on the Codex path', () => {
    expect(reportableAccount(undefined, 'gpt-5.6-luna', 'openai')).toBeUndefined()
  })
})

function buildLeasePoolAccount(accountId: string, status: PoolAccount['status'] = 'healthy'): PoolAccount {
  return {
    accountId,
    accessToken: `token-${accountId}`,
    refreshToken: `refresh-${accountId}`,
    expiresAt: Date.now() + 5 * 60_000,
    source: 'config',
    status,
    lastUsedAt: 0,
    credentialGeneration: 0,
    credentialGenerationState: 'legacy_unbound',
    usageFetchedAt: Date.now(),
  }
}

describe('registerWorkerCodexLease', () => {
  beforeEach(() => {
    resetCodexLeaseManagerForTest()
    resetCodexAccountPoolForTest()
  })

  afterEach(() => {
    resetCodexLeaseManagerForTest()
    resetCodexAccountPoolForTest()
  })

  test('does not throw when no Codex account is configured', () => {
    // An Anthropic-only machine has an empty pool, and selectAccountForLease
    // throws there. Both spawn sites sit outside the launch try/catch, so an
    // unguarded registration failed every Agent tool call on such a machine.
    // This is the Anthropic worker on that machine; the gpt case below is the
    // one that reaches the pool gate.
    resetCodexAccountPoolForTest()

    expect(() =>
      registerWorkerCodexLease({
        ownerId: 'agent_anthropic_only',
        ownerLabel: 'explore the repo',
        model: 'claude-sonnet-5',
        baseProvider: 'firstParty',
      }),
    ).not.toThrow()
    expect(getCodexLeaseForOwner('agent_anthropic_only')).toBeUndefined()
  })

  test('withholds a lease from an Anthropic worker even with a healthy pool', () => {
    seedCodexAccountPoolForTest({
      accounts: [buildLeasePoolAccount('acct-1')],
      activeAccountId: 'acct-1',
    })

    registerWorkerCodexLease({
      ownerId: 'agent_anthropic',
      ownerLabel: 'explore the repo',
      model: 'claude-sonnet-5',
      baseProvider: 'firstParty',
    })

    expect(getCodexLeaseForOwner('agent_anthropic')).toBeUndefined()
  })

  test('still leases for a non-gpt model inside a Codex session', () => {
    // Only `gpt-` prefixes decide routing on their own; every other model id
    // falls back to the session provider, and that request really does enter
    // the Codex adapter. Gating on the model name alone would strand it.
    seedCodexAccountPoolForTest({
      accounts: [buildLeasePoolAccount('acct-1')],
      activeAccountId: 'acct-1',
    })

    registerWorkerCodexLease({
      ownerId: 'agent_codex_session',
      ownerLabel: 'explore the repo',
      model: 'claude-sonnet-5',
      baseProvider: 'openai',
    })

    expect(getCodexLeaseForOwner('agent_codex_session')?.accountId).toBe('acct-1')
  })

  test('leases for a gpt worker whatever the session provider is', () => {
    seedCodexAccountPoolForTest({
      accounts: [buildLeasePoolAccount('acct-1')],
      activeAccountId: 'acct-1',
    })

    registerWorkerCodexLease({
      ownerId: 'agent_codex',
      ownerLabel: 'explore the repo',
      model: 'gpt-5.6-luna',
      baseProvider: 'firstParty',
    })

    const lease = getCodexLeaseForOwner('agent_codex')
    expect(lease?.accountId).toBe('acct-1')
    expect(lease?.ownerLabel).toBe('explore the repo')
    expect(lease?.ownerType).toBe('subagent')
  })

  test('leaves a Codex worker leaseless rather than throwing on an empty pool', () => {
    // The provider gate cannot carry this case: the worker really is on the
    // Codex path, so only the pool gate and the catch stand between an
    // uninitialised pool and a failed spawn.
    resetCodexAccountPoolForTest()

    expect(() =>
      registerWorkerCodexLease({
        ownerId: 'agent_codex_no_pool',
        ownerLabel: 'explore the repo',
        model: 'gpt-5.6-luna',
        baseProvider: 'openai',
      }),
    ).not.toThrow()
    expect(getCodexLeaseForOwner('agent_codex_no_pool')).toBeUndefined()
  })

  test('swallows a lease-selection failure instead of failing the spawn', () => {
    seedCodexAccountPoolForTest({
      accounts: [buildLeasePoolAccount('acct-1', 'capped')],
    })

    expect(() =>
      registerWorkerCodexLease({
        ownerId: 'agent_capped',
        ownerLabel: 'explore the repo',
        model: 'gpt-5.6-luna',
        baseProvider: 'openai',
      }),
    ).not.toThrow()
    expect(getCodexLeaseForOwner('agent_capped')).toBeUndefined()
  })
})
