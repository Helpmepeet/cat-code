/**
 * AskUserQuestion domain — P4-20 (`AskQuestionFlow`), reusing the SAME
 * `permission.requested` / `permission.resolved` events `permissionState.ts`
 * already models (decisions/ASK-USER-QUESTION-ANSWER.md). There is NO new
 * read-seam: an AskUserQuestion prompt IS a permission request
 * (`src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx`,
 * `requiresUserInteraction()`), so everything below is DERIVED from the queue —
 * never a parallel store, exactly as `planState.ts` does for ExitPlanMode.
 *
 * The questions the flow renders are the model's REAL tool-call input
 * (`AskUserQuestionTool.tsx` `inputSchema` — `questions:[{ question, header,
 * options:[{ label, description, preview? }], multiSelect }]`), read from the
 * raw-forwarded permission request's `input`. The renderer narrows defensively
 * (P0-3 posture) and never invents a question or an option.
 */

import type {
  PermissionQueueItem,
  PermissionRequest,
  PermissionState,
} from './permissionState.js'
import {
  isAskUserQuestionRequest,
  selectPermissionQueue,
} from './permissionState.js'
import type { SessionId } from '../../shared/protocol.js'

// Re-exported for parity with planState: consumers of the ask domain read the
// predicate + tool-name literal from here, but permissionState.ts OWNS them
// (single source for the ACTION and RENDER paths).
export {
  ASK_USER_QUESTION_TOOL_NAME,
  isAskUserQuestionRequest,
} from './permissionState.js'

export type AskQuestionOption = {
  /** SOURCE-BACKED: `AskUserQuestionTool.tsx` `questionOptionSchema` `label`. */
  label: string
  /** SOURCE-BACKED: `questionOptionSchema` `description`. */
  description: string
  /** SOURCE-BACKED: `questionOptionSchema` `preview` (optional). */
  preview: string | null
}

export type AskQuestion = {
  /** SOURCE-BACKED: `questionSchema` `question`. */
  question: string
  /** SOURCE-BACKED: `questionSchema` `header` (the chip label). */
  header: string
  /** SOURCE-BACKED: `questionSchema` `options` (2–4). */
  options: AskQuestionOption[]
  /** SOURCE-BACKED: `questionSchema` `multiSelect` (default false). */
  multiSelect: boolean
}

export type AskQuestionReview = {
  request: PermissionRequest
  /** An answer is in flight for this request (prevents double-submit). */
  submitted: boolean
  questions: AskQuestion[]
}

function narrowOption(value: unknown): AskQuestionOption | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.label !== 'string') return null
  return {
    label: record.label,
    description:
      typeof record.description === 'string' ? record.description : '',
    preview: typeof record.preview === 'string' ? record.preview : null,
  }
}

function narrowQuestion(value: unknown): AskQuestion | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.question !== 'string') return null
  if (!Array.isArray(record.options)) return null
  const options: AskQuestionOption[] = []
  for (const entry of record.options) {
    const option = narrowOption(entry)
    if (!option) return null
    options.push(option)
  }
  return {
    question: record.question,
    header: typeof record.header === 'string' ? record.header : '',
    options,
    multiSelect: record.multiSelect === true,
  }
}

/** Defensively narrow the raw permission input's `questions` array. */
export function narrowAskQuestions(input: Record<string, unknown>): AskQuestion[] {
  const raw = input.questions
  if (!Array.isArray(raw)) return []
  const questions: AskQuestion[] = []
  for (const entry of raw) {
    const question = narrowQuestion(entry)
    if (question) questions.push(question)
  }
  return questions
}

/** The pending AskUserQuestion request for this session, or `null` if none. */
export function selectAskQuestion(
  state: PermissionState,
  sessionId: SessionId | null,
): AskQuestionReview | null {
  const item = selectPermissionQueue(state, sessionId).find(candidate =>
    isAskUserQuestionRequest(candidate.request),
  )
  if (!item) return null
  const questions = narrowAskQuestions(item.request.request.input)
  // A malformed request with zero readable questions has nothing to render, so
  // the dedicated flow declines it and `selectGenericPermissionQueue` keeps it
  // in the generic card instead — the two exclusions use the SAME readability
  // test, so such a request stays visible and deniable rather than becoming
  // invisible and permanently pending (display degrades gracefully; inbound
  // still fails closed).
  if (questions.length === 0) return null
  return { request: item.request, submitted: item.submitted, questions }
}

/**
 * The generic permission queue minus BOTH the plan review and the
 * AskUserQuestion flow — each owns a dedicated renderer, never the generic
 * per-tool card. Composed on top of `selectNonPlanPermissionQueue` so the plan
 * exclusion stays single-sourced in `planState.ts`.
 */
export function selectGenericPermissionQueue(
  queue: PermissionQueueItem[],
): PermissionQueueItem[] {
  return queue.filter(
    item =>
      !isAskUserQuestionRequest(item.request) ||
      // Only a RENDERABLE AskUserQuestion is owned by the dedicated flow. A
      // malformed one (no readable questions) has no dedicated renderer, so it
      // must stay here to remain visible and deniable — mirroring the same
      // readability test `selectAskQuestion` applies.
      narrowAskQuestions(item.request.request.input).length === 0,
  )
}
