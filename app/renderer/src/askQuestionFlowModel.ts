import type { AskUserQuestionAnswer } from '../../shared/protocol.js'

export type DraftAnswer = { optionIndices: number[]; other: string }

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
