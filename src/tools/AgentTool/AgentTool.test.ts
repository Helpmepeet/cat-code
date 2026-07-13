import { afterEach, describe, expect, test } from 'bun:test'

import { randomUUID } from 'crypto'
import { mkdtempSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough } from 'stream'
import stripAnsi from 'strip-ansi'
import * as React from 'react'
import { resetStateForTests, switchSession } from '../../bootstrap/state.js'
import { readSessionState } from '../../agent-mode/sessionState.js'
import {
  allocateWorkerName,
  resetWorkerNamesForTests,
} from '../../agent-mode/workerNames.js'
import { render, ThemeProvider } from '../../ink.js'
import { AppStateProvider, getDefaultAppState } from '../../state/AppState.js'
import { getBuiltInAgents } from './builtInAgents.js'
import {
  AgentTool,
  buildAgentSessionStateTracking,
  deriveSessionStateTrackingObjective,
  finalizeFailedAgentLaunch,
  resolveSystemSubagentName,
} from './AgentTool.js'
import { renderGroupedAgentToolUse, renderToolResultMessage } from './UI.js'

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
const originalAgentMode = process.env.CLAUDE_CODE_AGENT_MODE
const originalCoordinatorMode = process.env.CLAUDE_CODE_COORDINATOR_MODE
const originalSdkDisableBuiltins =
  process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS

afterEach(() => {
  Math.random = originalRandom
  resetWorkerNamesForTests()
  if (originalAgentMode === undefined) {
    delete process.env.CLAUDE_CODE_AGENT_MODE
  } else {
    process.env.CLAUDE_CODE_AGENT_MODE = originalAgentMode
  }
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
  test('registers normal implementor and verification agents without Agent Mode gates', () => {
    delete process.env.CLAUDE_CODE_AGENT_MODE
    delete process.env.CLAUDE_CODE_COORDINATOR_MODE
    delete process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS

    const agentTypes = getBuiltInAgents().map(agent => agent.agentType)

    expect(agentTypes).toContain('implementor')
    expect(agentTypes).toContain('verification')
    expect(agentTypes).not.toContain('agent-mode-coding-worker')
    expect(agentTypes).not.toContain('agent-mode-verifier')
  })

  test('keeps Agent Mode worker roles separate from normal-mode roles', () => {
    process.env.CLAUDE_CODE_AGENT_MODE = '1'
    delete process.env.CLAUDE_CODE_COORDINATOR_MODE
    delete process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS

    const agentTypes = getBuiltInAgents().map(agent => agent.agentType)

    expect(agentTypes).toContain('agent-mode-coding-worker')
    expect(agentTypes).toContain('agent-mode-verifier')
    expect(agentTypes).not.toContain('implementor')
    expect(agentTypes).not.toContain('verification')
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

describe('deriveSessionStateTrackingObjective', () => {
  test('prefers the thread goal objective over worker description', () => {
    expect(
      deriveSessionStateTrackingObjective({
        threadGoalObjective: 'Finish the real goal',
        description: 'Implement a narrow worker task',
      }),
    ).toBe('Finish the real goal')
  })

  test('falls back to worker description and default text', () => {
    expect(
      deriveSessionStateTrackingObjective({
        description: 'Implement a narrow worker task',
      }),
    ).toBe('Implement a narrow worker task')

    expect(deriveSessionStateTrackingObjective({})).toBe(
      'Continue current objective',
    )
  })
})

describe('buildAgentSessionStateTracking', () => {
  test('uses thread goal state from app state inputs for agent mode', () => {
    expect(
      buildAgentSessionStateTracking({
        sessionMode: 'agent',
        sessionId: 'session-123',
        threadGoalObjective: 'Deliver the report',
        description: 'Map workspace',
      }),
    ).toEqual({
      sessionId: 'session-123',
      mode: 'agent',
      objective: 'Deliver the report',
      statePath: expect.any(String),
    })
  })

  test('returns undefined outside agent and coordinator modes', () => {
    expect(
      buildAgentSessionStateTracking({
        sessionMode: 'normal',
        sessionId: 'session-123',
        threadGoalObjective: 'Deliver the report',
        description: 'Map workspace',
      }),
    ).toBeUndefined()
  })
})

describe('finalizeFailedAgentLaunch', () => {
  test('records failed launch state and returns structured error output', async () => {
    const spawnCalls: Array<Record<string, unknown>> = []
    const terminalCalls: Array<Record<string, unknown>> = []
    const sessionId = randomUUID()
    const statePath = join(tmpdir(), `${sessionId}.agent-mode-state.json`)
    Math.random = () => 0

    const result = await finalizeFailedAgentLaunch(
      {
        prompt: 'Investigate the report flow',
        description: 'Map workspace for report flow',
        agentId: 'agent-123',
        agentType: 'Explore',
        model: 'gpt-5.5',
        error: new ReferenceError('store is not defined'),
        durationMs: 42,
        spawnedAt: '2026-05-02T10:00:00.000Z',
        worktreePath: null,
        sessionStateTracking: {
          sessionId,
          mode: 'agent',
          objective: 'Deliver the report',
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
        mode: 'agent',
        objective: 'Deliver the report',
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
        error: 'store is not defined',
        outputSummary: 'Map workspace for report flow',
        createStateIfMissing: {
          sessionId,
          mode: 'agent',
          objective: 'Deliver the report',
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
        model: 'gpt-5.5',
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
        model: 'gpt-5.5',
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
          sessionMode: 'agent',
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

  test('persists generic handles for tracked Agent Mode launch failures and advances allocation', async () => {
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
          sessionMode: 'agent',
          sessionId,
          threadGoalObjective: 'Deliver the report',
          description: 'Map workspace for report flow',
        }),
      })

      const state = await readSessionState(sessionId)
      const failedWorker = state?.knownWorkers.find(
        worker => worker.agentId === 'agent-123',
      )

      expect(failedWorker?.handle).toBe('Ada')
      expect(failedWorker?.handle).not.toBe('agent-123')
      expect(allocateWorkerName('Explore', [], { allowGeneric: true })).toBe(
        'Katherine',
      )
    } finally {
      await rm(tempProjectDir, { recursive: true, force: true })
    }
  })
})
