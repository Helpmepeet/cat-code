import { candidateOmissions, sampleHunkCoordinates } from './evidence.js'
import type { PlannerFailure } from './planner.js'
import {
  boundFilePatchDiagnosticMetadata,
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
  maxSourceLines: number
  maxSourceCharacters: number
  maxCandidateWindows: number
  maxLineLength: number
  maxMessageLength: number
}

export const DEFAULT_FILE_PATCH_DIAGNOSTIC_LIMITS: FilePatchDiagnosticLimits = {
  maxComparisons: 2_000,
  maxNearMatches: 4,
  maxCandidateCoordinates: 20,
  maxSourceLines: 100_000,
  maxSourceCharacters: 2_000_000,
  maxCandidateWindows: 64,
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
  /** Off for validation, which can run before the mutation permission decision. */
  includeSourceText?: boolean
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
  scannedLines: number
  comparedCharacters: number
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
  const coordinates = failure.candidateCoordinates ?? []
  const candidateCoordinates = sampleHunkCoordinates(coordinates, limits.maxCandidateCoordinates)
    .map(coordinate => ({ start: coordinate.start, end: coordinate.end,
      ...(coordinate.hunkIndex === undefined ? {} : { hunk: coordinate.hunkIndex + 1 }),
    }))
  const omitted = candidateOmissions(failure.candidateCoordinatesOmitted,
    failure.diagnosticsTruncated === true, coordinates.length - candidateCoordinates.length)
  let metadata: FilePatchDiagnosticMetadata = {
    code: failure.code,
    kind: failure.kind,
    path: failure.path,
    ...(failure.hunkIndex === undefined ? {} : { hunkIndex: failure.hunkIndex + 1 }),
    hunkCount: failure.hunkCount,
    candidateCoordinates,
    ...(omitted === undefined ? {} : { candidateCoordinatesOmitted: omitted }),
    ...(failure.completePlanWitnesses === undefined ? {} : {
      completePlanWitnesses: failure.completePlanWitnesses.map(witness => ({
        placements: witness.placements.map(placement => ({
          start: placement.start, end: placement.end, hunk: placement.hunkIndex + 1,
        })),
        placementsOmitted: witness.placementsOmitted,
      })),
    }),
    ...(failure.witnessReconstructionTruncated === undefined ? {} : {
      witnessReconstructionTruncated: failure.witnessReconstructionTruncated,
    }),
    nearMatches: [],
    diagnosticsTruncated: failure.diagnosticsTruncated === true || coordinates.length > candidateCoordinates.length,
  }

  const state: DiagnosticState = {
    comparisons: 0, truncated: false, scannedLines: 0, comparedCharacters: 0,
  }
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
    metadata.nearMatchSearch = {
      complete: !state.truncated,
      scannedLines: state.scannedLines,
      totalLines: sourceLines.length,
    }
    const near = metadata.nearMatches[0]
    if (input.includeSourceText && failure.code === 'PATCH_ANCHOR_NOT_FOUND' && near) {
      const actual = sourceLines[near.divergence.sourceLine]
      if (actual !== undefined) {
        near.actual = centeredSnippet(actual, near.divergence.column, limits.maxLineLength)
        near.actualTruncated = actual.length > limits.maxLineLength
      }
    }
  }

  const message = renderMessage(failure, metadata, limits, state)
  metadata.diagnosticsTruncated ||= state.truncated
  metadata = boundFilePatchDiagnosticMetadata(metadata)

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
    failure.kind === 'nonconsecutive-fingerprint' ||
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
  const matches: FilePatchNearMatch[] = []
  const anchorOffset = fingerprint.reduce((best, line, index) =>
    line.trim().length > fingerprint[best]!.trim().length ? index : best, 0)
  const anchor = fingerprint[anchorOffset]!
  const preferred = new Set([
    ...(failure.diagnostics ?? [])
      .filter(item => item.hunkIndex === failure.hunkIndex)
      .map(item => item.sourceLine),
    ...(failure.candidateCoordinates ?? []).map(item => item.start),
  ])
  const windows = new Map<number, number>()
  let remainingCharacters = limits.maxSourceCharacters
  if (anchor.length > remainingCharacters) state.truncated = true
  else {
    remainingCharacters -= anchor.length
    const anchorText = comparisonText(anchor)
    const anchorPairs = characterPairs(anchorText)
    for (let sourceLine = 0; sourceLine < sourceLines.length; sourceLine += 1) {
      if (sourceLine >= limits.maxSourceLines) {
        state.truncated = true
        break
      }
      const line = sourceLines[sourceLine]!
      if (line.length > remainingCharacters) {
        state.truncated = true
        continue
      }
      remainingCharacters -= line.length
      state.scannedLines++
      const start = sourceLine - anchorOffset
      if (start < 0 || preferred.has(start)) continue
      const actual = comparisonText(line)
      const similarity = pairSimilarity(anchorText, actual, anchorPairs)
      if (similarity < 0.55 || !credibleTextAgreement(anchorText, actual, similarity)) continue
      windows.set(start, similarity)
      if (windows.size > limits.maxCandidateWindows) {
        const worst = [...windows].sort((left, right) => left[1] - right[1] || right[0] - left[0])[0]!
        windows.delete(worst[0])
        state.truncated = true
      }
    }
  }
  const candidates = [
    ...preferred,
    ...[...windows].sort((left, right) => right[1] - left[1] || left[0] - right[0]).map(([start]) => start),
  ]
  for (const sourceStart of candidates) {
    if (sourceStart < 0 || sourceStart >= sourceLines.length) continue
    const comparison = compareWindow(sourceLines, fingerprint, sourceStart, state, limits)
    if (comparison === undefined) {
      if (state.comparisons >= limits.maxComparisons ||
        state.comparedCharacters > limits.maxSourceCharacters) break
      continue
    }
    const similarity = Math.max(0, 1 - comparison.score / fingerprint.length)
    if (similarity < 0.55 || !comparison.credible) continue
    matches.push({
      sourceStart,
      sourceEnd: Math.min(sourceLines.length, sourceStart + fingerprint.length),
      score: comparison.score,
      similarity,
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
      actualLength: comparison.divergence.actual.length,
    })
  }

  return selectBestMatches(matches, limits.maxNearMatches)
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
    state.comparedCharacters += expected.length + (actual?.length ?? 0)
    if (state.comparedCharacters > limits.maxSourceCharacters) {
      state.truncated = true
      return undefined
    }
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
      credible ||= /[^\s]/.test(expected)
      continue
    }
    const column = firstDivergenceColumn(expected, actual)
    const difference = lineDifferenceScore(expected, actual)
    credible ||= credibleTextAgreement(comparisonText(expected), comparisonText(actual), 1 - difference)
    score += difference
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
  const left = comparisonText(expected)
  const right = comparisonText(actual)
  return 1 - pairSimilarity(left, right, characterPairs(left))
}

