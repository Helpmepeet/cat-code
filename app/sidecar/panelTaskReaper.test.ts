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

/**
 * Finished but NOT yet `notified`, which is a real refusal in the engine's own
 * guard (`framework.ts:128`). The reaper must keep retrying rather than give up
 * or spin.
 */
function refusedWorker(id: string, evictAfter: number): TaskState {
  return {
    ...(finishedWorker(id, evictAfter) as unknown as Record<string, unknown>),
    notified: false,
  } as unknown as TaskState
}

/** Poll instead of sleeping a fixed span, so a slow machine doesn't go red. */
async function until(
  predicate: () => boolean,
  capMs: number,
): Promise<boolean> {
  const deadline = Date.now() + capMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await Bun.sleep(10)
  }
  return predicate()
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

test('the disposer stops the sweep — proven live first, so a no-op reaper cannot pass this', async () => {
  const store = createStore(getDefaultAppState())
  const stop = createSidecarPanelTaskReaper(store).start()

  // Phase 1: the reaper is demonstrably working.
  store.setState(prev => ({
    ...prev,
    tasks: { w1: finishedWorker('w1', Date.now() + 25) },
  }))
  expect(await until(() => store.getState().tasks.w1 === undefined, 1_000)).toBe(true)

  // Phase 2: after disposal the same deadline is ignored.
  stop()
  store.setState(prev => ({
    ...prev,
    tasks: { w2: finishedWorker('w2', Date.now() + 25) },
  }))
  await Bun.sleep(200)
  expect(store.getState().tasks.w2).toBeDefined()
})

test('a worker whose deadline already passed at start-up is swept immediately, not a retry interval later', async () => {
  const store = createStore(getDefaultAppState())
  store.setState(prev => ({
    ...prev,
    tasks: { w1: finishedWorker('w1', Date.now() - 1_000) },
  }))

  const stop = createSidecarPanelTaskReaper(store).start()
  // Well under RETRY_INTERVAL_MS: an already-due deadline has not earned a wait.
  expect(await until(() => store.getState().tasks.w1 === undefined, 500)).toBe(true)
  stop()
})

test('a refused eviction still gets swept under sustained store churn (no retry starvation)', async () => {
  const store = createStore(getDefaultAppState())
  // Past-due but NOT notified: the engine refuses, so the reaper must retry.
  store.setState(prev => ({
    ...prev,
    tasks: { w1: refusedWorker('w1', Date.now() - 1_000) },
  }))
  const stop = createSidecarPanelTaskReaper(store).start()

  // Churn faster than the retry interval, exactly as a live turn's progress
  // updates do. Re-arming the timer on every change used to postpone the sweep
  // forever, so the row never left the dock.
  const churn = setInterval(() => {
    store.setState(prev => ({ ...prev, statusLineRefreshKey: prev.statusLineRefreshKey + 1 }))
  }, 20)

  // The guard clears the way a delivered notification would.
  setTimeout(() => {
    store.setState(prev => {
      const task = prev.tasks.w1
      if (!task) return prev
      return { ...prev, tasks: { ...prev.tasks, w1: { ...task, notified: true } } }
    })
  }, 150)

  const evicted = await until(() => store.getState().tasks.w1 === undefined, 4_000)
  clearInterval(churn)
  stop()
  expect(evicted).toBe(true)
})
