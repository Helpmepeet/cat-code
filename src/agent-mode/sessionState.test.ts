import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { rm } from 'fs/promises'
import { resetStateForTests, switchSession } from '../bootstrap/state.js'
import { getTranscriptPathForSession } from '../utils/sessionStorage.js'
import {
  createSessionState,
  markWorkerResultSynthesized,
  readSessionState,
  recordWorkerSessionSpawn,
  recordWorkerSessionTerminal,
  resolveWorkerAgentId,
  updateSessionState,
} from './sessionState.js'

describe('agent mode session state', () => {
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

  test('marks completed worker output as pending synthesis until explicitly marked', async () => {
    const mode = 'agent'
    const objective = 'Build worker control plane'
    const workerAgentId = randomUUID().slice(0, 8)

    await updateSessionState(
      sessionId,
      () =>
        createSessionState({
          sessionId,
          mode,
          objective,
        }),
      state => {
        state.mode = mode
      },
    )

    await recordWorkerSessionSpawn({
      sessionId,
      mode,
      objective,
      handle: 'explore-1',
      agentId: workerAgentId,
      role: 'researcher',
      description: 'Explore a code path',
      worktreePath: null,
      spawnedAt: '2024-01-01T00:00:00.000Z',
    })

    await recordWorkerSessionTerminal({
      sessionId,
      agentId: workerAgentId,
      status: 'completed',
      outputSummary: 'Exploration finished',
    })

    const completedState = await readSessionState(sessionId)
    const completedWorker = completedState?.knownWorkers.find(
      worker => worker.agentId === workerAgentId,
    )

    expect(completedWorker).toBeDefined()
    expect(completedWorker!.synthesisStatus).toBe('pending')
    expect(completedWorker!.lastResultAt).toBeTruthy()

    const updated = await markWorkerResultSynthesized({
      sessionId,
      agentId: workerAgentId,
    })
    expect(updated).toBe(true)

    const synthesizedState = await readSessionState(sessionId)
    const synthesizedWorker = synthesizedState?.knownWorkers.find(
      worker => worker.agentId === workerAgentId,
    )

    expect(synthesizedWorker?.synthesisStatus).toBe('synthesized')
    expect(synthesizedWorker?.lastSynthesizedAt).toBeTruthy()
  })

  test('resolves worker ids by durable handle and direct id', async () => {
    const mode = 'agent'
    const objective = 'Resolve durable worker handles'
    const workerAgentId = randomUUID().slice(0, 8)

    await updateSessionState(
      sessionId,
      () =>
        createSessionState({
          sessionId,
          mode,
          objective,
        }),
      () => {},
    )

    await recordWorkerSessionSpawn({
      sessionId,
      mode,
      objective,
      handle: 'explore-1',
      agentId: workerAgentId,
      role: 'explorer',
      description: 'Resolve current context',
      worktreePath: null,
    })

    expect(await resolveWorkerAgentId(sessionId, 'explore-1')).toBe(
      workerAgentId,
    )
    expect(await resolveWorkerAgentId(sessionId, workerAgentId)).toBe(
      workerAgentId,
    )
    expect(await resolveWorkerAgentId(sessionId, 'unknown-worker')).toBeNull()
  })

  test('does not mark failed terminal workers as pending synthesis', async () => {
    const mode = 'agent'
    const objective = 'Handle failed worker'
    const failedAgentId = randomUUID().slice(0, 8)

    await updateSessionState(
      sessionId,
      () =>
        createSessionState({
          sessionId,
          mode,
          objective,
        }),
      () => {},
    )

    await recordWorkerSessionSpawn({
      sessionId,
      mode,
      objective,
      handle: 'explore-failed',
      agentId: failedAgentId,
      role: 'researcher',
      description: 'Failed branch',
      worktreePath: null,
      spawnedAt: '2024-01-01T00:00:00.000Z',
    })

    await recordWorkerSessionTerminal({
      sessionId,
      agentId: failedAgentId,
      status: 'failed',
      error: 'Tool crashed',
    })

    const failedState = await readSessionState(sessionId)
    const failedWorker = failedState?.knownWorkers.find(
      worker => worker.agentId === failedAgentId,
    )

    expect(failedWorker).toBeDefined()
    expect(failedWorker!.synthesisStatus).toBeUndefined()
    expect(failedWorker!.resumable).toBe(false)
  })
})
