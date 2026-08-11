/**
 * Delivery-acknowledgement queue — diagnostics traffic (CC-40).
 *
 * Extracted from preload.ts so its behaviour can be tested without Electron.
 * All external dependencies are injected at construction time: the rate guard,
 * the IPC send function, and the timer primitives.
 *
 * The queue never throws to its caller. A rate rejection retains the batch and
 * retries; a size or serialization rejection drops the batch. See
 * `docs/reports/2026-08-09-renderer-black-window-delivery-ack-rate-cap.md`.
 */

import type { DeliveryAcknowledgement } from '../shared/deliveryTrace.js'
import type { RendererIpcRejectionReason } from './rendererIpcGuard.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Watermark state per session, written at push time. */
export interface DeliveryWatermark {
  received: number
  applied: number
  committed: number
}

/**
 * The guard function the queue calls before sending. It MUST throw a
 * `GuardRejection` on refusal so the queue can distinguish rate (transient)
 * from size/serialization (permanent).
 */
export interface GuardRejection {
  reason: RendererIpcRejectionReason
}

export interface DeliveryAckQueueDeps {
  /**
   * Rate/size guard. Must throw an object with a `reason` property on
   * rejection. The queue catches the throw and inspects `reason`.
   */
  assertAllowed: (payload: unknown, kind: 'diagnostics') => void

  /** The IPC send function — called only after the guard passes. */
  send: (channel: string, payload: unknown) => void

  /** Fixed identity fields stamped on every acknowledgement. */
  documentId: string
  processInstanceId: string
  processStartedAt: string

  /**
   * Getter for the current subscription epoch. Called at PUSH time, not flush
   * time. A flush deferred across a document change must carry the OLD epoch
   * so main rejects it as a stale document.
   */
  getSubscriptionEpoch: () => number

  /** Injectable timer functions (default to global setTimeout/clearTimeout). */
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof globalThis.setTimeout>
  clearTimeout: (handle: ReturnType<typeof globalThis.setTimeout>) => void
}

