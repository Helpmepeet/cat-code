import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_TEXT_READ_MAX_OUTPUT_TOKENS,
  getTextReadBudget,
  resolveReadMaxTokensOverride,
} from './textReadBudget.js'

describe('text read default-limit provenance', () => {
  test('an unconfigured legacy default does not clamp large-context text', () => {
    const override = resolveReadMaxTokensOverride(undefined, undefined)
    expect(override).toBeUndefined()
    expect(override ?? DEFAULT_TEXT_READ_MAX_OUTPUT_TOKENS).toBe(25_000)
    expect(getTextReadBudget(980_000, override).hardTokenLimit).toBe(100_000)
  })

  test('an explicit 25k env override remains a 25k text limit', () => {
    const override = resolveReadMaxTokensOverride('25000', undefined)
    expect(override).toBe(25_000)
    expect(getTextReadBudget(980_000, override).hardTokenLimit).toBe(25_000)
  })

  test('env retains precedence over feature configuration', () => {
    expect(resolveReadMaxTokensOverride('4000', 8_000)).toBe(4_000)
  })

  test('feature overrides remain available separately from the legacy default', () => {
    expect(resolveReadMaxTokensOverride(undefined, 8_000)).toBe(8_000)
    expect(resolveReadMaxTokensOverride(undefined, 25_000)).toBe(25_000)
  })

  test('invalid env values fall through to the feature override', () => {
    for (const value of ['', '0', '-1', 'invalid', '9'.repeat(400)]) {
      expect(resolveReadMaxTokensOverride(value, 8_000)).toBe(8_000)
    }
  })

  test('invalid feature values do not invent an explicit limit', () => {
    for (const value of [0, -1, NaN, Infinity, '4000', null, {}]) {
      const override = resolveReadMaxTokensOverride(undefined, value)
      expect(override).toBeUndefined()
      expect(override ?? DEFAULT_TEXT_READ_MAX_OUTPUT_TOKENS).toBe(25_000)
    }
  })

  test('a broad configured limit is still bounded by the text-read policy', () => {
    const override = resolveReadMaxTokensOverride('200000', undefined)
    expect(override).toBe(200_000)
    expect(getTextReadBudget(980_000, override).hardTokenLimit).toBe(100_000)
    expect(getTextReadBudget(180_000, override).hardTokenLimit).toBe(22_500)
  })
})
