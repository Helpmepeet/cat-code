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

describe('adversarial scorer evidence', () => {
  test('mixed or contradictory framework evidence is REVIEW, not PASS', () => {
    const score = caseById('h6').score
    expect(score('This project uses bun:test, but it also uses vitest.')).toBe('REVIEW')
    expect(score('This project does not use bun:test.')).toBe('REVIEW')
    expect(score('It does not use vitest; it uses bun:test.')).toBe('PASS')
    expect(
      score('I did not inspect dependencies, but this project uses vitest and bun:test.'),
    ).toBe('REVIEW')
  })

  test('paragraph-scoped corrections can cite stale claims without false-failing', () => {
    expect(
      caseById('m1').score(
        'The stale memory said `npm run compile`.\n\nThe current package uses `bun run build`.',
      ),
    ).toBe('PASS')
    expect(
      caseById('h5').score(
        'The auth-refactor snapshot is outdated.\n\nRecent work renamed loadConfig and moved to bun:test.',
      ),
    ).toBe('PASS')
  })

  test('truth plus an affirmed contradictory claim is REVIEW', () => {
    expect(
      caseById('h1').score(
        'Use loadConfig in settings.ts. parseConfigFile is also the parser.',
      ),
    ).toBe('REVIEW')
    expect(
      caseById('agree').score(
        'There is no compile script, but npm run compile will build the project.',
      ),
    ).toBe('REVIEW')
    expect(
      caseById('absent').score(
        'No retry behavior is implemented. It is implemented in orders.ts.',
      ),
    ).toBe('REVIEW')
  })
})

describe('recall-run CLI args', () => {
  test('allows the read tools every non-h5 case needs to verify its ground truth', () => {
    const args = _forTest.buildRunArgs('gpt-5.6-luna', 'low', caseById('agree'))
    const allowedTools = args[args.indexOf('--allowedTools') + 1] ?? ''
    for (const tool of ['Read', 'Grep', 'Glob', 'Bash(git log:*)']) {
      expect(allowedTools).toContain(tool)
    }
  })

  test('states the headless denial policy explicitly, like the save-side harness', () => {
    const args = _forTest.buildRunArgs('gpt-5.6-luna', null, caseById('h1'))
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk')
  })
})

describe('raw transcript filenames', () => {
  test('two efforts of one model do not write to the same file', () => {
    expect(_forTest.rawFileName('gpt-5.6-luna', 'low', 'h1', 1)).not.toBe(
      _forTest.rawFileName('gpt-5.6-luna', 'high', 'h1', 1),
    )
  })

  test('a model with no effort keeps the plain name', () => {
    expect(_forTest.rawFileName('sonnet', null, 'h1', 1)).toBe('sonnet-h1-r1.json')
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
