import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_TEXT_READ_MAX_OUTPUT_TOKENS,
  getTextReadBudget,
  MAX_TEXT_READ_OUTPUT_TOKENS,
  measureTextReadTokens,
} from './textReadBudget.js'

describe('text read budget', () => {
  test('scales with the effective window up to a finite 100k ceiling', () => {
    for (const [context, expected] of [
      [180_000, 22_500],
      [200_000, 25_000],
      [252_000, 31_500],
      [352_000, 44_000],
      [500_000, 62_500],
      [980_000, 100_000],
      [1_030_000, 100_000],
      [Number.MAX_VALUE, 100_000],
    ] as const) {
      expect(getTextReadBudget(context)).toEqual({
        hardTokenLimit: expected,
        prefixTargetTokens: expected,
      })
    }
  })

  test('an operator-narrowed or exhausted effective window cannot be bypassed', () => {
    expect(getTextReadBudget(64_000).hardTokenLimit).toBe(8_000)
    expect(getTextReadBudget(180_000, 100_000).hardTokenLimit).toBe(22_500)
    for (const context of [0, -20_000, 7]) {
      expect(getTextReadBudget(context, 100_000)).toEqual({
        hardTokenLimit: 0,
        prefixTargetTokens: 0,
      })
    }
  })

  test('unknown context retains the conservative legacy default', () => {
    for (const context of [undefined, NaN, Infinity, -Infinity]) {
      expect(getTextReadBudget(context).hardTokenLimit).toBe(
        DEFAULT_TEXT_READ_MAX_OUTPUT_TOKENS,
      )
    }
    expect(getTextReadBudget(undefined, 4_000).hardTokenLimit).toBe(4_000)
  })

  test('explicit narrower limits apply even when equal to the legacy default', () => {
    for (const override of [4_000, 8_000, 25_000, 60_000]) {
      expect(getTextReadBudget(980_000, override)).toEqual({
        hardTokenLimit: override,
        prefixTargetTokens: override,
      })
    }
    expect(getTextReadBudget(980_000, 4_000.5).hardTokenLimit).toBe(4_000)
  })

  test('large or invalid overrides never disable the hard ceiling', () => {
    for (const override of [
      200_000,
      Number.MAX_VALUE,
      0,
      -1,
      NaN,
      Infinity,
      -Infinity,
    ]) {
      expect(getTextReadBudget(980_000, override).hardTokenLimit).toBe(
        MAX_TEXT_READ_OUTPUT_TOKENS,
      )
    }
  })
})

describe('rendered text read measurement', () => {
  test('document-sized rendered output fits offline on a large model', async () => {
    const { hardTokenLimit, prefixTargetTokens } = getTextReadBudget(980_000)
    // Fixed synthetic rendered output, not a fixture tied to a mutable repo map.
    const rendered = Array.from(
      { length: 160 },
      (_, index) => `${index + 1}\t${'Documentation text. '.repeat(12)}`,
    ).join('\n')
    expect(Buffer.byteLength(rendered)).toBeGreaterThan(25_000)
    let countCalls = 0
    const measured = await measureTextReadTokens(
      rendered,
      prefixTargetTokens,
      hardTokenLimit,
      async () => {
        countCalls++
        return null
      },
    )
    expect(countCalls).toBe(0)
    expect(measured.hardCount).toBeLessThan(hardTokenLimit)

    const legacyBudget = getTextReadBudget(200_000)
    const legacyMeasured = await measureTextReadTokens(
      rendered,
      legacyBudget.prefixTargetTokens,
      legacyBudget.hardTokenLimit,
      async () => null,
    )
    expect(legacyMeasured.hardCount).toBeGreaterThan(
      legacyBudget.hardTokenLimit,
    )
  })

  test('offline fallback uses bytes as the guard, not the optimistic estimate', async () => {
    const budget = getTextReadBudget(980_000)
    const measured = await measureTextReadTokens(
      'x'.repeat(100_001),
      budget.prefixTargetTokens,
      budget.hardTokenLimit,
      async () => null,
    )
    expect(measured.targetCount).toBe(Math.ceil(100_001 / 1.4))
    expect(measured.targetCount).toBeLessThan(budget.prefixTargetTokens)
    expect(measured.hardCount).toBe(100_001)
    expect(measured.hardCount).toBeGreaterThan(budget.hardTokenLimit)
  })

  test('multibyte text uses UTF-8 bytes for the fallback guard', async () => {
    const rendered = '界'.repeat(40_000)
    const measured = await measureTextReadTokens(
      rendered,
      100_000,
      100_000,
      async () => null,
    )
    expect(measured).toEqual({
      targetCount: Math.ceil(120_000 / 1.4),
      hardCount: 120_000,
    })
  })

  test('an available exact count can admit text beyond the byte guard', async () => {
    let countCalls = 0
    const measured = await measureTextReadTokens(
      'x'.repeat(120_000),
      100_000,
      100_000,
      async content => {
        countCalls++
        expect(content.length).toBe(120_000)
        return 30_000
      },
    )
    expect(countCalls).toBe(1)
    expect(measured).toEqual({ targetCount: 30_000, hardCount: 30_000 })
  })

  test('exact overflow remains visible to prefix fitting', async () => {
    expect(
      await measureTextReadTokens(
        'x'.repeat(150_000),
        100_000,
        100_000,
        async () => 110_000,
      ),
    ).toEqual({ targetCount: 110_000, hardCount: 110_000 })
  })

  test('empty output does not need a token counter', async () => {
    expect(
      await measureTextReadTokens('', 0, 0, async () => {
        throw new Error('The empty result must not be counted')
      }),
    ).toEqual({ targetCount: 0, hardCount: 0 })
  })
})
