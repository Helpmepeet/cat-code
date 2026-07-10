import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
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
import {
  getWorkerStatusLabel,
  summarizeAgentModeWorkers,
} from './workerUxSummary.js'

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
            model: 'gpt-5.6-luna',
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

  async function readDurableState(): Promise<unknown> {
    const projectDir = getSessionProjectDir()
    if (!projectDir) throw new Error('expected session project dir')
    return JSON.parse(
      await readFile(
        join(projectDir, `${sessionId}.agent-mode-state.json`),
        'utf-8',
      ),
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

  test('does not resurrect a worker as running when terminal recording wins the race', async () => {
    const mode = 'agent'
    const objective = 'Avoid stale running workers'
    const workerAgentId = randomUUID().slice(0, 8)

    const terminalPromise = recordWorkerSessionTerminal({
      sessionId,
      agentId: workerAgentId,
      status: 'killed',
      outputSummary: 'Map surfaces',
      createStateIfMissing: {
        mode,
        objective,
      },
    })
    const spawnPromise = recordWorkerSessionSpawn({
      sessionId,
      mode,
      objective,
      handle: 'Ada',
      agentId: workerAgentId,
      role: 'Explore',
      description: 'Map surfaces',
      worktreePath: null,
      spawnedAt: '2026-05-03T00:00:00.000Z',
    })

    await terminalPromise
    await spawnPromise

    const state = await readSessionState(sessionId)
    const worker = state?.knownWorkers.find(
      knownWorker => knownWorker.agentId === workerAgentId,
    )

    expect(worker?.status).toBe('killed')
    expect(state?.currentPhase).toBe('blocked')
    expect(state?.activeWorker?.agentId).toBe(workerAgentId)
    expect(state?.activeWorker?.status).toBe('killed')
    expect(
      state?.knownWorkers.some(knownWorker => knownWorker.status === 'running'),
    ).toBe(false)

    const durableState = (await readDurableState()) as {
      activeWorkers: Record<string, { role: string; agentId: string }>
    }
    expect(durableState.activeWorkers).toEqual({})
  })

  test('ignores terminal recording without existing state or tracking context', async () => {
    await recordWorkerSessionTerminal({
      sessionId,
      agentId: randomUUID().slice(0, 8),
      status: 'completed',
      outputSummary: 'Normal subagent finished',
    })

    expect(await readSessionState(sessionId)).toBeNull()
  })

  test('uses captured state path for tracked writes after ambient session switches', async () => {
    const mode = 'agent'
    const objective = 'Keep worker state in original project'
    const workerAgentId = randomUUID().slice(0, 8)
    const originalProjectDir = tempProjectDir
    const switchedProjectDir = mkdtempSync(join(tmpdir(), 'agent-mode-state-drift-'))
    const capturedStatePath = join(
      originalProjectDir,
      `${sessionId}.agent-mode-state.json`,
    )

    try {
      await recordWorkerSessionSpawn({
        sessionId,
        mode,
        objective,
        statePath: capturedStatePath,
        handle: 'explore-1',
        agentId: workerAgentId,
        role: 'explorer',
        description: 'Resolve stable state path',
        worktreePath: null,
      })

      switchSession(randomUUID() as never, switchedProjectDir)

      await recordWorkerSessionTerminal({
        sessionId,
        agentId: workerAgentId,
        status: 'completed',
        outputSummary: 'Stable path respected',
        createStateIfMissing: {
          mode,
          objective,
          statePath: capturedStatePath,
        },
      })

      const originalState = JSON.parse(
        await readFile(capturedStatePath, 'utf-8'),
      ) as {
        knownWorkers: Record<string, { status: string; outputSummary?: string }>
      }
      const driftedStatePath = join(
        switchedProjectDir,
        `${sessionId}.agent-mode-state.json`,
      )

      expect(originalState.knownWorkers[workerAgentId]).toMatchObject({
        status: 'completed',
        outputSummary: 'Stable path respected',
      })
      await expect(readFile(driftedStatePath, 'utf-8')).rejects.toThrow()
    } finally {
      await rm(switchedProjectDir, { recursive: true, force: true })
    }
  })

  test('serializes concurrent implicit and explicit writes to the same state file', async () => {
    const mode = 'agent'
    const objective = 'Preserve mixed same-file writes'
    const capturedStatePath = join(
      tempProjectDir,
      `${sessionId}.agent-mode-state.json`,
    )
    const originalDateNow = Date.now

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

    Date.now = () => 1_700_000_000_000
    try {
      await Promise.all([
        ...Array.from({ length: 20 }, (_, index) =>
          updateSessionState(
            sessionId,
            () =>
              createSessionState({
                sessionId,
                mode,
                objective,
              }),
            state => {
              const agentId = `implicit-${index}`
              state.knownWorkers[agentId] = {
                agentId,
                handle: agentId,
                role: 'implicit',
                description: 'Implicit write survived',
                status: 'running',
                resumable: false,
                worktreePath: null,
              }
            },
          ),
        ),
        ...Array.from({ length: 20 }, (_, index) =>
          recordWorkerSessionSpawn({
            sessionId,
            mode,
            objective,
            statePath: capturedStatePath,
            handle: `explicit-${index}`,
            agentId: `explicit-${index}`,
            role: 'explicit',
            description: 'Tracked write survived',
            worktreePath: null,
            spawnedAt: '2026-05-03T00:00:00.000Z',
          }),
        ),
      ])
    } finally {
      Date.now = originalDateNow
    }

    const durableState = (await readDurableState()) as {
      knownWorkers: Record<string, { role: string; status: string }>
    }
    const workers = Object.values(durableState.knownWorkers)
    const implicitWorkers = workers.filter(worker => worker.role === 'implicit')
    const explicitWorkers = workers.filter(worker => worker.role === 'explicit')

    expect(implicitWorkers).toHaveLength(20)
    expect(explicitWorkers).toHaveLength(20)
    expect(workers.every(worker => worker.status === 'running')).toBe(true)
  })

  test('does not add an unknown missing worker for untracked terminal recording against existing state', async () => {
    const mode = 'agent'
    const objective = 'Ignore unrelated subagent terminals'

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

    await recordWorkerSessionTerminal({
      sessionId,
      agentId: randomUUID().slice(0, 8),
      status: 'completed',
      outputSummary: 'Normal subagent finished',
    })

    const state = await readSessionState(sessionId)

    expect(state?.knownWorkers).toEqual([])
    expect(state?.currentPhase).toBe('planning')
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

  test('terminal failed and killed workers are removed from active counts', async () => {
    const mode = 'agent'
    const objective = 'Keep terminal worker truth'
    const failedAgentId = randomUUID().slice(0, 8)
    const killedAgentId = randomUUID().slice(0, 8)

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
      handle: 'Ada',
      agentId: failedAgentId,
      role: 'Explore',
      description: 'Map surfaces',
      worktreePath: null,
      spawnedAt: '2026-05-03T00:00:00.000Z',
    })
    await recordWorkerSessionSpawn({
      sessionId,
      mode,
      objective,
      handle: 'Katherine',
      agentId: killedAgentId,
      role: 'general-purpose',
      description: 'Run audit',
      worktreePath: null,
      spawnedAt: '2026-05-03T00:01:00.000Z',
    })

    await recordWorkerSessionTerminal({
      sessionId,
      agentId: failedAgentId,
      status: 'failed',
      error: 'Tool execution failed',
      outputSummary: 'Map surfaces',
    })
    await recordWorkerSessionTerminal({
      sessionId,
      agentId: killedAgentId,
      status: 'killed',
      outputSummary: 'Run audit',
    })

    let persistedActiveWorkerHandles: string[] = []
    await updateSessionState(
      sessionId,
      () =>
        createSessionState({
          sessionId,
          mode,
          objective,
        }),
      persistedState => {
        persistedActiveWorkerHandles = Object.keys(persistedState.activeWorkers)
      },
    )

    const state = await readSessionState(sessionId)
    const statuses = state?.knownWorkers
      .map(worker => worker.status)
      .sort((left, right) => left.localeCompare(right))

    expect(persistedActiveWorkerHandles).toEqual([])
    expect(state?.knownWorkers).toHaveLength(2)
    expect(statuses).toEqual(['failed', 'killed'])
    expect(state?.currentPhase).toBe('blocked')
    expect(state?.nextAction).toBe(
      'Inspect Katherine and recover or report the blocker.',
    )
    expect(
      state?.knownWorkers.some(worker => worker.status === 'running'),
    ).toBe(false)
  })

  test('failed or killed terminal updates clear stale pending synthesis state', async () => {
    const mode = 'agent'
    const objective = 'Keep terminal failure truth'
    const failedAgentId = randomUUID().slice(0, 8)
    const killedAgentId = randomUUID().slice(0, 8)

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

    for (const [handle, agentId] of [
      ['failed-1', failedAgentId],
      ['killed-1', killedAgentId],
    ] as const) {
      await recordWorkerSessionSpawn({
        sessionId,
        mode,
        objective,
        handle,
        agentId,
        role: 'implementor',
        description: `Run ${handle}`,
        worktreePath: null,
        spawnedAt: '2026-05-03T00:00:00.000Z',
      })
      await recordWorkerSessionTerminal({
        sessionId,
        agentId,
        status: 'completed',
        outputSummary: `${handle} completed`,
      })
    }

    const pendingState = await readSessionState(sessionId)
    expect(
      pendingState?.knownWorkers.map(worker => worker.synthesisStatus),
    ).toEqual(['pending', 'pending'])

    await recordWorkerSessionTerminal({
      sessionId,
      agentId: failedAgentId,
      status: 'failed',
      error: 'Worker crashed after result capture',
    })
    await recordWorkerSessionTerminal({
      sessionId,
      agentId: killedAgentId,
      status: 'killed',
      outputSummary: 'Worker was stopped after result capture',
    })

    const state = await readSessionState(sessionId)
    const failedWorker = state?.knownWorkers.find(
      worker => worker.agentId === failedAgentId,
    )
    const killedWorker = state?.knownWorkers.find(
      worker => worker.agentId === killedAgentId,
    )
    const summary = summarizeAgentModeWorkers(state)

    expect(failedWorker?.status).toBe('failed')
    expect(failedWorker?.synthesisStatus).toBeUndefined()
    expect(failedWorker?.lastResultAt).toBeUndefined()
    expect(failedWorker?.lastResultSummary).toBeUndefined()
    expect(getWorkerStatusLabel(failedWorker!)).toBe('attention')

    expect(killedWorker?.status).toBe('killed')
    expect(killedWorker?.synthesisStatus).toBeUndefined()
    expect(killedWorker?.lastResultAt).toBeUndefined()
    expect(killedWorker?.lastResultSummary).toBeUndefined()
    expect(getWorkerStatusLabel(killedWorker!)).toBe('attention')

    expect(state?.currentPhase).toBe('blocked')
    expect(summary.pendingSynthesis).toBe(0)
    expect(summary.ready).toBe(0)
    expect(summary.attention).toBe(2)
    expect(summary.visibleWorkers).toEqual([failedWorker, killedWorker])
  })
})
