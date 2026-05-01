import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { rm } from 'fs/promises'
import { resetStateForTests, switchSession } from '../../bootstrap/state.js'
import { getTranscriptPathForSession } from '../../utils/sessionStorage.js'
import {
  createSessionState,
  recordWorkerSessionSpawn,
  recordWorkerSessionTerminal,
  updateSessionState,
} from '../../agent-mode/sessionState.js'
import { ListWorkersTool } from './ListWorkersTool.js'

describe('ListWorkersTool', () => {
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

  test('lists worker sessions and supports filtering', async () => {
    const mode = 'agent'
    const objective = 'Verify roster retrieval'
    const completedWorker = randomUUID().slice(0, 8)
    const runningWorker = randomUUID().slice(0, 8)

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
      agentId: completedWorker,
      role: 'explorer',
      description: 'Completed lookup worker',
      worktreePath: null,
    })
    await recordWorkerSessionSpawn({
      sessionId,
      mode,
      objective,
      handle: 'agent-2',
      agentId: runningWorker,
      role: 'implementor',
      description: 'Running follow-up',
      worktreePath: null,
    })

    await recordWorkerSessionTerminal({
      sessionId,
      agentId: completedWorker,
      status: 'completed',
      outputSummary: 'Done',
    })

    const all = await ListWorkersTool.call(
      {
        activeOnly: false,
        resumableOnly: false,
      },
      undefined as never,
    )

    expect(all.data.objective).toBe(objective)
    expect(all.data.workers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ handle: 'explore-1', status: 'completed' }),
        expect.objectContaining({ handle: 'agent-2', status: 'running' }),
      ]),
    )

    const runningOnly = await ListWorkersTool.call(
      {
        activeOnly: true,
        resumableOnly: false,
      },
      undefined as never,
    )

    expect(
      runningOnly.data.workers.every(worker => worker.status === 'running'),
    ).toBe(true)
    expect(runningOnly.data.workers).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'running' })]),
    )
  })
})
