import { describe, expect, test } from 'bun:test'
import { renderPlannerFailure, type FilePatchDiagnosticMetadata } from './diagnostics.js'
import { planUpdateHunks, type PlannerFailure } from './planner.js'
import { serializeFilePatchError } from './types.js'

function failureFor(source: string, expected: string) {
  const result = planUpdateHunks({
    path: '/tmp/diagnostics.ts',
    source,
    hunks: [{ lines: [{ kind: 'context', text: expected }] }],
  })
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected planner failure')
  return (result as { ok: false; failure: PlannerFailure }).failure
}

describe('bounded planner failure diagnostics', () => {
  test('keeps primary metadata and original candidate coordinates stable', () => {
    const failure: PlannerFailure = {
      code: 'PATCH_ANCHOR_AMBIGUOUS',
      kind: 'ambiguity',
      path: '/tmp/repeated.ts',
      hunkIndex: 1,
      hunkCount: 3,
      candidateCoordinates: [
        { start: 4, end: 6 },
        { start: 12, end: 14 },
      ],
      message: 'The complete ordered update is ambiguous.',
      usage: {
        sourcePositionsScanned: 0,
        candidatesRetained: 2,
        hintComparisons: 0,
        dpTransitions: 0,
        predecessorsStored: 0,
        approximateComparisons: 0,
      },
    }

    const rendered = renderPlannerFailure({
      failure,
      operation: 'update',
      moveTo: '/tmp/moved.ts',
    })

    expect(rendered.error).toMatchObject({
      code: 'PATCH_ANCHOR_AMBIGUOUS',
      path: '/tmp/repeated.ts',
      operation: 'update',
      moveTo: '/tmp/moved.ts',
      hunkIndex: 2,
      hunkCount: 3,
    })
    expect(rendered.error.mutationOutcome).toBe('no-mutation')
    expect(rendered.metadata.candidateCoordinates).toEqual([
      { start: 4, end: 6 },
      { start: 12, end: 14 },
    ])
    expect(rendered.error.message).toContain('5-6')
    expect(rendered.error.message).toContain('13-14')
    expect(rendered.metadata.nearMatches).toEqual([])
  })

  test('centers a long-line near match on the first divergence', () => {
    const actual = `${'common-prefix-'.repeat(40)}actual-tail`
    const expected = `${'common-prefix-'.repeat(40)}expected-tail`
    const failure = failureFor(`${actual}\n`, expected)

    const rendered = renderPlannerFailure({
      failure,
      sourceLines: [actual],
      fingerprint: [expected],
    })

    expect(rendered.metadata.nearMatches).toHaveLength(1)
    const near = rendered.metadata.nearMatches[0]!
    expect(near.sourceStart).toBe(0)
    expect(near.divergence.column).toBe('common-prefix-'.repeat(40).length)
    expect(near.actualLength).toBe(actual.length)
    expect(rendered.error.message).toContain('first divergence at line 1')
    expect(rendered.error.message).not.toContain(actual)
    expect(rendered.error.message).not.toContain('actual-tail')
  })

  test('does not retain full source lines in serialized diagnostic metadata', () => {
    const prefix = 'shared-prefix-'.repeat(8_000)
    const actual = `${prefix}actual-tail`
    const expected = `${prefix}expected-tail`
    const rendered = renderPlannerFailure({
      failure: failureFor(`${actual}\n`, expected),
      sourceLines: [actual],
      fingerprint: [expected],
    })

    const serialized = JSON.stringify(serializeFilePatchError(rendered.error))
    expect(serialized.length).toBeLessThan(5_000)
    expect(serialized).not.toContain(prefix)
    expect(Object.keys(rendered.metadata.nearMatches[0]!.divergence)).toEqual([
      'expectedLine',
      'sourceLine',
      'column',
    ])
  })

  test('reports uncertainty when multiple approximate candidates are credible', () => {
    const failure = failureFor('target-alpha\ntarget-beta\n', 'target-gamma')
    const rendered = renderPlannerFailure({
      failure,
      sourceLines: ['target-alpha', 'target-beta'],
      fingerprint: ['target-gamma'],
    })

    expect(rendered.metadata.nearMatches.map(match => match.sourceStart)).toEqual([0, 1])
    expect(rendered.error.message).toContain('Several non-authoritative near matches remain (2)')
    expect(rendered.error.message).toContain('source lines 1-1')
    expect(rendered.error.message).toContain('source lines 2-2')
    expect(rendered.error.message).not.toContain('target-alpha\ntarget-beta')
  })

  test('diagnostic budget truncation preserves the primary failure', () => {
    const failure = failureFor('actual\n', 'expected')
    const rendered = renderPlannerFailure({
      failure,
      sourceLines: ['actual'],
      fingerprint: ['expected'],
      limits: { maxComparisons: 0 },
    })

    expect(rendered.error.code).toBe('PATCH_ANCHOR_NOT_FOUND')
    expect(rendered.error.path).toBe('/tmp/diagnostics.ts')
    expect(rendered.error.message).toContain(failure.message)
    expect(rendered.error.message).toContain('primary failure is unchanged')
    expect(rendered.metadata.diagnosticsTruncated).toBe(true)
    expect(rendered.metadata.nearMatches).toEqual([])
  })

  test('bounds coordinates and near-match text without running placement', () => {
    const failure: PlannerFailure = {
      code: 'PATCH_ANCHOR_NOT_FOUND',
      kind: 'missing-fingerprint',
      path: '/tmp/bounded.ts',
      hunkCount: 1,
      candidateCoordinates: Array.from({ length: 10 }, (_, index) => ({
        start: index,
        end: index + 1,
      })),
      message: 'The anchor is missing.',
      usage: {
        sourcePositionsScanned: 0,
        candidatesRetained: 0,
        hintComparisons: 0,
        dpTransitions: 0,
        predecessorsStored: 0,
        approximateComparisons: 0,
      },
    }
    const rendered = renderPlannerFailure({
      failure,
      sourceLines: ['a'.repeat(500)],
      fingerprint: ['b'.repeat(500)],
      limits: {
        maxCandidateCoordinates: 2,
        maxLineLength: 40,
        maxMessageLength: 500,
      },
    })

    expect(rendered.metadata.candidateCoordinates).toHaveLength(2)
    expect(rendered.metadata.nearMatches).toHaveLength(0)
    expect(rendered.error.message.length).toBeLessThanOrEqual(500)
    expect(rendered.error.diagnostics).toEqual(rendered.metadata)
    const metadata: FilePatchDiagnosticMetadata = rendered.metadata
    expect(metadata.code).toBe('PATCH_ANCHOR_NOT_FOUND')
  })

  test('never serializes source text and bounds externally supplied paths', () => {
    const actual = 'private-source-value'
    const expected = 'private-source-other'
    const rendered = renderPlannerFailure({
      failure: {
        ...failureFor(`${actual}\n`, expected),
        path: `/${'p'.repeat(1_000_000)}`,
      },
      sourceLines: [actual],
      fingerprint: [expected],
      moveTo: `/${'m'.repeat(1_000_000)}`,
    })

    const serialized = JSON.stringify(serializeFilePatchError(rendered.error))
    expect(serialized.length).toBeLessThan(5_000)
    expect(serialized).not.toContain(actual)
    expect(serialized).not.toContain('private-source-value')
    expect(rendered.metadata.path.length).toBeLessThanOrEqual(512)
    expect(rendered.metadata.diagnosticsTruncated).toBe(true)
  })
})
