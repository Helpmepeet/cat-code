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
} from './AgentTool.js'

const originalRandom = Math.random

afterEach(() => {
  Math.random = originalRandom
  releaseWorkerName('Ada')
  releaseWorkerName('Katherine')
  resetStateForTests()
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
