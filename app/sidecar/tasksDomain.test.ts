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
import { createSidecarTasksDomain, tasksSnapshot } from './tasksDomain.js'
import { createStore } from '../../src/state/store.js'
import { getDefaultAppState } from '../../src/state/AppStateStore.js'
import { AppSessionController, type AppSessionControllerAdapter } from '../../src/app-runtime/AppSessionController.js'
import type { AppPermissionRequest, AppPermissionResponse } from '../../src/app-runtime/sessionEvents.js'
import { unregisterAgentForeground } from '../../src/tasks/LocalAgentTask/LocalAgentTask.js'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { SleepAssertionOwner } from '../shared/sleepAssertion.js'
import { DesktopPower } from '../main/desktopPower.js'
import { unknownPowerObservation } from '../main/powerObservation.js'
import { PROTOCOL_VERSION } from '../shared/protocol.js'

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

test('Focused receives the real background Bash lifecycle and description without changing the task list', () => {
  const task = bashTask({ description: 'Run the suite', command: 'bun test', toolUseId: 'bash-call', startTime: 10000 })
  const store = createStore({ ...getDefaultAppState(), tasks: { b1: task } })
  const domain = createSidecarTasksDomain(store)
  const snapshots: ReturnType<typeof domain.getSnapshot>[] = []
  const stop = domain.subscribe(() => snapshots.push(domain.getSnapshot()))
  try {
    expect(domain.getSnapshot().items[0]?.label).toBe('bun test')
    expect(domain.getSnapshot().focusedBashJobs).toEqual([{ id: 'b1', toolUseId: 'bash-call', label: 'Run the suite', status: 'running', startTime: 10000 }])
    store.setState(state => ({ ...state, tasks: { b1: { ...task, status: 'failed', endTime: 12000 } } }))
    expect(snapshots.at(-1)?.focusedBashJobs).toEqual([{ id: 'b1', toolUseId: 'bash-call', label: 'Run the suite', status: 'failed', startTime: 10000, endTime: 12000 }])
    expect(snapshots.at(-1)?.items).toEqual([])
  } finally { stop() }
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
      a1: agentTask({
        id: 'a1',
        status: 'running',
        isBackgrounded: false,
        toolUseId: 'toolu-a1',
        agentName: 'lead-worker',
        agentType: 'verification',
        startTime: 100,
      }),
      a2: agentTask({ id: 'a2', status: 'running', isBackgrounded: true }),
    },
    'a1',
  )
  const ids = snapshot.items.map(item => item.id)
  expect(ids).not.toContain('a1')
  expect(ids).toContain('a2')
  expect(snapshot.subagents).toEqual([
    {
      toolUseId: 'toolu-a1',
      agentId: 'agent-1',
      agentName: 'lead-worker',
      agentType: 'verification',
      isSidechain: true,
      spawnedAt: 100,
      // The FOREGROUNDED worker is excluded from `items` but still listed here,
      // which is what lets a card offer `task.background.one` at all.
      isBackgrounded: false,
    },
  ])
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
    protocolVersion: 4,
    sessionId: 'sess-1',
    tasks: snapshot,
  }
  // Task descriptions are user-authored shell text, not credential material —
  // secretGuard's job is blocking KNOWN secret key names/shapes (accessToken,
  // sk-ant-… etc.), not arbitrary command strings. This just proves the guard
  // still runs over the new frame kind without special-casing it.
  expect(scanForSecrets(frame).ok).toBe(true)
})

