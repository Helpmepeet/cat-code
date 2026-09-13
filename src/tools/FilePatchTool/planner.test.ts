import { describe, expect, test } from 'bun:test'
import {
  planUpdateHunks,
  type PlannerHunk,
  type PlannerResult,
} from './planner.js'

function hunk(lines: PlannerHunk['lines'], overrides: Partial<PlannerHunk> = {}): PlannerHunk {
  return { lines, ...overrides }
}

function context(text: string) {
  return { kind: 'context' as const, text }
}

function deleted(text: string) {
  return { kind: 'delete' as const, text }
}

function added(text: string) {
  return { kind: 'add' as const, text }
}

function plan(source: string, hunks: PlannerHunk[], options: Partial<Parameters<typeof planUpdateHunks>[0]> = {}) {
  return planUpdateHunks({ path: '/tmp/example.ts', source, hunks, ...options })
}

function success(result: PlannerResult) {
  expect(result.ok).toBe(true)
  if ('failure' in result) throw new Error(result.failure.message)
  return result
}

function failure(result: PlannerResult) {
  expect(result.ok).toBe(false)
  if (!('failure' in result)) throw new Error('expected planner failure')
  return result.failure
}

describe('immutable source-coordinate placement', () => {
  test('returns one exact candidate with original source coordinates', () => {
    const result = success(
      plan('first\ntarget\nlast\n', [
        hunk([context('target'), deleted('last'), added('new last')]),
      ]),
    )

    expect(result.plan.hunks).toEqual([
      { hunkIndex: 0, sourceStart: 1, sourceEnd: 3, boundary: 'none', matchTier: 'exact' },
    ])
  })

  test('a later hunk resolves an earlier local ambiguity', () => {
    const result = success(
      plan('x\nkeep\nx\nfence\n', [
        hunk([context('x'), added('changed')]),
        hunk([context('x'), context('fence'), added('later')]),
      ]),
    )

    expect(result.plan.hunks.map(candidate => candidate.sourceStart)).toEqual([0, 2])
  })

  test('does not resolve ambiguity by selecting the first candidate', () => {
    const error = failure(
      plan('x\nkeep\nx\n', [hunk([context('x'), added('changed')])]),
    )
    expect(error.code).toBe('PATCH_ANCHOR_AMBIGUOUS')
    expect(error.kind).toBe('ambiguity')
  })

  test('rejects candidates that are only before the previous hunk', () => {
    const error = failure(
      plan('first\nsecond\n', [
        hunk([context('second')]),
        hunk([context('first')]),
      ]),
    )
    expect(error.code).toBe('PATCH_ORDER_CONFLICT')
  })

  test('rejects overlapping consumed ranges', () => {
    const error = failure(
      plan('a\nb\nc\n', [
        hunk([context('a'), context('b')]),
        hunk([context('b'), context('c')]),
      ]),
    )
    expect(error.code).toBe('PATCH_ORDER_CONFLICT')
  })

  test('never searches text introduced by an earlier hunk', () => {
    const result = success(
      plan('old\nanchor\n', [
        hunk([deleted('old'), added('anchor')]),
        hunk([context('anchor'), added('changed')]),
      ]),
    )
    expect(result.plan.hunks.map(candidate => candidate.sourceStart)).toEqual([0, 1])
  })
})

