import type { AutoModeObservationEvent } from '../utils/permissions/autoModeObservation.js'
import { recordToolReview } from './toolActivity.js'
import type { AutoModeReview } from './autoModeReviewContract.js'

/** One initial permission occurrence, including the time spent in fast review. */
export function createAutoModeReviewTracker(
  publish: (review: AutoModeReview) => void = recordToolReview,
  now: () => number = Date.now,
) {
  const startedAt = now()
  let identity: { toolUseId: string; attemptId: string } | undefined
  let entered = false
  let completed = false
  let failed = false
  function complete(result?: { shouldBlock: boolean; unavailable?: boolean; reason?: string }) {
    if (!entered || completed || !identity) return
    completed = true
    publish({ type: 'tool.review', ...identity, startedAt, completedAt: Math.max(startedAt, now()),
      outcome: failed || !result || result.unavailable ? 'inconclusive' : result.shouldBlock ? 'blocked' : 'allowed',
      ...(result?.reason !== undefined ? { reason: result.reason } : {}),
    })
  }
  return {
    observe(event: AutoModeObservationEvent) {
      if (event.subtype === 'auto_permission_start') {
        identity = { toolUseId: event.tool_use_id, attemptId: event.attempt_id }
      } else if (event.subtype === 'auto_permission_stage' && event.stage === 'thinking') {
        if (event.phase === 'entered' && !entered && identity) {
          entered = true
          publish({ type: 'tool.review', ...identity, startedAt, outcome: 'reviewing' })
        } else if (event.phase === 'resolved' && 'failure' in event) failed = true
      } else if (event.subtype === 'auto_permission_end') complete()
    },
    complete,
  }
}
