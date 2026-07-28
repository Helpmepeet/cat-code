import type { AskUserQuestionAnswer } from '../../shared/protocol.js'

export type DraftAnswer = { optionIndices: number[]; other: string }

/**
 * Leaving the freeform field without keeping the text (Escape) — it drops the
 * text ONLY. TYPING a freeform answer is what supersedes a single-select pick;
 * walking away from an empty field must not silently un-pick the option the
 * user already chose, which would grey out Submit with no visible cause.
 * Pure because the flow's key handler lives in an effect the SSR-only renderer
 * suite never runs.
 */
export function abandonOtherText(draft: DraftAnswer): DraftAnswer {
  return { optionIndices: draft.optionIndices, other: '' }
}

export function buildAskAnswerPayload(
  drafts: DraftAnswer[],
): AskUserQuestionAnswer[] {
  return drafts.map(draft => {
    const trimmed = draft.other.trim()
    return {
      optionIndices: draft.optionIndices,
      ...(trimmed.length > 0 ? { other: trimmed } : {}),
    }
  })
}
