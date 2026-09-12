import { expect, test } from 'bun:test'
import { cleanupInterruptedRun, OwnedProcessGroupLifecycle, reapOwnedProcessGroup, type ProcessGroupOps } from './streaming-benchmark-cleanup.js'

function harness(states: boolean[]) {
  const signals: Array<{ id: number; signal: NodeJS.Signals }> = []
  const ops: ProcessGroupOps = {
    alive: () => states.shift() ?? false,
    signal: (id, signal) => { signals.push({ id, signal }) },
    sleep: async () => {},
  }
  return { ops, signals }
}

test('already-exited owned group needs no signal', async () => {
  const h = harness([false])
  await reapOwnedProcessGroup(41, { initialWaitMs: 0, ops: h.ops })
  expect(h.signals).toEqual([])
})

test('signals only the exact owned group and stops after SIGTERM succeeds', async () => {
  const h = harness([true, true, false])
  await reapOwnedProcessGroup(42, { initialWaitMs: 0, termWaitMs: 1, pollMs: 1, ops: h.ops })
  expect(h.signals).toEqual([{ id: 42, signal: 'SIGTERM' }])
})

test('escalates a surviving owned group to SIGKILL', async () => {
  const h = harness([true, true, true, true, false])
  await reapOwnedProcessGroup(43, { initialWaitMs: 0, termWaitMs: 1, killWaitMs: 1, pollMs: 1, ops: h.ops })
  expect(h.signals).toEqual([{ id: 43, signal: 'SIGTERM' }, { id: 43, signal: 'SIGKILL' }])
})

test('interruption awaits owned-group cleanup before scratch deletion and exit', async () => {
  const order: string[] = []
  await cleanupInterruptedRun({
    processGroupId: 44,
    reap: async id => { order.push(`reap:${id}`) },
    removeScratch: () => { order.push('scratch') },
    exit: code => { order.push(`exit:${code}`) },
    exitCode: 130,
  })
  expect(order).toEqual(['reap:44', 'scratch', 'exit:130'])
})

test('interrupt and successful completion share cleanup and forbid the next spawn', async () => {
  let finish!: () => void
  let reapCalls = 0
  const lifecycle = new OwnedProcessGroupLifecycle(async () => {
    reapCalls++
    await new Promise<void>(resolve => { finish = resolve })
  })
  lifecycle.begin(55)
  const interrupted = lifecycle.interrupt()
  const completed = lifecycle.reapActive()
  expect(completed).toBe(interrupted)
  expect(reapCalls).toBe(1)
  expect(lifecycle.canStartSample).toBe(false)
  expect(() => lifecycle.begin(56)).toThrow('refusing to start another sample')
  finish()
  await Promise.all([interrupted, completed])
  expect(lifecycle.activeProcessGroupId).toBeNull()
  expect(lifecycle.canStartSample).toBe(false)
})

test('failed reap retains ownership and returns the same rejected cleanup', async () => {
  const failure = new Error('still alive')
  const lifecycle = new OwnedProcessGroupLifecycle(async () => { throw failure })
  lifecycle.begin(66)
  const first = lifecycle.reapActive(0)
  const second = lifecycle.reapActive(0)
  expect(second).toBe(first)
  await expect(first).rejects.toBe(failure)
  expect(lifecycle.activeProcessGroupId).toBe(66)
  expect(lifecycle.canStartSample).toBe(false)
})
