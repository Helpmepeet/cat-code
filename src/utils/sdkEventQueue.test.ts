import { afterEach, beforeEach, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'

import { getIsInteractive, setIsInteractive } from '../bootstrap/state.js'
import type { AppState } from '../state/AppState.js'
import type { TaskState } from '../tasks/types.js'
import { finalizeHeadlessRun } from '../cli/headlessRunFinalization.js'
import {
  drainSdkEvents,
  emitTaskTerminatedSdk,
  enqueueSdkEvent,
  flushSdkEvents,
  type SdkEvent,
} from './sdkEventQueue.js'
import { registerTask } from './task/framework.js'
import { emitTaskProgress } from './task/sdkProgress.js'
import { Stream } from './stream.js'

let wasInteractive: boolean
beforeEach(() => {
  wasInteractive = getIsInteractive()
  setIsInteractive(false)
  drainSdkEvents()
})
afterEach(() => {
  drainSdkEvents()
  try {
    flushSdkEvents(new Stream())
  } catch {
    // Clear any capacity failure left by an interrupted assertion.
  }
  setIsInteractive(wasInteractive)
})

// Independent SDK client fold: task_started opens a card and its terminal
// notification closes it. Progress must never determine task liveness.
function consume(events: SdkEvent[], running: Set<string>): void {
  for (const event of events) {
    if (event.subtype === 'task_started') running.add(event.task_id)
    if (event.subtype === 'task_notification') running.delete(event.task_id)
  }
}

function start(taskId: string): void {
  let state = { tasks: {} } as AppState
  registerTask(
    {
      id: taskId,
      type: 'local_agent',
      status: 'running',
      description: 'SDK queue regression worker',
    } as TaskState,
    update => {
      state = update(state)
    },
  )
}

function progress(taskId: string, toolUses: number): void {
  emitTaskProgress({
    taskId,
    toolUseId: undefined,
    description: 'SDK queue regression progress',
    startTime: Date.now(),
    totalTokens: toolUses,
    toolUses,
  })
}

test.each([999, 1000, 2000])(
  'a delivered start closes exactly once after %i later progress events',
  laterProgressEvents => {
    const taskId = randomUUID()
    const runId = randomUUID()
    const running = new Set<string>()
    start(taskId)
    consume(drainSdkEvents(), running)
    expect(running.has(taskId)).toBe(true)

    emitTaskTerminatedSdk(taskId, 'completed', { runId, summary: 'done' })
    for (let index = 0; index < laterProgressEvents; index++) {
      progress('other-worker', index)
    }
    // A second producer may observe the same completion before delivery.
    emitTaskTerminatedSdk(taskId, 'completed', { runId, summary: 'duplicate' })
    const delivered = drainSdkEvents()
    expect(delivered.length).toBeLessThanOrEqual(1000)
    consume(delivered, running)
    expect(running.has(taskId)).toBe(false)
    expect(
      delivered.filter(event => event.subtype === 'task_notification'),
    ).toHaveLength(1)

    emitTaskTerminatedSdk(taskId, 'completed', { runId, summary: 'retry' })
    expect(drainSdkEvents()).toEqual([])
  },
)

test('a terminal arriving at a full progress backlog reaches the SDK client', () => {
  const taskId = randomUUID()
  const running = new Set<string>()
  start(taskId)
  consume(drainSdkEvents(), running)
  for (let index = 0; index < 1000; index++) progress('other-worker', index)
  emitTaskTerminatedSdk(taskId, 'failed', { runId: randomUUID() })
  const events = drainSdkEvents()
  expect(events.length).toBeLessThanOrEqual(1000)
  consume(events, running)
  expect(running.size).toBe(0)
})

test('lifecycle-only saturation transfers retained rows before rejection and permits retry', async () => {
  const taskId = randomUUID()
  const runId = randomUUID()
  const running = new Set<string>()
  start(taskId)
  consume(drainSdkEvents(), running)
  const retained = Array.from({ length: 1000 }, () => randomUUID())
  for (const id of retained) emitTaskTerminatedSdk(id, 'completed')
  // Producers must finish terminal cleanup even when SDK delivery is blocked.
  expect(() => emitTaskTerminatedSdk(taskId, 'completed', { runId })).not.toThrow()
  // Progress remains disposable even when it cannot displace any lifecycle row.
  progress('other-worker', 1)
  // StructuredIO uses this same Stream as its outbound FIFO. The SDK flush
  // must publish every retained row before the caller sees a capacity failure.
  const output = new Stream<SdkEvent>()
  expect(() => flushSdkEvents(output)).toThrow(
    'SDK lifecycle event queue capacity exceeded',
  )
  const delivered: SdkEvent[] = []
  for (let index = 0; index < 1000; index++) {
    const next = await output.next()
    if (next.done !== false) {
      throw new Error('SDK output ended before retained events')
    }
    delivered.push(next.value)
  }
  expect(delivered.map(event => 'task_id' in event && event.task_id)).toEqual(
    retained,
  )
  expect(running.has(taskId)).toBe(true)
  emitTaskTerminatedSdk(taskId, 'completed', { runId })
  expect(() => flushSdkEvents(output)).not.toThrow()
  const retry = await output.next()
  if (retry.done !== false) throw new Error('SDK output ended before retry')
  consume([retry.value], running)
  expect(running.size).toBe(0)
  expect(() => flushSdkEvents(output)).not.toThrow()
})

test('final idle overflow reaches the run error handler and releases its running guard', async () => {
  const output = new Stream<SdkEvent>()
  let running = true
  let shutdownRequested = false
  let reportedError: unknown
  await finalizeHeadlessRun({
    flushInternalEvents: async () => {
      // Real task teardown can enqueue bookends while the transport flush awaits.
      for (let index = 0; index < 1001; index++) {
        emitTaskTerminatedSdk(randomUUID(), 'completed')
      }
    },
    goIdle: () => flushSdkEvents(output),
    onError: async error => {
      // print.ts passes its shared error-result and graceful-shutdown handler.
      reportedError = error
      shutdownRequested = true
    },
    release: () => {
      running = false
    },
  })
  expect(reportedError).toBeInstanceOf(Error)
  if (!(reportedError instanceof Error)) throw new Error('Missing SDK error')
  expect(reportedError.message).toBe('SDK lifecycle event queue capacity exceeded')
  expect(shutdownRequested).toBe(true)
  expect(running).toBe(false)
  // The accepted terminal rows survive finalization's failure path.
  const notifications: SdkEvent[] = []
  for (let index = 0; index < 1000; index++) {
    const next = await output.next()
    if (next.done !== false) throw new Error('SDK output ended during finalization')
    notifications.push(next.value)
  }
  expect(notifications.filter(event => event.subtype === 'task_notification'))
    .toHaveLength(1000)
})

test('a failing transport flush and error handler still release the running guard', async () => {
  let running = true
  let wentIdle = false
  const transportError = new Error('transport flush failed')
  const reportError = new Error('error reporting failed')
  await expect(
    finalizeHeadlessRun({
      flushInternalEvents: async () => {
        throw transportError
      },
      goIdle: () => {
        wentIdle = true
      },
      onError: async error => {
        expect(error).toBe(transportError)
        throw reportError
      },
      release: () => {
        running = false
      },
    }),
  ).rejects.toBe(reportError)
  expect(wentIdle).toBe(false)
  expect(running).toBe(false)
})

test('different runs close independently and an accepted new start resets old claims', () => {
  const taskId = randomUUID()
  const oldRun = randomUUID()
  const newRun = randomUUID()
  emitTaskTerminatedSdk(taskId, 'completed', { runId: oldRun })
  emitTaskTerminatedSdk(taskId, 'completed', { runId: newRun })
  expect(drainSdkEvents()).toHaveLength(2)
  emitTaskTerminatedSdk(taskId, 'completed', { runId: oldRun })
  expect(drainSdkEvents()).toEqual([])
  start(taskId)
  emitTaskTerminatedSdk(taskId, 'completed', { runId: oldRun })
  expect(drainSdkEvents().map(event => event.subtype)).toEqual([
    'task_started',
    'task_notification',
  ])
})

test('a reused task ID closes again when its earlier terminal is still pending', () => {
  const taskId = randomUUID()
  const running = new Set<string>()
  emitTaskTerminatedSdk(taskId, 'completed')
  start(taskId)
  emitTaskTerminatedSdk(taskId, 'completed')
  const events = drainSdkEvents()
  expect(events.map(event => event.subtype)).toEqual([
    'task_notification',
    'task_started',
    'task_notification',
  ])
  consume(events, running)
  expect(running.size).toBe(0)
})

test('interactive sessions do not retain SDK events or consume terminal claims', () => {
  const taskId = randomUUID()
  setIsInteractive(true)
  enqueueSdkEvent({
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    status: 'completed',
    summary: '',
    output_file: '',
  })
  expect(drainSdkEvents()).toEqual([])
  setIsInteractive(false)
  emitTaskTerminatedSdk(taskId, 'completed')
  expect(drainSdkEvents()).toHaveLength(1)
})
