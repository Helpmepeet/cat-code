import { expect, test } from 'bun:test'
import { isAutoModeReview } from './autoModeReviewContract.js'
import { createAutoModeReviewTracker } from './autoModeReview.js'
import type { AutoModeReview } from './autoModeReviewContract.js'

test('review contract is closed, validates chronology, and retains arbitrarily long full reasons', () => {
  const start = { type: 'tool.review', toolUseId: 'tool', attemptId: 'attempt', startedAt: 10, outcome: 'reviewing' }
  expect(isAutoModeReview(start)).toBe(true)
  const end = { ...start, completedAt: 30, outcome: 'allowed', reason: 'full reason\n'.repeat(1000) }
  expect(isAutoModeReview(end)).toBe(true)
  expect(isAutoModeReview({ ...start, outcome: 'inconclusive' })).toBe(true)
  for (const invalid of [
    { ...start, reason: 'premature verdict' }, { ...start, input: 'secret' }, { ...start, completedAt: 30 },
    { ...end, completedAt: 9 }, { ...end, completedAt: NaN }, { ...end, completedAt: undefined },
    { ...end, startedAt: -1 }, { ...end, attemptId: '' }, { ...end, outcome: 'deny' }, { ...end, reason: {} },
  ]) expect(isAutoModeReview(invalid)).toBe(false)
})

test('unresolved stage2 ends neutrally once; neither fast stages nor tool activity can create a review', () => {
  const events: AutoModeReview[] = []
  let now = 100
  const tracker = createAutoModeReviewTracker(event => events.push(event), () => now)
  tracker.observe({ schema_version: 1, subtype: 'auto_permission_start', attempt_id: 'attempt', tool_use_id: 'tool', tool_kind: 'other', auto_mode: 'auto', initial: true })
  tracker.observe({ schema_version: 1, subtype: 'auto_permission_stage', attempt_id: 'attempt', stage: 'fast', phase: 'entered' })
  expect(events).toEqual([])
  now = 200
  tracker.observe({ schema_version: 1, subtype: 'auto_permission_stage', attempt_id: 'attempt', stage: 'thinking', phase: 'entered' })
  now = 400
  tracker.observe({ schema_version: 1, subtype: 'auto_permission_end', attempt_id: 'attempt', raw_result: 'throw', route: 'stage2', disposition: 'unknown_outcome' })
  tracker.complete({ shouldBlock: true, reason: 'late verdict' })
  expect(events).toEqual([
    { type: 'tool.review', toolUseId: 'tool', attemptId: 'attempt', startedAt: 100, outcome: 'reviewing' },
    { type: 'tool.review', toolUseId: 'tool', attemptId: 'attempt', startedAt: 100, completedAt: 400, outcome: 'inconclusive' },
  ])
})
