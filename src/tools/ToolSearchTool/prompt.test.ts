import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'
import { AskUserQuestionTool } from '../AskUserQuestionTool/AskUserQuestionTool.js'
import { isDeferredTool } from './prompt.js'

describe('ToolSearchTool prompt', () => {
  test('keeps AskUserQuestion available without a ToolSearch round-trip', () => {
    expect(isDeferredTool(AskUserQuestionTool)).toBe(false)
  })

  test('tells the model to load instructed deferred tools before treating them as unavailable', () => {
    const source = readFileSync(
      new URL('./prompt.ts', import.meta.url),
      'utf8',
    )

    expect(source).toContain(
      'If instructions mention a tool that is not directly callable but appears as deferred, load it with "select:<tool>" before treating it as unavailable.',
    )
  })
})
