import { expect, test } from 'bun:test'
import { reapOwnedProcessGroup, type ProcessGroupOps } from './streaming-benchmark-cleanup.js'

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