describe('whole-line hints', () => {
  test('uses case-sensitive trimmed whole-line equality', () => {
    const result = success(
      plan('class A {\n  target\n}\nclass B {\n  target\n}\n', [
        hunk([context('  target')], { hints: ['class B {'] }),
      ]),
    )
    expect(result.plan.hunks[0]!.sourceStart).toBe(4)

    expect(
      failure(
        plan('function foobar() {\n  target\n}\n', [
          hunk([context('  target')], { hints: ['function foo'] }),
        ]),
      ).code,
    ).toBe('PATCH_HINT_NOT_FOUND')
  })

  test('ignores indentation and trailing whitespace but not internal whitespace or case', () => {
    expect(
      success(
        plan('  class A {   \ntarget\n', [hunk([context('target')], { hints: ['class A {'] })]),
      ).plan.hunks[0]!.diagnosticHintLines,
    ).toEqual([0])

    expect(
      failure(
        plan('class  A {\ntarget\n', [hunk([context('target')], { hints: ['class A {'] })]),
      ).code,
    ).toBe('PATCH_HINT_NOT_FOUND')
    expect(
      failure(
        plan('Class A {\ntarget\n', [hunk([context('target')], { hints: ['class A {'] })]),
      ).code,
    ).toBe('PATCH_HINT_NOT_FOUND')
  })

  test('allows a same-line hint at the candidate first fingerprint line', () => {
    const result = success(
      plan('target\n', [hunk([context('target')], { hints: ['target'] })]),
    )
    expect(result.plan.hunks[0]!.diagnosticHintLines).toEqual([0])
  })

  test('keeps hint witness choices out of candidate identity', () => {
    const result = success(
      plan('scope\nscope\ntarget\n', [hunk([context('target')], { hints: ['scope'] })]),
    )
    expect(result.plan.hunks).toHaveLength(1)
    expect(result.plan.hunks[0]!.diagnosticHintLines).toEqual([0])
  })

  test('treats whitespace-only hints as bare @@', () => {
    const result = plan('target\ntarget\n', [hunk([context('target')], { hints: ['   '] })])
    expect(failure(result).code).toBe('PATCH_ANCHOR_AMBIGUOUS')
  })

  test('requires stacked hints to be distinct and supplied in order', () => {
    expect(
      success(
        plan('outer\ninner\ntarget\n', [
          hunk([context('target')], { hints: ['outer', 'inner'] }),
        ]),
      ).plan.hunks[0]!.diagnosticHintLines,
    ).toEqual([0, 1])
    expect(
      failure(
        plan('inner\nouter\ntarget\n', [
          hunk([context('target')], { hints: ['outer', 'inner'] }),
        ]),
      ).code,
    ).toBe('PATCH_HINT_NOT_FOUND')
  })
})

describe('BOF, EOF, and insertion ordering', () => {
  test('only permits context-free insertion at BOF for the first hunk', () => {
    const result = success(plan('old\n', [hunk([added('prefix')])]))
    expect(result.plan.hunks[0]!.boundary).toBe('bof')
    expect(failure(plan('old\n', [hunk([context('old')]), hunk([added('bad')])])).code).toBe(
      'PATCH_INVALID_INSERTION',
    )
  })

  test('hard EOF never falls back to an interior exact match', () => {
    const error = failure(
      plan('target\nother\ntarget\nother\n', [
        hunk([context('target'), added('new')], { isEndOfFile: true }),
      ]),
    )
    expect(error.code).toBe('PATCH_HARD_EOF_CONFLICT')
  })

  test('reports a missing hint when the hard-EOF fingerprint exists at EOF', () => {
    const error = failure(
      plan('target\n', [
        hunk([context('target')], { isEndOfFile: true, hints: ['missing'] }),
      ]),
    )
    expect(error.code).toBe('PATCH_HINT_NOT_FOUND')
  })

  test('allows context-free EOF insertion only as the final hunk', () => {
    const result = success(
      plan('old\n', [
        hunk([context('old')]),
        hunk([added('tail')], { isEndOfFile: true }),
      ]),
    )
    expect(result.plan.hunks[1]!.boundary).toBe('eof')
  })

  test('returns a structured missing-hint failure for context-free EOF insertion', () => {
    const nonempty = failure(
      plan('old\n', [
        hunk([added('tail')], { isEndOfFile: true, hints: ['missing'] }),
      ]),
    )
    const empty = failure(
      plan('', [
        hunk([added('tail')], { isEndOfFile: true, hints: ['missing'] }),
      ]),
    )
    expect(nonempty.code).toBe('PATCH_HINT_NOT_FOUND')
    expect(empty.code).toBe('PATCH_HINT_NOT_FOUND')
  })

  test('labels a fingerprinted hard-EOF placement as eof', () => {
    const result = success(
      plan('head\ntail', [
        hunk([context('tail')], { isEndOfFile: true }),
      ]),
    )
    expect(result.plan.hunks[0]!.boundary).toBe('eof')
  })

  test('preserves patch order for BOF then EOF insertion on an empty file', () => {
    const result = success(
      plan('', [
        hunk([added('first')]),
        hunk([added('second')], { isEndOfFile: true }),
      ]),
    )
    expect(result.plan.hunks.map(candidate => [candidate.sourceStart, candidate.sourceEnd])).toEqual([
      [0, 0],
      [0, 0],
    ])
  })
})

