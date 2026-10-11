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
  workerState,
  reduceWorkersState,
  selectLiveWorkersSnapshot,
  selectWorkerById,
  selectWorkerDisplayName,
  summarizeWorkers,
  workerAccessibleLabel,
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
    protocolVersion: 3,
    sessionId: 's1',
    workers: snapshot([worker()]),
  }
  let state = reduceWorkersState(createWorkersState(), { type: 'frame', frame })
  expect(selectLiveWorkersSnapshot(state, 's1')?.workers).toHaveLength(1)
  expect(selectLiveWorkersSnapshot(state, 's2')).toBeNull()

  const lifecycle: LifecycleFrame = {
    kind: 'lifecycle',
    protocolVersion: 3,
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

test('the Workers list summary counts foreground, background and blocked work separately', () => {
  const summary = summarizeWorkers([
    worker({ agentId: 'foreground' }),
    worker({ agentId: 'background', isBackgrounded: true }),
    worker({ agentId: 'blocked', status: 'completed', handoffStatus: 'blocked' }),
  ])
  expect(summary).toEqual({ working: 1, background: 1, assistant: 1, done: 0 })
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
