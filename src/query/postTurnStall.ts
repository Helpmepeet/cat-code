import type { AgentId } from '../types/ids.js'
import {
  recordPostTurnStall,
  type PostTurnStallPhase,
} from '../utils/sessionStorage.js'

// -- post-turn stall reporting
//
// The awaits between the final assistant message and result emission are
// unbounded and, before this, wrote nothing anywhere: an overnight run stayed
// "working" for nine hours with no record naming what it was waiting on
// (docs/reports/2026-08-10-overnight-turn-hang-investigation.md).
//
// This reports; it does not rescue. Racing the await against a rejection would
// unstick the turn and destroy the evidence — the whole point is that the hung
// process is still hung and still sampleable when someone looks.

/**
 * How long one post-turn await may run before it is reported once. NOT a
 * timeout — nothing is cancelled when this elapses.
 */
export const POST_TURN_STALL_THRESHOLD_MS = 60_000

/** Schedules `callback` after `delayMs` and returns its cancel function. */
type Scheduler = (callback: () => void, delayMs: number) => () => void

const realScheduler: Scheduler = (callback, delayMs) => {
  const handle = setTimeout(callback, delayMs)
  // A pending report must never be the reason the process stays alive.
  handle.unref()
  return () => clearTimeout(handle)
}

let scheduler: Scheduler = realScheduler
let thresholdMs = POST_TURN_STALL_THRESHOLD_MS

export type PostTurnStallContext = {
  turnCount: number
  querySource: string
  agentId?: AgentId
}

/**
 * Arm a one-shot stall report for `phase` and return its disarm function.
 *
 * Call disarm from a `finally` around the await. A fast await then costs one
 * cleared timer, and a hung one still hangs forever — after saying so once.
 */
export function watchPostTurnStall(
  phase: PostTurnStallPhase,
  context: PostTurnStallContext,
): () => void {
  const armedAt = Date.now()
  const cancel = scheduler(() => {
    recordPostTurnStall({
      phase,
      elapsed_ms: Date.now() - armedAt,
      threshold_ms: thresholdMs,
      turn_count: context.turnCount,
      query_source: context.querySource,
      ...(context.agentId ? { agentId: context.agentId } : {}),
    })
  }, thresholdMs)
  let disarmed = false
  return () => {
    if (disarmed) return
    disarmed = true
    cancel()
  }
}

export const _forTest = {
  /**
   * Replace the timer so a test can fire the report on demand. Passing null
   * restores the real one.
   */
  setScheduler(next: Scheduler | null): void {
    scheduler = next ?? realScheduler
  },
  setThresholdMs(ms: number | null): void {
    thresholdMs = ms ?? POST_TURN_STALL_THRESHOLD_MS
  },
}
