import { expect, test } from 'bun:test'
import type { AutoModeReview } from '../../../src/app-runtime/autoModeReviewContract.js'
import { summarizeAutoModeReviews } from './autoModeReview.js'

const allowed = (toolUseId: string, elapsed: number): AutoModeReview => ({ type: 'tool.review', toolUseId, attemptId: toolUseId, startedAt: 1000, completedAt: 1000 + elapsed, outcome: 'allowed', reason: 'User approved this action.' })

test('only supplied deep-review evidence contributes, each call once, using the shared duration formatter', () => {
  expect(summarizeAutoModeReviews([undefined])).toBeNull()
  expect(summarizeAutoModeReviews([allowed('a', 12000)])).toEqual({ outcome: 'allowed', count: 1, text: 'Reviewed for 12s' })
  expect(summarizeAutoModeReviews([allowed('a', 12000), allowed('a', 12000), undefined, allowed('b', 19000)])).toEqual({ outcome: 'allowed', count: 2, text: 'Reviewed 2 commands for 31s' })
  expect(summarizeAutoModeReviews([allowed('a', 72999)])?.text).toBe('Reviewed for 1m 12s')
})

test('a block hides the count and other timing, including still-running reviews', () => {
  const block = { ...allowed('b', 9000), outcome: 'blocked' as const }
  expect(summarizeAutoModeReviews([allowed('a', 12000), block, { ...allowed('c', 10000), outcome: 'reviewing', completedAt: undefined }])).toEqual({ outcome: 'blocked', count: 1, text: 'Blocked after 9s' })
})

test('unfinished and inconclusive reviews never claim permission was granted', () => {
  expect(summarizeAutoModeReviews([{ ...allowed('a', 12000), outcome: 'reviewing', completedAt: undefined }])?.text).toBe('Auto mode is reviewing this')
  expect(summarizeAutoModeReviews([allowed('a', 12000), { ...allowed('b', 19000), outcome: 'inconclusive' }])).toEqual({ outcome: 'inconclusive', count: 2, text: 'Auto mode review ended without a decision' })
})
