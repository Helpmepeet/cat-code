/**
 * Tests for the delivery-acknowledgement queue (CC-40).
 *
 * These are the behavioural assertions that replace the source-text pins in
 * preloadSource.test.ts. Each test covers a property that was previously
 * unverifiable because preload.ts imports Electron.
 */

import { describe, expect, test } from 'bun:test'
import type { DeliveryAcknowledgement } from '../shared/deliveryTrace.js'
import { RendererIpcRejection } from './rendererIpcGuard.js'
import { DeliveryAckQueue, type DeliveryAckQueueDeps, type DeliveryAckQueueOptions } from './deliveryAckQueue.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal deps with controllable timer and guard. */
function makeDeps(overrides?: Partial<DeliveryAckQueueDeps>): DeliveryAckQueueDeps & {
  sent: Array<{ channel: string; payload: unknown }>
  timers: Array<{ fn: () => void; ms: number; id: number }>
  fireTimer: () => void
  fireAllTimers: () => void
  epoch: number
  guardCalls: Array<{ payload: unknown; kind: string }>
} {
  let timerId = 0
  const timers: Array<{ fn: () => void; ms: number; id: number }> = []
  const sent: Array<{ channel: string; payload: unknown }> = []
  const guardCalls: Array<{ payload: unknown; kind: string }> = []
  const state = { epoch: 0 }

  const result = {
    assertAllowed: overrides?.assertAllowed ?? ((payload: unknown, kind: 'diagnostics') => {
      guardCalls.push({ payload, kind })
    }),
    send: overrides?.send ?? ((channel: string, payload: unknown) => {
      sent.push({ channel, payload })
    }),
    documentId: overrides?.documentId ?? 'doc-1',
    processInstanceId: overrides?.processInstanceId ?? 'proc-1',
    processStartedAt: overrides?.processStartedAt ?? '2026-08-09T00:00:00Z',
    getSubscriptionEpoch: overrides?.getSubscriptionEpoch ?? (() => state.epoch),
    setTimeout: overrides?.setTimeout ?? ((fn: () => void, ms: number) => {
      const id = ++timerId
      timers.push({ fn, ms, id })
      return id as unknown as ReturnType<typeof globalThis.setTimeout>
    }),
    clearTimeout: overrides?.clearTimeout ?? ((handle: ReturnType<typeof globalThis.setTimeout>) => {
      const idx = timers.findIndex(t => t.id === (handle as unknown as number))
      if (idx >= 0) timers.splice(idx, 1)
    }),
    sent,
    timers,
    fireTimer: () => {
      const t = timers.shift()
      if (t) t.fn()
    },
    fireAllTimers: () => {
      while (timers.length > 0) {
        const t = timers.shift()!
        t.fn()
      }
    },
    epoch: state.epoch,
    guardCalls,
    get _epochState() { return state },
  }

  // Allow mutation of epoch through the state object
  Object.defineProperty(result, 'epoch', {
    get: () => state.epoch,
    set: (v: number) => { state.epoch = v },
  })

  return result as typeof result
}

const DEFAULT_OPTS: DeliveryAckQueueOptions = {
  channel: 'catcode:delivery-ack',
  maxBatchSize: 64,
  maxPending: 1024,
  flushIntervalMs: 50,
}

