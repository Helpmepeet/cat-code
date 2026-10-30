import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { canPersistHandoffTranscript, getTranscriptPath } from '../utils/sessionStorage.js'
import { logForDebugging } from '../utils/debug.js'
import { isAutoModeReview, type AutoModeReview } from './autoModeReviewContract.js'

const activeReviews = new Map<string, Map<string, string>>()

/** The companion tree moves and backs up with the session; model readers never open this file. */
export function autoModeReviewPath(transcriptPath: string): string {
  return join(dirname(transcriptPath), basename(transcriptPath, '.jsonl'), 'auto-mode-reviews')
}

export function appendAutoModeReview(transcriptPath: string, review: AutoModeReview): void {
  if (!isAutoModeReview(review)) return
  const path = autoModeReviewPath(transcriptPath)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  // A leading separator isolates a prior process's torn tail from this record.
  appendFileSync(path, `\n${JSON.stringify(review)}\n`, { mode: 0o600 })
}

/** All branches share the owning session's display store; tool-use IDs are join keys. */
export function persistAutoModeReview(review: AutoModeReview): void {
  try {
    if (!canPersistHandoffTranscript()) return
    const path = getTranscriptPath()
    appendAutoModeReview(path, review)
    if (review.outcome === 'reviewing') {
      const calls = activeReviews.get(path) ?? new Map<string, string>()
      calls.set(review.toolUseId, review.attemptId)
      activeReviews.set(path, calls)
    } else {
      const calls = activeReviews.get(path)
      calls?.delete(review.toolUseId)
      if (calls?.size === 0) activeReviews.delete(path)
    }
  } catch (error) {
    logForDebugging(`Auto mode review persistence failed for ${review.toolUseId}: ${String(error)}`, { level: 'warn' })
  }
}

export function readAutoModeReviews(transcriptPath: string): AutoModeReview[] {
  let text: string
  try { text = readFileSync(autoModeReviewPath(transcriptPath), 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const latest = new Map<string, AutoModeReview>()
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const review: unknown = JSON.parse(line)
      if (isAutoModeReview(review)) latest.set(review.toolUseId, review)
    } catch { /* A partial display-store tail cannot damage the engine transcript. */ }
  }
  // Reconnects to a live check keep its spinner; a lost process has no verdict.
  return [...latest.values()].map(review => review.outcome === 'reviewing' &&
    activeReviews.get(transcriptPath)?.get(review.toolUseId) !== review.attemptId
    ? { ...review, outcome: 'inconclusive' }
    : review)
}
