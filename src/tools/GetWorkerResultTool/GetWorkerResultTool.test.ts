import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { dirname } from 'path'
import { mkdir, rm, writeFile } from 'fs/promises'
import { resetStateForTests, switchSession } from '../../bootstrap/state.js'
import { getTranscriptPathForSession } from '../../utils/sessionStorage.js'
import {
  _resetTaskOutputDirForTest,
  getTaskOutputPath,
} from '../../utils/task/diskOutput.js'
import {
  createSessionState,
  readSessionState,
  recordWorkerSessionSpawn,
  recordWorkerSessionTerminal,
  updateSessionState,
} from '../../agent-mode/sessionState.js'
import { GetWorkerResultTool } from './GetWorkerResultTool.js'

describe('GetWorkerResultTool', () => {
  let sessionId: string
  let statePath: string
  let outputPath: string

  beforeEach(() => {
    resetStateForTests()
    sessionId = randomUUID()
    switchSession(sessionId as never)
    _resetTaskOutputDirForTest()
    statePath = getTranscriptPathForSession(sessionId).replace(
      '.jsonl',
      '.agent-mode-state.json',
    )
  })

  afterEach(async () => {
    await rm(statePath, { force: true })
    if (outputPath) {
      await rm(outputPath, { force: true })
    }
  })

  test('returns worker output and marks as synthesized', async () => {
    const workerAgentId = randomUUID().slice(0, 8)

    await updateSessionState(
      sessionId,
      () =>
        createSessionState({
          sessionId,
          mode: 'agent',
          objective: 'Check worker output',
        }),
      () => {},
    )
    await recordWorkerSessionSpawn({
      sessionId,
      mode: 'agent',
      objective: 'Check worker output',
      handle: 'explore-1',
      agentId: workerAgentId,
      role: 'explorer',
      description: 'Worker to read',
      worktreePath: null,
    })
    await recordWorkerSessionTerminal({
      sessionId,
      agentId: workerAgentId,
      status: 'completed',
      outputSummary: 'Worker complete',
    })

    outputPath = getTaskOutputPath(workerAgentId)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, 'worker final answer')

    const noMark = await GetWorkerResultTool.call(
      { worker: 'explore-1', markSynthesized: false },
      undefined as never,
    )

    expect(noMark.data.agentId).toBe(workerAgentId)
    expect(noMark.data.output).toContain('worker final answer')
    expect(noMark.data.synthesized).toBe(false)

    const marked = await GetWorkerResultTool.call(
      { worker: 'explore-1', markSynthesized: true },
      undefined as never,
    )

    expect(marked.data.worker).toBe('explore-1')
    expect(marked.data.synthesized).toBe(true)

    const state = await readSessionState(sessionId)
    const worker = state?.knownWorkers.find(w => w.agentId === workerAgentId)
    expect(worker?.synthesisStatus).toBe('synthesized')
  })

  test('does not mark synthesized when no output is present', async () => {
    const workerAgentId = randomUUID().slice(0, 8)

    await updateSessionState(
      sessionId,
      () =>
        createSessionState({
          sessionId,
          mode: 'agent',
          objective: 'Check worker output guard',
        }),
      () => {},
    )
    await recordWorkerSessionSpawn({
      sessionId,
      mode: 'agent',
      objective: 'Check worker output guard',
      handle: 'silent-worker',
      agentId: workerAgentId,
      role: 'observer',
      description: 'Worker with no file output',
      worktreePath: null,
    })

    const result = await GetWorkerResultTool.call(
      { worker: 'silent-worker', markSynthesized: true },
      undefined as never,
    )

    expect(result.data.hasOutput).toBe(false)
    expect(result.data.synthesized).toBe(false)
    expect(result.data.reason).toBe('No output available for this worker')
  })

  test('throws for unknown worker handle', async () => {
    const resultPromise = GetWorkerResultTool.call(
      { worker: 'missing-worker', markSynthesized: false },
      undefined as never,
    )

    await expect(resultPromise).rejects.toThrow('No Agent Mode worker found for: missing-worker')
  })
})
