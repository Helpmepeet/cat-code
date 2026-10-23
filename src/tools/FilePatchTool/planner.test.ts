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

describe('strict indentation repair and source reordering', () => {
  test.each([['\t\t', '\t'], ['        ', '      ']])(
    'repairs %j to %j with explicit added-line metadata',
    (from, to) => {
      const result = success(plan(`${to}old\n`, [
        hunk([deleted(`${from}old`), added(`${from}new`)]),
      ]))
      expect(result.plan.hunks[0].indentationAdjustment).toEqual({ from, to })
      expect(result.plan.reordered).toBeUndefined()
      expect(result.plan.hunks[0].forwardMatchCount).toBeUndefined()
    },
  )

  test('rejects an added line shorter than the old-side prefix', () => {
    expect(failure(plan('      old\n', [
      hunk([deleted('        old'), added('    new')]),
    ])).code).toBe('PATCH_ANCHOR_NOT_FOUND')
  })

  test('rejects inconsistent old-side indentation changes', () => {
    expect(failure(plan('  one\n   two\n', [
      hunk([deleted('    one'), deleted('    two'), added('    new')]),
    ])).code).toBe('PATCH_ANCHOR_NOT_FOUND')
  })

  test('rejects multiple adjusted ranges even with different replacement prefixes', () => {
    expect(failure(plan('  old\n    old\n', [
      hunk([deleted('      old'), added('      new')]),
    ])).code).toBe('PATCH_ANCHOR_AMBIGUOUS')
  })

  test('later exact constraints can make adjusted placement strictly unique', () => {
    const result = success(plan('  old\nfence\n    old\n', [
      hunk([deleted('      old'), added('      new')]),
      hunk([context('fence')]),
    ]))
    expect(result.plan.hunks.map(candidate => candidate.sourceStart)).toEqual([0, 1])
    expect(result.plan.hunks[0].indentationAdjustment).toEqual({ from: '      ', to: '  ' })
  })

  test('a raw exact match blocked by hints does not authorize indentation repair', () => {
    expect(failure(plan('    old\nscope\n  old\n', [
      hunk([deleted('    old'), added('    new')], { hints: ['scope'] }),
    ])).code).toBe('PATCH_HINT_NOT_FOUND')
  })

  test('keeps relative Python indentation including the block end', () => {
    const lines = [
      context('        if ready:'),
      deleted('            old()'),
      added('            new()'),
      context('        after()'),
    ]
    const result = success(plan('    if ready:\n        old()\n    after()\n', [hunk(lines)]))
    const adjustment = result.plan.hunks[0].indentationAdjustment!
    expect(adjustment).toEqual({ from: '        ', to: '    ' })
    expect(lines.filter(line => line.kind !== 'delete').map(line =>
      adjustment.to + line.text.slice(adjustment.from.length),
    )).toEqual(['    if ready:', '        new()', '    after()'])
  })

  test('preserves exact candidates instead of including indentation alternatives', () => {
    const result = success(plan('    old\n  old\n', [
      hunk([deleted('    old'), added('    new')]),
    ]))
    expect(result.plan.hunks[0].sourceStart).toBe(0)
    expect(result.plan.hunks[0].indentationAdjustment).toBeUndefined()
  })

  test('indentation cannot authorize a closing-delimiter forward choice', () => {
    expect(failure(plan('  anchor\n}\n}\n', [
      hunk([deleted('    anchor'), added('    updated')]),
      hunk([deleted('}'), added('};')]),
    ])).code).toBe('PATCH_ANCHOR_AMBIGUOUS')
  })

  test('indentation cannot combine with reordering', () => {
    expect(failure(plan('first\n  second\n', [
      hunk([deleted('    second'), added('    new')]),
      hunk([context('first')]),
    ])).code).toBe('PATCH_ORDER_CONFLICT')
  })

  test('ambiguous candidates cannot authorize source reordering', () => {
    expect(failure(plan('first\nfirst\nsecond\n', [
      hunk([context('second')]), hunk([context('first')]),
    ])).code).toBe('PATCH_ORDER_CONFLICT')
  })

  test('reordering still validates final-output newline claims', () => {
    expect(failure(plan('first\nsecond\n', [
      hunk([deleted('second'), added('new second')]),
      hunk([deleted('first'), added('new first')], {
        newlineMarkers: [{ afterHunkLine: 1, appliesTo: 'new' }],
      }),
    ])).code).toBe('PATCH_ORDER_CONFLICT')
  })

  test('adjusted candidates honor hints and old-side newline markers', () => {
    const result = success(plan('scope\n  old', [
      hunk([deleted('    old'), added('    new')], {
        hints: ['scope'], newlineMarkers: [{ afterHunkLine: 0, appliesTo: 'old' }],
      }),
    ]))
    expect(result.plan.hunks[0].diagnosticHintLines).toEqual([0])
    expect(result.plan.output.hasFinalNewline).toBe(true)
    expect(failure(plan('scope\n  old\n', [
      hunk([deleted('    old'), added('    new')], {
        newlineMarkers: [{ afterHunkLine: 0, appliesTo: 'old' }],
      }),
    ])).code).toBe('PATCH_NEWLINE_CONFLICT')
  })

  test('blank old lines match blank source lines and added blank bytes are unchanged', () => {
    const result = success(plan('  old\n\n', [
      hunk([deleted('    old'), context(''), added('    new'), added(' \t')]),
    ]))
    expect(result.plan.hunks[0].indentationAdjustment).toEqual({ from: '    ', to: '  ' })
    const whitespaceBlank = success(plan('  old\n \n', [
      hunk([deleted('    old'), context(''), added('    new')]),
    ]))
    expect(whitespaceBlank.plan.hunks[0].indentationAdjustment).toEqual({ from: '    ', to: '  ' })
  })

  test('does not normalize trailing whitespace, punctuation, or tab widths', () => {
    for (const source of ['  old \n', '  old;\n']) {
      expect(failure(plan(source, [
        hunk([deleted('    old'), added('    new')]),
      ])).code).toBe('PATCH_ANCHOR_NOT_FOUND')
    }
    expect(failure(plan('  old\n  \ttail\n', [
      hunk([deleted('    old'), context('        tail'), added('    new')]),
    ])).code).toBe('PATCH_ANCHOR_NOT_FOUND')
  })

  test('repair discovery fails closed on its shared scan budget', () => {
    const source = '  old\n'
    const hunks = [hunk([deleted('    old'), added('    new')])]
    const result = success(plan(source, hunks))
    expect(failure(plan(source, hunks, {
      limits: { maxSourcePositionsScanned: result.usage.sourcePositionsScanned - 1 },
    })).code).toBe('PATCH_PLANNER_LIMIT')
  })
})

