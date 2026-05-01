import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { createTaskStateBase } from '../../Task.js'
import { rm } from 'fs/promises'
import { resetStateForTests, switchSession } from '../../bootstrap/state.js'
import { getTranscriptPathForSession } from '../../utils/sessionStorage.js'
import { createSessionState, recordWorkerSessionSpawn, updateSessionState } from '../../agent-mode/sessionState.js'
import { CancelWorkerTool } from './CancelWorkerTool.js'

describe('CancelWorkerTool', () => {
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

  test('stops a running worker via task id resolution', async () => {
    const workerAgentId = randomUUID().slice(0, 8)
    const handle = 'explore-1'
    const objective = 'Verify cancel path'

    await updateSessionState(
      sessionId,
      () =>
        createSessionState({
          sessionId,
          mode: 'agent',
          objective,
        }),
      () => {},
    )
    await recordWorkerSessionSpawn({
      sessionId,
      mode: 'agent',
      objective,
      handle,
      agentId: workerAgentId,
      role: 'explorer',
      description: 'Long-running worker',
      worktreePath: null,
    })

    let appState = {
      tasks: {
        [workerAgentId]: {
          ...createTaskStateBase(workerAgentId, 'local_agent', 'worker task'),
          status: 'running',
        },
      },
    }

    const context = {
      getAppState: () => appState,
      setAppState: (update: (next: unknown) => void) => {
        appState = update(appState)
      },
    }

    const result = await CancelWorkerTool.call(
      { worker: handle },
      context as never,
    )

    expect(result.data.agentId).toBe(workerAgentId)
    expect(result.data.stopped.taskId).toBe(workerAgentId)
    expect(result.data.stopped.taskType).toBe('local_agent')
    expect(appState.tasks?.[workerAgentId]?.status).toBe('killed')
  })

  test('returns failure state for already terminal worker', async () => {
    const workerAgentId = randomUUID().slice(0, 8)
    const handle = 'explore-complete'
    const objective = 'Handle already terminal worker'

    await updateSessionState(
      sessionId,
      () =>
        createSessionState({
          sessionId,
          mode: 'agent',
          objective,
        }),
      () => {},
    )
    await recordWorkerSessionSpawn({
      sessionId,
      mode: 'agent',
      objective,
      handle,
      agentId: workerAgentId,
      role: 'explorer',
      description: 'already completed worker',
      worktreePath: null,
    })

    let appState = {
      tasks: {
        [workerAgentId]: {
          ...createTaskStateBase(workerAgentId, 'local_agent', 'worker task'),
          status: 'completed',
        },
      },
    }

    const context = {
      getAppState: () => appState,
      setAppState: (update: (next: unknown) => void) => {
        appState = update(appState)
      },
    }

    const result = await CancelWorkerTool.call(
      { worker: handle },
      context as never,
    )

    expect(result.data.stopped).toBe(false)
    expect(result.data.code).toBe('not_running')
  })
})
