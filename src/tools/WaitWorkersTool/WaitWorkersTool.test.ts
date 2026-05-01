import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { rm } from 'fs/promises'
import { resetStateForTests, switchSession } from '../../bootstrap/state.js'
import { getTranscriptPathForSession } from '../../utils/sessionStorage.js'
import {
  createSessionState,
  recordWorkerSessionSpawn,
  updateSessionState,
} from '../../agent-mode/sessionState.js'
import { WaitWorkersTool } from './WaitWorkersTool.js'

describe('WaitWorkersTool', () => {
  let sessionId: string
  let statePath: string

  beforeEach(() => {
    resetStateForTests()
    sessionId = randomUUID()
    switchSession(sessionId as never)
    statePath = getTranscriptPathForSession(sessionId).replace(
      '.jsonl',
      '.agent-mode-state.json',
    )
  })

  afterEach(async () => {
    await rm(statePath, { force: true })
  })

  test('returns complete when workers are already terminal', async () => {
    const workerAgentId = randomUUID().slice(0, 8)

    await updateSessionState(
      sessionId,
      () =>
        createSessionState({
          sessionId,
          mode: 'agent',
          objective: 'Wait for worker completion',
        }),
      () => {},
    )
    await recordWorkerSessionSpawn({
      sessionId,
      mode: 'agent',
      objective: 'Wait for worker completion',
      handle: 'explore-1',
      agentId: workerAgentId,
      role: 'explorer',
      description: 'Completed worker',
      worktreePath: null,
    })

    const context = {
      getAppState: () => ({
        tasks: {
          [workerAgentId]: {
            status: 'completed',
            description: 'done',
          },
        },
      }),
      setAppState: (_) => {},
    }

    const result = await WaitWorkersTool.call(
      { workers: ['explore-1'], timeout: 2000 },
      context as never,
    )

    expect(result.data.status).toBe('complete')
    expect(result.data.workers).toHaveLength(1)
    expect(result.data.workers[0]?.status).toBe('completed')
  })

  test('supports timeout and missing worker reporting', async () => {
    const runningWorker = randomUUID().slice(0, 8)

    await updateSessionState(
      sessionId,
      () =>
        createSessionState({
          sessionId,
          mode: 'agent',
          objective: 'Wait for worker completion',
        }),
      () => {},
    )
    await recordWorkerSessionSpawn({
      sessionId,
      mode: 'agent',
      objective: 'Wait for worker completion',
      handle: 'agent-runner',
      agentId: runningWorker,
      role: 'implementor',
      description: 'Long-running worker',
      worktreePath: null,
    })

    const context = {
      getAppState: () => ({
        tasks: {
          [runningWorker]: {
            status: 'running',
            description: 'running',
          },
        },
      }),
      setAppState: (_) => {},
    }

    const timeoutResult = await WaitWorkersTool.call(
      {
        workers: ['agent-runner', 'unknown-worker'],
        timeout: 10,
      },
      context as never,
    )

    expect(timeoutResult.data.status).toBe('timeout')
    expect(timeoutResult.data.workers[0]?.agentId).toBe(runningWorker)
    expect(timeoutResult.data.missing).toContain('unknown-worker')
  })

  test('returns missing status when all worker targets are unknown', async () => {
    const context = {
      getAppState: () => ({ tasks: {} }),
      setAppState: () => {},
    }

    const result = await WaitWorkersTool.call(
      {
        workers: ['unknown-worker-a', 'unknown-worker-b'],
        timeout: 100,
      },
      context as never,
    )

    expect(result.data.status).toBe('missing')
    expect(result.data.workers).toHaveLength(0)
    expect(result.data.missing).toEqual(['unknown-worker-a', 'unknown-worker-b'])
  })

  test('treats not_in_memory durable workers as non-terminal', async () => {
    const sessionWorkerId = randomUUID().slice(0, 8)

    await updateSessionState(
      sessionId,
      () =>
        createSessionState({
          sessionId,
          mode: 'agent',
          objective: 'Wait for durable-only worker',
        }),
      () => {},
    )
    await recordWorkerSessionSpawn({
      sessionId,
      mode: 'agent',
      objective: 'Wait for durable-only worker',
      handle: 'session-only-worker',
      agentId: sessionWorkerId,
      role: 'implementor',
      description: 'Worker not in AppState',
      worktreePath: null,
    })

    const context = {
      getAppState: () => ({ tasks: {} }),
      setAppState: () => {},
    }

    const result = await WaitWorkersTool.call(
      {
        workers: ['session-only-worker'],
        timeout: 50,
      },
      context as never,
    )

    expect(result.data.status).toBe('timeout')
    expect(result.data.workers[0]?.status).toBe('running')
  })
})