describe('newline constraints', () => {
  test('requires a final newline for an EOF-affecting unmarked replacement', () => {
    const result = success(plan('old', [hunk([deleted('old'), added('new')])]))
    expect(result.plan.output).toEqual({ lineCount: 1, hasFinalNewline: true, outputEofAffected: true })
  })

  test('rejects old-side marker when source EOF has a newline', () => {
    const error = failure(
      plan('old\n', [
        hunk([deleted('old'), added('new')], {
          newlineMarkers: [{ afterHunkLine: 0, appliesTo: 'old' }],
        }),
      ]),
    )
    expect(error.code).toBe('PATCH_NEWLINE_CONFLICT')
  })

  test('old-only marker does not suppress the new-side default newline', () => {
    const result = success(
      plan('old', [
        hunk([deleted('old'), added('new')], {
          newlineMarkers: [{ afterHunkLine: 0, appliesTo: 'old' }],
        }),
      ]),
    )
    expect(result.plan.output.hasFinalNewline).toBe(true)
  })

  test('new-only marker makes the complete output unterminated', () => {
    const result = success(
      plan('old', [
        hunk([deleted('old'), added('new')], {
          newlineMarkers: [{ afterHunkLine: 1, appliesTo: 'new' }],
        }),
      ]),
    )
    expect(result.plan.output.hasFinalNewline).toBe(false)
  })

  test('counts newline validity as part of complete-plan uniqueness', () => {
    const result = success(
      plan('old\nold', [
        hunk([deleted('old'), added('new')], {
          newlineMarkers: [{ afterHunkLine: 1, appliesTo: 'new' }],
        }),
      ]),
    )
    expect(result.plan.hunks[0]!.sourceStart).toBe(1)
  })

  test('a deletion that removes the source tail affects output EOF', () => {
    const result = success(plan('head\ntail', [hunk([deleted('tail')])]))
    expect(result.plan.output).toEqual({ lineCount: 1, hasFinalNewline: true, outputEofAffected: true })
  })

  test('consumes legacy output-level newline directives without old-side evidence', () => {
    const absent = success(
      plan('head\ntail', [
        hunk([deleted('tail')], { newline: { kind: 'legacy-output', outputAtEof: 'absent' } }),
      ]),
    )
    expect(absent.plan.output.hasFinalNewline).toBe(false)

    const present = success(
      plan('head\ntail', [
        hunk([deleted('tail')], { newline: { kind: 'legacy-output', outputAtEof: 'present' } }),
      ]),
    )
    expect(present.plan.output.hasFinalNewline).toBe(true)
  })

  test('legacy defaults do not rewrite newline state for a context-only EOF hunk', () => {
    const result = success(
      plan('only-line', [
        hunk([context('only-line')], {
          newline: { kind: 'legacy-output', outputAtEof: 'present' },
        }),
      ]),
    )
    expect(result.plan.output).toEqual({
      lineCount: 1,
      hasFinalNewline: false,
      outputEofAffected: false,
    })
  })

  test('a later deletion can make an earlier marked line the final output line', () => {
    const result = success(
      plan('old\ntail\n', [
        hunk([deleted('old'), added('new')], {
          newlineMarkers: [{ afterHunkLine: 1, appliesTo: 'new' }],
        }),
        hunk([deleted('tail')]),
      ]),
    )
    expect(result.plan.output.hasFinalNewline).toBe(false)
  })

  test('rejects a marked line when a later hunk leaves output after it', () => {
    const error = failure(
      plan('old\ntail\n', [
        hunk([deleted('old'), added('new')], {
          newlineMarkers: [{ afterHunkLine: 1, appliesTo: 'new' }],
        }),
        hunk([context('tail')]),
      ]),
    )
    expect(error.code).toBe('PATCH_NEWLINE_CONFLICT')
  })
})

