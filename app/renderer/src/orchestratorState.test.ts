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
  selectDockedOrchestratorWorkers,
  selectOrchestratorRosterLine,
  selectPromotedWorker,
  selectWorkerById,
  selectWorkerDisplayName,
  summarizeOrchestratorWorkers,
  workerAccessibleLabel,
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

test('reduce folds an agent-mode.snapshot per session and prunes it on lifecycle/removal', () => {
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
  expect('s1' in state.bySession).toBe(false)
  // A lifecycle for an unseen session is a no-op, not a whole-store allocation.
  expect(
    reduceOrchestratorState(state, { type: 'frame', frame: lifecycle }),
  ).toBe(state)

  state = reduceOrchestratorState(createOrchestratorState(), { type: 'frame', frame })
  state = reduceOrchestratorState(state, { type: 'session-removed', sessionId: 's1' })
  expect(selectAgentModeSnapshot(state, 's1')).toBeNull()
  expect('s1' in state.bySession).toBe(false)
})

test('a blocked worker waits on the assistant, never on the user', () => {
  // The handoff is queued to the delegating conversation and drained into a fresh
  // turn with no human action, so there is no "solo" case to escalate: agent mode
  // decides which persona the parent runs, not whether a parent exists.
  const blocked = worker({ status: 'completed', handoffStatus: 'blocked' })
  expect(orchestratorWorkerState(blocked)).toBe('waiting')
  expect(deriveWorkerOwner(blocked)).toBe('orchestrator')
})

test('non-blocked lifecycle reuses the shared agent-mode vocabulary', () => {
  expect(orchestratorWorkerState(worker({ status: 'running' }))).toBe('running')
  expect(
    orchestratorWorkerState(worker({ status: 'completed', synthesisStatus: 'pending' })),
  ).toBe('result-ready')
  expect(
    orchestratorWorkerState(worker({ status: 'completed', synthesisStatus: 'synthesized' })),
  ).toBe('reviewed')
  expect(
    orchestratorWorkerState(worker({ origin: 'prior', resumable: true, status: 'completed' })),
  ).toBe('resumable')
  expect(orchestratorWorkerState(worker({ status: 'failed' }))).toBe('failed')
  expect(orchestratorWorkerState(worker({ status: 'killed' }))).toBe('stopped')
})

test('a backgrounded worker reads BACKGROUND, and only while it is genuinely running', () => {
  expect(
    orchestratorWorkerState(worker({ status: 'running', isBackgrounded: true })),
  ).toBe('background')
  // Foreground stays running — the two spawns rendered identically before this.
  expect(
    orchestratorWorkerState(worker({ status: 'running', isBackgrounded: false })),
  ).toBe('running')
  // Outranked: a settled worker is not "in background" just because it was spawned that way.
  expect(
    orchestratorWorkerState(
      worker({ status: 'completed', synthesisStatus: 'pending', isBackgrounded: true }),
    ),
  ).toBe('result-ready')
})

test('the docked roster keeps only live work and unresolved worker states', () => {
  const visible = selectDockedOrchestratorWorkers([
    worker({ agentId: 'running', status: 'running' }),
    worker({ agentId: 'background', status: 'running', isBackgrounded: true }),
    worker({ agentId: 'waiting', status: 'completed', handoffStatus: 'blocked' }),
    worker({ agentId: 'result-ready', status: 'completed', synthesisStatus: 'pending' }),
    worker({ agentId: 'failed', status: 'failed' }),
    worker({ agentId: 'completed', status: 'completed' }),
    worker({ agentId: 'reviewed', status: 'completed', synthesisStatus: 'synthesized' }),
    worker({ agentId: 'stopped', status: 'killed' }),
    worker({ agentId: 'resumable', status: 'completed', origin: 'prior', resumable: true }),
    worker({ agentId: 'stale', status: 'completed', origin: 'prior', resumable: false }),
  ])

  expect(visible.map(item => item.agentId)).toEqual([
    'running',
    'background',
    'waiting',
    'result-ready',
    'failed',
  ])
})

test('the roster counts background separately, and still calls it in flight', () => {
  const line = selectOrchestratorRosterLine(
    [
      worker({ agentId: 'w1', status: 'running' }),
      worker({ agentId: 'w2', status: 'running', isBackgrounded: true }),
    ],
  )
  expect(line.tail.map(count => count.text)).toEqual(['1 working', '1 in background'])
  expect(line.anyWorking).toBe(true)
  // A lone background worker still counts as an active subagent, not as done.
  const summary = summarizeOrchestratorWorkers([
    worker({ status: 'running', isBackgrounded: true }),
  ])
  // Counted apart from `working` so the Workers list and the roster agree, but
  // still "active" for the pill rather than folded into done.
  expect(summary).toEqual({ working: 0, background: 1, orchestrator: 0, done: 0 })
  expect(orchestratorPill([worker({ status: 'running', isBackgrounded: true })])).toEqual({
    label: '1 subagent active',
  })
})

