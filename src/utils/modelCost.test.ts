import { describe, expect, test } from 'bun:test'

import { CLAUDE_SONNET_4_5_CONFIG } from './model/configs.js'
import { firstPartyNameToCanonical } from './model/model.js'
import { calculateUSDCost } from './modelCost.js'

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
