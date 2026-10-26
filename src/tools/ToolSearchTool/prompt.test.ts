import { describe, expect, test } from 'bun:test'
import { AskUserQuestionTool } from '../AskUserQuestionTool/AskUserQuestionTool.js'
import { getPrompt, isDeferredTool } from './prompt.js'

describe('ToolSearchTool prompt', () => {
  test('keeps AskUserQuestion available without a ToolSearch round-trip', () => {
    expect(isDeferredTool(AskUserQuestionTool)).toBe(false)
  })

  test('tells the model to load instructed deferred tools before treating them as unavailable', () => {
    const prompt = getPrompt()

    expect(prompt).toContain(
      'If instructions mention a tool that is not directly callable but appears as deferred, load it with "select:<tool>" before treating it as unavailable.',
    )
    expect(prompt).toContain('makes their full schemas available for subsequent calls')
    expect(prompt).not.toContain('<functions>')
    expect(prompt).not.toContain('<function>')
  })
})
