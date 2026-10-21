import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { AskUserQuestionTool } from './AskUserQuestionTool.js'
import { ASK_USER_QUESTION_TOOL_PROMPT } from './prompt.js'

const question = (count: number) => ({
  question: 'What should happen next?',
  header: 'Next',
  options: Array.from({ length: count }, (_, index) => ({
    label: `Choice ${index}`,
    description: `Description ${index}`,
  })),
  multiSelect: false,
})

describe('AskUserQuestion free-text contract', () => {
  for (const count of [0, 2, 3, 4]) {
    test(`accepts ${count} options in input and output`, () => {
      const questions = [question(count)]
      expect(AskUserQuestionTool.inputSchema.safeParse({ questions }).success).toBe(true)
      expect(AskUserQuestionTool.outputSchema.safeParse({ questions, answers: {} }).success).toBe(true)
    })
  }
  for (const count of [1, 5]) {
    test(`rejects ${count} options in input and output`, () => {
      const questions = [question(count)]
      expect(AskUserQuestionTool.inputSchema.safeParse({ questions }).success).toBe(false)
      expect(AskUserQuestionTool.outputSchema.safeParse({ questions, answers: {} }).success).toBe(false)
    })
  }
  test('publishes both cardinality branches to the model', () => {
    const schema = z.toJSONSchema(AskUserQuestionTool.inputSchema) as any
    const branches = schema.properties.questions.items.properties.options.anyOf
    expect(branches.map((branch: any) => [branch.minItems, branch.maxItems])).toEqual([[0, 0], [2, 4]])
    expect(ASK_USER_QUESTION_TOOL_PROMPT).toContain('options: []')
    expect(ASK_USER_QUESTION_TOOL_PROMPT).toContain('wait or explain first')
  })
  test('returns wait instructions without a continuation directive', () => {
    const questions = [question(0)]
    const result = AskUserQuestionTool.mapToolResultToToolResultBlockParam({
      questions,
      answers: { [questions[0]!.question]: 'Wait, explain first.' },
    }, 'question-1')
    expect(result.content).toBe('User has answered your questions: "What should happen next?"="Wait, explain first.".')
  })
})
