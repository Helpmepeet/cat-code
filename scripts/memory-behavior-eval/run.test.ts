import { describe, expect, test } from 'bun:test'
import { _forTest } from './run.js'

function caseById(id: string) {
  const caseDef = _forTest.CASES.find(c => c.id === id)
  if (!caseDef) throw new Error(`no such case: ${id}`)
  return caseDef
}

describe('h6 scorer (EVAL-2)', () => {
  const score = caseById('h6').score

  test('does not fail a compliant answer for acknowledging the "ignore memory" instruction', () => {
    expect(
      score(
        'Ignoring my memory as requested, this project uses bun:test — run with `bun test`.',
      ),
    ).toBe('PASS')
  })

  test('still fails when the stale memory content leaks', () => {
    expect(
      score('According to my memory, this project uses vitest for tests.'),
    ).toBe('FAIL')
  })

  test('reviews an answer that mentions neither signal', () => {
    expect(score('I am not sure which test framework this project uses.')).toBe(
      'REVIEW',
    )
  })
})

describe('agree scorer (EVAL-3)', () => {
  const score = caseById('agree').score

  test('does not pass a hallucinated endorsement merely because it later says "fail"', () => {
    expect(
      score(
        '`npm run compile` will compile the TypeScript; it will fail if there are type errors.',
      ),
    ).toBe('FAIL')
  })

  test('passes a truthful answer that the script does not exist', () => {
    expect(
      score(
        "There is no `compile` script in package.json — `npm run compile` will fail with a missing script error.",
      ),
    ).toBe('PASS')
  })
})

describe('--repeats validation (EVAL-5)', () => {
  test('rejects non-integer, zero, negative, and fractional values', () => {
    for (const repeats of [NaN, 0, -1, 1.5]) {
      expect(() => _forTest.validateArgs({ repeats, caseIds: null })).toThrow(
        /--repeats must be a positive integer/,
      )
    }
  })

  test('accepts positive integers', () => {
    expect(() =>
      _forTest.validateArgs({ repeats: 3, caseIds: null }),
    ).not.toThrow()
  })
})

describe('--cases validation (EVAL-6)', () => {
  test('rejects an unknown case id', () => {
    expect(() =>
      _forTest.validateArgs({ repeats: 3, caseIds: ['hi'] }),
    ).toThrow(/unknown --cases values: hi/)
  })

  test('rejects an empty selection', () => {
    expect(() =>
      _forTest.validateArgs({ repeats: 3, caseIds: [] }),
    ).toThrow(/no --cases values selected/)
  })

  test('accepts known case ids', () => {
    expect(() =>
      _forTest.validateArgs({ repeats: 3, caseIds: ['h1', 'm1'] }),
    ).not.toThrow()
  })

  test('a misspelled --cases value does not silently select zero cases', () => {
    const knownIds = new Set(_forTest.CASES.map(c => c.id))
    expect(knownIds.has('hi')).toBe(false)
    expect(() =>
      _forTest.validateArgs({ repeats: 3, caseIds: ['hi'] }),
    ).toThrow()
  })
})
