import { describe, expect, test } from 'bun:test'

import {
  getWorkerDisplayHandle,
  getWorkerStatusLabel,
  summarizeAgentModeWorkers,
} from './workerUxSummary.js'
import type { AgentModeSessionState, DurableWorkerSession } from './sessionState.js'

describe('workerUxSummary', () => {
  test('counts durable worker states and pending synthesis from known workers', () => {
    const runningWorker = worker({
      agentId: 'worker-1',
      role: 'implementor',
      description: 'Implement the helper',
      status: 'running',
      spawnedAt: '2026-05-02T10:00:00.000Z',
    })
    const pendingWorker = worker({
      agentId: 'worker-2',
      handle: 'reviewer',
      role: 'reviewer',
      description: 'Review the change',
      status: 'completed',
      spawnedAt: '2026-05-02T10:01:00.000Z',
      synthesisStatus: 'pending',
    })
    const failedWorker = worker({
      agentId: 'worker-3',
      role: 'verifier',
      description: 'Check the result',
      status: 'failed',
      spawnedAt: '2026-05-02T10:02:00.000Z',
    })

    const state: AgentModeSessionState = {
      objective: 'Ship worker UX',
      currentPhase: 'executing',
      activeWorker: runningWorker,
      knownWorkers: [runningWorker, pendingWorker, failedWorker],
      nextAction: 'Continue the current objective.',
    }

    expect(summarizeAgentModeWorkers(state)).toEqual({
      hasWorkers: true,
      active: 1,
      ready: 1,
      reviewed: 0,
      attention: 1,
      pendingSynthesis: 1,
      visibleWorkers: [runningWorker, pendingWorker, failedWorker],
    })
  })

  test('falls back to no workers when no durable state exists', () => {
    expect(summarizeAgentModeWorkers(null)).toEqual({
      hasWorkers: false,
      active: 0,
      ready: 0,
      reviewed: 0,
      attention: 0,
      pendingSynthesis: 0,
      visibleWorkers: [],
    })
  })

  test('prefers handle over agent id in display handles', () => {
    expect(
      getWorkerDisplayHandle({
        agentId: 'worker-2',
        handle: 'reviewer',
      }),
    ).toBe('@reviewer')

    expect(
      getWorkerDisplayHandle({
        agentId: 'worker-2',
        handle: 'worker-2',
      }),
    ).toBe('@worker-2')
  })

  test('maps synthesis and attention states to UX labels', () => {
    expect(
      getWorkerStatusLabel(completedWorker({ synthesisStatus: 'pending' })),
    ).toBe('result ready')

    expect(
      getWorkerStatusLabel(completedWorker({ synthesisStatus: 'synthesized' })),
    ).toBe('reviewed')

    expect(getWorkerStatusLabel(terminalWorker('killed'))).toBe('attention')
    expect(getWorkerStatusLabel(terminalWorker('running'))).toBe('running')
  })

  test('counts reviewed workers separately from result-ready workers', () => {
    const reviewedWorker = worker({
      agentId: 'worker-reviewed',
      role: 'implementor',
      description: 'Already reviewed',
      status: 'completed',
      spawnedAt: '2026-05-02T10:00:00.000Z',
      synthesisStatus: 'synthesized',
    })
    const legacyCompletedWorker = worker({
      agentId: 'worker-legacy',
      role: 'implementor',
      description: 'Completed before synthesis tracking',
      status: 'completed',
      spawnedAt: '2026-05-02T10:01:00.000Z',
    })
    const resultReadyWorker = worker({
      agentId: 'worker-ready',
      role: 'implementor',
      description: 'Finished and waiting on the lead',
      status: 'completed',
      spawnedAt: '2026-05-02T10:02:00.000Z',
      synthesisStatus: 'pending',
    })

    const state: AgentModeSessionState = {
      objective: 'Count worker buckets cleanly',
      currentPhase: 'verifying',
      activeWorker: null,
      knownWorkers: [reviewedWorker, legacyCompletedWorker, resultReadyWorker],
      nextAction: 'Read the worker result before concluding.',
    }

    expect(summarizeAgentModeWorkers(state)).toMatchObject({
      active: 0,
      ready: 1,
      reviewed: 1,
      attention: 0,
      pendingSynthesis: 1,
      visibleWorkers: [resultReadyWorker],
    })
  })

  test('keeps the last four visible workers after filtering in spawned order', () => {
    const runningOld = worker({
      agentId: 'worker-1',
      role: 'implementor',
      description: 'Old running worker',
      status: 'running',
      spawnedAt: '2026-05-02T10:00:00.000Z',
    })
    const hiddenCompleted = worker({
      agentId: 'worker-2',
      role: 'implementor',
      description: 'Completed and hidden',
      status: 'completed',
      spawnedAt: '2026-05-02T10:01:00.000Z',
    })
    const pendingReview = worker({
      agentId: 'worker-3',
      role: 'reviewer',
      description: 'Pending review',
      status: 'completed',
      spawnedAt: '2026-05-02T10:02:00.000Z',
      synthesisStatus: 'pending',
    })
    const failedWorker = worker({
      agentId: 'worker-4',
      role: 'verifier',
      description: 'Needs attention',
      status: 'failed',
      spawnedAt: '2026-05-02T10:03:00.000Z',
    })
    const runningNew = worker({
      agentId: 'worker-5',
      role: 'implementor',
      description: 'Still running',
      status: 'running',
      spawnedAt: '2026-05-02T10:04:00.000Z',
    })
    const killedWorker = worker({
      agentId: 'worker-6',
      role: 'verifier',
      description: 'Killed worker',
      status: 'killed',
      spawnedAt: '2026-05-02T10:05:00.000Z',
    })

    const state: AgentModeSessionState = {
      objective: 'Trim visible workers',
      currentPhase: 'planning',
      activeWorker: null,
      knownWorkers: [
        runningOld,
        hiddenCompleted,
        pendingReview,
        failedWorker,
        runningNew,
        killedWorker,
      ],
      nextAction: 'Continue the current objective.',
    }

    expect(summarizeAgentModeWorkers(state).visibleWorkers).toEqual([
      pendingReview,
      failedWorker,
      runningNew,
      killedWorker,
    ])
  })

  test('does not include synthesized workers in visible workers', () => {
    const runningWorker = worker({
      agentId: 'worker-1',
      role: 'implementor',
      description: 'Still running',
      status: 'running',
      spawnedAt: '2026-05-02T10:00:00.000Z',
    })
    const synthesizedWorker = worker({
      agentId: 'worker-2',
      role: 'reviewer',
      description: 'Already synthesized',
      status: 'completed',
      spawnedAt: '2026-05-02T10:01:00.000Z',
      synthesisStatus: 'synthesized',
    })

    const state: AgentModeSessionState = {
      objective: 'Check visibility',
      currentPhase: 'planning',
      activeWorker: null,
      knownWorkers: [runningWorker, synthesizedWorker],
      nextAction: 'Continue the current objective.',
    }

    expect(summarizeAgentModeWorkers(state).visibleWorkers).toEqual([
      runningWorker,
    ])
  })
})

function completedWorker(
  overrides: Partial<DurableWorkerSession> = {},
): DurableWorkerSession {
  return worker({
    agentId: 'worker-completed',
    role: 'implementor',
    description: 'Completed worker',
    status: 'completed',
    ...overrides,
  })
}

function terminalWorker(
  status: DurableWorkerSession['status'],
): DurableWorkerSession {
  return worker({
    agentId: `worker-${status}`,
    role: 'implementor',
    description: 'Worker status sample',
    status,
  })
}

function worker(
  overrides: Partial<DurableWorkerSession> & Pick<DurableWorkerSession, 'agentId'>,
): DurableWorkerSession {
  return {
    agentId: overrides.agentId,
    handle: overrides.handle,
    role: overrides.role ?? 'implementor',
    description: overrides.description ?? 'Worker sample',
    status: overrides.status ?? 'completed',
    synthesisStatus: overrides.synthesisStatus,
    resumable: overrides.resumable,
    worktreePath: overrides.worktreePath ?? null,
    outputSummary: overrides.outputSummary,
    error: overrides.error,
    spawnedAt: overrides.spawnedAt,
  }
}
