import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdir, rm, writeFile } from 'fs/promises'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  getSessionProjectDir,
  resetStateForTests,
  switchSession,
} from '../bootstrap/state.js'
import {
  createSessionState,
  markWorkerResultSynthesized,
  readSessionState,
  readSessionStateWithContinuity,
  recordWorkerSessionSpawn,
  recordWorkerSessionTerminal,
  resolveWorkerAgentId,
  resolveWorkerAgentTarget,
  updateSessionState,
} from './sessionState.js'

describe('agent mode session state', () => {
  let sessionId: string
  let tempProjectDir: string

  beforeEach(() => {
    resetStateForTests()
    sessionId = randomUUID()
    tempProjectDir = mkdtempSync(join(tmpdir(), 'agent-mode-state-'))
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

  test('discovers prior local workers and classifies stale transcripts honestly', async () => {
    const projectDir = getSessionProjectDir()
    if (!projectDir) throw new Error('expected session project dir')
    const priorSessionId = randomUUID()

    await writePriorState(priorSessionId, {
      sessionId: priorSessionId,
      mode: 'agent',
      objective: 'Previous objective',
      activeWorkers: {},
      knownWorkers: {
        'agent-reusable': {
          agentId: 'agent-reusable',
          handle: 'explore-1',
          role: 'explorer',
          description: 'Reusable prior worker',
          status: 'completed',
          resumable: true,
          synthesisStatus: 'synthesized',
          worktreePath: null,
          spawnedAt: '2026-05-01T00:00:00.000Z',
        },
        'agent-current': {
          agentId: 'agent-current',
          handle: 'current-1',
          role: 'explorer',
          description: 'Already resumed worker',
          status: 'completed',
          resumable: true,
          worktreePath: null,
          spawnedAt: '2026-05-01T00:02:00.000Z',
        },
        'agent-stale': {
          agentId: 'agent-stale',
          handle: 'explore-2',
          role: 'explorer',
          description: 'Missing transcript worker',
          status: 'completed',
          resumable: true,
          synthesisStatus: 'synthesized',
          worktreePath: null,
          spawnedAt: '2026-05-01T00:01:00.000Z',
        },
      },
    })
    await writePriorAgentTranscript(priorSessionId, 'agent-reusable')
    await recordWorkerSessionSpawn({
      sessionId,
      mode: 'agent',
      objective: 'Current objective',
      handle: 'current-1',
      agentId: 'agent-current',
      role: 'explorer',
      description: 'Already resumed worker',
      worktreePath: null,
      spawnedAt: '2026-05-02T00:00:00.000Z',
    })

    const state = await readSessionStateWithContinuity(sessionId)
    const reusable = state?.knownWorkers.find(
      worker => worker.agentId === 'agent-reusable',
    )
    const stale = state?.knownWorkers.find(
      worker => worker.agentId === 'agent-stale',
    )

    expect(
      state?.knownWorkers.filter(worker => worker.agentId === 'agent-current'),
    ).toHaveLength(1)
    expect(
      state?.knownWorkers.find(worker => worker.agentId === 'agent-current')
        ?.origin,
    ).toBe('current')
    expect(reusable).toMatchObject({
      agentId: 'agent-reusable',
      handle: 'explore-1',
      originSessionId: priorSessionId,
      origin: 'prior',
      resumable: true,
    })
    expect(state?.currentPhase).toBe('executing')
    expect(state?.activeWorker?.agentId).toBe('agent-current')
    expect(state?.nextAction).toBe(
      'Continue current-1 on the current objective.',
    )
    expect(stale).toMatchObject({
      agentId: 'agent-stale',
      handle: 'explore-2',
      originSessionId: priorSessionId,
      origin: 'prior',
      resumable: false,
      reuseBlockedReason: expect.stringContaining('transcript'),
    })
  })

  test('resolves prior worker handles with their origin session', async () => {
    const priorSessionId = randomUUID()

    await writePriorState(priorSessionId, {
      sessionId: priorSessionId,
      mode: 'agent',
      objective: 'Previous objective',
      activeWorkers: {},
      knownWorkers: {
        'agent-reusable': {
          agentId: 'agent-reusable',
          handle: 'explore-1',
          role: 'explorer',
          description: 'Reusable prior worker',
          status: 'completed',
          resumable: true,
          worktreePath: null,
        },
      },
    })
    await writePriorAgentTranscript(priorSessionId, 'agent-reusable')

    await expect(resolveWorkerAgentTarget(sessionId, 'explore-1')).resolves.toEqual({
      agentId: 'agent-reusable',
      originSessionId: priorSessionId,
    })
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

  test('derives verifying phase and synthesis-focused next action', async () => {
    const mode = 'agent'
    const objective = 'Synthesize worker findings'
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
      handle: 'review-1',
      agentId: workerAgentId,
      role: 'reviewer',
      description: 'Review the current objective',
      worktreePath: null,
      spawnedAt: '2024-01-01T00:00:00.000Z',
    })
    await recordWorkerSessionTerminal({
      sessionId,
      agentId: workerAgentId,
      status: 'completed',
      outputSummary: 'Review complete',
    })

    const state = await readSessionState(sessionId)

    expect(state?.currentPhase).toBe('verifying')
    expect(state?.activeWorker?.agentId).toBe(workerAgentId)
    expect(state?.nextAction).toBe(
      'Read and synthesize review-1 before concluding the objective.',
    )
  })

  test('derives blocked phase and blocker-focused next action', async () => {
    const mode = 'agent'
    const objective = 'Recover a failed worker'
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
      handle: 'implement-1',
      agentId: workerAgentId,
      role: 'implementor',
      description: 'Implement the current objective',
      worktreePath: null,
      spawnedAt: '2024-01-01T00:00:00.000Z',
    })
    await recordWorkerSessionTerminal({
      sessionId,
      agentId: workerAgentId,
      status: 'failed',
      error: 'Tool crashed',
    })

    const state = await readSessionState(sessionId)

    expect(state?.currentPhase).toBe('blocked')
    expect(state?.activeWorker?.agentId).toBe(workerAgentId)
    expect(state?.nextAction).toBe(
      'Inspect implement-1 and recover or report the blocker.',
    )
  })
})
