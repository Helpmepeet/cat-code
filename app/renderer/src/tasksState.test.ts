import { expect, test } from 'bun:test'
import type { ServerFrame, SessionId, TaskSnapshotItem, TasksSnapshot } from '../../shared/protocol.js'
import {
  createTasksState,
  groupTaskItems,
  reduceTasksState,
  selectTasksSnapshot,
  sortTaskItems,
  TASK_COLOR_CLASS,
  TASK_KIND_META,
  taskColorClass,
  taskDisplayState,
  taskKindMeta,
} from './tasksState.js'
import { AGENT_STATE_META } from './agentIdentity.js'

test('every task/state color resolves to STATIC Tailwind classes (Tailwind v4 emits no interpolated arbitrary values)', () => {
  // Both color vocabularies the TasksDialog renders must have an explicit map
  // entry — a hex with no entry would silently fall back to muted, and (worse,
  // pre-fix) a dynamic `text-[${color}]` never renders at all.
  const kindColors = Object.values(TASK_KIND_META).map(meta => meta.color)
  const stateColors = Object.values(AGENT_STATE_META).map(meta => meta.color)
  for (const color of [...kindColors, ...stateColors]) {
    expect(TASK_COLOR_CLASS[color]).toBeDefined()
  }

  // No resolved class may carry an interpolation or an arbitrary-value token —
  // every class string is a complete literal Tailwind can scan.
  const allClasses = Object.values(TASK_COLOR_CLASS).flatMap(entry => [
    entry.text,
    entry.border,
    entry.dot,
  ])
  for (const cls of allClasses) {
    expect(cls).not.toContain('[#')
    expect(cls).not.toContain('${')
    expect(cls).not.toContain('var(')
  }

  // The resolver degrades to a muted static fallback, never undefined.
  const fallback = taskColorClass('#not-a-known-color')
  expect(fallback.text).toBe('text-text-subtle')
  expect(fallback.dot).not.toContain('[#')
})

function item(over: Partial<TaskSnapshotItem> = {}): TaskSnapshotItem {
  return {
    id: 'b1',
    type: 'local_bash',
    status: 'running',
    label: 'npm test',
    startTime: 1,
    ...over,
  }
}

function tasksFrame(sessionId: SessionId, tasks: TasksSnapshot): ServerFrame {
  return { kind: 'tasks.snapshot', protocolVersion: 1, sessionId, tasks }
}

function lifecycleFrame(sessionId: SessionId): ServerFrame {
  return { kind: 'lifecycle', protocolVersion: 1, sessionId, status: 'disconnected' }
}

test('reduces tasks snapshots by session id', () => {
  const snapshot: TasksSnapshot = { items: [item()] }
  const state = reduceTasksState(createTasksState(), {
    type: 'frame',
    frame: tasksFrame('a', snapshot),
  })

  expect(selectTasksSnapshot(state, 'a')).toEqual(snapshot)
  expect(selectTasksSnapshot(state, 'missing')).toBeNull()
  expect(selectTasksSnapshot(state, null)).toBeNull()
})

test('clears the known snapshot on lifecycle reset', () => {
  let state = reduceTasksState(createTasksState(), {
    type: 'frame',
    frame: tasksFrame('a', { items: [item()] }),
  })
  expect(selectTasksSnapshot(state, 'a')).not.toBeNull()

  state = reduceTasksState(state, { type: 'frame', frame: lifecycleFrame('a') })
  expect(selectTasksSnapshot(state, 'a')).toBeNull()
})

test('sorts running-first, then newest', () => {
  const items = [
    item({ id: 'old-done', status: 'completed', startTime: 1 }),
    item({ id: 'new-done', status: 'completed', startTime: 5 }),
    item({ id: 'running', status: 'running', startTime: 2 }),
  ]
  expect(sortTaskItems(items).map(i => i.id)).toEqual(['running', 'new-done', 'old-done'])
})

test('groups active vs completed, sorted within each group', () => {
  const snapshot: TasksSnapshot = {
    items: [
      item({ id: 'r1', status: 'running', startTime: 1 }),
      item({ id: 'p1', status: 'pending', startTime: 2 }),
      item({ id: 'c1', status: 'completed', startTime: 3 }),
      item({ id: 'f1', status: 'failed', startTime: 4 }),
      item({ id: 'k1', status: 'killed', startTime: 5 }),
    ],
  }
  const { active, completed } = groupTaskItems(snapshot)
  expect(active.map(i => i.id).sort()).toEqual(['p1', 'r1'])
  expect(completed.map(i => i.id).sort()).toEqual(['c1', 'f1', 'k1'])
  expect(groupTaskItems(null)).toEqual({ active: [], completed: [] })
})

test('taskDisplayState reuses P4-2 deriveTaskAgentState for local_agent/teammate/remote_agent', () => {
  expect(
    taskDisplayState(item({ type: 'local_agent', status: 'running', handoffStatus: 'blocked' })),
  ).toBe('needs-you')
  expect(
    // P4-8: orchestrator-owned blocked is the neutral 'waiting' ("Waiting on
    // orchestrator"), not 'blocked' (deriveTaskAgentState wiring of the `waiting`
    // state). P4-9's dialog never passes blockedOwner, so its rendering is unchanged.
    taskDisplayState(
      item({ type: 'local_agent', status: 'running', handoffStatus: 'blocked' }),
      { blockedOwner: 'orchestrator' },
    ),
  ).toBe('waiting')
  expect(
    taskDisplayState(item({ type: 'local_agent', status: 'running', isBackgrounded: true })),
  ).toBe('background')
  expect(
    taskDisplayState(item({ type: 'in_process_teammate', status: 'running', isIdle: true })),
  ).toBe('paused')
  expect(
    taskDisplayState(
      item({ type: 'remote_agent', status: 'running', ultraplanPhase: 'plan_ready' }),
    ),
  ).toBe('needs-you')
})

test('taskDisplayState maps status-only task types 1:1 onto the shared vocabulary', () => {
  expect(taskDisplayState(item({ type: 'local_bash', status: 'pending' }))).toBe('running')
  expect(taskDisplayState(item({ type: 'local_bash', status: 'running' }))).toBe('running')
  expect(taskDisplayState(item({ type: 'dream', status: 'completed' }))).toBe('completed')
  expect(taskDisplayState(item({ type: 'monitor_mcp', status: 'failed' }))).toBe('failed')
  expect(taskDisplayState(item({ type: 'local_workflow', status: 'killed' }))).toBe('stopped')
})

test('every TaskType has a kind badge', () => {
  const types: TaskSnapshotItem['type'][] = [
    'local_bash',
    'local_agent',
    'remote_agent',
    'in_process_teammate',
    'local_workflow',
    'monitor_mcp',
    'dream',
  ]
  for (const type of types) {
    expect(taskKindMeta(type).label.length).toBeGreaterThan(0)
  }
})
