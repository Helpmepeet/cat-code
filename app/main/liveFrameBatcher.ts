import type { ServerFrame } from '../shared/protocol.js'

export const LIVE_FRAME_BATCH_DELAY_MS = 8
export const LIVE_FRAME_BATCH_MAX_FRAMES = 32
export const LIVE_FRAME_BATCH_MAX_BYTES = 256 * 1024

export type LiveFrameDeliveryOrigin = 'ordinary-live' | 'immediate'
export type LiveFrameFlushReason =
  | 'deadline'
  | 'overdue'
  | 'count'
  | 'bytes'
  | 'barrier'
  | 'manual'

export type LiveFrameBatcherStats = Readonly<{
  acceptedFrames: number
  queuedFrames: number
  queuedBytes: number
  sendCount: number
  sentFrames: number
  flushCount: number
  maxQueuedFrames: number
  maxQueuedBytes: number
  totalWaitMs: number
  maxWaitMs: number
  flushes: Readonly<Record<LiveFrameFlushReason, number>>
}>

type TimerHandle = ReturnType<typeof setTimeout>

export type LiveFrameDeliveryCoordinatorOptions = {
  delayMs?: number
  maxFrames?: number
  maxBytes?: number
  now?: () => number
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle
  clearTimer?: (timer: TimerHandle) => void
  sendNow: (frames: ServerFrame[]) => void
  isDestinationAvailable: () => boolean
  onSendFailure: (error: unknown) => void
}

export type LiveFrameDeliveryCoordinator = {
  deliver(frames: ServerFrame[], origin?: LiveFrameDeliveryOrigin): void
  flush(): void
  invalidateDocument(): void
  dispose(): void
  stats(): LiveFrameBatcherStats
}

export function createRendererLossTransition<Reason extends string>(options: {
  isDisposed: () => boolean
  onUnavailable: () => void
  decide: (reason: Reason) =>
    | Readonly<{ action: 'reload'; attempt: number }>
    | Readonly<{ action: 'give-up' }>
    | Readonly<{ action: 'ignore' }>
  onReload: (reason: Reason, attempt: number) => void
  onGiveUp: (reason: Reason) => void
}) {
  let handledForDocument = false
  return {
    lose(reason: Reason): boolean {
      if (handledForDocument || options.isDisposed()) return false
      handledForDocument = true
      options.onUnavailable()
      const decision = options.decide(reason)
      if (decision.action === 'reload') options.onReload(reason, decision.attempt)
      else if (decision.action === 'give-up') options.onGiveUp(reason)
      return true
    },
    documentReady(): void {
      handledForDocument = false
    },
  }
}

type MutableStats = {
  acceptedFrames: number
  sendCount: number
  sentFrames: number
  flushCount: number
  maxQueuedFrames: number
  maxQueuedBytes: number
  totalWaitMs: number
  maxWaitMs: number
  flushes: Record<LiveFrameFlushReason, number>
}

const utf8 = new TextEncoder()

export function serializedServerFrameUtf8Bytes(frame: ServerFrame): number {
  return utf8.encode(JSON.stringify(frame)).byteLength
}

export function isBatchableLiveFrame(frame: ServerFrame): boolean {
  if (frame.kind !== 'event' || frame.replay === true || frame.recovered === true) return false
  const container: unknown = frame.event
  if (!isRecord(container) || container.type !== 'message') return false
  const message = container.message
  if (!isRecord(message) || message.type !== 'stream_event') return false
  const event = message.event
  if (!isRecord(event) || event.type !== 'content_block_delta') return false
  if (!Number.isSafeInteger(event.index) || (event.index as number) < 0) return false
  const delta = event.delta
  if (!isRecord(delta)) return false
  return (
    (delta.type === 'text_delta' && typeof delta.text === 'string') ||
    (delta.type === 'thinking_delta' && typeof delta.thinking === 'string')
  )
}

