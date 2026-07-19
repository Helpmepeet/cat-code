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
    },
  })

  const result = await domain.stop('whatever')
  expect(result.ok).toBe(false)
  expect(result.message).toContain('boom')
})
