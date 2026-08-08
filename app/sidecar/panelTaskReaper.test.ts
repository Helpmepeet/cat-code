/**
 * Panel-task reaper — the LIVE path over the real engine `evictTerminalTask` and a
 * real app-state store. The bug this pins: a backgrounded worker that finished
 * stayed in `AppState.tasks` for the rest of the session, so the docked roster kept
 * rendering its row above the composer. The engine stamps the deadline; the
 * terminal REPL's panel tick honours it; the desktop had no owner for it.
 *
 * These are deliberately end-state assertions over `agentModeSnapshot` as well as
 * the store, because the roster is what the operator sees: an evicted task must
 * leave the worker list the roster renders from, not merely the map.
 */
import { expect, test } from 'bun:test'
import { getDefaultAppState } from '../../src/state/AppStateStore.js'
import { createStore } from '../../src/state/store.js'
import { createTaskStateBase } from '../../src/Task.js'
import type { TaskState } from '../../src/tasks/types.js'
import { agentModeSnapshot } from './agentModeDomain.js'
import { createSidecarPanelTaskReaper } from './panelTaskReaper.js'

/** A backgrounded worker that has finished — the shape the engine leaves behind. */
function finishedWorker(id: string, evictAfter: number | undefined): TaskState {
  return {
    ...createTaskStateBase(id, 'local_agent', 'Audit docs and archive refs'),
    type: 'local_agent',
    status: 'completed',
    // `enqueueAgentNotification` sets this on the background completion path;
    // `evictTerminalTask` refuses to evict an unnotified task.
    notified: true,
    agentId: `agent-${id}`,
    agentType: 'general-purpose',
    agentName: 'Wilkes',
    isBackgrounded: true,
    retain: false,
    endTime: Date.now(),
    ...(evictAfter !== undefined ? { evictAfter } : {}),
  } as unknown as TaskState
}

function runningWorker(id: string): TaskState {
  return {
    ...createTaskStateBase(id, 'local_agent', 'Audit docs and archive refs'),
    type: 'local_agent',
    status: 'running',
    agentId: `agent-${id}`,
    agentType: 'general-purpose',
    agentName: 'Wilkes',
    isBackgrounded: true,
    retain: false,
  } as unknown as TaskState
}

test('a finished worker leaves the store AND the roster snapshot once its evictAfter deadline passes', async () => {
  const store = createStore(getDefaultAppState())
  const stop = createSidecarPanelTaskReaper(store).start()

  store.setState(prev => ({
    ...prev,
    tasks: { w1: finishedWorker('w1', Date.now() + 25) },
  }))
  // Before the deadline the row is still the operator's to see (the engine's own
  // grace period, `PANEL_GRACE_MS`) — the reaper must not evict early.
  expect(agentModeSnapshot(store.getState().tasks, null, true).workers).toHaveLength(1)

  await Bun.sleep(150)

  expect(store.getState().tasks.w1).toBeUndefined()
  expect(agentModeSnapshot(store.getState().tasks, null, true).workers).toHaveLength(0)
  stop()
})

test('a still-running worker (no deadline stamped) is never evicted', async () => {
  const store = createStore(getDefaultAppState())
  const stop = createSidecarPanelTaskReaper(store).start()

  store.setState(prev => ({ ...prev, tasks: { w1: runningWorker('w1') } }))
  await Bun.sleep(150)

  expect(store.getState().tasks.w1?.status).toBe('running')
  expect(agentModeSnapshot(store.getState().tasks, null, true).workers).toHaveLength(1)
  stop()
})

test('the disposer stops the sweep — a deadline that passes afterwards is not acted on', async () => {
  const store = createStore(getDefaultAppState())
  const stop = createSidecarPanelTaskReaper(store).start()

  store.setState(prev => ({
    ...prev,
    tasks: { w1: finishedWorker('w1', Date.now() + 50) },
  }))
  stop()
  await Bun.sleep(150)

  expect(store.getState().tasks.w1).toBeDefined()
})

test('a worker whose deadline already passed at start-up is swept without waiting for a store change', async () => {
  const store = createStore(getDefaultAppState())
  store.setState(prev => ({
    ...prev,
    tasks: { w1: finishedWorker('w1', Date.now() - 1_000) },
  }))

  const stop = createSidecarPanelTaskReaper(store).start()
  // Past-due tasks are retried on the panel's own 1s cadence, matching
  // `CoordinatorTaskPanel`'s tick rather than spinning.
  await Bun.sleep(1_200)

  expect(store.getState().tasks.w1).toBeUndefined()
  stop()
})
