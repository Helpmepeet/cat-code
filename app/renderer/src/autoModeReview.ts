import { createContext } from 'react'
import type { AutoModeReview } from '../../../src/app-runtime/autoModeReviewContract.js'
import { duration } from './focusedLive.js'

export const AutoModeReviewContext = createContext<AutoModeReview | undefined>(undefined)
export type ReviewSummary = { outcome: AutoModeReview['outcome']; count: number; text: string }

/** Each logical call counts once; a policy block takes precedence over the rest. */
export function summarizeAutoModeReviews(reviews: readonly (AutoModeReview | undefined)[]): ReviewSummary | null {
  const calls = [...new Map(reviews.filter((review): review is AutoModeReview => review !== undefined).map(review => [review.toolUseId, review])).values()]
  if (!calls.length) return null
  const blocked = calls.find(review => review.outcome === 'blocked')
  if (blocked) return { outcome: 'blocked', count: 1, text: `Blocked after ${duration((blocked.completedAt ?? blocked.startedAt) - blocked.startedAt)}` }
  if (calls.some(review => review.outcome === 'reviewing')) return { outcome: 'reviewing', count: calls.length, text: 'Auto mode is reviewing this' }
  if (calls.some(review => review.outcome === 'inconclusive')) return { outcome: 'inconclusive', count: calls.length, text: 'Auto mode review ended without a decision' }
  const elapsed = calls.reduce((sum, review) => sum + (review.completedAt ?? review.startedAt) - review.startedAt, 0)
  return { outcome: 'allowed', count: calls.length, text: calls.length > 1 ? `Reviewed ${calls.length} commands for ${duration(elapsed)}` : `Reviewed for ${duration(elapsed)}` }
}
