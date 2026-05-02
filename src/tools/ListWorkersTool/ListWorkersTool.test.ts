import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdtempSync } from 'fs'
import { mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { resetStateForTests, switchSession } from '../../bootstrap/state.js'
import { getSessionProjectDir } from '../../bootstrap/state.js'
import {
  createSessionState,
  recordWorkerSessionSpawn,
  recordWorkerSessionTerminal,
  updateSessionState,
} from '../../agent-mode/sessionState.js'
import { ListWorkersTool } from './ListWorkersTool.js'

describe('ListWorkersTool', () => {
  let sessionId: string
  let tempProjectDir: string

  beforeEach(() => {
    resetStateForTests()
    sessionId = randomUUID()
    tempProjectDir = mkdtempSync(join(tmpdir(), 'list-workers-'))
    switchSession(sessionId as never, tempProjectDir)
  })

  afterEach(async () => {
    await rm(tempProjectDir, { recursive: true, force: true })
  })

  async function writePriorState(
    priorSessionId: string,
    state: unknown,
  ): Promise<void> {
    const projectDir = getSessionProjectDir()
    if (!projectDir) throw new Error('expected session project dir')
    const priorStatePath = join(
      projectDir,
      `${priorSessionId}.agent-mode-state.json`,
    )
    await mkdir(dirname(priorStatePath), { recursive: true })
    await writeFile(priorStatePath, JSON.stringify(state), 'utf-8')
  }

  async function writePriorAgentTranscript(
    priorSessionId: string,
    agentId: string,
  ): Promise<void> {
    const projectDir = getSessionProjectDir()
    if (!projectDir) throw new Error('expected session project dir')
    const transcriptPath = join(
      projectDir,
      priorSessionId,
      'subagents',
      `agent-${agentId}.jsonl`,
    )
    await mkdir(dirname(transcriptPath), { recursive: true })
    const userUuid = randomUUID()
    const assistantUuid = randomUUID()
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: 'user',
          uuid: userUuid,
          parentUuid: null,
          isSidechain: true,
          sessionId: priorSessionId,
          agentId,
          timestamp: '2026-05-01T00:00:00.000Z',
          message: { role: 'user', content: 'continue' },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: assistantUuid,
          parentUuid: userUuid,
          isSidechain: true,
          sessionId: priorSessionId,
          agentId,
          timestamp: '2026-05-01T00:00:01.000Z',
          message: {
            id: `msg-${assistantUuid}`,
            type: 'message',
            role: 'assistant',
            model: 'gpt-5.3-codex',
            content: [{ type: 'text', text: 'prior result' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        }),
        '',
      ].join('\n'),
      'utf-8',
    )
  }

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

  test('lists prior resumable workers from recent Agent Mode sessions', async () => {
    const priorSessionId = randomUUID()

    await writePriorState(priorSessionId, {
      sessionId: priorSessionId,
      mode: 'agent',
      objective: 'Prior continuity objective',
      activeWorkers: {},
      knownWorkers: {
        'agent-prior': {
          agentId: 'agent-prior',
          handle: 'explore-1',
          role: 'explorer',
          description: 'Map prior state',
          status: 'completed',
          resumable: true,
          worktreePath: null,
          spawnedAt: '2026-05-01T00:00:00.000Z',
        },
      },
    })
    await writePriorAgentTranscript(priorSessionId, 'agent-prior')

    const result = await ListWorkersTool.call(
      {
        activeOnly: false,
        resumableOnly: true,
      },
      undefined as never,
    )

    expect(result.data.workers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: 'agent-prior',
          handle: 'explore-1',
          originSessionId: priorSessionId,
          origin: 'prior',
          resumable: true,
        }),
      ]),
    )
  })
})
