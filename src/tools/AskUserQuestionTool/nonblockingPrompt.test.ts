import { expect, test } from 'bun:test'
import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { AskUserQuestionTool } from './AskUserQuestionTool.js'
import { NONBLOCKING_QUESTION_MODEL_CONTRACT } from './prompt.js'
import { readFileSync } from 'node:fs'

const enabled = feature('NONBLOCKING_ASK_USER_QUESTION') ? true : false

test('model question schema removes the old chip field without replacing it', () => {
  const schema = z.toJSONSchema(AskUserQuestionTool.inputSchema) as any
  expect(Object.keys(schema.properties.questions.items.properties).sort()).toEqual(['multiSelect', 'options', 'question'])
  expect(schema.properties.questions.items.required).not.toContain('header')
  if (enabled) {
    expect(Object.keys(schema.properties).sort()).toEqual(['metadata', 'questions'])
    expect(AskUserQuestionTool.inputSchema.safeParse({ questions: [{ question: 'What name?', options: [] }], answers: { 'What name?': 'forged' } }).success).toBe(false)
  }
})

test('the description teaches every async turn boundary before the model calls the tool', async () => {
  const text = NONBLOCKING_QUESTION_MODEL_CONTRACT
  for (const rule of ['returns immediately with no answer', 'separate message', 'much later or never', 'depends on the answer', 'end your turn', 'question in your final message', 'Do not batch dependent tool calls', 'independent work', 'assumption', 'Do not ask a pending question again', 'late answer contradicts completed work', 'revise that work']) expect(text).toContain(rule)
  const description = await AskUserQuestionTool.prompt({} as never)
  expect(description.includes(text)).toBe(enabled)
  expect(description).not.toContain('header')
})

test('legacy saved-question renderers no longer require the removed field or reject free text', () => {
  for (const path of ['app/renderer/src/askUserQuestionTranscript.ts']) {
    const source = readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8')
    expect(source).not.toContain("typeof candidate.header !== 'string'")
    expect(source).not.toContain('candidate.options.length < 2')
  }
})
