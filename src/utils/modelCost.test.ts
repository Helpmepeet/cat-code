import { describe, expect, test } from 'bun:test'

import { CLAUDE_SONNET_4_5_CONFIG } from './model/configs.js'
import { firstPartyNameToCanonical } from './model/model.js'
import { calculateUSDCost } from './modelCost.js'
import { getConfiguredStandardModelCosts } from './modelCostRates.js'

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