test('summary + pill: a blocked worker is counted on the assistant and never alerts', () => {
  const blocked = summarizeOrchestratorWorkers([
    worker({ status: 'completed', handoffStatus: 'blocked' }),
  ])
  expect(blocked).toMatchObject({ orchestrator: 1 })
  // The old amber "1 needs you" pill: a blocked worker is in flight, not owed to you.
  expect(orchestratorPill([worker({ status: 'completed', handoffStatus: 'blocked' })])).toEqual({
    label: '1 subagent active',
  })

  const busy = orchestratorPill([
    worker({ status: 'running' }),
    worker({ agentId: 'w-2', handle: 'Bell', status: 'running' }),
  ])
  expect(busy).toEqual({ label: '2 subagents active' })

  const settled = orchestratorPill([
    worker({ status: 'completed', synthesisStatus: 'synthesized' }),
  ])
  expect(settled).toBeNull()
})

test('failed workers stay on the assistant while stopped workers are settled', () => {
  const failed = worker({ agentId: 'w-failed', status: 'failed' })
  const stopped = worker({ agentId: 'w-stopped', status: 'killed' })

  expect(deriveWorkerOwner(failed)).toBe('orchestrator')
  expect(deriveWorkerOwner(stopped)).toBe('none')
  expect(summarizeOrchestratorWorkers([failed, stopped])).toEqual({
    working: 0,
    background: 0,
    orchestrator: 1,
    done: 1,
  })

  const line = selectOrchestratorRosterLine([failed, stopped])
  expect(line.lead?.worker.agentId).toBe('w-failed')
  expect(line.tail).toEqual([{ text: '1 done', tone: 'done' }])
})

test('roster promotes the news-bearing worker (failure over a ready result over quiet workers)', () => {
  const workers = [
    worker({ agentId: 'w-run', handle: 'Bell', status: 'running' }),
    worker({ agentId: 'w-result', handle: 'Hopper', status: 'completed', synthesisStatus: 'pending' }),
    worker({ agentId: 'w-fail', handle: 'Turing', status: 'failed' }),
  ]
  expect(workerEventPriority(workers[0])).toBe(0)
  expect(workerEventPriority(workers[1])).toBe(1)
  expect(workerEventPriority(workers[2])).toBe(2)
  expect(selectPromotedWorker(workers)?.worker.agentId).toBe('w-fail')
  // A quiet swarm promotes nobody — the roster shows neutral counts only.
  expect(selectPromotedWorker([worker({ status: 'running' })])).toBeNull()
})

test('roster line: at rest it names nobody and tallies the swarm honestly', () => {
  const line = selectOrchestratorRosterLine(
    [
      worker({ agentId: 'w-1', status: 'running' }),
      worker({ agentId: 'w-2', status: 'running' }),
      worker({ agentId: 'w-3', status: 'completed', handoffStatus: 'blocked' }),
      worker({ agentId: 'w-4', status: 'completed', synthesisStatus: 'synthesized' }),
    ],
  )
  expect(line.lead).toBeNull()
  expect(line.anyWorking).toBe(true)
  expect(line.tail).toEqual([
    { text: '2 working', tone: 'working' },
    { text: '1 on the assistant', tone: 'waiting' },
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
  )
  expect(line.lead?.worker.agentId).toBe('w-fail')
  expect(line.tail).toEqual([
    { text: '1 working', tone: 'working' },
    { text: '+1 more', tone: 'done' },
  ])
})

test('roster line: a quiet-but-stalled swarm still reports its blocked workers, never as news', () => {
  // The D2 C2 invariant at the line level, now unconditional: a blocked worker
  // promotes nobody and stays a NEUTRAL count, because the assistant owns the
  // handoff whether or not this session runs the agent-mode persona.
  const line = selectOrchestratorRosterLine([
    worker({ agentId: 'w-1', status: 'completed', handoffStatus: 'blocked' }),
    worker({ agentId: 'w-2', status: 'completed', handoffStatus: 'blocked' }),
  ])
  expect(line.lead).toBeNull()
  expect(line.anyWorking).toBe(false)
  expect(line.tail).toEqual([{ text: '2 on the assistant', tone: 'waiting' }])
})

test('roster line: an empty swarm has no lead and no counts', () => {
  expect(selectOrchestratorRosterLine([])).toEqual({
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

test('selectWorkerDisplayName omits legacy ids and unnamed handles', () => {
  expect(selectWorkerDisplayName({ agentId: 'agent-a', handle: 'Turing' })).toBe('Turing')
  expect(selectWorkerDisplayName({ agentId: 'agent-a', handle: '@Turing' })).toBe('Turing')
  expect(selectWorkerDisplayName({ agentId: 'agent-a', handle: 'agent-a' })).toBeNull()
  expect(selectWorkerDisplayName({ agentId: 'agent-a', handle: '@agent-a' })).toBeNull()
  expect(selectWorkerDisplayName({ agentId: 'agent-a', handle: '  ' })).toBeNull()
  expect(selectWorkerDisplayName({ agentId: 'agent-a', handle: null })).toBeNull()
})

test('workerAccessibleLabel preserves normalized type and lifecycle without exposing the id', () => {
  const label = workerAccessibleLabel(
    worker({
      agentId: 'agent-a',
      handle: 'agent-a',
      role: 'Explore',
      description: 'Inspect the repository',
      origin: 'prior',
      resumable: true,
      status: 'completed',
    }),
  )
  expect(label).toContain('Inspect the repository')
  expect(label).toContain('type Explore')
  expect(label).toContain('status Resumable')
  expect(label).not.toContain('agent-a')
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