export interface DeliveryAckQueueOptions {
  /** IPC channel name for delivery acknowledgements. */
  channel: string
  /** Maximum acknowledgements per guarded send. */
  maxBatchSize: number
  /** Retained acknowledgements are trimmed to this on each failed attempt. */
  maxPending: number
  /** Timer interval in milliseconds between flush attempts. */
  flushIntervalMs: number
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export class DeliveryAckQueue {
  private readonly deps: DeliveryAckQueueDeps
  private readonly opts: DeliveryAckQueueOptions

  private readonly pending: DeliveryAcknowledgement[] = []
  private flushTimer: ReturnType<typeof globalThis.setTimeout> | null = null
  /** The last attempt was rejected by the rate guard and the batch is still queued. */
  private retrying = false

  /** Watermarks written at push time, keyed by sessionId. */
  private readonly watermarks = new Map<string, DeliveryWatermark>()

  constructor(deps: DeliveryAckQueueDeps, opts: DeliveryAckQueueOptions) {
    this.deps = deps
    this.opts = opts
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Queue a delivery acknowledgement.
   *
   * Usually defers: pushes onto the pending array and schedules a flush. But at
   * the batch threshold it DOES flush inline, on the caller's own stack, and the
   * caller can be a React passive effect. That is not a leftover — it bounds the
   * pending array. What makes it safe is that `flush` swallows the guard's
   * rejection rather than that a send cannot happen here, so a rate rejection
   * still never reaches the frame-dispatch caller. Removing the containment in
   * `flush` and relying on this being deferred is what unmounted the renderer to
   * a black window on 2026-08-09.
   */
  push(
    sessionId: string,
    sequence: number,
    deliveryAttempt: number,
    streamEpoch: string,
    traceId: string,
    stage: DeliveryAcknowledgement['stage'],
  ): void {
    const payload: DeliveryAcknowledgement = {
      sessionId,
      streamEpoch,
      sequence,
      deliveryAttempt,
      traceId,
      stage,
      documentId: this.deps.documentId,
      subscriptionEpoch: this.deps.getSubscriptionEpoch(),
      rendererProcessInstanceId: this.deps.processInstanceId,
      rendererProcessStartedAt: this.deps.processStartedAt,
    }
    this.pending.push(payload)
    // While retrying, every push would otherwise re-enter the batch branch and
    // serialize acknowledgements again just to be rejected again. Wait for the
    // timer instead: the window is 1000ms, so the budget is never far from rolling.
    if (!this.retrying && this.pending.length >= this.opts.maxBatchSize) {
      this.flush()
    } else {
      this.scheduleFlush()
    }
    const current = this.watermarks.get(sessionId) ?? { received: 0, applied: 0, committed: 0 }
    if (stage === 'preload.received' || stage === 'renderer.subscription.received') current.received = Math.max(current.received, sequence)
    if (stage === 'renderer.state.applied') current.applied = Math.max(current.applied, sequence)
    if (stage === 'renderer.ui.committed') current.committed = Math.max(current.committed, sequence)
    this.watermarks.set(sessionId, current)
  }

  /** Read-only snapshot of the current watermarks. */
  getWatermarks(): ReadonlyMap<string, DeliveryWatermark> {
    return this.watermarks
  }

  /** Number of pending acknowledgements awaiting flush. */
  get pendingCount(): number {
    return this.pending.length
  }

  /** Whether the queue is in retry mode. */
  get isRetrying(): boolean {
    return this.retrying
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /**
   * Schedule a flush if one is not already pending.
   * Idempotent: calling this when a timer is already armed is a no-op.
   */
  private scheduleFlush(): void {
    if (this.flushTimer !== null) return
    this.flushTimer = this.deps.setTimeout(() => this.flush(), this.opts.flushIntervalMs)
  }

  /**
   * Flush pending acknowledgements via the injected send function.
   *
   * On rate rejection: retains the batch and re-arms the timer.
   * On size/serialize rejection: drops the rest and returns (it will never succeed).
   */
  private flush(): void {
    if (this.flushTimer !== null) {
      this.deps.clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    while (this.pending.length > 0) {
      const acknowledgements = this.pending.splice(0, this.opts.maxBatchSize)
      const payload = { acknowledgements }
      // These are diagnostics, and the rejection must not escape: this runs on a
      // React effect stack whenever the batch branch above fires synchronously,
      // and an exception there reaches the error boundary, whose own reporter is
      // blocked by the same spent budget. That pair unmounted the renderer to a
      // black window on 2026-08-09.
      try {
        // The only diagnostics-class sender: high volume, rate set by engine
        // output rather than by the user, and losing one costs evidence only.
        this.deps.assertAllowed(payload, 'diagnostics')
        this.deps.send(this.opts.channel, payload)
      } catch (error) {
        // Only a rate rejection clears on its own. A size or serialization
        // rejection is a property of the payload, so retrying it would re-reject
        // the identical bytes every tick forever and the queue would never drain.
        if (!isRateRejection(error)) {
          return
        }
        // Keep the batch and retry rather than dropping it. `updateWatermarks`
        // advances each stage by a CONTIGUOUS scan (`app/main/deliveryTraceSink.ts`),
        // so a discarded batch pins `applied` below `produced` for the rest of the
        // stream and `firstMissing` then reports a renderer stall that never
        // happened — the same symptom the 2026-08-09 investigation was chasing.
        // This narrows that to starvation deeper than the bound below rather than
        // eliminating it: any ack actually dropped still pins the watermark.
        this.pending.unshift(...acknowledgements)
        // Drop the NEWEST beyond the bound. `contiguous()` resumes from the
        // current watermark, so keeping the head lets it advance through the
        // retained sequences; keeping the tail would pin it immediately.
        if (this.pending.length > this.opts.maxPending) {
          this.pending.splice(this.opts.maxPending)
        }
        this.retrying = true
        this.scheduleFlush()
        return
      }
    }
    this.retrying = false
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a caught error is a rate rejection from the IPC guard.
 *
 * Matches any object with `reason === 'rate'` — this is the shape of
 * `RendererIpcRejection` without importing the class, keeping the module
 * Electron-free.
 */
function isRateRejection(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'reason' in error &&
    (error as { reason: unknown }).reason === 'rate'
  )
}
