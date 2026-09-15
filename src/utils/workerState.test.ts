import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { readFile, rm, writeFile } from 'fs/promises'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getSessionProjectDir,
  resetStateForTests,
  switchSession,
} from '../bootstrap/state.js'
import {
  createSessionState,
  readPersistedWorkerHandle,
  readSessionState,
  recordWorkerSessionSpawn,
  recordWorkerSessionTerminal,
  resolveWorkerAgentId,
  resolveWorkerAgentTarget,
  updateSessionState,
} from './workerState.js'

describe('worker session state', () => {
  let sessionId: string
  let tempProjectDir: string

  beforeEach(() => {
    resetStateForTests()
    sessionId = randomUUID()
    tempProjectDir = mkdtempSync(join(tmpdir(), 'worker-session-state-'))
    switchSession(sessionId as never, tempProjectDir)
  })

  afterEach(async () => {
    await rm(tempProjectDir, { recursive: true, force: true })
  })

  async function readDurableState(): Promise<unknown> {
    const projectDir = getSessionProjectDir()
    if (!projectDir) throw new Error('expected session project dir')
    return JSON.parse(
      await readFile(
        join(projectDir, `${sessionId}.worker-state.json`),
        'utf-8',
      ),
    )
  }

  test('does not resurrect a worker as running when terminal recording wins the race', async () => {
    const mode = 'normal'
    const workerAgentId = randomUUID().slice(0, 8)

    const terminalPromise = recordWorkerSessionTerminal({
      sessionId,
      agentId: workerAgentId,
      status: 'killed',
      createStateIfMissing: { mode },
    })
    const spawnPromise = recordWorkerSessionSpawn({
      sessionId,
      mode,
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

    expect(state?.knownWorkers[workerAgentId]?.status).toBe('killed')
    expect(
      Object.values(state?.knownWorkers ?? {}).some(
        worker => worker.status === 'running',
      ),
    ).toBe(false)
    // A terminal worker holds no active slot, so nothing keeps it addressable
    // as a live target after it ended.
    expect(state?.activeWorkers).toEqual({})

    const durableState = (await readDurableState()) as {
      activeWorkers: Record<string, { role: string; agentId: string }>
    }
    expect(durableState.activeWorkers).toEqual({})
  })

  test('reads legacy state only for coordinator records', async () => {
    const legacyPath = join(
      tempProjectDir,
      `${sessionId}.agent-mode-state.json`,
    )
    const legacyState = {
      sessionId,
      mode: 'coordinator',
      activeWorkers: {},
      knownWorkers: {},
    }

    await writeFile(legacyPath, JSON.stringify(legacyState))
    expect((await readSessionState(sessionId))?.mode).toBe('coordinator')

    await writeFile(legacyPath, JSON.stringify({ ...legacyState, mode: 'agent' }))
    expect(await readSessionState(sessionId)).toBeNull()
  })

  test('ignores terminal recording without existing state or tracking context', async () => {
    await recordWorkerSessionTerminal({
      sessionId,
      agentId: randomUUID().slice(0, 8),
      status: 'completed',
    })

    expect(await readSessionState(sessionId)).toBeNull()
  })

  test('uses captured state path for tracked writes after ambient session switches', async () => {
    const mode = 'normal'
    const workerAgentId = randomUUID().slice(0, 8)
    const switchedProjectDir = mkdtempSync(
      join(tmpdir(), 'worker-session-state-drift-'),
    )
    const capturedStatePath = join(
      tempProjectDir,
      `${sessionId}.worker-state.json`,
    )

    try {
      await recordWorkerSessionSpawn({
        sessionId,
        mode,
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
        createStateIfMissing: { mode, statePath: capturedStatePath },
      })

      const originalState = JSON.parse(
        await readFile(capturedStatePath, 'utf-8'),
      ) as {
        knownWorkers: Record<string, { status: string }>
      }
      const driftedStatePath = join(
        switchedProjectDir,
        `${sessionId}.worker-state.json`,
      )

      expect(originalState.knownWorkers[workerAgentId]).toMatchObject({
        status: 'completed',
      })
      await expect(readFile(driftedStatePath, 'utf-8')).rejects.toThrow()
    } finally {
      await rm(switchedProjectDir, { recursive: true, force: true })
    }
  })

  test('serializes concurrent implicit and explicit writes to the same state file', async () => {
    const mode = 'normal'
    const capturedStatePath = join(
      tempProjectDir,
      `${sessionId}.worker-state.json`,
    )

    await updateSessionState(
      sessionId,
      () => createSessionState({ sessionId, mode }),
      () => {},
    )

    await Promise.all([
      ...Array.from({ length: 20 }, (_, index) =>
        updateSessionState(
          sessionId,
          () => createSessionState({ sessionId, mode }),
          state => {
            const agentId = `implicit-${index}`
            state.knownWorkers[agentId] = {
              agentId,
              handle: agentId,
              role: 'implicit',
              description: 'Implicit write survived',
              status: 'running',
              worktreePath: null,
            }
          },
        ),
      ),
      ...Array.from({ length: 20 }, (_, index) =>
        recordWorkerSessionSpawn({
          sessionId,
          mode,
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

    const durableState = (await readDurableState()) as {
      knownWorkers: Record<string, { role: string; status: string }>
    }
    const workers = Object.values(durableState.knownWorkers)

    expect(workers.filter(worker => worker.role === 'implicit')).toHaveLength(20)
    expect(workers.filter(worker => worker.role === 'explicit')).toHaveLength(20)
    expect(workers.every(worker => worker.status === 'running')).toBe(true)
  })

  test('does not add an unknown missing worker for untracked terminal recording against existing state', async () => {
    const mode = 'normal'

    await updateSessionState(
      sessionId,
      () => createSessionState({ sessionId, mode }),
      () => {},
    )

    await recordWorkerSessionTerminal({
      sessionId,
      agentId: randomUUID().slice(0, 8),
      status: 'completed',
    })

    const state = await readSessionState(sessionId)

    expect(state?.knownWorkers).toEqual({})
  })

  test('resolves worker ids by durable handle and direct id', async () => {
    const mode = 'normal'
    const workerAgentId = randomUUID().slice(0, 8)

    await recordWorkerSessionSpawn({
      sessionId,
      mode,
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

  test('resolves handles case-insensitively and reports the origin session', async () => {
    const mode = 'normal'
    const workerAgentId = randomUUID().slice(0, 8)

    await recordWorkerSessionSpawn({
      sessionId,
      mode,
      handle: 'Ada',
      agentId: workerAgentId,
      role: 'explorer',
      description: 'Answer by name, whatever the casing',
      worktreePath: null,
    })

    expect(await resolveWorkerAgentTarget(sessionId, 'ada')).toEqual({
      agentId: workerAgentId,
      originSessionId: sessionId,
    })
  })

  test('a handle that is only the agent id is not a name worth showing', async () => {
    const mode = 'normal'
    const named = randomUUID().slice(0, 8)
    const unnamed = randomUUID().slice(0, 8)

    await recordWorkerSessionSpawn({
      sessionId,
      mode,
      handle: 'Ada',
      agentId: named,
      role: 'explorer',
      description: 'Named worker',
      worktreePath: null,
    })
    await recordWorkerSessionSpawn({
      sessionId,
      mode,
      agentId: unnamed,
      role: 'explorer',
      description: 'Unnamed worker',
      worktreePath: null,
    })

    expect(await readPersistedWorkerHandle(sessionId, named)).toBe('Ada')
    expect(await readPersistedWorkerHandle(sessionId, unnamed)).toBeNull()
  })
})
