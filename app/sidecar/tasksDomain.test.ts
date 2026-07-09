import { expect, test } from 'bun:test'
import { createTaskStateBase } from '../../src/Task.js'
import type { DreamTaskState } from '../../src/tasks/DreamTask/DreamTask.js'
import type { InProcessTeammateTaskState } from '../../src/tasks/InProcessTeammateTask/types.js'
import type { LocalAgentTaskState } from '../../src/tasks/LocalAgentTask/LocalAgentTask.js'
import type { LocalShellTaskState } from '../../src/tasks/LocalShellTask/guards.js'
import type { RemoteAgentTaskState } from '../../src/tasks/RemoteAgentTask/RemoteAgentTask.js'
import type { TaskState } from '../../src/tasks/types.js'
import { scanForSecrets } from '../shared/secretGuard.js'
import type { TasksSnapshotFrame } from '../shared/protocol.js'
import { tasksSnapshot } from './tasksDomain.js'

function bashTask(over: Partial<LocalShellTaskState> = {}): LocalShellTaskState {
  return {
    ...createTaskStateBase('b1', 'local_bash', 'echo hi'),
    type: 'local_bash',
    status: 'running',
    command: 'echo hi',
    completionStatusSentInAttachment: false,
    shellCommand: null,
    lastReportedTotalLines: 0,
    isBackgrounded: true,
    ...over,
  }
}

function agentTask(over: Partial<LocalAgentTaskState> = {}): LocalAgentTaskState {
  return {
    ...createTaskStateBase('a1', 'local_agent', 'Implement the thing'),
    type: 'local_agent',
    status: 'running',
    agentId: 'agent-1',
    prompt: 'Implement the thing',
    agentType: 'general-purpose',
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
    ...over,
  }
}

function remoteTask(over: Partial<RemoteAgentTaskState> = {}): RemoteAgentTaskState {
  return {
    ...createTaskStateBase('r1', 'remote_agent', 'Cloud session'),
    type: 'remote_agent',
    status: 'running',
    remoteTaskType: 'remote-agent',
    sessionId: 'remote-sess-1',
    command: 'do the thing',
    title: 'Cloud session',
    todoList: [],
    log: [],
    pollStartedAt: Date.now(),
    ...over,
  }
}

function teammateTask(over: Partial<InProcessTeammateTaskState> = {}): InProcessTeammateTaskState {
  return {
    ...createTaskStateBase('t1', 'in_process_teammate', 'Researcher teammate'),
    type: 'in_process_teammate',
    status: 'running',
    identity: {
      agentId: 'researcher@team-1',
      agentName: 'researcher',
      teamName: 'team-1',
      planModeRequired: false,
      parentSessionId: 'leader-sess',
    },
    prompt: 'Research the thing',
    awaitingPlanApproval: false,
    permissionMode: 'default',
    pendingUserMessages: [],
    isIdle: false,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    ...over,
  }
}

function dreamTask(over: Partial<DreamTaskState> = {}): DreamTaskState {
  return {
    ...createTaskStateBase('d1', 'dream', 'Overnight cleanup'),
    type: 'dream',
    status: 'running',
    phase: 'updating',
    sessionsReviewing: 1,
    filesTouched: [],
    turns: [],
    priorMtime: 0,
    ...over,
  }
}

test('maps every real task type into a snapshot item with the right per-type label', () => {
  const tasks: Record<string, TaskState> = {
    b1: bashTask({ command: 'npm test', kind: 'bash' }),
    a1: agentTask({ description: 'Fix the bug', agentName: 'fixer', agentType: 'implementor' }),
    r1: remoteTask({ title: 'PR review' }),
    t1: teammateTask(),
    d1: dreamTask({ description: 'Nightly pass' }),
  }

  const snapshot = tasksSnapshot(tasks, undefined)
  const byId = Object.fromEntries(snapshot.items.map(item => [item.id, item]))

  expect(byId.b1).toMatchObject({ type: 'local_bash', label: 'npm test', kind: 'bash' })
  expect(byId.a1).toMatchObject({
    type: 'local_agent',
    label: 'Fix the bug',
    agentName: 'fixer',
    agentType: 'implementor',
  })
  expect(byId.r1).toMatchObject({ type: 'remote_agent', label: 'PR review' })
  expect(byId.t1).toMatchObject({ type: 'in_process_teammate', label: '@researcher', agentName: 'researcher' })
  expect(byId.d1).toMatchObject({ type: 'dream', label: 'Nightly pass' })
})

