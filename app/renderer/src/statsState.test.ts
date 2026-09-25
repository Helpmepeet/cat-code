import { describe, expect, test } from 'bun:test'
import { formatModelDisplayName } from './statsState.js'

describe('statsState', () => {
  test('formatModelDisplayName maps canonical IDs to human titles', () => {
    expect(formatModelDisplayName('claude-3-5-sonnet-20241022')).toBe('Claude 3.5 Sonnet')
    expect(formatModelDisplayName('claude-3-opus-20240229')).toBe('Claude 3 Opus')
    expect(formatModelDisplayName('gpt-4o')).toBe('GPT-4o')
    expect(formatModelDisplayName('custom-model')).toBe('custom-model')
  })

  test('formatModelDisplayName speaks the engine\'s own marketing vocabulary', () => {
    // Mirrors `getMarketingNameForModel` (`src/utils/model/model.ts:785`), which
    // is what the composer rail already prints for the SESSION's model. Two
    // different names for one model in one window is the bug this prevents.
    expect(formatModelDisplayName('claude-sonnet-5-20260115')).toBe('Sonnet 5')
    expect(formatModelDisplayName('claude-opus-5')).toBe('Opus 5')
    expect(formatModelDisplayName('claude-fable-5')).toBe('Fable 5')
    expect(formatModelDisplayName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(formatModelDisplayName('gpt-5.6-luna')).toBe('GPT-5.6 Luna')
    expect(formatModelDisplayName('gpt-5.6-sol')).toBe('GPT-5.6 Sol')
  })

  test('formatModelDisplayName tests the specific 4.x ids before the general ones', () => {
    // `claude-opus-4` is a substring of `claude-opus-4-5`, so a reordering here
    // silently relabels every 4.5 run as plain Opus 4.
    expect(formatModelDisplayName('claude-opus-4-5-20251101')).toBe('Opus 4.5')
    expect(formatModelDisplayName('claude-opus-4-1-20250805')).toBe('Opus 4.1')
    expect(formatModelDisplayName('claude-opus-4-20250514')).toBe('Opus 4')
    expect(formatModelDisplayName('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5')
    expect(formatModelDisplayName('claude-sonnet-4-20250514')).toBe('Sonnet 4')
  })

  test('formatModelDisplayName keeps the 1M-context marker, which changes what the run is', () => {
    expect(formatModelDisplayName('claude-sonnet-5[1m]')).toBe('Sonnet 5 (with 1M context)')
    expect(formatModelDisplayName('claude-opus-5[1M]')).toBe('Opus 5 (with 1M context)')
  })

})
