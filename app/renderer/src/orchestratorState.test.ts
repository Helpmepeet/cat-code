import { expect, test } from 'bun:test'
import type {
  AgentModeSnapshot,
  AgentModeSnapshotFrame,
  AgentModeWorkerItem,
  LifecycleFrame,
} from '../../shared/protocol.js'
import {
  createOrchestratorState,
  deriveWorkerOwner,
  displayHandle,
  orchestratorPill,
  orchestratorWorkerState,
  reduceOrchestratorState,
  selectAgentModeSnapshot,
  selectOrchestratorRosterLine,
  selectPromotedWorker,
  selectWorkerById,
  summarizeOrchestratorWorkers,
  workerEventPriority,
} from './orchestratorState.js'

function worker(over: Partial<AgentModeWorkerItem> = {}): AgentModeWorkerItem {
  return {
    agentId: 'w-1',
    handle: 'Turing',
    role: 'agent-mode-coding-worker',
    status: 'running',
    description: 'Build the roster',
    ...over,
  }
}

function snapshot(
  workers: AgentModeWorkerItem[],
  over: Partial<AgentModeSnapshot> = {},
): AgentModeSnapshot {
  return { active: true, objective: 'Ship it', phase: 'executing', workers, ...over }
}

test('reduce folds an agent-mode.snapshot per session and clears it on lifecycle', () => {
  const frame: AgentModeSnapshotFrame = {
    kind: 'agent-mode.snapshot',
    protocolVersion: 1,
    sessionId: 's1',
    agentMode: snapshot([worker()]),
  }
  let state = reduceOrchestratorState(createOrchestratorState(), { type: 'frame', frame })
  expect(selectAgentModeSnapshot(state, 's1')?.workers).toHaveLength(1)
  expect(selectAgentModeSnapshot(state, 's2')).toBeNull()

  const lifecycle: LifecycleFrame = {
    kind: 'lifecycle',
    protocolVersion: 1,
    sessionId: 's1',
    status: 'exited',
  }
  state = reduceOrchestratorState(state, { type: 'frame', frame: lifecycle })
  expect(selectAgentModeSnapshot(state, 's1')).toBeNull()
})

test('a blocked worker is neutral WAITING under an active orchestrator, amber NEEDS-YOU when solo', () => {
  const blocked = worker({ status: 'completed', handoffStatus: 'blocked' })
  expect(orchestratorWorkerState(blocked, true)).toBe('waiting')
  expect(deriveWorkerOwner(blocked, true)).toBe('orchestrator')
  // Solo case — no orchestrator to pick up the handoff → escalates to the human.
  expect(orchestratorWorkerState(blocked, false)).toBe('needs-you')
  expect(deriveWorkerOwner(blocked, false)).toBe('user')
})

test('non-blocked lifecycle reuses the shared agent-mode vocabulary', () => {
  expect(orchestratorWorkerState(worker({ status: 'running' }), true)).toBe('running')
  expect(
    orchestratorWorkerState(worker({ status: 'completed', synthesisStatus: 'pending' }), true),
  ).toBe('result-ready')
  expect(
    orchestratorWorkerState(worker({ status: 'completed', synthesisStatus: 'synthesized' }), true),
  ).toBe('reviewed')
  expect(
    orchestratorWorkerState(worker({ origin: 'prior', resumable: true, status: 'completed' }), true),
  ).toBe('resumable')
  expect(orchestratorWorkerState(worker({ status: 'failed' }), true)).toBe('attention')
})

test('summary + pill: a solo escalation is amber, a busy swarm is neutral, a settled swarm is silent', () => {
  const solo = summarizeOrchestratorWorkers(
    [worker({ status: 'completed', handoffStatus: 'blocked' })],
    false,
  )
  expect(solo).toMatchObject({ user: 1 })
  expect(orchestratorPill([worker({ status: 'completed', handoffStatus: 'blocked' })], false)).toEqual({
    label: '1 needs you',
    attention: true,
  })

  const busy = orchestratorPill(
    [worker({ status: 'running' }), worker({ agentId: 'w-2', handle: 'Bell', status: 'running' })],
    true,
  )
  expect(busy).toEqual({ label: '2 subagents active', attention: false })

  const settled = orchestratorPill(
    [worker({ status: 'completed', synthesisStatus: 'synthesized' })],
    true,
  )
  expect(settled).toBeNull()
})