// P4-31 — the bash-only fixture above leaves `subagents` EMPTY, so it never
// exercised the new outbound field. Agent names and types are user-authored
// (`.claude/agents/<name>.md`), so they are the arm of this frame most likely to
// carry pasted credential-shaped text.
test('the outbound subagents field is covered by secretGuard, and a real secret in an agent name is caught', () => {
  const clean = tasksSnapshot(
    {
      a1: agentTask({
        id: 'a1',
        status: 'running',
        isBackgrounded: true,
        toolUseId: 'toolu-a1',
        agentName: 'curl -H "Authorization: Bearer sk-fake-not-a-real-secret"',
        agentType: 'verification',
        startTime: 100,
      }),
    },
    undefined,
  )
  // The field is actually populated — otherwise this test proves nothing.
  expect(clean.subagents).toHaveLength(1)
  const frame: TasksSnapshotFrame = {
    kind: 'tasks.snapshot',
    protocolVersion: 4,
    sessionId: 'sess-1',
    tasks: clean,
  }
  expect(scanForSecrets(frame).ok).toBe(true)

  // Failing-direction proof that the guard actually DESCENDS into `subagents`
  // rather than stopping at `items`. It must be a secret KEY, not a
  // secret-shaped value: `scanForSecrets` matches on key names only
  // (`app/shared/secretGuard.ts:28-41`), so a credential pasted into a name
  // string is deliberately out of its scope — the assertion above is about the
  // guard running, not about redacting user text.
  const planted = {
    ...clean,
    subagents: [{ ...clean.subagents![0]!, accessToken: 'planted' }],
  }
  const result = scanForSecrets({ ...frame, tasks: planted })
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.path).toContain('subagents')
})

test('an empty task map produces an empty, well-formed snapshot', () => {
  expect(tasksSnapshot(undefined, undefined)).toEqual({ items: [], subagents: [] })
  expect(tasksSnapshot({}, undefined)).toEqual({ items: [], subagents: [] })
})

/* --------------------------------------------------------------------------- *
 * hasLiveWork — the IDLE-PARK park gate (decisions/IDLE-PARK.md §3). Reads the
 * RAW store, foreground-inclusive — NOT the display snapshot.
 * --------------------------------------------------------------------------- */

function storeWith(tasks: Record<string, TaskState>, foregroundedTaskId?: string) {
  return createStore({
    ...getDefaultAppState(),
    tasks,
    ...(foregroundedTaskId ? { foregroundedTaskId } : {}),
  })
}

test('hasLiveWork — true for a running background task', () => {
  const domain = createSidecarTasksDomain(storeWith({ b1: bashTask({ status: 'running' }) }))
  expect(domain.hasLiveWork()).toBe(true)
})

test('hasLiveWork — true for a pending task', () => {
  const domain = createSidecarTasksDomain(storeWith({ b1: bashTask({ status: 'pending' }) }))
  expect(domain.hasLiveWork()).toBe(true)
})

test('hasLiveWork — true for a running FOREGROUNDED local_agent the display snapshot HIDES', () => {
  const worker = agentTask({ id: 'a1', status: 'running', isBackgrounded: false })
  const store = storeWith({ a1: worker }, 'a1')
  const domain = createSidecarTasksDomain(store)
  // The display snapshot hides it (foregrounded + non-backgrounded)…
  expect(domain.getSnapshot().items).toHaveLength(0)
  expect(domain.getSnapshot().hasForegroundTask).toBe(true)
  // …but the park gate must still see it — no turn loss.
  expect(domain.hasLiveWork()).toBe(true)
})

test('completion facts include the same foreground worker omitted from display items', () => {
  const worker = agentTask({ id: 'a1', status: 'running', isBackgrounded: false })
  const domain = createSidecarTasksDomain(storeWith({ a1: worker }, 'a1'))
  expect(domain.getSnapshot().items).toHaveLength(0)
  expect(domain.readUnfinishedWork()).toMatchObject({
    available: true, activeSubagents: 1, backgroundMainTurn: false,
  })
})

test('completion facts read nested workers retained in the root task store', () => {
  const store = storeWith({
    parent: agentTask({ id: 'parent', agentId: 'agent-parent' }),
    child: agentTask({ id: 'child', agentId: 'agent-child' }),
    grandchild: agentTask({ id: 'grandchild', agentId: 'agent-grandchild' }),
  })
  expect(Object.keys(store.getState().tasks)).toHaveLength(3)
  expect(createSidecarTasksDomain(store).readUnfinishedWork()).toMatchObject({
    available: true, activeSubagents: 3,
  })
})

