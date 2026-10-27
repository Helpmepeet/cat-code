import { afterEach, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { AskUserQuestionTool } from './AskUserQuestionTool.js'
import { resetStateForTests, setQuestionPreviewFormat } from '../../bootstrap/state.js'
import { ASK_USER_QUESTION_TOOL_PROMPT, MAX_HTML_PREVIEW_CHARS } from './prompt.js'

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

describe('AskUserQuestion HTML previews', () => {
  const withPreview = (preview: string) => ({
    questions: [{
      question: 'Which layout?',
      header: 'Layout',
      options: [
        { label: 'Stacked', description: 'One column', preview },
        { label: 'Split', description: 'Two columns' },
      ],
      multiSelect: false,
    }],
  })
  const validate = (preview: string) =>
    AskUserQuestionTool.validateInput!(withPreview(preview) as never, {} as never)

  afterEach(() => resetStateForTests())

  test('the html format teaches the renderer contract and its limit', async () => {
    setQuestionPreviewFormat('html')
    const prompt = await AskUserQuestionTool.prompt({} as never)
    expect(prompt).toContain('A self-contained HTML fragment')
    expect(prompt).toContain('var(--fg)')
    expect(prompt).toContain(`at most ${MAX_HTML_PREVIEW_CHARS} characters`)
  })

  test('rejects an oversized preview only in html mode', async () => {
    const oversized = `<div>${'x'.repeat(MAX_HTML_PREVIEW_CHARS)}</div>`
    setQuestionPreviewFormat('markdown')
    expect((await validate(oversized)).result).toBe(true)
    setQuestionPreviewFormat('html')
    const result = await validate(oversized)
    expect(result.result).toBe(false)
    expect(result.result === false && result.message).toContain(`the limit is ${MAX_HTML_PREVIEW_CHARS}`)
    expect((await validate('<div>fits</div>')).result).toBe(true)
  })

  test('html mode still rejects plain text and executable tags', async () => {
    setQuestionPreviewFormat('html')
    expect((await validate('plain text')).result).toBe(false)
    expect((await validate('<div><script>1</script></div>')).result).toBe(false)
  })
})
