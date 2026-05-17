import { afterEach, describe, expect, test } from 'bun:test'

import { randomUUID } from 'crypto'
import { mkdtempSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { resetStateForTests, switchSession } from '../../bootstrap/state.js'
import { readSessionState } from '../../agent-mode/sessionState.js'
import { allocateWorkerName, releaseWorkerName } from '../../agent-mode/workerNames.js'
import {
  AgentTool,
  buildAgentSessionStateTracking,
  deriveSessionStateTrackingObjective,
  finalizeFailedAgentLaunch,
  resolveSystemSubagentName,
} from './AgentTool.js'

const originalRandom = Math.random

afterEach(() => {
  Math.random = originalRandom
  releaseWorkerName('Ada')
  releaseWorkerName('Katherine')
  resetStateForTests()
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
      allocatedAgentName: 'Ada',
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
      },
      'toolu_123',
    )

    const text = Array.isArray(result.content)
      ? result.content.map(block => ('text' in block ? block.text : '')).join('\n')
      : result.content
    expect(text).toContain("use SendMessage with to: 'agent-123'")
    expect(text).toContain("use ResumeAgent({ agentId: 'agent-123', prompt })")
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
      },
      'toolu_123',
    )

    const text = Array.isArray(result.content)
      ? result.content.map(block => ('text' in block ? block.text : '')).join('\n')
      : result.content
    expect(text).toContain("agentName: Ada")
    expect(text).toContain("use ResumeAgent({ agentId: '@Ada', prompt })")
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

  test('persists generic handles for tracked Agent Mode launch failures without leaking reservations', async () => {
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
        'Ada',
      )
    } finally {
      await rm(tempProjectDir, { recursive: true, force: true })
    }
  })
})
