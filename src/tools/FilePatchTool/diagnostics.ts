import type { PlannerFailure } from './planner.js'
import {
  FilePatchError,
  type FilePatchDiagnosticMetadata,
  type FilePatchMutationOutcome,
  type FilePatchNearMatch,
  type FilePatchOperationType,
} from './types.js'

export type {
  FilePatchDiagnosticMetadata,
  FilePatchNearMatch,
} from './types.js'

/** Limits for work and text emitted by the diagnostic-only renderer. */
export type FilePatchDiagnosticLimits = {
  maxComparisons: number
  maxNearMatches: number
  maxCandidateCoordinates: number
  maxLineLength: number
  maxMessageLength: number
}

export const DEFAULT_FILE_PATCH_DIAGNOSTIC_LIMITS: FilePatchDiagnosticLimits = {
  maxComparisons: 2_000,
  maxNearMatches: 4,
  maxCandidateCoordinates: 20,
  maxLineLength: 160,
  maxMessageLength: 1_200,
}

export type FilePatchSourceEvidence = {
  /** Immutable execution-time source lines, in original source coordinates. */
  sourceLines: readonly string[]
  /** Old-side fingerprint lines for the failed hunk. */
  fingerprint?: readonly string[]
}

export type RenderPlannerFailureInput = {
  failure: PlannerFailure
  operation?: FilePatchOperationType
  moveTo?: string
  source?: FilePatchSourceEvidence
  /** Alias accepted for callers that already hold the source lines separately. */
  sourceLines?: readonly string[]
  /** Alias accepted for callers that call the old-side fingerprint `oldLines`. */
  fingerprint?: readonly string[]
  oldLines?: readonly string[]
  mutationOutcome?: FilePatchMutationOutcome
  limits?: Partial<FilePatchDiagnosticLimits>
}

export type RenderedPlannerFailure = {
  error: FilePatchError
  metadata: FilePatchDiagnosticMetadata
}

type DiagnosticState = {
  comparisons: number
  truncated: boolean
}

/**
 * Render planner evidence for the FilePatchTool boundary.
 *
 * This function only formats an already-decided planner failure. Approximate
 * comparisons are deliberately diagnostic-only: a near match is never turned
 * into a candidate or a write authorization. The returned metadata keeps
 * source coordinates separate from the user-facing, one-based hunk ordinal.
 */
export function renderPlannerFailure(
  input: RenderPlannerFailureInput,
): RenderedPlannerFailure {
  const failure = input.failure
  const limits = { ...DEFAULT_FILE_PATCH_DIAGNOSTIC_LIMITS, ...input.limits }
  const candidateCoordinates = (failure.candidateCoordinates ?? [])
    .slice(0, limits.maxCandidateCoordinates)
    .map(coordinate => ({ start: coordinate.start, end: coordinate.end }))
  const metadata: FilePatchDiagnosticMetadata = {
    code: failure.code,
    kind: failure.kind,
    path: failure.path,
    ...(failure.hunkIndex === undefined ? {} : { hunkIndex: failure.hunkIndex + 1 }),
    hunkCount: failure.hunkCount,
    candidateCoordinates,
    nearMatches: [],
    diagnosticsTruncated: failure.diagnosticsTruncated === true,
  }

  const state: DiagnosticState = { comparisons: 0, truncated: metadata.diagnosticsTruncated }
  const sourceLines = input.source?.sourceLines ?? input.sourceLines
  const fingerprint =
    input.source?.fingerprint ?? input.fingerprint ?? input.oldLines
  if (
    sourceLines !== undefined &&
    fingerprint !== undefined &&
    fingerprint.length > 0 &&
    shouldSearchNearMatches(failure)
  ) {
    metadata.nearMatches = findNearMatches(
      sourceLines,
      fingerprint,
      failure,
      limits,
      state,
    )
  }

  const message = renderMessage(failure, metadata, limits, state)
  metadata.diagnosticsTruncated ||= state.truncated

  const error = new FilePatchError(message, {
    code: failure.code,
    path: failure.path,
    operation: input.operation,
    moveTo: input.moveTo,
    ...(failure.hunkIndex === undefined
      ? {}
      : { hunkIndex: failure.hunkIndex + 1 }),
    hunkCount: failure.hunkCount,
    diagnostics: metadata,
    mutationOutcome: input.mutationOutcome ?? 'no-mutation',
  })
  return { error, metadata }
}

