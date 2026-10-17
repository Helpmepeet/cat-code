import { describe, expect, test } from 'bun:test'

import { CLAUDE_SONNET_4_5_CONFIG } from './model/configs.js'
import { firstPartyNameToCanonical } from './model/model.js'
import { calculateUSDCost } from './modelCost.js'
import { getConfiguredStandardModelCosts, ratesForPrompt } from './modelCostRates.js'

describe('calculateUSDCost', () => {
  const model = firstPartyNameToCanonical(
    CLAUDE_SONNET_4_5_CONFIG.firstParty,
  )

  test('returns 0 when usage is unexpectedly undefined', () => {
    expect(calculateUSDCost(model, undefined)).toBe(0)
  })

  test('returns 0 when usage is malformed at runtime', () => {
    expect(
      calculateUSDCost(
        model,
        { output_tokens: 12 } as unknown as Parameters<
          typeof calculateUSDCost
        >[1],
      ),
    ).toBe(0)
  })
})

test('retained-history pricing recognizes configured IDs without guessing aliases or future versions', () => {
  for (const configuredId of Object.values(CLAUDE_SONNET_4_5_CONFIG)) {
    expect(getConfiguredStandardModelCosts(configuredId)?.inputTokens).toBe(3)
    expect(getConfiguredStandardModelCosts(configuredId)?.outputTokens).toBe(15)
  }
  expect(getConfiguredStandardModelCosts(`${CLAUDE_SONNET_4_5_CONFIG.firstParty}[1m]`)?.inputTokens).toBe(3)
  expect(getConfiguredStandardModelCosts('sonnet')).toBeUndefined()
  expect(getConfiguredStandardModelCosts('claude-sonnet-4-99')).toBeUndefined()
  expect(getConfiguredStandardModelCosts('gpt-6-astra')).toBeUndefined()
})

// Prices are the independent API contract, including matching 5.5 before 5.
test.each([
  ['claude-opus-5-5', 4, 20],
  ['claude-sonnet-5-5', 2, 10],
  ['claude-opus-5', 5, 25],
  ['claude-sonnet-5', 3, 15],
] as const)('%s uses its own live and retained-history price', (model, input, output) => {
  expect(calculateUSDCost(model, { input_tokens: 1_000_000, output_tokens: 1_000_000 } as never)).toBe(input + output)
  expect(getConfiguredStandardModelCosts(model)?.inputTokens).toBe(input)
  expect(getConfiguredStandardModelCosts(model)?.outputTokens).toBe(output)
})

describe('claude-haiku-5-5 prompt-size tiers', () => {
  const usage = (prompt: { input: number; read?: number; write?: number }) =>
    ({
      input_tokens: prompt.input,
      cache_read_input_tokens: prompt.read ?? 0,
      cache_creation_input_tokens: prompt.write ?? 0,
      output_tokens: 1_000_000,
    }) as never

  test('a prompt at or under 100K uses the base rates', () => {
    // 100K exactly is not "exceeding 100K".
    expect(calculateUSDCost('claude-haiku-5-5', usage({ input: 100_000 }))).toBeCloseTo(0.5 + 0.1 * 0.1, 10)
    expect(calculateUSDCost('claude-haiku-5-5', usage({ input: 0, read: 1_000_000 }))).toBeGreaterThan(0)
  })

  test('a prompt over 100K reprices input, output, and cache with the long-prompt rates', () => {
    expect(calculateUSDCost('claude-haiku-5-5', usage({ input: 100_001 }))).toBeCloseTo(2.5 + 100_001 * 0.5 / 1e6, 10)
    // Cached tokens count toward prompt size, and price at the long cache rates.
    expect(
      calculateUSDCost('claude-haiku-5-5', usage({ input: 1, read: 100_000, write: 1_000_000 })),
    ).toBeCloseTo(2.5 + 1 * 0.5 / 1e6 + 100_000 * 0.05 / 1e6 + 1_000_000 * 0.625 / 1e6, 10)
  })

  test('retained history sees the same rate card, tiered by request size', () => {
    const rates = getConfiguredStandardModelCosts('claude-haiku-5-5')!
    expect(rates).toMatchObject({ inputTokens: 0.1, outputTokens: 0.5, promptCacheReadTokens: 0.01, promptCacheWriteTokens: 0.125 })
    expect(ratesForPrompt(rates, 100_000)).toBe(rates)
    expect(ratesForPrompt(rates, 100_001)).toMatchObject({ inputTokens: 0.5, outputTokens: 2.5, promptCacheReadTokens: 0.05, promptCacheWriteTokens: 0.625 })
    expect(getConfiguredStandardModelCosts('claude-haiku-5-5')).toBeDefined()
    expect(getConfiguredStandardModelCosts('anthropic.claude-haiku-5-5')).toBeDefined()
    // Untiered models are unaffected.
    const sonnet = getConfiguredStandardModelCosts('claude-sonnet-5-5')!
    expect(ratesForPrompt(sonnet, 5_000_000)).toBe(sonnet)
  })
})
