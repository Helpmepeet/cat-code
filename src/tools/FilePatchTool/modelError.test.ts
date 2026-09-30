import { describe, expect, test } from 'bun:test'
import { applyPatchToBuffersPlanned } from './applier.js'
import { renderPlannerFailure } from './diagnostics.js'
import { planUpdateHunks } from './planner.js'
import { projectFilePatchErrorForModel, MAX_MODEL_PATCH_ERROR_LENGTH } from './modelError.js'
import { boundFilePatchDiagnosticMetadata, FilePatchError, serializeFilePatchError, type FilePatchDiagnosticMetadata, type FilePatchModelError } from './types.js'

function metadata(count = 10): FilePatchDiagnosticMetadata {
  return {
    code: 'PATCH_ANCHOR_AMBIGUOUS', kind: 'ambiguity', path: '/tmp/example.ts', hunkCount: 2,
    candidateCoordinates: Array.from({ length: count }, (_, index) => ({
      start: index * 3, end: index * 3 + 1, hunk: index < count - 1 ? 1 : 2,
    })),
    candidateCoordinatesOmitted: 5, nearMatches: [], diagnosticsTruncated: true,
  }
}

function errorWithEvidence(diagnostics = metadata()): FilePatchModelError {
  return serializeFilePatchError(new FilePatchError('Repeated diagnostic prose. '.repeat(80), {
    code: diagnostics.code, operation: 'update', path: diagnostics.path,
    hunkCount: 2, diagnostics,
  }))
}