/** Convenience adapter for callers that only need the FilePatchError. */
export function plannerFailureAsFilePatchError(
  input: RenderPlannerFailureInput,
): FilePatchError {
  return renderPlannerFailure(input).error
}

function shouldSearchNearMatches(failure: PlannerFailure): boolean {
  // Ambiguity and exact candidate conflicts already have authoritative
  // coordinates. Searching approximate positions there adds noise and can
  // make an exact ambiguity look like a repairable mismatch.
  return (
    failure.kind === 'missing-fingerprint' ||
    failure.kind === 'missing-hint' ||
    failure.kind === 'hard-eof' ||
    failure.kind === 'ordering'
  )
}

function findNearMatches(
  sourceLines: readonly string[],
  fingerprint: readonly string[],
  failure: PlannerFailure,
  limits: FilePatchDiagnosticLimits,
  state: DiagnosticState,
): FilePatchNearMatch[] {
  const maxStart = Math.max(0, sourceLines.length - 1)
  const matches: FilePatchNearMatch[] = []
  let bestScore = Number.POSITIVE_INFINITY

  for (let sourceStart = 0; sourceStart <= maxStart; sourceStart += 1) {
    const comparison = compareWindow(sourceLines, fingerprint, sourceStart, state, limits)
    if (comparison === undefined) break
    if (comparison.score < bestScore) {
      bestScore = comparison.score
    }
    // Keep only credible candidates. A source line that shares no exact line
    // with the fingerprint is not useful repair guidance and can expose too
    // much of an unrelated file. A one-line fingerprint is allowed one small
    // textual divergence; longer fingerprints allow one divergent line.
    const threshold = Math.max(1, fingerprint.length)
    if (comparison.score > threshold || !comparison.credible) continue
    if (comparison.exactLines === 0 && comparison.score > 2) continue
    matches.push({
      sourceStart,
      sourceEnd: Math.min(sourceLines.length, sourceStart + fingerprint.length),
      score: comparison.score,
      divergence: {
        expectedLine: comparison.divergence.expectedLine,
        sourceLine: comparison.divergence.sourceLine,
        column: comparison.divergence.column,
      },
      expected: centeredSnippet(
        comparison.divergence.expected,
        comparison.divergence.column,
        limits.maxLineLength,
      ),
      actual: centeredSnippet(
        comparison.divergence.actual,
        comparison.divergence.column,
        limits.maxLineLength,
      ),
    })
  }

  if (state.truncated) return selectBestMatches(matches, limits.maxNearMatches)

  // The planner may have supplied exact coordinates for a hint or boundary
  // failure. Preserve them as the primary evidence; approximate windows are
  // supplementary and must not replace that evidence.
  const coordinates = failure.candidateCoordinates ?? []
  const coordinateSet = new Set(coordinates.map(coordinate => coordinate.start))
  const ranked = matches.filter(match => !coordinateSet.has(match.sourceStart))
  const retained = selectBestMatches(ranked, limits.maxNearMatches)
  return retained.length > 0 ? retained : selectBestMatches(matches, limits.maxNearMatches)
}

type WindowComparison = {
  score: number
  exactLines: number
  divergence: {
    expectedLine: number
    sourceLine: number
    column: number
    expected: string
    actual: string
  }
  credible: boolean
}

function compareWindow(
  sourceLines: readonly string[],
  fingerprint: readonly string[],
  sourceStart: number,
  state: DiagnosticState,
  limits: FilePatchDiagnosticLimits,
): WindowComparison | undefined {
  let score = 0
  let exactLines = 0
  let divergence:
    | WindowComparison['divergence']
    | undefined
  let credible = false

  for (let expectedLine = 0; expectedLine < fingerprint.length; expectedLine += 1) {
    if (!chargeDiagnosticComparison(state, limits)) return undefined
    const actual = sourceLines[sourceStart + expectedLine]
    const expected = fingerprint[expectedLine]!
    if (actual === undefined) {
      score += Math.max(2, Math.min(expected.length + 1, 32))
      divergence ??= {
        expectedLine,
        sourceLine: sourceStart + expectedLine,
        column: 0,
        expected,
        actual: '<end of file>',
      }
      continue
    }
    if (actual === expected) {
      exactLines += 1
      continue
    }
    const column = firstDivergenceColumn(expected, actual)
    const suffix = commonSuffixLength(expected.slice(column), actual.slice(column))
    credible ||= column >= 3 || suffix >= 3
    score += lineDifferenceScore(expected, actual)
    divergence ??= { expectedLine, sourceLine: sourceStart + expectedLine, column, expected, actual }
  }

  // An all-exact window is not a near match. Such a window is already
  // represented by planner candidate coordinates or is filtered by a hint.
  if (divergence === undefined) return undefined
  return { score, exactLines, divergence, credible }
}

