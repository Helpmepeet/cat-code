import type {
  ToolCardStatus,
  ToolResultProjection,
} from './transcriptProjector.js'

export type AskUserQuestionTranscriptItem = {
  question: string
  answer?: string
  note?: string
}

export type AskUserQuestionTranscriptPresentation = {
  state: 'answered' | 'declined' | 'pending'
  items: AskUserQuestionTranscriptItem[]
}

/**
 * Builds the dedicated transcript presentation only when its source data is
 * sufficient. Older results without structured answers keep the generic card.
 */
export function askUserQuestionTranscriptPresentation(
  toolName: string,
  input: Record<string, unknown>,
  status: ToolCardStatus,
  result: ToolResultProjection | null,
): AskUserQuestionTranscriptPresentation | null {
  if (toolName !== 'AskUserQuestion' || status === 'cancelled') return null
  const questions = readQuestionTexts(input.questions)
  if (questions === null) return null

  if (status === 'pending') {
    return { state: 'pending', items: questions.map(question => ({ question })) }
  }
  if (status === 'error') {
    return { state: 'declined', items: questions.map(question => ({ question })) }
  }

  const structured = result?.askUserQuestion
  if (structured === undefined) return null
  const items: AskUserQuestionTranscriptItem[] = []
  for (const question of questions) {
    const answer = Object.prototype.hasOwnProperty.call(
      structured.answers,
      question,
    )
      ? structured.answers[question]
      : undefined
    if (typeof answer !== 'string') return null
    const note = Object.prototype.hasOwnProperty.call(
      structured.notesByQuestion,
      question,
    )
      ? structured.notesByQuestion[question]
      : undefined
    items.push({
      question,
      answer,
      ...(note === undefined || note.length === 0 ? {} : { note }),
    })
  }
  return { state: 'answered', items }
}

function readQuestionTexts(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) return null
  const questions: string[] = []
  for (const candidate of value) {
    if (!isRecord(candidate)) return null
    if (
      typeof candidate.question !== 'string' ||
      typeof candidate.header !== 'string' ||
      (candidate.multiSelect !== undefined &&
        typeof candidate.multiSelect !== 'boolean') ||
      !Array.isArray(candidate.options) ||
      candidate.options.length < 2 ||
      candidate.options.length > 4
    ) {
      return null
    }
    for (const option of candidate.options) {
      if (
        !isRecord(option) ||
        typeof option.label !== 'string' ||
        typeof option.description !== 'string' ||
        (option.preview !== undefined && typeof option.preview !== 'string')
      ) {
        return null
      }
    }
    questions.push(candidate.question)
  }
  return questions
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
