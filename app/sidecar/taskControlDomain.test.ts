/**
 * P4-8b task-control write-seam — the LIVE path (the real engine `stopTask` over a
 * real app-state store), plus the fail-closed cases. The SERVER boundary (schema +
 * allowlist + result frame) is exercised separately in `sidecarServer.test.ts` with
 * a fake executor; here we prove the engine wiring is real: a `stop` actually flips
 * the task to `killed` in the store and fires the store subscription that the
 * tasks/agent-mode snapshots re-broadcast off (the 2026-07-09 live-path gate — not a
 * shape-only assertion).
 */
import { expect, test } from 'bun:test'
import { getDefaultAppState } from '../../src/state/AppStateStore.js'
import { createStore } from '../../src/state/store.js'
import { createTaskStateBase } from '../../src/Task.js'
import type { TaskState } from '../../src/tasks/types.js'
import { evictTerminalTask } from '../../src/utils/task/framework.js'
import { createSidecarTaskControlDomain } from './taskControlDomain.js'

function runningWorker(id: string): TaskState {
  return {
    ...createTaskStateBase(id, 'local_agent', 'Wire the auth flow'),
    type: 'local_agent',
    status: 'running',
    agentId: `agent-${id}`,
    agentType: 'implementor',
    agentName: 'Turing',
    abortController: new AbortController(),
  } as unknown as TaskState
}

test('P4-8b — stop() runs the REAL stopTask: the running worker flips to killed AND the store subscription fires (live re-broadcast trigger)', async () => {
  const store = createStore(getDefaultAppState())
  store.setState(prev => ({ ...prev, tasks: { t1: runningWorker('t1') } }))
  let notifications = 0
  store.subscribe(() => {
    notifications += 1
  })

  const domain = createSidecarTaskControlDomain(store)
  const result = await domain.stop('t1')

  expect(result.ok).toBe(true)
  // The real engine kill mutated the SAME store the tasks/agent-mode read-seams read.
  expect(store.getState().tasks.t1?.status).toBe('killed')
  // The store mutation fired at least once → the tasks/agent-mode snapshot
  // subscriptions re-broadcast (the live path, not a synthetic frame).
  expect(notifications).toBeGreaterThan(0)
})

test('P4-8b — stop() on an UNKNOWN taskId fails closed (ok:false) with no store mutation', async () => {
  const store = createStore(getDefaultAppState())
  store.setState(prev => ({ ...prev, tasks: { t1: runningWorker('t1') } }))
  let notifications = 0
  store.subscribe(() => {
    notifications += 1
  })

  const domain = createSidecarTaskControlDomain(store)
  const result = await domain.stop('does-not-exist')

  expect(result.ok).toBe(false)
  // Fail-closed: the live worker is untouched, no store change fired.
  expect(store.getState().tasks.t1?.status).toBe('running')
  expect(notifications).toBe(0)
})

test('P4-8b — stop() on an already-terminal task fails closed (ok:false), no side effect', async () => {
  const store = createStore(getDefaultAppState())
  const done = { ...runningWorker('t2'), status: 'completed' } as unknown as TaskState
  store.setState(prev => ({ ...prev, tasks: { t2: done } }))

  const domain = createSidecarTaskControlDomain(store)
  const result = await domain.stop('t2')

  expect(result.ok).toBe(false)
  expect(store.getState().tasks.t2?.status).toBe('completed')
})

test('P4-8b — stop() is throw-free even when the executor throws a non-StopTaskError', async () => {
  const store = createStore(getDefaultAppState())
  const domain = createSidecarTaskControlDomain(store, {
    executor: {
      async stop() {
        throw new Error('boom')
      },
      async dismiss() {
        throw new Error('boom')
      },
    },
  })

  const result = await domain.stop('whatever')
  expect(result.ok).toBe(false)
  expect(result.message).toContain('boom')
})

/* ------------------------------------------------------------------------- *
 * CC-32 follow-up — dismiss() over the REAL engine composition
 * ------------------------------------------------------------------------- *
 * The shape that motivated the verb: a worker whose report carried a
 * `status: blocked` handoff line, so `completeAgentTask` stamped
 * `handoffStatus:'blocked'` and NO `evictAfter`
 * (`src/tasks/LocalAgentTask/LocalAgentTask.tsx:540,548`). The shared eviction
 * guard `(evictAfter ?? Infinity) > Date.now()` refuses it forever and the panel
 * reaper skips undefined deadlines, so nothing but this verb retires the row.
 */