describe('closing-delimiter forward placement', () => {
  const anchor = () => hunk([deleted('anchor'), added('updated')])
  const closing = (text = '}') => hunk([deleted(text), added(`${text} // changed`)])

  test('selects the first exact closing update and annotates every tie-break', () => {
    const result = success(plan('anchor\n}\n}\n}\n}\n', [anchor(), closing(), closing()]))
    expect(result.plan.hunks.map(candidate => [candidate.sourceStart, candidate.forwardMatchCount]))
      .toEqual([[0, undefined], [1, 3], [2, 3]])
  })

  test('keeps indentation exact and admits whole multiline closing fingerprints', () => {
    const result = success(plan('anchor\n}\n  }\n  });\n  }\n  });\n', [
      anchor(),
      hunk([context('  }'), deleted('  });'), added('  }); // changed')]),
    ]))
    expect(result.plan.hunks[1]).toMatchObject({ sourceStart: 2, forwardMatchCount: 2 })
  })

  test.each(['', '   ', '{', '}, 1000)', 'this.syncSessions()', 'code();\n}'])(
    'rejects ambiguous noneligible fingerprint %j',
    text => {
      const lines = text.split('\n')
      expect(failure(plan(`anchor\n${text}\n${text}\n`, [
        anchor(), hunk([...lines.map(deleted), added('replacement')]),
      ])).code).toBe('PATCH_ANCHOR_AMBIGUOUS')
    },
  )

  test('rejects ambiguous first anchors even when only one can reach the closings', () => {
    expect(failure(plan('anchor\n}\n}\nanchor\n', [anchor(), closing()])).code)
      .toBe('PATCH_ANCHOR_AMBIGUOUS')
  })

  test('does not treat an insertion as a unique first source anchor', () => {
    expect(failure(plan('}\n}\n', [hunk([added('anchor')]), closing()])).code)
      .toBe('PATCH_ANCHOR_AMBIGUOUS')
  })

  test('rejects syncSessions ambiguity between verify and onSessionsChanged', () => {
    expect(failure(plan('anchor\nverify() {\n  this.syncSessions()\n}\nonSessionsChanged() {\n  this.syncSessions()\n}\n', [
      anchor(), hunk([deleted('  this.syncSessions()'), added('  this.refreshSessions()')]),
    ])).code).toBe('PATCH_ANCHOR_AMBIGUOUS')
  })

  test('punctuation choices cannot hide a later real-code ambiguity', () => {
    expect(failure(plan('anchor\n}\ncode\n}\ncode\n', [
      anchor(), closing(), hunk([deleted('code'), added('new code')]),
    ])).code).toBe('PATCH_ANCHOR_AMBIGUOUS')
  })

  test('honors whole-line hints without treating them as scope boundaries', () => {
    const result = success(plan('anchor\n}\nscope\n}\n}\n', [
      anchor(), hunk([deleted('}'), added('};')], { hints: [' scope '] }),
    ]))
    expect(result.plan.hunks[1]).toMatchObject({
      sourceStart: 3, forwardMatchCount: 2, diagnosticHintLines: [2],
    })
  })

  test('preserves unique complete plans despite ambiguous raw first candidates', () => {
    const result = success(plan('anchor\n}\nfence\nanchor\n}\n', [
      anchor(), closing(), hunk([context('fence')]),
    ]))
    expect(result.plan.hunks.map(candidate => candidate.sourceStart)).toEqual([0, 1, 2])
    expect(result.plan.hunks.every(candidate => candidate.forwardMatchCount === undefined)).toBe(true)
  })

  test('counts only placements that can precede the remaining hunks', () => {
    const result = success(plan('anchor\n}\n}\nfence\n}\n', [
      anchor(), closing(), hunk([context('fence')]),
    ]))
    expect(result.plan.hunks[1]).toMatchObject({ sourceStart: 1, forwardMatchCount: 2 })
  })

  test('newline constraints resolve closings before fallback and remain unannotated', () => {
    const result = success(plan('anchor\n}\n}', [
      anchor(), hunk([deleted('}'), added('};')], {
        newlineMarkers: [{ afterHunkLine: 0, appliesTo: 'old' }],
      }),
    ]))
    expect(result.plan.hunks[1].sourceStart).toBe(2)
    expect(result.plan.hunks[1].forwardMatchCount).toBeUndefined()
  })

  test('allows raw real-code duplicates when full-plan ordering makes them unique', () => {
    const result = success(plan('anchor\n}\n}\ncode\nfence\ncode\n', [
      anchor(), closing(), hunk([context('code')]), hunk([context('fence')]),
    ]))
    expect(result.plan.hunks.map(candidate => candidate.sourceStart)).toEqual([0, 1, 3, 4])
    expect(result.plan.hunks[1].forwardMatchCount).toBe(2)
    expect(result.plan.hunks[2].forwardMatchCount).toBeUndefined()
  })

  test('fallback preserves a later source-EOF newline constraint', () => {
    const result = success(plan('anchor\n}\n}\n}', [
      anchor(), closing(), hunk([deleted('}'), added('];')], {
        newlineMarkers: [{ afterHunkLine: 0, appliesTo: 'old' }],
      }),
    ]))
    expect(result.plan.hunks.map(candidate => candidate.sourceStart)).toEqual([0, 1, 3])
    expect(result.plan.hunks[1].forwardMatchCount).toBe(2)
    expect(result.plan.hunks[2].forwardMatchCount).toBeUndefined()
    expect(result.plan.output.hasFinalNewline).toBe(true)
  })

  test('missing and invalid later insertion anchors still fail', () => {
    expect(failure(plan('anchor\n}\n}\n', [
      anchor(), closing(), hunk([context('missing')]),
    ])).code).toBe('PATCH_ANCHOR_NOT_FOUND')
    expect(failure(plan('anchor\n}\n}\n', [
      anchor(), closing(), hunk([added('insert')]),
    ])).code).toBe('PATCH_INVALID_INSERTION')
  })

  test('does not depend on diagnostic witness budgets', () => {
    const result = success(plan('anchor\n}\n}\n}\n', [anchor(), closing()], {
      diagnostics: true, limits: { maxWitnessTransitions: 0, maxWitnessNodes: 0 },
    }))
    expect(result.plan.hunks[1].forwardMatchCount).toBe(3)
  })

  test('fails closed when fallback exhausts the shared planning budget', () => {
    const source = 'anchor\n}\n}\n}\n'
    const hunks = [anchor(), closing()]
    const complete = success(plan(source, hunks))
    expect(failure(plan(source, hunks, {
      limits: { maxDpTransitions: complete.usage.dpTransitions - 1 },
    })).code).toBe('PATCH_PLANNER_LIMIT')
    expect(failure(plan(source, hunks, {
      limits: { maxCandidatesPerHunk: 2 },
    })).code).toBe('PATCH_PLANNER_LIMIT')
  })
})

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

  test('exact ambiguity skips trimmed diagnostics even when whitespace near matches exist', () => {
    const error = failure(plan('x\n x \nx\n', [hunk([context('x'), added('changed')])], {
      diagnostics: true,
    }))
    expect(error.code).toBe('PATCH_ANCHOR_AMBIGUOUS')
    expect(error.diagnostics).toBeUndefined()
    expect(error.usage.approximateComparisons).toBe(0)
  })

  test('reorders uniquely anchored nonoverlapping hunks with original identity', () => {
    const result = success(
      plan('first\nsecond\n', [
        hunk([context('second')]),
        hunk([context('first')]),
      ]),
    )
    expect(result.plan.reordered).toBe(true)
    expect(result.plan.hunks.map(candidate => candidate.hunkIndex)).toEqual([1, 0])
  })

  test('rejects overlapping consumed ranges', () => {
    const error = failure(
      plan('a\nb\nc\n', [
        hunk([context('a'), context('b')]),
        hunk([context('b'), context('c')]),
      ]),
    )
    expect(error.kind).toBe('overlap')
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

describe('bounded complete-plan ambiguity witnesses', () => {
  test('retains two distinct valid ordered plans, excluding candidates after every continuation', () => {
    const source = 'x\ny\nx\ny\nx\n'
    const hunks = [hunk([context('x')]), hunk([context('y')])]
    const error = failure(plan(source, hunks, { diagnostics: true }))
    const witnesses = error.completePlanWitnesses!
    expect(witnesses).toHaveLength(2)
    expect(new Set(witnesses.map(witness => JSON.stringify(witness.placements))).size).toBe(2)
    for (const witness of witnesses) {
      expect(witness.placementsOmitted).toBe(0)
      expect(witness.placements).toHaveLength(2)
      const [first, second] = witness.placements
      expect(first!.hunkIndex).toBe(0)
      expect(second!.hunkIndex).toBe(1)
      expect(first!.end).toBeLessThanOrEqual(second!.start)
      expect(source.split('\n')[first!.start]).toBe('x')
      expect(source.split('\n')[second!.start]).toBe('y')
      expect(first!.start).not.toBe(4)
    }
  })

  test('keeps both witnesses valid under old and new newline constraints at EOF', () => {
    const error = failure(plan('x\nx\nend', [
      hunk([context('x'), added('changed')]),
      hunk([context('end')], { newlineMarkers: [{ afterHunkLine: 0, appliesTo: 'both' }] }),
    ], { diagnostics: true }))
    expect(error.code).toBe('PATCH_ANCHOR_AMBIGUOUS')
    expect(error.completePlanWitnesses!.map(witness => witness.placements)).toEqual([
      [{ hunkIndex: 0, start: 0, end: 1 }, { hunkIndex: 1, start: 2, end: 3 }],
      [{ hunkIndex: 0, start: 1, end: 2 }, { hunkIndex: 1, start: 2, end: 3 }],
    ])
  })

  test('does not count different hint witnesses as different placement sequences', () => {
    const error = failure(plan('scope\nscope\nx\nx\n', [
      hunk([context('x')], { hints: ['scope'] }),
    ], { diagnostics: true }))
    expect(error.completePlanWitnesses!.map(witness => witness.placements[0]!.start)).toEqual([2, 3])
    success(plan('scope\nscope\nx\n', [hunk([context('x')], { hints: ['scope'] })], { diagnostics: true }))
  })

  test('diagnostic reconstruction exhaustion preserves exact ambiguity and planning usage', () => {
    const base = failure(plan('x\nx\n', [hunk([context('x')])]))
    for (const limits of [{ maxWitnessTransitions: 0 }, { maxWitnessNodes: 0 }]) {
      const bounded = failure(plan('x\nx\n', [hunk([context('x')])], { diagnostics: true, limits }))
      expect(bounded.code).toBe(base.code)
      expect(bounded.usage).toEqual(base.usage)
      expect(bounded.completePlanWitnesses).toEqual([])
      expect(bounded.witnessReconstructionTruncated).toBe(true)
    }
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

  test('accounts for discovery coordinates discarded by hint and EOF failure caps', () => {
    for (const overrides of [{ hints: ['missing'] }, { isEndOfFile: true }]) {
      const error = failure(plan(`${'x\n'.repeat(55)}tail\n`, [hunk([context('x')], overrides)]))
      expect(error.candidateCoordinates).toHaveLength(40)
      expect(error.candidateCoordinates![0]).toEqual({ hunkIndex: 0, start: 0, end: 1 })
      expect(error.candidateCoordinatesOmitted).toBe(15)
      expect(error.diagnosticsTruncated).toBe(true)
    }
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
