import { expect, test } from 'bun:test'
import type {
  LiveWorkersSnapshot,
  WorkersSnapshotFrame,
  LiveWorkerItem,
  LifecycleFrame,
} from '../../shared/protocol.js'
import {
  createWorkersState,
  deriveWorkerOwner,
  displayHandle,
  workersPill,
  workerState,
  reduceWorkersState,
  selectLiveWorkersSnapshot,
  selectDockedWorkers,
  selectWorkerRosterLine,
  selectPromotedWorker,
  selectWorkerById,
  selectWorkerDisplayName,
  summarizeWorkers,
  workerAccessibleLabel,
  workerEventPriority,
} from './workersState.js'

function worker(over: Partial<LiveWorkerItem> = {}): LiveWorkerItem {
  return {
    agentId: 'w-1',
    handle: 'Turing',
    role: 'implementor',
    status: 'running',
    description: 'Build the roster',
    ...over,
  }
}

function snapshot(
  workers: LiveWorkerItem[],
  over: Partial<LiveWorkersSnapshot> = {},
): LiveWorkersSnapshot {
  return { workers, ...over }
}

test('reduce folds a workers.snapshot per session and prunes it on lifecycle/removal', () => {
  const frame: WorkersSnapshotFrame = {
    kind: 'workers.snapshot',
    protocolVersion: 1,
    sessionId: 's1',
    workers: snapshot([worker()]),
  }
  let state = reduceWorkersState(createWorkersState(), { type: 'frame', frame })
  expect(selectLiveWorkersSnapshot(state, 's1')?.workers).toHaveLength(1)
  expect(selectLiveWorkersSnapshot(state, 's2')).toBeNull()

  const lifecycle: LifecycleFrame = {
    kind: 'lifecycle',
    protocolVersion: 1,
    sessionId: 's1',
    status: 'exited',
  }
  state = reduceWorkersState(state, { type: 'frame', frame: lifecycle })
  expect(selectLiveWorkersSnapshot(state, 's1')).toBeNull()
  expect('s1' in state.bySession).toBe(false)
  // A lifecycle for an unseen session is a no-op, not a whole-store allocation.
  expect(
    reduceWorkersState(state, { type: 'frame', frame: lifecycle }),
  ).toBe(state)

  state = reduceWorkersState(createWorkersState(), { type: 'frame', frame })
  state = reduceWorkersState(state, { type: 'session-removed', sessionId: 's1' })
  expect(selectLiveWorkersSnapshot(state, 's1')).toBeNull()
  expect('s1' in state.bySession).toBe(false)
})

test('a blocked worker waits on the assistant, never on the user', () => {
  // The handoff is queued to the delegating conversation and drained into a fresh
  // turn with no human action, so there is no "solo" case to escalate.
  // decides which persona the parent runs, not whether a parent exists.
  const blocked = worker({ status: 'completed', handoffStatus: 'blocked' })
  expect(workerState(blocked)).toBe('waiting')
  expect(deriveWorkerOwner(blocked)).toBe('assistant')
})

test('non-blocked lifecycle uses the live worker vocabulary', () => {
  expect(workerState(worker({ status: 'running' }))).toBe('running')
  expect(workerState(worker({ status: 'completed' }))).toBe('completed')
  expect(workerState(worker({ status: 'failed' }))).toBe('failed')
  expect(workerState(worker({ status: 'killed' }))).toBe('stopped')
})

test('a backgrounded worker reads BACKGROUND, and only while it is genuinely running', () => {
  expect(
    workerState(worker({ status: 'running', isBackgrounded: true })),
  ).toBe('background')
  // Foreground stays running — the two spawns rendered identically before this.
  expect(
    workerState(worker({ status: 'running', isBackgrounded: false })),
  ).toBe('running')
  // A settled worker is not "in background" just because it was spawned that way.
  expect(workerState(worker({ status: 'completed', isBackgrounded: true }))).toBe('completed')
})

test('the docked roster keeps only live work and unresolved worker states', () => {
  const visible = selectDockedWorkers([
    worker({ agentId: 'running', status: 'running' }),
    worker({ agentId: 'background', status: 'running', isBackgrounded: true }),
    worker({ agentId: 'waiting', status: 'completed', handoffStatus: 'blocked' }),
    worker({ agentId: 'failed', status: 'failed' }),
    worker({ agentId: 'completed', status: 'completed' }),
    worker({ agentId: 'stopped', status: 'killed' }),
  ])

  expect(visible.map(item => item.agentId)).toEqual([
    'running',
    'background',
    'waiting',
    'failed',
  ])
})