test('the task-mode snapshot turns off once the same worker is backgrounded', () => {
  const worker = agentTask({
    id: 'a1',
    status: 'running',
    isBackgrounded: true,
  })
  const domain = createSidecarTasksDomain(storeWith({ a1: worker }))

  expect(domain.getSnapshot().hasForegroundTask).toBe(false)
})

test('the task-mode snapshot hides Background when terminal backgrounding is disabled', () => {
  const previous = process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS
  process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1'
  try {
    const worker = agentTask({
      id: 'a1',
      status: 'running',
      isBackgrounded: false,
    })
    const domain = createSidecarTasksDomain(storeWith({ a1: worker }, 'a1'))

    expect(domain.getSnapshot().hasForegroundTask).toBe(false)
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS
    } else {
      process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = previous
    }
  }
})

test('hasLiveWork — false when every task is terminal', () => {
  const domain = createSidecarTasksDomain(
    storeWith({
      b1: bashTask({ status: 'completed' }),
      a1: agentTask({ id: 'a1', status: 'completed', isBackgrounded: true, handoffStatus: 'blocked' }),
    }),
  )
  expect(domain.hasLiveWork()).toBe(false)
})

test('hasLiveWork — false for an empty task map', () => {
  const domain = createSidecarTasksDomain(storeWith({}))
  expect(domain.hasLiveWork()).toBe(false)
})

test('task subscription ignores engine progress outside the display projection', () => {
  const task = bashTask({ status: 'running' })
  const store = storeWith({ b1: task })
  const domain = createSidecarTasksDomain(store)
  let notifications = 0
  const stop = domain.subscribe(() => notifications++)

  store.setState(previous => ({
    ...previous,
    tasks: { b1: { ...task, lastReportedTotalLines: 100 } },
  }))
  expect(notifications).toBe(0)

  store.setState(previous => ({
    ...previous,
    tasks: { b1: { ...task, status: 'completed' } },
  }))
  expect(notifications).toBe(1)
  stop()
})

function powerDomain(
  tasks: Record<string, TaskState>,
  foregroundedTaskId?: string,
  adapter: AppSessionControllerAdapter = { async *runTurn() {} },
) {
  const store = storeWith(tasks, foregroundedTaskId)
  const controller = new AppSessionController(adapter)
  const domain = createSidecarTasksDomain(store, controller)
  const children: EventEmitter[] = []
  const assertion = new SleepAssertionOwner({ enabled: true, setTimeout, clearTimeout, log() {},
    spawn() {
      const child = Object.assign(new EventEmitter(), { unref() {}, kill() { return true } })
      children.push(child)
      queueMicrotask(() => child.emit('spawn'))
      return child as unknown as ChildProcess
    } })
  const power = new DesktopPower(assertion, { setActive() {},
    read: () => ({ status: 'inactive', observation: unknownPowerObservation(), observedAt: null, failures: 0 }) })
  const stopEvents = controller.subscribe(event => power.receive('session', {
    kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: 'session', event,
  }))
  const publish = () => power.receive('session', {
    kind: 'tasks.snapshot', protocolVersion: PROTOCOL_VERSION, sessionId: 'session', tasks: domain.getSnapshot(),
  })
  const stopDomain = domain.subscribe(publish)
  publish()
  return { store, controller, domain, power,
    dispose() { stopEvents(); stopDomain(); power.dispose(); for (const child of children) child.emit('exit') } }
}

const workerPermission = (): AppPermissionRequest => ({ requestId: 'worker-permission', request: {
  subtype: 'can_use_tool', tool_name: 'Read', tool_use_id: 'tu-read', input: {}, agent_id: 'agent-1',
} })