function pushN(queue: DeliveryAckQueue, n: number, sessionId = 'sess-1', startSeq = 1): void {
  for (let i = 0; i < n; i++) {
    queue.push(sessionId, startSeq + i, 1, 'epoch-1', `trace-${startSeq + i}`, 'preload.received')
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DeliveryAckQueue', () => {
  // -----------------------------------------------------------------------
  // 1. Rate rejection retains the batch and retries
  // -----------------------------------------------------------------------

  test('a rate rejection retains the batch and retries it', () => {
    let rejectNext = false
    const deps = makeDeps({
      assertAllowed: (payload, kind) => {
        if (rejectNext) throw new RendererIpcRejection('rate exceeded', 'rate')
      },
    })
    const queue = new DeliveryAckQueue(deps, DEFAULT_OPTS)

    // Push enough to trigger an immediate flush
    pushN(queue, 10)
    // First flush succeeds via the timer
    deps.fireTimer()
    expect(deps.sent.length).toBe(1)
    const firstBatchSize = (deps.sent[0].payload as { acknowledgements: unknown[] }).acknowledgements.length
    expect(firstBatchSize).toBe(10)

    // Push more, but this time the guard rejects
    rejectNext = true
    pushN(queue, 5, 'sess-1', 11)
    deps.fireTimer()
    // Nothing sent — batch retained
    expect(deps.sent.length).toBe(1)
    expect(queue.pendingCount).toBe(5)
    expect(queue.isRetrying).toBe(true)

    // A timer was re-armed for retry
    expect(deps.timers.length).toBe(1)

    // Now let the guard pass
    rejectNext = false
    deps.fireTimer()
    expect(deps.sent.length).toBe(2)
    expect(queue.pendingCount).toBe(0)
    expect(queue.isRetrying).toBe(false)
  })

  // -----------------------------------------------------------------------
  // 2. Size/serialization rejection drops the batch
  // -----------------------------------------------------------------------

  test('a size rejection drops the batch instead of retrying it forever', () => {
    let rejectNext = false
    const deps = makeDeps({
      assertAllowed: (_payload, _kind) => {
        if (rejectNext) throw new RendererIpcRejection('too big', 'size')
      },
    })
    const queue = new DeliveryAckQueue(deps, DEFAULT_OPTS)

    pushN(queue, 5)
    rejectNext = true
    deps.fireTimer()

    // Batch dropped, not retained
    expect(deps.sent.length).toBe(0)
    // The remaining items in pending (if any beyond the spliced batch) are gone
    // because the flush returns early — the 5 items were spliced out and then
    // the size error caused them to be dropped (not unshifted back)
    expect(queue.isRetrying).toBe(false)
  })

  test('a serialization rejection drops the batch instead of retrying it forever', () => {
    let rejectNext = false
    const deps = makeDeps({
      assertAllowed: (_payload, _kind) => {
        if (rejectNext) throw new RendererIpcRejection('bad payload', 'serialization')
      },
    })
    const queue = new DeliveryAckQueue(deps, DEFAULT_OPTS)

    pushN(queue, 5)
    rejectNext = true
    deps.fireTimer()

    expect(deps.sent.length).toBe(0)
    expect(queue.isRetrying).toBe(false)
  })

  // -----------------------------------------------------------------------
  // 3. At most one timer is armed at a time
  // -----------------------------------------------------------------------

  test('at most one timer is armed at a time', () => {
    const deps = makeDeps()
    const queue = new DeliveryAckQueue(deps, DEFAULT_OPTS)

    pushN(queue, 3)
    expect(deps.timers.length).toBe(1)

    // Push more — should NOT arm a second timer
    pushN(queue, 3, 'sess-1', 4)
    expect(deps.timers.length).toBe(1)

    // Push even more
    pushN(queue, 3, 'sess-1', 7)
    expect(deps.timers.length).toBe(1)
  })

  // -----------------------------------------------------------------------
  // 4. Retained queue is trimmed at its bound, dropping newest
  // -----------------------------------------------------------------------

  test('the retained queue is trimmed at its bound, dropping newest rather than oldest', () => {
    let callCount = 0
    const deps = makeDeps({
      assertAllowed: (_payload, _kind) => {
        callCount++
        // Always rate-reject to force retention
        throw new RendererIpcRejection('rate exceeded', 'rate')
      },
    })
    const opts = { ...DEFAULT_OPTS, maxPending: 10, maxBatchSize: 64 }
    const queue = new DeliveryAckQueue(deps, opts)

    // Push 20 items — they all land in pending since no flush has run yet
    pushN(queue, 20)

    // Fire timer — flush will try to send all 20, get rate-rejected, unshift
    // the batch back, and then trim to maxPending (10)
    deps.fireTimer()

    expect(queue.pendingCount).toBe(10)

    // The OLDEST (lowest sequence) should survive, newest dropped.
    // Fire the timer again with a passing guard to see what was retained.
    callCount = 0
    deps.sent.length = 0
    // Replace the assertAllowed to pass now
    ;(deps as unknown as { assertAllowed: (p: unknown, k: string) => void }).assertAllowed = () => {}
    deps.fireTimer()

    const batch = (deps.sent[0].payload as { acknowledgements: DeliveryAcknowledgement[] }).acknowledgements
    // Sequences 1..10 should survive (the oldest)
    expect(batch[0].sequence).toBe(1)
    expect(batch[batch.length - 1].sequence).toBe(10)
  })

  // -----------------------------------------------------------------------
  // 5. Retrying flag clears once the queue fully drains
  // -----------------------------------------------------------------------

  test('the retrying flag clears once the queue fully drains', () => {
    let shouldReject = true
    const deps = makeDeps({
      assertAllowed: (_payload, _kind) => {
        if (shouldReject) throw new RendererIpcRejection('rate exceeded', 'rate')
      },
    })
    const queue = new DeliveryAckQueue(deps, DEFAULT_OPTS)

    pushN(queue, 5)
    deps.fireTimer()
    expect(queue.isRetrying).toBe(true)

    // Let the guard pass
    shouldReject = false
    deps.fireTimer()
    expect(queue.isRetrying).toBe(false)
    expect(queue.pendingCount).toBe(0)
  })

  // -----------------------------------------------------------------------
  // 6. Acknowledgements keep their order across a failed attempt
  // -----------------------------------------------------------------------

  test('acknowledgements keep their order across a failed attempt', () => {
    let shouldReject = true
    const deps = makeDeps({
      assertAllowed: (_payload, _kind) => {
        if (shouldReject) throw new RendererIpcRejection('rate exceeded', 'rate')
      },
    })
    const queue = new DeliveryAckQueue(deps, { ...DEFAULT_OPTS, maxBatchSize: 3 })

    // Push 5 items: sequences 1, 2, 3, 4, 5
    pushN(queue, 5)

    // Flush — first batch (1,2,3) is rejected, unshifted back. Second batch
    // never runs because flush returns after the rejection.
    deps.fireTimer()
    expect(queue.isRetrying).toBe(true)

    // Now let it succeed
    shouldReject = false
    deps.fireTimer()

    // Should have sent two batches: [1,2,3] and [4,5]
    expect(deps.sent.length).toBe(2)
    const batch1 = (deps.sent[0].payload as { acknowledgements: DeliveryAcknowledgement[] }).acknowledgements
    const batch2 = (deps.sent[1].payload as { acknowledgements: DeliveryAcknowledgement[] }).acknowledgements

    expect(batch1.map(a => a.sequence)).toEqual([1, 2, 3])
    expect(batch2.map(a => a.sequence)).toEqual([4, 5])
  })

  // -----------------------------------------------------------------------
  // 7. Subscription epoch is stamped at push time, not flush time
  // -----------------------------------------------------------------------

  test('the subscription epoch is stamped when an acknowledgement is queued, not when it is sent', () => {
    const deps = makeDeps()
    const queue = new DeliveryAckQueue(deps, DEFAULT_OPTS)

    // Push with epoch 0
    queue.push('sess-1', 1, 1, 'epoch-1', 'trace-1', 'preload.received')

    // Change epoch before flush
    ;(deps as unknown as { _epochState: { epoch: number } })._epochState.epoch = 5

    // Push with epoch 5
    queue.push('sess-1', 2, 1, 'epoch-1', 'trace-2', 'preload.received')

    // Flush
    deps.fireTimer()

    const batch = (deps.sent[0].payload as { acknowledgements: DeliveryAcknowledgement[] }).acknowledgements
    // First ack should have epoch 0 (stamped at push time)
    expect(batch[0].subscriptionEpoch).toBe(0)
    // Second ack should have epoch 5 (stamped at push time, after change)
    expect(batch[1].subscriptionEpoch).toBe(5)
  })

  // -----------------------------------------------------------------------
  // Additional coverage
  // -----------------------------------------------------------------------

  test('watermarks are updated at push time, keyed by sessionId', () => {
    const deps = makeDeps()
    const queue = new DeliveryAckQueue(deps, DEFAULT_OPTS)

    queue.push('sess-1', 3, 1, 'e1', 't1', 'preload.received')
    queue.push('sess-1', 5, 1, 'e1', 't2', 'renderer.state.applied')
    queue.push('sess-2', 1, 1, 'e1', 't3', 'renderer.ui.committed')

    const wm = queue.getWatermarks()
    expect(wm.get('sess-1')).toEqual({ received: 3, applied: 5, committed: 0 })
    expect(wm.get('sess-2')).toEqual({ received: 0, applied: 0, committed: 1 })
  })

  test('watermarks take max of sequence numbers (not last-write)', () => {
    const deps = makeDeps()
    const queue = new DeliveryAckQueue(deps, DEFAULT_OPTS)

    queue.push('sess-1', 10, 1, 'e1', 't1', 'preload.received')
    queue.push('sess-1', 5, 1, 'e1', 't2', 'preload.received')

    const wm = queue.getWatermarks()
    expect(wm.get('sess-1')!.received).toBe(10)
  })

  test('immediate flush fires when batch size is reached and not retrying', () => {
    const deps = makeDeps()
    const queue = new DeliveryAckQueue(deps, { ...DEFAULT_OPTS, maxBatchSize: 3 })

    // Push exactly 3 items — should trigger an immediate flush (no timer)
    pushN(queue, 3)
    expect(deps.sent.length).toBe(1)
    const batch = (deps.sent[0].payload as { acknowledgements: DeliveryAcknowledgement[] }).acknowledgements
    expect(batch.length).toBe(3)
  })

  test('immediate flush is suppressed while retrying to avoid re-rejection', () => {
    let shouldReject = true
    const deps = makeDeps({
      assertAllowed: (_payload, _kind) => {
        if (shouldReject) throw new RendererIpcRejection('rate exceeded', 'rate')
      },
    })
    const queue = new DeliveryAckQueue(deps, { ...DEFAULT_OPTS, maxBatchSize: 3 })

    // Push 3 — immediate flush is rate-rejected, queue is now retrying
    pushN(queue, 3)
    expect(queue.isRetrying).toBe(true)

    // Push 3 more — should NOT trigger immediate flush (retrying), just schedule
    const timerCountBefore = deps.timers.length
    pushN(queue, 3, 'sess-1', 4)
    // Timer should already be armed from the rejection; no extra timer
    expect(deps.timers.length).toBeLessThanOrEqual(timerCountBefore)
    // And no new send was attempted
    expect(deps.sent.length).toBe(0)
  })

  test('the guard always runs before send (a rejected payload is never sent)', () => {
    const callOrder: string[] = []
    const deps = makeDeps({
      assertAllowed: () => { callOrder.push('guard') },
      send: () => { callOrder.push('send') },
    })
    const queue = new DeliveryAckQueue(deps, DEFAULT_OPTS)

    pushN(queue, 5)
    deps.fireTimer()

    // Guard must be called before send for every batch
    expect(callOrder[0]).toBe('guard')
    expect(callOrder[1]).toBe('send')
  })

  test('the guard is called with diagnostics budget class', () => {
    const guardCalls: Array<{ kind: string }> = []
    const deps = makeDeps({
      assertAllowed: (_payload: unknown, kind: 'diagnostics') => {
        guardCalls.push({ kind })
      },
    })
    const queue = new DeliveryAckQueue(deps, DEFAULT_OPTS)

    pushN(queue, 5)
    deps.fireTimer()

    expect(guardCalls.length).toBe(1)
    expect(guardCalls[0].kind).toBe('diagnostics')
  })

  test('flush clears the timer before processing', () => {
    const clearedIds: unknown[] = []
    let timerId = 0
    const deps = makeDeps({
      setTimeout: (fn: () => void, _ms: number) => {
        const id = ++timerId
        // Store the fn so we can call it manually
        ;(deps as unknown as { _lastFn: () => void })._lastFn = fn
        return id as unknown as ReturnType<typeof globalThis.setTimeout>
      },
      clearTimeout: (handle: ReturnType<typeof globalThis.setTimeout>) => {
        clearedIds.push(handle)
      },
    })
    const queue = new DeliveryAckQueue(deps, DEFAULT_OPTS)

    pushN(queue, 3)
    // A timer was armed (id=1)
    // Trigger the immediate flush by reaching batch size
    pushN(queue, 61, 'sess-1', 4)
    // The immediate flush should have cleared the pending timer
    expect(clearedIds.length).toBeGreaterThan(0)
  })

  test('fixed identity fields are stamped on every acknowledgement', () => {
    const deps = makeDeps({
      documentId: 'my-doc',
      processInstanceId: 'my-proc',
      processStartedAt: '2026-01-01T00:00:00Z',
    })
    const queue = new DeliveryAckQueue(deps, DEFAULT_OPTS)

    queue.push('sess-1', 1, 1, 'epoch-1', 'trace-1', 'preload.received')
    deps.fireTimer()

    const batch = (deps.sent[0].payload as { acknowledgements: DeliveryAcknowledgement[] }).acknowledgements
    expect(batch[0].documentId).toBe('my-doc')
    expect(batch[0].rendererProcessInstanceId).toBe('my-proc')
    expect(batch[0].rendererProcessStartedAt).toBe('2026-01-01T00:00:00Z')
  })
})
