import { describe, expect, test } from 'bun:test'
import type { ServerFrame } from '../shared/protocol.js'
import { AttachmentGate } from './attachmentGate.js'
import {
  createAttachedFrameDeliveryCoordinator,
  createLiveFrameDeliveryCoordinator,
  createRendererReadyTracker,
  createRendererLossTransition,
  isBatchableLiveFrame,
  serializedServerFrameUtf8Bytes,
} from './liveFrameBatcher.js'

type EventServerFrame = Extract<ServerFrame, { kind: 'event' }>

const base = (sessionId: string): EventServerFrame => ({
  kind: 'event', protocolVersion: 2, sessionId,
  event: { type: 'message', message: { type: 'stream_event', event: {
    type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: sessionId },
  } } } as never,
})
const thinking = (id: string): EventServerFrame => ({
  ...base(id),
  event: { type: 'message', message: { type: 'stream_event', event: {
    type: 'content_block_delta', index: 2, delta: { type: 'thinking_delta', thinking: id },
  } } } as never,
})
const barrier = (id: string): ServerFrame => ({ kind: 'pong', protocolVersion: 2, sessionId: id, nonce: id })

function harness(options: { delayMs?: number; maxFrames?: number; maxBytes?: number } = {}) {
  let time = 0
  let available = true
  let fail: unknown = null
  const deliveries: ServerFrame[][] = []
  const timers: Array<{ callback: () => void; cancelled: boolean; dueAt: number }> = []
  const coordinator = createLiveFrameDeliveryCoordinator({
    ...options,
    now: () => time,
    setTimer: (callback, delayMs) => {
      const timer = { callback, cancelled: false, dueAt: time + delayMs }
      timers.push(timer)
      return timer as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: value => { (value as unknown as { cancelled: boolean }).cancelled = true },
    isDestinationAvailable: () => available,
    sendNow: frames => deliveries.push(frames),
    onSendFailure: error => { fail = error },
  })
  return {
    coordinator, deliveries, timers,
    tick(ms: number) { time += ms },
    fire(index = timers.length - 1) {
      const timer = timers[index]
      if (timer && !timer.cancelled && time >= timer.dueAt) timer.callback()
    },
    forceFire(index = timers.length - 1) { timers[index]?.callback() },
    unavailable() { available = false },
    failure: () => fail,
  }
}

describe('live frame eligibility', () => {
  test('accepts only well-formed live text/thinking deltas', () => {
    expect(isBatchableLiveFrame(base('a'))).toBe(true)
    expect(isBatchableLiveFrame(thinking('b'))).toBe(true)
    expect(isBatchableLiveFrame({ ...base('a'), replay: true })).toBe(false)
    expect(isBatchableLiveFrame({ ...base('a'), recovered: true })).toBe(false)
    expect(isBatchableLiveFrame(barrier('a'))).toBe(false)
    const malformed = base('a') as any
    malformed.event.message.event.index = -1
    expect(isBatchableLiveFrame(malformed)).toBe(false)
    malformed.event.message.event.index = 0.5
    expect(isBatchableLiveFrame(malformed)).toBe(false)
    malformed.event.message.event.index = 0
    malformed.event.message.event.delta = { type: 'input_json_delta', partial_json: '{}' }
    expect(isBatchableLiveFrame(malformed)).toBe(false)
    malformed.event = null
    expect(isBatchableLiveFrame(malformed)).toBe(false)
  })

  test('accounts exact UTF-8 JSON bytes including multibyte content', () => {
    const frame = base('🐈')
    expect(serializedServerFrameUtf8Bytes(frame)).toBe(new TextEncoder().encode(JSON.stringify(frame)).byteLength)
  })
})

describe('live frame delivery coordinator', () => {
  test('uses the first-frame deadline without debounce and has no idle timer', () => {
    const h = harness({ delayMs: 8 })
    expect(h.timers).toHaveLength(0)
    h.coordinator.deliver([base('a')], 'ordinary-live')
    expect(h.timers[0]?.dueAt).toBe(8)
    h.tick(7)
    h.coordinator.deliver([base('b')], 'ordinary-live')
    expect(h.timers).toHaveLength(1)
    h.tick(1); h.fire()
    expect(h.deliveries).toEqual([[base('a'), base('b')]])
    expect(h.coordinator.stats().queuedFrames).toBe(0)
  })

  test('flushes an overdue queue before accepting a new frame', () => {
    const h = harness({ delayMs: 8 })
    h.coordinator.deliver([base('a')], 'ordinary-live')
    h.tick(9)
    h.coordinator.deliver([base('b')], 'ordinary-live')
    expect(h.deliveries).toEqual([[base('a')]])
    h.tick(8)
    h.fire()
    expect(h.deliveries).toEqual([[base('a')], [base('b')]])
    expect(h.coordinator.stats().flushes.overdue).toBe(1)
  })

  test('preserves interleaved FIFO and flushes before every barrier', () => {
    const h = harness()
    h.coordinator.deliver([base('a')], 'ordinary-live')
    h.coordinator.deliver([thinking('b')], 'ordinary-live')
    h.coordinator.deliver([barrier('a')], 'immediate')
    expect(h.deliveries).toEqual([[base('a'), thinking('b')], [barrier('a')]])
  })

  test('singleton immediate origin and multi-frame inputs remain barriers', () => {
    const h = harness()
    h.coordinator.deliver([base('live')], 'ordinary-live')
    h.coordinator.deliver([base('replay-like')])
    h.coordinator.deliver([base('x'), base('y')], 'ordinary-live')
    expect(h.deliveries).toEqual([[base('live')], [base('replay-like')], [base('x'), base('y')]])
  })

  test('flushes at count and exact JSON-array byte boundaries', () => {
    const first = base('a'), second = base('b')
    const exact = 2 + serializedServerFrameUtf8Bytes(first) + 1 + serializedServerFrameUtf8Bytes(second)
    const count = harness({ maxFrames: 2 })
    count.coordinator.deliver([first], 'ordinary-live')
    count.coordinator.deliver([second], 'ordinary-live')
    count.coordinator.deliver([base('c')], 'ordinary-live')
    expect(count.deliveries).toEqual([[first, second]])
    const bytes = harness({ maxBytes: exact })
    bytes.coordinator.deliver([first], 'ordinary-live')
    bytes.coordinator.deliver([second], 'ordinary-live')
    expect(bytes.deliveries).toEqual([])
    bytes.coordinator.deliver([base('cc')], 'ordinary-live')
    expect(bytes.deliveries).toEqual([[first, second]])
  })

  test('sends an oversized valid frame immediately without rejection', () => {
    const frame = base('oversized')
    const h = harness({ maxBytes: serializedServerFrameUtf8Bytes(frame) + 1 })
    h.coordinator.deliver([frame], 'ordinary-live')
    expect(h.deliveries).toEqual([[frame]])
    expect(h.coordinator.stats().queuedFrames).toBe(0)
  })

  test('document invalidation cancels pending copies and stale callbacks', () => {
    const h = harness()
    h.coordinator.deliver([base('old')], 'ordinary-live')
    h.coordinator.invalidateDocument()
    h.coordinator.deliver([base('new')], 'ordinary-live')
    h.forceFire(0)
    expect(h.deliveries).toEqual([])
    h.tick(8)
    h.fire(1)
    expect(h.deliveries).toEqual([[base('new')]])
  })

  test('a cancelled deadline cannot flush a later same-document queue', () => {
    const h = harness()
    h.coordinator.deliver([base('old')], 'ordinary-live')
    h.coordinator.flush()
    h.coordinator.deliver([base('new')], 'ordinary-live')
    h.forceFire(0)
    expect(h.deliveries).toEqual([[base('old')]])
    h.tick(8)
    h.fire(1)
    expect(h.deliveries).toEqual([[base('old')], [base('new')]])
  })

  test('destination loss abandons the batch and reports recovery once', () => {
    const h = harness()
    h.coordinator.deliver([base('a')], 'ordinary-live')
    h.unavailable(); h.tick(8); h.fire()
    expect(h.deliveries).toEqual([])
    expect(h.failure()).toBeInstanceOf(Error)
    expect(h.coordinator.stats().queuedFrames).toBe(0)
  })

  test('a send exception is contained and abandons pending delivery copies', () => {
    let failure: unknown = null
    const coordinator = createLiveFrameDeliveryCoordinator({
      isDestinationAvailable: () => true,
      sendNow: () => { throw new Error('disposed frame') },
      onSendFailure: error => { failure = error },
    })
    coordinator.deliver([base('a')], 'ordinary-live')
    coordinator.flush()
    expect(failure).toBeInstanceOf(Error)
    expect(coordinator.stats().queuedFrames).toBe(0)
    expect(coordinator.stats().sendCount).toBe(0)
  })

  test('detaches before send, tolerates reentrancy, and disposal is idempotent', () => {
    const deliveries: ServerFrame[][] = []
    let coordinator: ReturnType<typeof createLiveFrameDeliveryCoordinator>
    coordinator = createLiveFrameDeliveryCoordinator({
      delayMs: 8, isDestinationAvailable: () => true, onSendFailure: () => {},
      sendNow: frames => { deliveries.push(frames); coordinator.deliver([base('reentrant')], 'ordinary-live') },
    })
    coordinator.deliver([base('a')], 'ordinary-live')
    coordinator.flush()
    expect(deliveries).toEqual([[base('a')]])
    expect(coordinator.stats().queuedFrames).toBe(1)
    coordinator.dispose(); coordinator.dispose(); coordinator.flush()
    expect(deliveries).toHaveLength(1)
  })

  test('does not continue the outer delivery after reentrant invalidation', () => {
    const deliveries: ServerFrame[][] = []
    let coordinator: ReturnType<typeof createLiveFrameDeliveryCoordinator>
    coordinator = createLiveFrameDeliveryCoordinator({
      isDestinationAvailable: () => true, onSendFailure: () => {},
      sendNow: frames => { deliveries.push(frames); coordinator.invalidateDocument() },
    })
    coordinator.deliver([base('queued')], 'ordinary-live')
    coordinator.deliver([barrier('barrier')])
    expect(deliveries).toEqual([[base('queued')]])
  })

  test('serializes a nested delivery behind the outer frame and keeps caps', () => {
    const deliveries: ServerFrame[][] = []
    let nested = false
    let coordinator: ReturnType<typeof createLiveFrameDeliveryCoordinator>
    coordinator = createLiveFrameDeliveryCoordinator({
      maxFrames: 1,
      isDestinationAvailable: () => true,
      onSendFailure: () => {},
      sendNow: frames => {
        deliveries.push(frames)
        if (!nested) {
          nested = true
          coordinator.deliver([base('c')], 'ordinary-live')
        }
      },
    })
    coordinator.deliver([base('a')], 'ordinary-live')
    coordinator.deliver([base('b')], 'ordinary-live')
    coordinator.flush()
    expect(deliveries).toEqual([[base('a')], [base('b')], [base('c')]])
    expect(coordinator.stats().maxQueuedFrames).toBe(1)
  })

  test('zero-delay policy preserves immediate delivery', () => {
    const h = harness({ delayMs: 0 })
    h.coordinator.deliver([base('a')], 'ordinary-live')
    h.coordinator.deliver([base('b')], 'ordinary-live')
    expect(h.deliveries).toEqual([[base('a')], [base('b')]])
    expect(h.timers).toHaveLength(0)
  })
})

describe('renderer loss transition', () => {
  test('one failed document consumes one bounded recovery decision', () => {
    let unavailable = 0, decisions = 0, reloads = 0
    const transition = createRendererLossTransition<string>({
      isDisposed: () => false,
      onUnavailable: () => { unavailable++ },
      decide: () => { decisions++; return { action: 'reload', attempt: decisions } },
      onReload: (_reason, attempt) => { reloads += attempt },
      onGiveUp: () => {},
      timeoutReason: 'load-failed',
    })
    expect(transition.lose('send-failed')).toBe(true)
    expect(transition.lose('later-process-gone')).toBe(false)
    expect({ unavailable, decisions, reloads }).toEqual({ unavailable: 1, decisions: 1, reloads: 1 })
    transition.documentReady()
    expect(transition.lose('new-document-gone')).toBe(true)
    expect({ unavailable, decisions, reloads }).toEqual({ unavailable: 2, decisions: 2, reloads: 3 })
  })

  test('does not revive a disposed window and reaches the visible give-up path', () => {
    let disposed = true, giveUps = 0
    const transition = createRendererLossTransition<string>({
      isDisposed: () => disposed,
      onUnavailable: () => {},
      decide: () => ({ action: 'give-up' }),
      onReload: () => {},
      onGiveUp: () => { giveUps++ },
      timeoutReason: 'load-failed',
    })
    expect(transition.lose('closed')).toBe(false)
    disposed = false
    expect(transition.lose('exhausted')).toBe(true)
    expect(giveUps).toBe(1)
  })

  test('a replacement that dies before readiness advances through the watchdog', () => {
    let decisions = 0
    const timers: Array<() => void> = []
    const transition = createRendererLossTransition<string>({
      isDisposed: () => false,
      onUnavailable: () => {},
      decide: () => ({ action: 'reload', attempt: ++decisions }),
      onReload: () => {}, onGiveUp: () => {}, timeoutReason: 'load-failed',
      setTimer: callback => { timers.push(callback); return callback as unknown as ReturnType<typeof setTimeout> },
      clearTimer: () => {},
    })
    transition.lose('send-failed')
    expect(transition.lose('old-process-gone-after-navigation')).toBe(false)
    timers[0]?.()
    expect(decisions).toBe(2)
  })

  test('new readiness re-arms recovery before replay; StrictMode readiness does not', () => {
    let decisions = 0
    const transition = createRendererLossTransition<string>({
      isDisposed: () => false, onUnavailable: () => {},
      decide: () => ({ action: 'reload', attempt: ++decisions }),
      onReload: () => {}, onGiveUp: () => {}, timeoutReason: 'load-failed',
    })
    transition.lose('old-send-failed')
    const ready = createRendererReadyTracker(() => transition.documentReady())
    let coordinator: ReturnType<typeof createLiveFrameDeliveryCoordinator>
    coordinator = createLiveFrameDeliveryCoordinator({
      delayMs: 0, isDestinationAvailable: () => true,
      sendNow: () => { throw new Error('replay send failed') },
      onSendFailure: () => { transition.lose('new-replay-failed') },
    })
    expect(ready.ready('replacement')).toBe(true)
    coordinator.deliver([barrier('replay')])
    expect(decisions).toBe(2)
    expect(ready.ready('replacement')).toBe(false)
    coordinator.deliver([barrier('strict-repeat')])
    expect(decisions).toBe(2)
  })
})

describe('attachment and live-delivery composition', () => {
  test('flushes the FIFO prefix before session eviction and clears replay', () => {
    const gate = new AttachmentGate()
    gate.onRendererReady()
    const h = harness()
    const attached = createAttachedFrameDeliveryCoordinator(gate, h.coordinator)
    attached.onFrame('a', base('a'))
    attached.onFrame('b', base('b'))
    let deliveriesSeenAtEviction = 0
    attached.evictSession('a', () => { deliveriesSeenAtEviction = h.deliveries.length })
    expect(h.deliveries).toEqual([[base('a'), base('b')]])
    expect(deliveriesSeenAtEviction).toBe(1)
    attached.onNavigationStart()
    expect(gate.onRendererReady().map(frame => frame.sessionId)).toEqual(['b'])
  })

  test('send loss during eviction re-arms attachment before host publication', () => {
    const gate = new AttachmentGate()
    gate.onRendererReady()
    let available = true
    let attached: ReturnType<typeof createAttachedFrameDeliveryCoordinator>
    const delivery = createLiveFrameDeliveryCoordinator({
      isDestinationAvailable: () => available,
      sendNow: () => {},
      onSendFailure: () => attached.onNavigationStart(),
    })
    attached = createAttachedFrameDeliveryCoordinator(gate, delivery)
    attached.onFrame('a', base('a'))
    available = false
    let detachedAtPublication = false
    attached.evictSession('a', () => { detachedAtPublication = !gate.isAttached })
    expect(detachedAtPublication).toBe(true)
    expect(gate.onRendererReady()).toEqual([])
  })

  test('window close disposes delivery but preserves replay until shutdown persistence', () => {
    const gate = new AttachmentGate()
    gate.onRendererReady()
    const h = harness()
    const attached = createAttachedFrameDeliveryCoordinator(gate, h.coordinator)
    attached.onFrame('a', base('a'))

    // BrowserWindow `closed`: timers and pending delivery copies are discarded,
    // while the replay buffer must survive for Host.shutdownAll.
    h.coordinator.dispose()
    let persisted: ServerFrame[] = []
    // `window-all-closed`: shutdown invokes evictReplay before the final reset.
    attached.evictSession('a', () => { persisted = gate.snapshotSession('a') })
    attached.reset()

    expect(persisted).toEqual([base('a')])
    expect(gate.onRendererReady()).toEqual([])
    expect(h.deliveries).toEqual([])
  })

  test('a new ready identity invalidates old delivery copies before replay', () => {
    const gate = new AttachmentGate()
    const h = harness()
    const attached = createAttachedFrameDeliveryCoordinator(gate, h.coordinator)
    const ready = createRendererReadyTracker(() => attached.onNavigationStart())

    ready.ready('first-document')
    gate.onRendererReady()
    attached.onFrame('a', base('old-document'))
    expect(h.coordinator.stats().queuedFrames).toBe(1)

    expect(ready.ready('replacement-document')).toBe(true)
    expect(h.coordinator.stats().queuedFrames).toBe(0)
    expect(gate.onRendererReady()).toEqual([base('old-document')])

    attached.onFrame('a', base('same-document'))
    expect(ready.ready('replacement-document')).toBe(false)
    expect(h.coordinator.stats().queuedFrames).toBe(1)
  })
})