function chargeDiagnosticComparison(
  state: DiagnosticState,
  limits: FilePatchDiagnosticLimits,
): boolean {
  if (state.comparisons >= limits.maxComparisons) {
    state.truncated = true
    return false
  }
  state.comparisons += 1
  return true
}

function lineDifferenceScore(expected: string, actual: string): number {
  // Near-match ranking is line-oriented. A long line with one reflowed token
  // is one divergent line, not hundreds of divergent characters. Credibility
  // is checked separately using the shared prefix/suffix around the witness.
  void expected
  void actual
  return 1
}

function commonSuffixLength(left: string, right: string): number {
  let count = 0
  while (
    count < left.length &&
    count < right.length &&
    left[left.length - count - 1] === right[right.length - count - 1]
  ) {
    count += 1
  }
  return count
}

function firstDivergenceColumn(expected: string, actual: string): number {
  const length = Math.min(expected.length, actual.length)
  let column = 0
  while (column < length && expected[column] === actual[column]) column += 1
  return column
}

function centeredSnippet(value: string, column: number, maxLength: number): string {
  if (value.length <= maxLength) return value
  const half = Math.max(1, Math.floor((maxLength - 1) / 2))
  const start = Math.max(0, Math.min(column - half, value.length - maxLength + 1))
  const end = Math.min(value.length, start + maxLength - 1)
  return `${start > 0 ? '…' : ''}${value.slice(start, end)}${end < value.length ? '…' : ''}`
}

function selectBestMatches(
  matches: readonly FilePatchNearMatch[],
  limit: number,
): FilePatchNearMatch[] {
  return [...matches]
    .sort((left, right) => left.score - right.score || left.sourceStart - right.sourceStart)
    .slice(0, limit)
}

function renderMessage(
  failure: PlannerFailure,
  metadata: FilePatchDiagnosticMetadata,
  limits: FilePatchDiagnosticLimits,
  state: DiagnosticState,
): string {
  const parts = [failure.message]
  if (metadata.candidateCoordinates.length > 0) {
    const ranges = metadata.candidateCoordinates
      .map(coordinate => `${coordinate.start + 1}-${coordinate.end}`)
      .join(', ')
    parts.push(`Candidate source ranges: ${ranges}.`)
  }
  if (metadata.nearMatches.length > 0) {
    if (metadata.nearMatches.length > 1) {
      parts.push(
        `Several non-authoritative near matches remain (${metadata.nearMatches.length}); none was selected.`,
      )
    } else {
      parts.push('One non-authoritative near match is shown; it was not selected.')
    }
    for (const match of metadata.nearMatches) {
      parts.push(
        `Near match at source lines ${match.sourceStart + 1}-${match.sourceEnd}: ` +
          `first divergence at line ${match.divergence.sourceLine + 1}, column ${match.divergence.column + 1}. ` +
          `expected ${JSON.stringify(match.expected)}; found ${JSON.stringify(match.actual)}.`,
      )
    }
  }
  if (failure.diagnostics && failure.diagnostics.length > 0) {
    const witnesses = failure.diagnostics
      .slice(0, limits.maxNearMatches)
      .map(item => `source line ${item.sourceLine + 1}`)
      .join(', ')
    parts.push(`Non-authoritative trimmed-line witnesses: ${witnesses}.`)
  }
  if (failure.diagnosticsTruncated || metadata.diagnosticsTruncated || state.truncated) {
    parts.push('Additional diagnostic detail was truncated; the primary failure is unchanged.')
  }
  return boundText(parts.join(' '), limits.maxMessageLength)
}

function boundText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  const marker = '… [truncated]'
  return `${text.slice(0, Math.max(0, maxLength - marker.length))}${marker}`
}
