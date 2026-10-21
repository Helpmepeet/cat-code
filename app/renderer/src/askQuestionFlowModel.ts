import type { AskUserQuestionAnswer } from '../../shared/protocol.js'
import type { AskQuestion } from './askQuestionState.js'

export type DraftAnswer = {
  optionIndices: number[]
  other: string
  /** Kept by option index, never by the cursor or last option visited. */
  notes?: Record<number, string>
}
export type AskQuestionDraft = { questionIndex: number; answers: DraftAnswer[] }

/**
 * Leaving the freeform field without keeping the text (Escape) — it drops the
 * text ONLY. TYPING a freeform answer is what supersedes a single-select pick;
 * walking away from an empty field must not silently un-pick the option the
 * user already chose, which would grey out Submit with no visible cause.
 * Pure because the flow's key handler lives in an effect the SSR-only renderer
 * suite never runs.
 */
export function abandonOtherText(draft: DraftAnswer): DraftAnswer {
  return { ...draft, other: '' }
}

export function buildAskAnswerPayload(
  drafts: DraftAnswer[],
): AskUserQuestionAnswer[] {
  return drafts.map(draft => {
    const trimmed = draft.other.trim()
    const notes = draft.optionIndices.flatMap(optionIndex => {
      const text = draft.notes?.[optionIndex]?.trim()
      return text ? [{ optionIndex, text }] : []
    })
    return {
      optionIndices: draft.optionIndices,
      ...(trimmed.length > 0 ? { other: trimmed } : {}),
      ...(notes.length > 0 ? { notes } : {}),
    }
  })
}

export function hasAskAnswer(draft: DraftAnswer | undefined): boolean {
  return draft !== undefined &&
    (draft.optionIndices.length > 0 || draft.other.trim().length > 0)
}

/** The deny path carries context, not an invented completed answer. */
export function buildAskChatMessage(
  questions: AskQuestion[],
  drafts: DraftAnswer[],
): string {
  const summary = questions.map((question, index) => {
    const draft = drafts[index]
    const picks = draft?.optionIndices.flatMap(optionIndex => {
      const option = question.options[optionIndex]
      if (!option) return []
      const note = draft?.notes?.[optionIndex]?.trim()
      return [option.label + (note ? ` (user notes: ${note})` : '')]
    }) ?? []
    if (draft?.other.trim()) picks.push(draft.other.trim())
    return `- ${question.question}: ${picks.length ? picks.join(', ') : 'No answer given'}`
  })
  return `The user wants to chat about these questions rather than submit answers now.\n${summary.join('\n')}`
}