test('a monitor-kind bash task renders its description, not the raw command', () => {
  const snapshot = tasksSnapshot(
    { b1: bashTask({ kind: 'monitor', description: 'watching build output', command: 'tail -f build.log' }) },
    undefined,
  )
  expect(snapshot.items[0]).toMatchObject({ label: 'watching build output', kind: 'monitor' })
})

test('excludes a terminal, non-backgrounded task (the base isBackgroundTask rule)', () => {
  const snapshot = tasksSnapshot(
    { b1: bashTask({ status: 'completed', isBackgrounded: true }) },
    undefined,
  )
  // completed + not running/pending -> isBackgroundTask() is false, and it's
  // not a local_agent, so isVisibleBackgroundTask() drops it (matches
  // BackgroundTasksDialog.tsx:122-130 — only a terminal BACKGROUNDED
  // local_agent gets the "stay visible" carve-out).
  expect(snapshot.items).toHaveLength(0)
})

test('keeps a terminal backgrounded local_agent visible (blocked/completed handoff stays openable)', () => {
  const snapshot = tasksSnapshot(
    { a1: agentTask({ status: 'completed', isBackgrounded: true, handoffStatus: 'blocked' }) },
    undefined,
  )
  expect(snapshot.items).toHaveLength(1)
  expect(snapshot.items[0]).toMatchObject({ id: 'a1', status: 'completed', handoffStatus: 'blocked' })
})

test('excludes the foregrounded local_agent — its messages already render in the main pane', () => {
  const snapshot = tasksSnapshot(
    {
      a1: agentTask({ id: 'a1', status: 'running', isBackgrounded: false }),
      a2: agentTask({ id: 'a2', status: 'running', isBackgrounded: true }),
    },
    'a1',
  )
  const ids = snapshot.items.map(item => item.id)
  expect(ids).not.toContain('a1')
  expect(ids).toContain('a2')
  expect(snapshot.foregroundedTaskId).toBe('a1')
})

test('a running foreground (isBackgrounded: false) bash task is not yet a background task', () => {
  // isBackgroundTask() checks `isBackgrounded` on ANY task carrying the field
  // (not just local_agent) — a shell explicitly running in the foreground
  // hasn't been backgrounded yet, matching `types.ts:37-46`.
  const hidden = tasksSnapshot({ b1: bashTask({ status: 'running', isBackgrounded: false }) }, undefined)
  expect(hidden.items).toHaveLength(0)

  const visible = tasksSnapshot({ b1: bashTask({ status: 'running', isBackgrounded: true }) }, undefined)
  expect(visible.items.map(i => i.id)).toEqual(['b1'])
})

test('carries the real teammate/remote-agent state fields the P4-2 vocabulary derives from', () => {
  const snapshot = tasksSnapshot(
    {
      t1: teammateTask({ awaitingPlanApproval: true, shutdownRequested: false, isIdle: false }),
      r1: remoteTask({ isUltraplan: true, ultraplanPhase: 'needs_input' }),
    },
    undefined,
  )
  const byId = Object.fromEntries(snapshot.items.map(item => [item.id, item]))
  expect(byId.t1).toMatchObject({ awaitingPlanApproval: true })
  expect(byId.r1).toMatchObject({ isUltraplan: true, ultraplanPhase: 'needs_input' })
})

test('the outbound tasks.snapshot frame is secretGuard-clean even with token-shaped labels', () => {
  const snapshot = tasksSnapshot(
    { b1: bashTask({ description: 'curl -H "Authorization: Bearer sk-fake-not-a-real-secret"' }) },
    undefined,
  )
  const frame: TasksSnapshotFrame = {
    kind: 'tasks.snapshot',
    protocolVersion: 1,
    sessionId: 'sess-1',
    tasks: snapshot,
  }
  // Task descriptions are user-authored shell text, not credential material —
  // secretGuard's job is blocking KNOWN secret key names/shapes (accessToken,
  // sk-ant-… etc.), not arbitrary command strings. This just proves the guard
  // still runs over the new frame kind without special-casing it.
  expect(scanForSecrets(frame).ok).toBe(true)
})

test('an empty task map produces an empty, well-formed snapshot', () => {
  expect(tasksSnapshot(undefined, undefined)).toEqual({ items: [] })
  expect(tasksSnapshot({}, undefined)).toEqual({ items: [] })
})
