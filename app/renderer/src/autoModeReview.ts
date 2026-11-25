import { createContext } from 'react'
import { AUTO_MODE_REJECTION_PREFIX, SCRIPT_APPROVAL_STOP_REASONS, type AutoModeReview } from '../../../src/app-runtime/autoModeReviewContract.js'
import { duration } from './focusedLive.js'

export const AutoModeReviewContext = createContext<AutoModeReview | undefined>(undefined)
export type ReviewSummary = { outcome: AutoModeReview['outcome']; count: number; text: string }

export const AUTO_MODE_DECISION_LABELS = {
  blocked: 'Blocked by Auto mode',
  asking: 'Auto mode requested your decision',
  inconclusive: 'Auto mode review ended without a decision',
} as const

const scriptStopReasons: ReadonlySet<string> = new Set(Object.values(SCRIPT_APPROVAL_STOP_REASONS))

export function autoModeDecisionLabel(outcome: keyof typeof AUTO_MODE_DECISION_LABELS, reviewer?: AutoModeReview['reviewer'], reason?: string): string {
  if (outcome === 'inconclusive') {
    if (reason && scriptStopReasons.has(reason)) return reason
    if (reviewer?.verdict) return 'Action held after Auto mode review'
  }
  return AUTO_MODE_DECISION_LABELS[outcome]
}

export function visibleAutoModeReason(review?: AutoModeReview): string | undefined {
  if (review?.outcome === 'allowed' || review?.outcome === 'reviewing') return undefined
  return review?.reason || undefined
}

export function isDuplicateAutoModeDenial(review: AutoModeReview | undefined, content: string): boolean {
  return review?.outcome === 'blocked' && !!review.reason && content === AUTO_MODE_REJECTION_PREFIX + review.reason
}

/** Each logical call counts once; a policy block takes precedence over the rest. */
export function summarizeAutoModeReviews(reviews: readonly (AutoModeReview | undefined)[]): ReviewSummary | null {
  const calls = [...new Map(reviews.filter((review): review is AutoModeReview => review !== undefined).map(review => [review.toolUseId, review])).values()]
  if (!calls.length) return null
  const blocked = calls.find(review => review.outcome === 'blocked')
  if (blocked) return { outcome: 'blocked', count: 1, text: `Blocked after ${duration((blocked.completedAt ?? blocked.startedAt) - blocked.startedAt)}` }
  if (calls.some(review => review.outcome === 'reviewing')) return { outcome: 'reviewing', count: calls.length, text: 'Auto mode is reviewing this' }
  if (calls.some(review => review.outcome === 'asking')) return { outcome: 'asking', count: calls.length, text: AUTO_MODE_DECISION_LABELS.asking }
  const inconclusive = calls.find(review => review.outcome === 'inconclusive' && review.reviewer?.verdict) ??
    calls.find(review => review.outcome === 'inconclusive')
  if (inconclusive) return { outcome: 'inconclusive', count: calls.length, text: autoModeDecisionLabel('inconclusive', inconclusive.reviewer, inconclusive.reason) }
  const elapsed = calls.reduce((sum, review) => sum + (review.completedAt ?? review.startedAt) - review.startedAt, 0)
  return { outcome: 'allowed', count: calls.length, text: calls.length > 1 ? `Reviewed ${calls.length} commands for ${duration(elapsed)}` : `Reviewed for ${duration(elapsed)}` }
}
