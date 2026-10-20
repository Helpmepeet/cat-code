import { describe, expect, test } from 'bun:test'
import { resolve } from 'path'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { asSystemPrompt } from '../utils/systemPromptType.js'
import {
  HARNESS_FEEDBACK_EXPIRES_AT,
  withTemporaryHarnessFeedback,
} from './temporaryHarnessFeedback.js'

describe('temporary harness feedback', () => {
  test('adds a bounded reporting rule without reading the inbox or mutating the base prompt', () => {
    const base = asSystemPrompt(['main or worker instructions'])
    const prompt = withTemporaryHarnessFeedback(base, HARNESS_FEEDBACK_EXPIRES_AT - 1)

    expect(base).toEqual(['main or worker instructions'])
    expect(prompt[0]).toBe(base[0])
    expect(prompt).toHaveLength(2)
    expect(prompt[1]).toContain(
      JSON.stringify(resolve(getClaudeConfigHomeDir(), 'harness-feedback.md')),
    )
    expect(prompt[1]).toContain('even if a workaround succeeds')
    expect(prompt[1]).toContain('single append-only write')
    expect(prompt[1]).toContain('Follow normal permissions and role restrictions')
    expect(prompt[1]).toContain('parent agents record feedback returned by workers')
  })

  test('stops at midnight on November 3 in Bangkok, including for existing sessions', () => {
    const base = asSystemPrompt(['unchanged instructions'])
    expect(new Date(HARNESS_FEEDBACK_EXPIRES_AT).toISOString()).toBe(
      '2026-11-02T17:00:00.000Z',
    )
    expect(withTemporaryHarnessFeedback(base, HARNESS_FEEDBACK_EXPIRES_AT - 1)).toHaveLength(2)
    expect(withTemporaryHarnessFeedback(base, HARNESS_FEEDBACK_EXPIRES_AT)).toBe(base)
    expect(withTemporaryHarnessFeedback(base, HARNESS_FEEDBACK_EXPIRES_AT + 1)).toBe(base)
  })
})