test('the roster counts background separately, and still calls it in flight', () => {
  const line = selectWorkerRosterLine(
    [
      worker({ agentId: 'w1', status: 'running' }),
      worker({ agentId: 'w2', status: 'running', isBackgrounded: true }),
    ],
  )
  expect(line.tail.map(count => count.text)).toEqual(['1 working', '1 in background'])
  expect(line.anyWorking).toBe(true)
  // A lone background worker still counts as an active subagent, not as done.
  const summary = summarizeWorkers([
    worker({ status: 'running', isBackgrounded: true }),
  ])
  // Counted apart from `working` so the Workers list and the roster agree, but
  // still "active" for the pill rather than folded into done.
  expect(summary).toEqual({ working: 0, background: 1, assistant: 0, done: 0 })
  expect(workersPill([worker({ status: 'running', isBackgrounded: true })])).toEqual({
    label: '1 subagent active',
  })
})

test('summary + pill: a blocked worker is counted on the assistant and never alerts', () => {
  const blocked = summarizeWorkers([
    worker({ status: 'completed', handoffStatus: 'blocked' }),
  ])
  expect(blocked).toMatchObject({ assistant: 1 })
  // The old amber "1 needs you" pill: a blocked worker is in flight, not owed to you.
  expect(workersPill([worker({ status: 'completed', handoffStatus: 'blocked' })])).toEqual({
    label: '1 subagent active',
  })

  const busy = workersPill([
    worker({ status: 'running' }),
    worker({ agentId: 'w-2', handle: 'Bell', status: 'running' }),
  ])
  expect(busy).toEqual({ label: '2 subagents active' })

  const settled = workersPill([
    worker({ status: 'completed' }),
  ])
  expect(settled).toBeNull()
})

test('failed workers stay on the assistant while stopped workers are settled', () => {
  const failed = worker({ agentId: 'w-failed', status: 'failed' })
  const stopped = worker({ agentId: 'w-stopped', status: 'killed' })

  expect(deriveWorkerOwner(failed)).toBe('assistant')
  expect(deriveWorkerOwner(stopped)).toBe('none')
  expect(summarizeWorkers([failed, stopped])).toEqual({
    working: 0,
    background: 0,
    assistant: 1,
    done: 1,
  })

  const line = selectWorkerRosterLine([failed, stopped])
  expect(line.lead?.worker.agentId).toBe('w-failed')
  expect(line.tail).toEqual([{ text: '1 done', tone: 'done' }])
})

test('roster promotes a failed worker over quiet workers', () => {
  const workers = [
    worker({ agentId: 'w-run', handle: 'Bell', status: 'running' }),
    worker({ agentId: 'w-fail', handle: 'Turing', status: 'failed' }),
  ]
  expect(workerEventPriority(workers[0])).toBe(0)
  expect(workerEventPriority(workers[1])).toBe(2)
  expect(selectPromotedWorker(workers)?.worker.agentId).toBe('w-fail')
  // A quiet swarm promotes nobody — the roster shows neutral counts only.
  expect(selectPromotedWorker([worker({ status: 'running' })])).toBeNull()
})

test('roster line: at rest it names nobody and tallies the swarm honestly', () => {
  const line = selectWorkerRosterLine(
    [
      worker({ agentId: 'w-1', status: 'running' }),
      worker({ agentId: 'w-2', status: 'running' }),
      worker({ agentId: 'w-3', status: 'completed', handoffStatus: 'blocked' }),
      worker({ agentId: 'w-4', status: 'completed' }),
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
  const line = selectWorkerRosterLine(
    [
      worker({ agentId: 'w-fail', status: 'failed' }),
      worker({ agentId: 'w-run', status: 'running' }),
    ],
  )
  expect(line.lead?.worker.agentId).toBe('w-fail')
  expect(line.tail).toEqual([
    { text: '1 working', tone: 'working' },
  ])
})

test('roster line: a quiet-but-stalled swarm still reports its blocked workers, never as news', () => {
  // The D2 C2 invariant at the line level, now unconditional: a blocked worker
  // promotes nobody and stays a NEUTRAL count, because the assistant owns the
  // handoff for every live worker.
  const line = selectWorkerRosterLine([
    worker({ agentId: 'w-1', status: 'completed', handoffStatus: 'blocked' }),
    worker({ agentId: 'w-2', status: 'completed', handoffStatus: 'blocked' }),
  ])
  expect(line.lead).toBeNull()
  expect(line.anyWorking).toBe(false)
  expect(line.tail).toEqual([{ text: '2 on the assistant', tone: 'waiting' }])
})

test('roster line: an empty swarm has no lead and no counts', () => {
  expect(selectWorkerRosterLine([])).toEqual({
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
      status: 'completed',
    }),
  )
  expect(label).toContain('Inspect the repository')
  expect(label).toContain('type Explore')
  expect(label).toContain('status Completed')
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
