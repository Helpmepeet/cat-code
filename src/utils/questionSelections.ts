import type { PendingQuestionSpec, QuestionAnswer } from './pendingQuestions.js'
import { z } from 'zod/v4'

export type QuestionSelection = {
  toolUseId: string
  questionIndex: number
  question: string
  selectedOptions: { optionIndex: number; label: string; description: string }[]
  other?: string
  notes: { optionIndex: number; text: string }[]
}

const selectionSchema = z.strictObject({
  toolUseId: z.string().min(1),
  questionIndex: z.number().int().min(0).max(3),
  question: z.string(),
  selectedOptions: z.array(z.strictObject({
    optionIndex: z.number().int().min(0).max(3),
    label: z.string(),
    description: z.string(),
  })).max(4),
  other: z.string().optional(),
  notes: z.array(z.strictObject({ optionIndex: z.number().int().min(0).max(3), text: z.string() })).max(4),
})
const questionSpecsSchema = z.array(z.object({
  question: z.string(),
  options: z.array(z.object({ label: z.string(), description: z.string() })).max(4),
  multiSelect: z.boolean().default(false),
})).min(1).max(4)

/** Validate persisted engine output against its original question call. */
export function readQuestionSelections(value: unknown, toolUseId: string, questions: unknown): QuestionSelection[] | null {
  const specs = questionSpecsSchema.safeParse(questions)
  const selections = z.array(selectionSchema).min(1).max(4).safeParse(value)
  if (!specs.success || !selections.success || specs.data.length !== selections.data.length) return null
  try {
    for (let index = 0; index < selections.data.length; index++) {
      const selection = selections.data[index]!
      if (selection.toolUseId !== toolUseId || selection.questionIndex !== index) return null
      const expected = reconstructQuestionSelection(toolUseId, index, specs.data[index]!, {
        optionIndices: selection.selectedOptions.map(option => option.optionIndex),
        other: selection.other,
        notes: selection.notes,
      })
      if (JSON.stringify(expected) !== JSON.stringify(selection)) return null
    }
    return selections.data
  } catch {
    return null
  }
}

/** Reconstruct only from receiver-owned questions and validated user indices. */
export function reconstructQuestionSelection(toolUseId: string, questionIndex: number, question: PendingQuestionSpec, answer: QuestionAnswer): QuestionSelection {
  const indices = answer.optionIndices
  if (new Set(indices).size !== indices.length || indices.some(i => !Number.isInteger(i) || i < 0 || i >= question.options.length)) throw new Error('Invalid option selection')
  const other = answer.other?.trim() || undefined
  if (!indices.length && !other || !question.multiSelect && indices.length + (other ? 1 : 0) > 1) throw new Error('Invalid answer cardinality')
  const notes = answer.notes ?? []
  if (new Set(notes.map(n => n.optionIndex)).size !== notes.length || notes.some(n => !indices.includes(n.optionIndex))) throw new Error('Notes must refer to distinct selected options')
  return {
    toolUseId, questionIndex, question: question.question,
    selectedOptions: indices.map(optionIndex => ({ optionIndex, label: question.options[optionIndex]!.label, description: question.options[optionIndex]!.description })),
    ...(other ? { other } : {}),
    notes: notes.map(n => ({ optionIndex: n.optionIndex, text: n.text })),
  }
}

// This capability never appears in the model's input schema. Bind to both the
// tool identity and exact receiver reconstruction; changed inputs fail closed.
const received = new Map<string, { binding: string; parsedBinding: string; selections: QuestionSelection[] }>()
function binding(questions: unknown, answers: unknown): string { return JSON.stringify([questions, answers]) }
export function recordQuestionSelections(toolUseId: string, questions: unknown, answers: unknown, selections: QuestionSelection[]): void {
  // Zod's record parser deliberately drops __proto__. Accept only that known
  // parser loss, then restore its answer from the receiver's typed selection.
  const parsedAnswers = answers && typeof answers === 'object' && !Array.isArray(answers)
    ? Object.fromEntries(Object.entries(answers).filter(([key]) => key !== '__proto__'))
    : answers
  received.set(toolUseId, { binding: binding(questions, answers), parsedBinding: binding(questions, parsedAnswers), selections: structuredClone(selections) })
  // Pending permission capabilities are short-lived and process-local.
  if (received.size > 256) received.delete(received.keys().next().value!)
}
export function takeQuestionSelections(toolUseId: string | undefined, questions: unknown, answers: unknown): QuestionSelection[] | undefined {
  if (!toolUseId) return undefined
  const entry = received.get(toolUseId)
  received.delete(toolUseId)
  const actual = binding(questions, answers)
  return entry && (entry.binding === actual || entry.parsedBinding === actual) ? entry.selections : undefined
}

export function discardQuestionSelections(toolUseId: string): void {
  received.delete(toolUseId)
}