function blockedWorker(id: string): TaskState {
  return {
    ...createTaskStateBase(id, 'local_agent', 'Audit the docs'),
    type: 'local_agent',
    status: 'completed',
    agentId: id,
    agentType: 'general-purpose',
    agentName: 'Gauss',
    isBackgrounded: true,
    notified: true,
    handoffStatus: 'blocked',
    // `retain` is what ARMS the `(evictAfter ?? Infinity) > Date.now()` guard —
    // it is keyed on `'retain' in task`, and the real task always carries it
    // (`LocalAgentTask.tsx:633`). Omitting it here would skip the guard entirely
    // and make the fixture evict, proving nothing.
    retain: false,
    // The defining property: the engine stamped no deadline at all.
    evictAfter: undefined,
  } as unknown as TaskState
}

test('CC-32 — dismiss() retires a BLOCKED worker the engine would never evict, via the real stopOrDismissAgent + evictTerminalTask', async () => {
  const store = createStore(getDefaultAppState())
  store.setState(prev => ({ ...prev, tasks: { g1: blockedWorker('g1') } }))
  let notifications = 0
  store.subscribe(() => {
    notifications += 1
  })

  // Precondition, not an assumption: the engine's own evictor refuses this row.
  evictTerminalTask('g1', store.setState)
  expect(store.getState().tasks.g1).toBeDefined()

  const domain = createSidecarTaskControlDomain(store)
  const result = await domain.dismiss('g1')

  expect(result.ok).toBe(true)
  // The row is GONE from the same store the tasks/agent-mode read-seams read.
  expect(store.getState().tasks.g1).toBeUndefined()
  // The store mutation fired → the snapshot subscriptions re-broadcast (live path).
  expect(notifications).toBeGreaterThan(0)
})

test('CC-32 — dismiss() on a worker whose notification is still pending MARKS it (evictAfter 0) so the reaper can finish, without evicting early', async () => {
  const store = createStore(getDefaultAppState())
  const unnotified = {
    ...blockedWorker('g2'),
    notified: false,
  } as unknown as TaskState
  store.setState(prev => ({ ...prev, tasks: { g2: unnotified } }))

  const domain = createSidecarTaskControlDomain(store)
  const result = await domain.dismiss('g2')

  expect(result.ok).toBe(true)
  // The engine's `notified` guard still holds the row — we did NOT bypass it.
  const task = store.getState().tasks.g2
  expect(task).toBeDefined()
  // But it now carries the dismissal mark, which is what lets the panel reaper's
  // next sweep evict it. Without this, a blocked row has no deadline to sweep on.
  expect((task as { evictAfter?: number } | undefined)?.evictAfter).toBe(0)
})

test('CC-32 — dismiss() on a RUNNING worker fails closed (that is task.stop territory), no store mutation', async () => {
  const store = createStore(getDefaultAppState())
  store.setState(prev => ({ ...prev, tasks: { t1: runningWorker('t1') } }))
  let notifications = 0
  store.subscribe(() => {
    notifications += 1
  })

  const domain = createSidecarTaskControlDomain(store)
  const result = await domain.dismiss('t1')

  expect(result.ok).toBe(false)
  expect(result.refusal).toBe('still_running')
  expect(result.message).toContain('still running')
  expect(store.getState().tasks.t1?.status).toBe('running')
  expect(notifications).toBe(0)
})

test('CC-32 — dismiss() on an UNKNOWN taskId fails closed, no store mutation', async () => {
  const store = createStore(getDefaultAppState())
  store.setState(prev => ({ ...prev, tasks: { g1: blockedWorker('g1') } }))
  let notifications = 0
  store.subscribe(() => {
    notifications += 1
  })

  const domain = createSidecarTaskControlDomain(store)
  const result = await domain.dismiss('does-not-exist')

  expect(result.ok).toBe(false)
  // The refusal CODE survives the domain boundary, because `not_found` means
  // something different to the server than `still_running` does: no live task
  // holds the row, so the persisted plane is the only thing left rendering it.
  expect(result.refusal).toBe('not_found')
  expect(store.getState().tasks.g1).toBeDefined()
  expect(notifications).toBe(0)
})

test('CC-32 — dismiss() refuses a non-worker task (the verb is a panel-worker escape hatch, not a task GC)', async () => {
  const store = createStore(getDefaultAppState())
  const shell = {
    ...createTaskStateBase('b1', 'local_bash', 'npm run build'),
    type: 'local_bash',
    status: 'completed',
    notified: true,
  } as unknown as TaskState
  store.setState(prev => ({ ...prev, tasks: { b1: shell } }))

  const domain = createSidecarTaskControlDomain(store)
  const result = await domain.dismiss('b1')

  expect(result.ok).toBe(false)
  expect(store.getState().tasks.b1).toBeDefined()
})

test('CC-32 — dismiss() is throw-free when the executor throws', async () => {
  const store = createStore(getDefaultAppState())
  const domain = createSidecarTaskControlDomain(store, {
    executor: {
      async stop() {
        throw new Error('unused')
      },
      async dismiss() {
        throw new Error('boom')
      },
    },
  })

  const result = await domain.dismiss('whatever')
  expect(result.ok).toBe(false)
  expect(result.message).toContain('boom')
})