export function createLiveFrameDeliveryCoordinator(
  options: LiveFrameDeliveryCoordinatorOptions,
): LiveFrameDeliveryCoordinator {
  const delayMs = options.delayMs ?? LIVE_FRAME_BATCH_DELAY_MS
  const maxFrames = options.maxFrames ?? LIVE_FRAME_BATCH_MAX_FRAMES
  const maxBytes = options.maxBytes ?? LIVE_FRAME_BATCH_MAX_BYTES
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error('delayMs must be nonnegative')
  if (!Number.isSafeInteger(maxFrames) || maxFrames < 1) throw new Error('maxFrames must be positive')
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 2) throw new Error('maxBytes must fit an empty JSON array')

  const now = options.now ?? (() => performance.now())
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
  const clearTimer = options.clearTimer ?? (timer => clearTimeout(timer))
  let pending: ServerFrame[] = []
  let pendingBytes = 0
  let oldestAt = 0
  let timer: TimerHandle | null = null
  let generation = 0
  let disposed = false
  const counters: MutableStats = {
    acceptedFrames: 0,
    sendCount: 0,
    sentFrames: 0,
    flushCount: 0,
    maxQueuedFrames: 0,
    maxQueuedBytes: 0,
    totalWaitMs: 0,
    maxWaitMs: 0,
    flushes: { deadline: 0, overdue: 0, count: 0, bytes: 0, barrier: 0, manual: 0 },
  }

  const clearPendingTimer = () => {
    if (timer !== null) clearTimer(timer)
    timer = null
  }

  const abandonPending = () => {
    // Timer callbacks are generation-bound. Increment even for an ordinary
    // drain so a cancelled callback cannot flush a later queue in this document.
    generation++
    clearPendingTimer()
    pending = []
    pendingBytes = 0
    oldestAt = 0
  }

  const failDelivery = (error: unknown) => {
    abandonPending()
    try {
      options.onSendFailure(error)
    } catch {
      // A recovery callback is a last-resort boundary. It must not crash main.
    }
  }

  const send = (frames: ServerFrame[]) => {
    if (frames.length === 0 || disposed) return
    if (!options.isDestinationAvailable()) {
      failDelivery(new Error('renderer destination unavailable'))
      return
    }
    try {
      options.sendNow(frames)
      counters.sendCount++
      counters.sentFrames += frames.length
    } catch (error) {
      failDelivery(error)
    }
  }

  const drain = (reason: LiveFrameFlushReason) => {
    if (pending.length === 0 || disposed) return
    const frames = pending
    const waitMs = Math.max(0, now() - oldestAt)
    // Detach state before invoking an arbitrary, potentially reentrant sender.
    abandonPending()
    counters.flushCount++
    counters.flushes[reason]++
    counters.totalWaitMs += waitMs
    counters.maxWaitMs = Math.max(counters.maxWaitMs, waitMs)
    send(frames)
  }

  const drainAndStayedCurrent = (reason: LiveFrameFlushReason): boolean => {
    const before = generation
    const hadPending = pending.length > 0
    drain(reason)
    const expected = hadPending ? before + 1 : before
    return !disposed && generation === expected
  }

  const armDeadline = () => {
    const armedGeneration = generation
    timer = setTimer(() => {
      if (disposed || armedGeneration !== generation) return
      timer = null
      drain('deadline')
    }, Math.max(0, oldestAt + delayMs - now()))
  }

  const deliver = (
    frames: ServerFrame[],
    origin: LiveFrameDeliveryOrigin = 'immediate',
  ) => {
    if (disposed || frames.length === 0) return
    counters.acceptedFrames += frames.length
    const frame = frames[0]
    const eligible =
      delayMs > 0 &&
      origin === 'ordinary-live' &&
      frames.length === 1 &&
      frame !== undefined &&
      isBatchableLiveFrame(frame)
    if (!eligible) {
      if (!drainAndStayedCurrent('barrier')) return
      send(frames)
      return
    }

    const arrival = now()
    if (
      pending.length > 0 &&
      arrival - oldestAt >= delayMs &&
      !drainAndStayedCurrent('overdue')
    ) return
    const frameBytes = serializedServerFrameUtf8Bytes(frame)
    const addedBytes = frameBytes + (pending.length === 0 ? 0 : 1)
    if (pending.length >= maxFrames) {
      if (!drainAndStayedCurrent('count')) return
    } else if (pending.length > 0 && pendingBytes + addedBytes > maxBytes) {
      if (!drainAndStayedCurrent('bytes')) return
    }

    // An otherwise-valid single frame that cannot fit the queue keeps the old
    // immediate-delivery behavior. The queue budget never becomes a wire cap.
    if (frameBytes + 2 > maxBytes) {
      if (!drainAndStayedCurrent('bytes')) return
      send([frame])
      return
    }

    if (pending.length === 0) {
      oldestAt = arrival
      pendingBytes = 2 + frameBytes
      pending.push(frame)
      armDeadline()
    } else {
      pending.push(frame)
      pendingBytes += frameBytes + 1
    }
    counters.maxQueuedFrames = Math.max(counters.maxQueuedFrames, pending.length)
    counters.maxQueuedBytes = Math.max(counters.maxQueuedBytes, pendingBytes)
  }

  return {
    deliver,
    flush: () => drain('manual'),
    invalidateDocument() {
      abandonPending()
    },
    dispose() {
      if (disposed) return
      disposed = true
      abandonPending()
    },
    stats() {
      return {
        acceptedFrames: counters.acceptedFrames,
        queuedFrames: pending.length,
        queuedBytes: pendingBytes,
        sendCount: counters.sendCount,
        sentFrames: counters.sentFrames,
        flushCount: counters.flushCount,
        maxQueuedFrames: counters.maxQueuedFrames,
        maxQueuedBytes: counters.maxQueuedBytes,
        totalWaitMs: counters.totalWaitMs,
        maxWaitMs: counters.maxWaitMs,
        flushes: { ...counters.flushes },
      }
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