function comparisonText(value: string): string {
  return value.replace(/\s/g, '')
}

function characterPairs(text: string): Map<string, number> {
  const pairs = new Map<string, number>()
  for (let index = 1; index < text.length; index++) {
    const pair = text.slice(index - 1, index + 1)
    pairs.set(pair, (pairs.get(pair) ?? 0) + 1)
  }
  return pairs
}

function pairSimilarity(left: string, right: string, leftPairs: ReadonlyMap<string, number>): number {
  if (!left || !right) return 0
  if (left === right) return 1
  if (left.length < 2 || right.length < 2) return 0
  let shared = 0
  for (const [pair, count] of characterPairs(right)) shared += Math.min(count, leftPairs.get(pair) ?? 0)
  return 2 * shared / (left.length + right.length - 2)
}

function credibleTextAgreement(left: string, right: string, similarity: number): boolean {
  // Indentation, punctuation and a generic three-character prefix are not
  // enough to recommend an unrelated line as source evidence.
  return similarity >= 0.55 && /[\p{L}\p{N}_$]/u.test(left) && /[\p{L}\p{N}_$]/u.test(right)
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
      .map(coordinate => coordinate.start === coordinate.end
        ? `insertion after source line ${coordinate.start}`
        : `${coordinate.start + 1}-${coordinate.end}`)
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
          `expected ${JSON.stringify(match.expected)}; source line length ${match.actualLength}.`,
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
