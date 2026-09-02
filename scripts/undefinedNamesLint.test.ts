import { describe, expect, test } from 'bun:test'

import { parseUndefinedNames } from './undefinedNamesLint.js'

describe('parseUndefinedNames', () => {
  test('catches a value used but never imported', () => {
    // The shape of the real regression: QueryEngine called toSDKRetryError
    // without importing it, so every retryable API error threw instead of
    // emitting an api_retry frame.
    const found = parseUndefinedNames(
      "src/QueryEngine.ts(1105,22): error TS2304: Cannot find name 'toSDKRetryError'.",
    )
    expect(found).toEqual([
      { column: 22, file: 'src/QueryEngine.ts', line: 1105, name: 'toSDKRetryError' },
    ])
  })

  test('catches a missing type namespace', () => {
    const found = parseUndefinedNames(
      "src/Tool.ts(107,12): error TS2503: Cannot find namespace 'React'.",
    )
    expect(found.map(n => n.name)).toEqual(['React'])
  })

  test('keeps a did-you-mean suffix out of the reported name', () => {
    const found = parseUndefinedNames(
      "src/utils/effort.ts(382,20): error TS2304: Cannot find name 'getAntModelOverrideConfig'. Did you mean 'getAntModelOverrideSection'?",
    )
    expect(found.map(n => n.name)).toEqual(['getAntModelOverrideConfig'])
  })

  test('ignores the known-red baseline diagnostics that are not undefined names', () => {
    const found = parseUndefinedNames(
      [
        "src/QueryEngine.ts(310,37): error TS2345: Argument of type 'x' is not assignable to parameter of type 'y'.",
        "src/QueryEngine.ts(824,60): error TS2339: Property 'preservedMessages' does not exist on type 'unknown'.",
        'Found 1879 errors in 214 files.',
      ].join('\n'),
    )
    expect(found).toEqual([])
  })

  test('reports every occurrence across a multi-file run', () => {
    const found = parseUndefinedNames(
      [
        "src/commands/insights.ts(1591,3): error TS2304: Cannot find name 'z'.",
        "src/commands/insights.ts(1592,22): error TS2304: Cannot find name 'z'.",
        "src/utils/thinking.ts(96,7): error TS2304: Cannot find name 'resolveAntModel'.",
      ].join('\n'),
    )
    expect(found).toHaveLength(3)
    expect(found.map(n => n.file)).toEqual([
      'src/commands/insights.ts',
      'src/commands/insights.ts',
      'src/utils/thinking.ts',
    ])
  })

  test('returns nothing for empty output', () => {
    expect(parseUndefinedNames('')).toEqual([])
  })
})
