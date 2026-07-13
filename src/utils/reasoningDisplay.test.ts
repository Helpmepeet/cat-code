import { describe, expect, test } from 'bun:test'
import { shouldShowReasoningBlock } from './reasoningDisplay.js'

describe('shouldShowReasoningBlock', () => {
  test('raw mode falls back to the summary when no raw reasoning exists', () => {
    expect(shouldShowReasoningBlock('raw', 'summary', false)).toBe(true)
  })

  test('raw mode prefers raw reasoning when it exists', () => {
    expect(shouldShowReasoningBlock('raw', 'summary', true)).toBe(false)
    expect(shouldShowReasoningBlock('raw', 'raw', true)).toBe(true)
  })

  test('summary and off modes preserve their display contracts', () => {
    expect(shouldShowReasoningBlock('summary', 'summary', false)).toBe(true)
    expect(shouldShowReasoningBlock('summary', 'raw', true)).toBe(false)
    expect(shouldShowReasoningBlock('off', 'summary', false)).toBe(false)
    expect(shouldShowReasoningBlock('off', 'raw', true)).toBe(false)
  })
})