test('roster promotes the news-bearing worker (failure over a ready result over quiet workers)', () => {
  const workers = [
    worker({ agentId: 'w-run', handle: 'Bell', status: 'running' }),
    worker({ agentId: 'w-result', handle: 'Hopper', status: 'completed', synthesisStatus: 'pending' }),
    worker({ agentId: 'w-fail', handle: 'Turing', status: 'failed' }),
  ]
  expect(workerEventPriority(workers[0], true)).toBe(0)
  expect(workerEventPriority(workers[1], true)).toBe(1)
  expect(workerEventPriority(workers[2], true)).toBe(2)
  expect(selectPromotedWorker(workers, true)?.worker.agentId).toBe('w-fail')
  // A quiet swarm promotes nobody — the roster shows neutral counts only.
  expect(selectPromotedWorker([worker({ status: 'running' })], true)).toBeNull()
})

test('roster line: at rest it names nobody and tallies the swarm honestly', () => {
  const line = selectOrchestratorRosterLine(
    [
      worker({ agentId: 'w-1', status: 'running' }),
      worker({ agentId: 'w-2', status: 'running' }),
      worker({ agentId: 'w-3', status: 'completed', handoffStatus: 'blocked' }),
      worker({ agentId: 'w-4', status: 'completed', synthesisStatus: 'synthesized' }),
    ],
    true,
  )
  expect(line.lead).toBeNull()
  expect(line.anyWorking).toBe(true)
  expect(line.tail).toEqual([
    { text: '2 working', tone: 'working' },
    { text: '1 needs input', tone: 'waiting' },
    { text: '1 done', tone: 'done' },
  ])
})

test('roster line: a promoted lead is excluded from the tail, extra news becomes "+N more"', () => {
  const line = selectOrchestratorRosterLine(
    [
      worker({ agentId: 'w-fail', status: 'failed' }),
      worker({ agentId: 'w-result', status: 'completed', synthesisStatus: 'pending' }),
      worker({ agentId: 'w-run', status: 'running' }),
    ],
    true,
  )
  expect(line.lead?.worker.agentId).toBe('w-fail')
  expect(line.tail).toEqual([
    { text: '1 working', tone: 'working' },
    { text: '+1 more', tone: 'done' },
  ])
})

test('roster line: a quiet-but-stalled swarm still reports its blocked workers, never as news', () => {
  // The D2 C2 invariant, at the line level: blocked under an active orchestrator
  // promotes nobody and stays a NEUTRAL count.
  const active = selectOrchestratorRosterLine(
    [
      worker({ agentId: 'w-1', status: 'completed', handoffStatus: 'blocked' }),
      worker({ agentId: 'w-2', status: 'completed', handoffStatus: 'blocked' }),
    ],
    true,
  )
  expect(active.lead).toBeNull()
  expect(active.anyWorking).toBe(false)
  expect(active.tail).toEqual([{ text: '2 needs input', tone: 'waiting' }])

  // Solo: the same workers own the human's attention, so one is promoted.
  const solo = selectOrchestratorRosterLine(
    [
      worker({ agentId: 'w-1', status: 'completed', handoffStatus: 'blocked' }),
      worker({ agentId: 'w-2', status: 'completed', handoffStatus: 'blocked' }),
    ],
    false,
  )
  expect(solo.lead?.priority).toBe(3)
  expect(solo.tail).toEqual([{ text: '+1 more', tone: 'done' }])
})

test('roster line: an empty swarm has no lead and no counts', () => {
  expect(selectOrchestratorRosterLine([], true)).toEqual({
    lead: null,
    tail: [],
    anyWorking: false,
  })
})

test('displayHandle strips the mention sigil for display', () => {
  expect(displayHandle('@Turing')).toBe('Turing')
  expect(displayHandle('Turing')).toBe('Turing')
  expect(displayHandle(null)).toBeNull()
})

test('selectWorkerById finds a worker or degrades to null (drilldown/focus lookup)', () => {
  const snap = snapshot([
    worker({ agentId: 'w-1', handle: 'Turing' }),
    worker({ agentId: 'w-2', handle: 'Hopper' }),
  ])
  expect(selectWorkerById(snap, 'w-2')?.handle).toBe('Hopper')
  // Gone from the re-broadcast snapshot → null (auto-exit the detail/focus view).
  expect(selectWorkerById(snap, 'w-missing')).toBeNull()
  // Null-safe on a cold snapshot / no selection.
  expect(selectWorkerById(null, 'w-1')).toBeNull()
  expect(selectWorkerById(snap, null)).toBeNull()
})
