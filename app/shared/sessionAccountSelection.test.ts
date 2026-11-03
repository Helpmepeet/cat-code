import { expect, test } from 'bun:test'
import { mergeSessionAccountSelection, parseSessionAccountSelection } from './sessionAccountSelection.js'

test('saved Claude generation is a closed paired nonnegative safe integer', () => {
  expect(parseSessionAccountSelection({ anthropic: 'claude', anthropicLoginGeneration: 0 })).toEqual({ anthropic: 'claude', anthropicLoginGeneration: 0 })
  for (const generation of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, null, '1']) {
    expect(parseSessionAccountSelection({ anthropic: 'claude', anthropicLoginGeneration: generation })).toBeUndefined()
  }
  expect(parseSessionAccountSelection({ anthropicLoginGeneration: 1 })).toBeUndefined()
  expect(parseSessionAccountSelection({ anthropic: 'claude', token: 'private' })).toBeUndefined()
})

test('provider merges retain the paired generation but never transfer it to a different account', () => {
  const selection = { anthropic: 'claude', anthropicLoginGeneration: 3, openai: 'codex-a' }
  expect(mergeSessionAccountSelection(selection, { openai: 'codex-b' })).toEqual({ ...selection, openai: 'codex-b' })
  expect(mergeSessionAccountSelection(selection, { anthropic: 'claude' })).toEqual(selection)
  expect(mergeSessionAccountSelection(selection, { anthropic: 'other' })).toEqual({ anthropic: 'other', openai: 'codex-a' })
  expect(mergeSessionAccountSelection(selection, { anthropic: 'claude', anthropicLoginGeneration: 4 })).toEqual({ ...selection, anthropicLoginGeneration: 4 })
})
