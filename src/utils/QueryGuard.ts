/**
 * Synchronous state machine for the query lifecycle, compatible with
 * React's `useSyncExternalStore`.
 *
 * Three states:
 *   idle        → no query, safe to dequeue and process
 *   dispatching → an item was dequeued, async chain hasn't reached onQuery yet
 *   running     → onQuery called tryStart(), query is executing
 *
 * Transitions:
 *   idle → dispatching  (reserve)
 *   dispatching → running  (tryStart)
 *   idle → running  (tryStart, for direct user submissions)
 *   running → idle  (end / forceEnd)
 *   dispatching → idle  (cancelReservation, when processQueueIfReady fails)
 *
 * `isActive` returns true for both dispatching and running, preventing
 * re-entry from the queue processor during the async gap.
 *
 * Usage with React:
 *   const queryGuard = useRef(new QueryGuard()).current
 *   const isQueryActive = useSyncExternalStore(
 *     queryGuard.subscribe,
 *     queryGuard.getSnapshot,
 *   )
 */
import { createSignal } from './signal.js'
import { logForDebugging } from './debug.js'

export class QueryGuard {
  private _status: 'idle' | 'dispatching' | 'running' = 'idle'
  private _generation = 0
  private _changed = createSignal()

  /**
   * Reserve the guard for queue processing. Transitions idle → dispatching.
   * Returns false if not idle (another query or dispatch in progress).
   */
  reserve(): boolean {
    if (this._status !== 'idle') {
      logForDebugging(
        `[QueryGuard] reserve blocked status=${this._status} generation=${this._generation}`,
      )
      return false
    }
    this._status = 'dispatching'
    logForDebugging(
      `[QueryGuard] reserve -> dispatching generation=${this._generation}`,
    )
    this._notify()
    return true
  }

  /**
   * Cancel a reservation when processQueueIfReady had nothing to process.
   * Transitions dispatching → idle.
   */
  cancelReservation(): void {
    if (this._status !== 'dispatching') return
    this._status = 'idle'
    logForDebugging(
      `[QueryGuard] cancelReservation -> idle generation=${this._generation}`,
    )
    this._notify()
  }

  /**
   * Start a query. Returns the generation number on success,
   * or null if a query is already running (concurrent guard).
   * Accepts transitions from both idle (direct user submit)
   * and dispatching (queue processor path).
   */
  tryStart(): number | null {
    if (this._status === 'running') {
      logForDebugging(
        `[QueryGuard] tryStart blocked status=${this._status} generation=${this._generation}`,
      )
      return null
    }
    this._status = 'running'
    ++this._generation
    logForDebugging(
      `[QueryGuard] tryStart -> running generation=${this._generation}`,
    )
    this._notify()
    return this._generation
  }

  /**
   * End a query. Returns true if this generation is still current
   * (meaning the caller should perform cleanup). Returns false if a
   * newer query has started (stale finally block from a cancelled query).
   */
  end(generation: number): boolean {
    if (this._generation !== generation) {
      logForDebugging(
        `[QueryGuard] end stale requested=${generation} current=${this._generation} status=${this._status}`,
      )
      return false
    }
    if (this._status !== 'running') {
      logForDebugging(
        `[QueryGuard] end ignored status=${this._status} generation=${this._generation}`,
      )
      return false
    }
    this._status = 'idle'
    logForDebugging(
      `[QueryGuard] end -> idle generation=${this._generation}`,
    )
    this._notify()
    return true
  }

  /**
   * Force-end the current query regardless of generation.
   * Used by onCancel where any running query should be terminated.
   * Increments generation so stale finally blocks from the cancelled
   * query's promise rejection will see a mismatch and skip cleanup.
   */
  forceEnd(): void {
    if (this._status === 'idle') return
    this._status = 'idle'
    ++this._generation
    logForDebugging(
      `[QueryGuard] forceEnd -> idle generation=${this._generation}`,
    )
    this._notify()
  }

  /**
   * Is the guard active (dispatching or running)?
   * Always synchronous — not subject to React state batching delays.
   */
  get isActive(): boolean {
    return this._status !== 'idle'
  }

  /**
   * Is a model turn actually executing?
   *
   * Narrower than `isActive`, which also counts `dispatching` — the window a
   * caller reserves for ITSELF before its async chain reaches onQuery. A
   * dispatch is exclusive (`reserve` only succeeds from idle), so code running
   * inside a dispatch that asked `isActive` would see its own reservation and
   * conclude another turn was in flight. Ask this instead when the question is
   * "is a turn running?" rather than "is the guard taken?".
   */
  get isRunning(): boolean {
    return this._status === 'running'
  }

  get generation(): number {
    return this._generation
  }

  // --
  // useSyncExternalStore interface

  /** Subscribe to state changes. Stable reference — safe as useEffect dep. */
  subscribe = this._changed.subscribe

  /** Snapshot for useSyncExternalStore. Returns `isActive`. */
  getSnapshot = (): boolean => {
    return this._status !== 'idle'
  }

  private _notify(): void {
    this._changed.emit()
  }
}