test('real retained foreground completion releases power without changing its UI capability', async () => {
  const worker = agentTask({ isBackgrounded: false,
    pendingMessages: [{ id: 'follow-up', message: 'follow-up', status: 'pending', acceptedAt: 1 }], retain: true })
  const h = powerDomain({ a1: worker }, 'a1')
  try {
    await Promise.resolve()
    expect(h.power.read().assertion.desired).toBe(true)
    unregisterAgentForeground('a1', h.store.setState)
    expect(h.store.getState().tasks.a1?.status).toBe('completed')
    expect(h.domain.getSnapshot()).toMatchObject({ hasForegroundTask: true, hasOperationalWork: false })
    expect(h.power.read().assertion.desired).toBe(false)
  } finally { h.dispose() }
})

test('foreground permission wait releases only blocked work and re-acquires on resolution', async () => {
  let requested!: () => void
  const waiting = new Promise<void>(resolve => { requested = resolve })
  const h = powerDomain({ a1: agentTask({ isBackgrounded: false }) }, 'a1', {
    async *runTurn({ onPermissionRequest }) {
      const response = onPermissionRequest(workerPermission())
      requested()
      await response
    },
  })
  const turn = h.controller.submit('run worker')
  try {
    await waiting
    expect(h.controller.isTurnActive()).toBe(true)
    expect(h.store.getState().tasks.a1?.status).toBe('running')
    expect(h.domain.getSnapshot().hasOperationalWork).toBe(false)
    expect(h.power.read().assertion.desired).toBe(false)
    h.store.setState(state => ({ ...state, tasks: { ...state.tasks, b1: bashTask() } }))
    expect(h.power.read().assertion.desired).toBe(true)
    h.store.setState(state => ({ ...state, tasks: { a1: state.tasks.a1! } }))
    expect(h.power.read().assertion.desired).toBe(false)
    h.controller.respondToPermissionRequest('worker-permission', { behavior: 'deny', message: 'test resolution' })
    expect(h.domain.getSnapshot().hasOperationalWork).toBe(true)
    expect(h.power.read().assertion.desired).toBe(true)
    await turn
  } finally {
    h.controller.respondToPermissionRequest('worker-permission', { behavior: 'deny', message: 'test cleanup' })
    await turn; h.dispose()
  }
})

test('background permission after parent turn ends releases power but keeps independent work protected', async () => {
  let requestPermission!: (request: AppPermissionRequest) => Promise<AppPermissionResponse>
  const h = powerDomain({ a1: agentTask() }, undefined, {
    async *runTurn({ onPermissionRequest }) { requestPermission = onPermissionRequest },
  })
  await h.controller.submit('launch worker')
  const response = requestPermission(workerPermission())
  try {
    expect(h.controller.isTurnActive()).toBe(false)
    expect(h.power.read().assertion.desired).toBe(false)
    h.store.setState(state => ({ ...state, tasks: { ...state.tasks, a2: agentTask({ id: 'a2', agentId: 'agent-2' }) } }))
    expect(h.power.read().assertion.desired).toBe(true)
    h.store.setState(state => ({ ...state, tasks: { a1: state.tasks.a1! } }))
    expect(h.power.read().assertion.desired).toBe(false)
  } finally {
    h.controller.respondToPermissionRequest('worker-permission', { behavior: 'deny', message: 'test cleanup' })
    await response; h.dispose()
  }
})

test('a background permission does not suppress the runnable parent turn', async () => {
  let requested!: () => void
  const waiting = new Promise<void>(resolve => { requested = resolve })
  const h = powerDomain({ a1: agentTask() }, undefined, {
    async *runTurn({ onPermissionRequest }) {
      const response = onPermissionRequest(workerPermission())
      requested()
      await response
    },
  })
  const turn = h.controller.submit('parent work')
  try {
    await waiting
    expect(h.domain.getSnapshot().hasOperationalWork).toBe(true)
    expect(h.power.read().assertion.desired).toBe(true)
  } finally {
    h.controller.respondToPermissionRequest('worker-permission', { behavior: 'deny', message: 'test cleanup' })
    await turn; h.dispose()
  }
})