describe('bounded planning and diagnostics', () => {
  test('distinguishes present but nonconsecutive old-side lines', () => {
    const error = failure(
      plan('last\ngap\nfirst\n', [
        hunk([context('first'), context('last')]),
      ]),
    )
    expect(error.code).toBe('PATCH_ANCHOR_NONCONSECUTIVE')
    expect(error.kind).toBe('nonconsecutive-fingerprint')
  })

  test('fails closed for invalid numeric limits', () => {
    const error = failure(
      plan('target\n', [hunk([context('target')])], {
        limits: { maxSourcePositionsScanned: Number.POSITIVE_INFINITY },
      }),
    )
    expect(error.code).toBe('PATCH_PLANNER_LIMIT')
  })

  test('uses an iterative compact frontier for many ordered hunks', () => {
    const lineCount = 2_000
    const source = Array.from({ length: lineCount }, (_, index) => `line-${index}`)
    const result = success(
      plan(
        `${source.join('\n')}\n`,
        source.map(line => hunk([context(line)])),
        {
          limits: {
            maxSourcePositionsScanned: 4_100_000,
            maxCandidatesTotal: 4_000,
            maxDpTransitions: 10_000,
            maxPredecessors: 4_000,
          },
        },
      ),
    )
    expect(result.plan.hunks).toHaveLength(lineCount)
  })

  test('fails closed on source scanning budget', () => {
    const error = failure(
      plan('a\nb\nc\n', [hunk([context('c')])], { limits: { maxSourcePositionsScanned: 1 } }),
    )
    expect(error.code).toBe('PATCH_PLANNER_LIMIT')
    expect(error.usage.sourcePositionsScanned).toBe(1)
  })

  test('charges every fingerprint comparison without allocating all starts', () => {
    const source = Array.from({ length: 400 }, () => 'same').join('\n')
    const lines = [
      ...Array.from({ length: 200 }, () => context('same')),
      context('missing'),
    ]
    const error = failure(
      plan(source, [hunk(lines)], {
        limits: { maxSourcePositionsScanned: 250 },
      }),
    )
    expect(error.code).toBe('PATCH_PLANNER_LIMIT')
    expect(error.usage.sourcePositionsScanned).toBe(250)
  })

  test('fails closed on per-hunk candidate retention budget', () => {
    const error = failure(
      plan('x\nx\n', [hunk([context('x')])], { limits: { maxCandidatesPerHunk: 1 } }),
    )
    expect(error.code).toBe('PATCH_PLANNER_LIMIT')
  })

  test('fails closed on hint, DP transition, and predecessor budgets', () => {
    expect(
      failure(
        plan('scope\ntarget\n', [hunk([context('target')], { hints: ['missing'] })], {
          limits: { maxHintComparisons: 0 },
        }),
      ).code,
    ).toBe('PATCH_PLANNER_LIMIT')
    expect(
      failure(plan('target\n', [hunk([context('target')])], { limits: { maxDpTransitions: 0 } })).code,
    ).toBe('PATCH_PLANNER_LIMIT')
    expect(
      failure(plan('target\n', [hunk([context('target')])], { limits: { maxPredecessors: 0 } })).code,
    ).toBe('PATCH_PLANNER_LIMIT')
  })

  test('diagnostic budget exhaustion preserves the primary failure', () => {
    const error = failure(
      plan('  target\n', [hunk([context('missing')])], {
        diagnostics: true,
        limits: { maxDiagnosticComparisons: 0 },
      }),
    )
    expect(error.code).toBe('PATCH_ANCHOR_NOT_FOUND')
    expect(error.diagnosticsTruncated).toBe(true)
    expect(error.usage.approximateComparisons).toBe(0)
  })

  test('fails closed when complete-plan newline validation exhausts DP budget', () => {
    const error = failure(
      plan('old\nold', [
        hunk([deleted('old'), added('new')], {
          newlineMarkers: [{ afterHunkLine: 1, appliesTo: 'new' }],
        }),
      ], { limits: { maxDpTransitions: 4 } }),
    )
    expect(error.code).toBe('PATCH_PLANNER_LIMIT')
    expect(error.usage.dpTransitions).toBe(4)
  })
})