describe('compact patch model errors', () => {
  test('samples across hunks, accumulates bounds once, and never mutates persisted evidence', () => {
    const bounded = boundFilePatchDiagnosticMetadata(metadata(50))
    expect(bounded.candidateCoordinates).toHaveLength(40)
    expect(bounded.candidateCoordinatesOmitted).toBe(15)
    expect(boundFilePatchDiagnosticMetadata(bounded)).toEqual(bounded)
    const persisted = errorWithEvidence(bounded)
    const before = JSON.stringify(persisted)
    const view = projectFilePatchErrorForModel(persisted)
    const evidence = view.failures[0]!.evidence!
    expect(evidence.kind).toBe('raw-hunk-candidates')
    expect(evidence.candidates.slice(0, 2)).toEqual([
      { hunk: 1, kind: 'lines', startLine: 1, endLine: 1 },
      { hunk: 2, kind: 'lines', startLine: 148, endLine: 148 },
    ])
    expect(evidence.omittedCandidateCount).toBe(49)
    expect(evidence.diagnosticsTruncated).toBe(true)
    expect(view.failures[0]!.repair).toContain('Read the intended regions')
    expect(view.failures[0]!.message).not.toContain('Repeated diagnostic prose')
    expect(view).not.toHaveProperty('diagnostics')
    expect(view).not.toHaveProperty('repair')
    expect(JSON.stringify(persisted)).toBe(before)
  })

  test('defines ordinary ranges and insertion boundaries independently of patch-envelope lines', () => {
    const diagnostics = metadata(0)
    diagnostics.candidateCoordinates = [
      { start: 4, end: 7, hunk: 1 }, { start: 8, end: 9, hunk: 2 },
      { start: 0, end: 0, hunk: 3 }, { start: 12, end: 12, hunk: 4 },
    ]
    const persisted = errorWithEvidence(diagnostics)
    persisted.patchSourceSpan = { startLine: 20, endLine: 23 }
    const primary = projectFilePatchErrorForModel(persisted).failures[0]!
    expect(primary.evidence!.candidates).toEqual([
      { hunk: 1, kind: 'lines', startLine: 5, endLine: 7 },
      { hunk: 2, kind: 'lines', startLine: 9, endLine: 9 },
      { hunk: 3, kind: 'insertion', afterLine: 0 },
      { hunk: 4, kind: 'insertion', afterLine: 12 },
    ])
    expect(primary.patchSourceSpan).toEqual({ kind: 'patch-envelope-lines', startLine: 20, endLine: 23 })
  })

  test('retains raw candidates that cannot participate in a complete ordered plan through aggregation', () => {
    const hunks = [
      { lines: [{ kind: 'context' as const, text: 'x' }], isEndOfFile: false },
      { lines: [{ kind: 'context' as const, text: 'y' }], isEndOfFile: false },
    ]
    // The final x is after every y and cannot participate, but is a raw candidate.
    let caught: unknown
    try {
      applyPatchToBuffersPlanned([{ type: 'update', path: '/tmp/raw', hunks }], new Map([
        ['/tmp/raw', { path: '/tmp/raw', exists: true, buffer: { content: 'x\ny\nx\ny\nx\n' } }],
      ]))
    } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(FilePatchError)
    const persisted = serializeFilePatchError(caught as FilePatchError)
    expect(persisted.details[0]!.diagnostics!.candidateCoordinates).toContainEqual({ hunk: 1, start: 4, end: 5 })
    const view = projectFilePatchErrorForModel(persisted)
    expect(view.failures).toHaveLength(1)
    expect(view.failures[0]!.evidence!.candidates).toContainEqual({ hunk: 1, kind: 'lines', startLine: 5, endLine: 5 })
    expect(JSON.stringify(view)).not.toContain('validPlanCount')
    expect(view.failures[0]!.evidence).not.toHaveProperty('plans')
  })

  test('sequential planner, renderer, metadata, and model caps account for every candidate', () => {
    const planned = planUpdateHunks({ path: '/tmp/many', source: `${'x\n'.repeat(55)}y\n`, hunks: [
      { lines: [{ kind: 'context', text: 'x' }] }, { lines: [{ kind: 'context', text: 'y' }] },
    ] })
    if (!('failure' in planned)) throw new Error('expected ambiguity')
    expect(planned.failure.candidateCoordinates).toHaveLength(40)
    expect(planned.failure.candidateCoordinatesOmitted).toBe(16)
    const rendered = renderPlannerFailure({ failure: planned.failure })
    expect(rendered.metadata.candidateCoordinatesOmitted).toBe(36)
    const view = projectFilePatchErrorForModel(serializeFilePatchError(rendered.error))
    expect(view.failures[0]!.evidence!.omittedCandidateCount).toBe(50)
    expect(view.failures[0]!.evidence!.candidates.some(candidate => candidate.hunk === 2)).toBe(true)
  })

  test('preserves independent failure omissions through repeated construction and serialization', () => {
    const details = Array.from({ length: 12 }, (_, index) => ({
      code: 'UNKNOWN', operation: 'update' as const, path: `/tmp/${index}`, message: 'Failed.',
    }))
    const first = new FilePatchError('Preflight failed.', { code: 'PATCH_PREFLIGHT_FAILED', details, omittedFailureCount: 2 })
    const rewrapped = new FilePatchError(first.message, {
      code: first.code, details: first.details, omittedFailureCount: first.omittedFailureCount,
    })
    const view = projectFilePatchErrorForModel(serializeFilePatchError(rewrapped))
    expect(view.failures).toHaveLength(8)
    expect(view.omittedFailureCount).toBe(6)
  })

  test('bounds escaped payloads by dropping optional locations then whole failures with explicit counts', () => {
    const persisted = errorWithEvidence(metadata(40))
    persisted.details = Array.from({ length: 20 }, () => ({
      code: 'UNKNOWN', operation: 'update', path: '\u0000'.repeat(10_000),
      moveTo: '\u0001'.repeat(10_000), message: '\u0002'.repeat(10_000), diagnostics: metadata(40),
    }))
    persisted.omittedFailureCount = 3
    const view = projectFilePatchErrorForModel(persisted)
    const json = JSON.stringify(view)
    expect(json.length).toBeLessThanOrEqual(MAX_MODEL_PATCH_ERROR_LENGTH)
    expect(JSON.parse(json).failures.length).toBeGreaterThan(0)
    expect(view.omittedFailureCount).toBe(23 - view.failures.length)
    expect(view.failures[0]!.evidence!.candidates).toEqual([])
    expect(view.failures[0]!.evidence!.omittedCandidateCount).toBe(45)
  })

  for (const mutationOutcome of ['no-mutation', 'complete-rollback', 'incomplete-recovery'] as const) {
    test(`gives safe guidance for ${mutationOutcome}`, () => {
      const persisted = errorWithEvidence()
      persisted.mutationOutcome = mutationOutcome
      persisted.repair = 'Recovery information: published destination may remain.'
      const view = projectFilePatchErrorForModel(persisted)
      expect(view.mutationOutcome).toBe(mutationOutcome)
      if (mutationOutcome === 'incomplete-recovery') {
        expect(view.failures[0]!.repair).toContain('before further mutation')
        expect(view.failures[0]!.repair).not.toContain('retry')
        expect(view.recovery).toContain('published destination may remain')
      } else if (mutationOutcome === 'complete-rollback') {
        expect(view.failures[0]!.repair).toContain('Read the restored files')
      } else {
        expect(view.failures[0]!.repair).toContain('retry')
      }
    })
  }

  test('handles legacy evidence, unknown codes, parser errors, and unknown mutation status without inventing facts', () => {
    const persisted = errorWithEvidence()
    delete persisted.diagnostics!.candidateCoordinatesOmitted
    const legacy = projectFilePatchErrorForModel(persisted)
    expect(legacy.failures[0]!.evidence).not.toHaveProperty('omittedCandidateCount')
    expect(legacy.failures[0]!.evidence!.candidates).toHaveLength(6)
    const parser = serializeFilePatchError(new FilePatchError('Unexpected patch header.', { code: 'UNKNOWN' }))
    delete (parser as Partial<FilePatchModelError>).mutationOutcome
    const view = projectFilePatchErrorForModel(parser)
    expect(view).not.toHaveProperty('mutationOutcome')
    expect(view.failures[0]).toMatchObject({ code: 'UNKNOWN', message: 'Unexpected patch header.' })
    expect(view.failures[0]).not.toHaveProperty('hunk')
    expect(view.failures[0]).not.toHaveProperty('path')
    expect(view.failures[0]!.repair).toContain('Verify mutation and recovery status')
  })
})
