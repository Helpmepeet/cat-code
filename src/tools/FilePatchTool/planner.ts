/**
 * Pure source-coordinate placement for one update operation.
 *
 * This module deliberately does not import the parser or applier.  The parser
 * is being evolved alongside it, so the input is structural and accepts both
 * the proposed `hints` field and the current `scopeHints` spelling.  Nothing
 * in this module has filesystem access or mutates the source snapshot.
 */

export type PlannerLine = {
  kind: 'context' | 'delete' | 'add'
  text: string
}

export type PlannerNewlineSide = 'old' | 'new' | 'both'

/** `afterHunkLine` is a zero-based index into the hunk's `lines` array. */
export type PlannerNewlineMarker = {
  afterHunkLine: number
  appliesTo: PlannerNewlineSide
}

export type PlannerHunk = {
  /** New parser spelling. */
  hints?: readonly string[]
  /** Compatibility spelling accepted by the adapter during the refactor. */
  scopeHints?: readonly string[]
  lines: readonly PlannerLine[]
  isEndOfFile?: boolean
  /** Historical structured input. It is output-level only, never old-side evidence. */
  noNewlineAtEndOfFile?: boolean
  newlineMarkers?: readonly PlannerNewlineMarker[]
  newline?:
    | {
        kind?: 'canonical'
        markers: readonly PlannerNewlineMarker[]
      }
    | {
        kind: 'legacy-output'
        outputAtEof: 'present' | 'absent'
      }
}

export type PlannerSource = {
  lines: readonly string[]
  /** Whether the source byte sequence has a final LF. */
  hasFinalNewline: boolean
}

export type PlannerSourceInput = string | PlannerSource | readonly string[]

export type PlannerMatchTier = 'exact'
export type PlannerCandidateBoundary = 'none' | 'bof' | 'eof'

export type HunkCandidate = {
  hunkIndex: number
  /** Zero-based inclusive source line coordinate. */
  sourceStart: number
  /** Zero-based exclusive source line coordinate. */
  sourceEnd: number
  boundary: PlannerCandidateBoundary
  matchTier: PlannerMatchTier
  /** One deterministic witness line per effective hint, when hints exist. */
  diagnosticHintLines?: number[]
}

export type PlannerOutputEvidence = {
  lineCount: number
  hasFinalNewline: boolean
  /** True when the final output line is produced by a planned hunk. */
  outputEofAffected: boolean
}

export type UpdatePlacementPlan = {
  path: string
  hunks: HunkCandidate[]
  output: PlannerOutputEvidence
}

export type PlannerFailureCode =
  | 'PATCH_ANCHOR_NOT_FOUND'
  | 'PATCH_HINT_NOT_FOUND'
  | 'PATCH_INVALID_INSERTION'
  | 'PATCH_HARD_EOF_CONFLICT'
  | 'PATCH_ORDER_CONFLICT'
  | 'PATCH_ANCHOR_AMBIGUOUS'
  | 'PATCH_NEWLINE_CONFLICT'
  | 'PATCH_PLANNER_LIMIT'

export type PlannerFailureKind =
  | 'missing-fingerprint'
  | 'missing-hint'
  | 'invalid-insertion'
  | 'hard-eof'
  | 'ordering'
  | 'ambiguity'
  | 'newline'
  | 'limit'

export type PlannerDiagnostic = {
  hunkIndex: number
  sourceLine: number
  /** This is evidence only and can never authorize a candidate. */
  reason: 'trimmed-line-near-match'
}

export type PlannerFailure = {
  code: PlannerFailureCode
  kind: PlannerFailureKind
  path: string
  hunkIndex?: number
  hunkCount: number
  /** Bounded exact candidate coordinates, in original source coordinates. */
  candidateCoordinates?: Array<{ start: number; end: number }>
  message: string
  diagnostics?: PlannerDiagnostic[]
  diagnosticsTruncated?: boolean
  /** Planning usage is useful to callers when a bound is intentionally tight. */
  usage: PlannerUsage
}

export type PlannerSuccess = {
  ok: true
  plan: UpdatePlacementPlan
  usage: PlannerUsage
}

export type PlannerFailureResult = {
  ok: false
  failure: PlannerFailure
}

export type PlannerResult = PlannerSuccess | PlannerFailureResult

export type PlannerLimits = {
  maxSourcePositionsScanned: number
  maxCandidatesPerHunk: number
  maxCandidatesTotal: number
  maxHintComparisons: number
  maxDpTransitions: number
  maxPredecessors: number
  maxDiagnosticComparisons: number
}

export type PlannerUsage = {
  sourcePositionsScanned: number
  candidatesRetained: number
  hintComparisons: number
  dpTransitions: number
  predecessorsStored: number
  approximateComparisons: number
}

export type PlanUpdateInput = {
  path: string
  source: PlannerSourceInput
  hunks: readonly PlannerHunk[]
  limits?: Partial<PlannerLimits>
  /** Approximate comparisons are opt-in and diagnostic-only. */
  diagnostics?: boolean
}

export const DEFAULT_PLANNER_LIMITS: PlannerLimits = {
  maxSourcePositionsScanned: 100_000,
  maxCandidatesPerHunk: 2_000,
  maxCandidatesTotal: 10_000,
  maxHintComparisons: 2_000_000,
  maxDpTransitions: 100_000,
  maxPredecessors: 100_000,
  maxDiagnosticComparisons: 20_000,
}

type EffectiveHunk = {
  hints: string[]
  lines: readonly PlannerLine[]
  isEndOfFile: boolean
  noNewlineAtEndOfFile: boolean
  markers: readonly PlannerNewlineMarker[]
  legacyOutputAtEof?: 'present' | 'absent'
}

type CandidateSet = {
  candidates: HunkCandidate[]
  exactCoordinates: Array<{ start: number; end: number }>
  effectiveHintCount: number
  fingerprintLength: number
  /** For hard EOF hunks, distinguishes an interior-only exact match. */
  boundaryExactMatch?: boolean
  invalidInsertion?: PlannerFailure
}

type InternalOutputLine = {
  text: string
  sourceIndex?: number
  hunkIndex?: number
  hunkLineIndex?: number
}

type PlannerCounters = PlannerUsage & {
  limits: PlannerLimits
}

class PlannerLimitError extends Error {
  readonly counter: keyof PlannerUsage

  constructor(counter: keyof PlannerUsage) {
    super(`planner limit exceeded: ${counter}`)
    this.name = 'PlannerLimitError'
    this.counter = counter
  }
}

function mergedLimits(limits: Partial<PlannerLimits> | undefined): PlannerLimits {
  return { ...DEFAULT_PLANNER_LIMITS, ...limits }
}

function newCounters(limits: PlannerLimits): PlannerCounters {
  return {
    sourcePositionsScanned: 0,
    candidatesRetained: 0,
    hintComparisons: 0,
    dpTransitions: 0,
    predecessorsStored: 0,
    approximateComparisons: 0,
    limits,
  }
}

function charge(
  counters: PlannerCounters,
  counter: keyof PlannerUsage,
  amount = 1,
): void {
  const next = counters[counter] + amount
  if (next > counters.limits[limitName(counter)]) {
    throw new PlannerLimitError(counter)
  }
  counters[counter] = next
}

function limitName(counter: keyof PlannerUsage): keyof PlannerLimits {
  switch (counter) {
    case 'sourcePositionsScanned':
      return 'maxSourcePositionsScanned'
    case 'candidatesRetained':
      return 'maxCandidatesTotal'
    case 'hintComparisons':
      return 'maxHintComparisons'
    case 'dpTransitions':
      return 'maxDpTransitions'
    case 'predecessorsStored':
      return 'maxPredecessors'
    case 'approximateComparisons':
      return 'maxDiagnosticComparisons'
  }
}

function snapshotUsage(counters: PlannerCounters): PlannerUsage {
  return {
    sourcePositionsScanned: counters.sourcePositionsScanned,
    candidatesRetained: counters.candidatesRetained,
    hintComparisons: counters.hintComparisons,
    dpTransitions: counters.dpTransitions,
    predecessorsStored: counters.predecessorsStored,
    approximateComparisons: counters.approximateComparisons,
  }
}

function normalizeSource(source: PlannerSourceInput): PlannerSource {
  if (typeof source === 'string') {
    const normalized = source.replaceAll('\r\n', '\n')
    const hasFinalNewline = normalized.endsWith('\n')
    if (normalized.length === 0) return { lines: [], hasFinalNewline: false }
    const parts = normalized.split('\n')
    if (hasFinalNewline) parts.pop()
    return { lines: parts, hasFinalNewline }
  }
  if (Array.isArray(source)) {
    return { lines: source.slice(), hasFinalNewline: false }
  }
  const structured = source as PlannerSource
  return {
    lines: structured.lines.slice(),
    hasFinalNewline: structured.hasFinalNewline,
  }
}

function effectiveHunk(hunk: PlannerHunk): EffectiveHunk {
  const hints = (hunk.hints ?? hunk.scopeHints ?? []).slice()
  const markers = hunk.newlineMarkers ?? (hunk.newline?.kind !== 'legacy-output' ? hunk.newline?.markers : undefined) ?? []
  const legacyOutputAtEof =
    hunk.newline?.kind === 'legacy-output'
      ? hunk.newline.outputAtEof
      : hunk.noNewlineAtEndOfFile === true
        ? 'absent'
        : undefined
  return {
    hints,
    lines: hunk.lines,
    isEndOfFile: hunk.isEndOfFile === true,
    noNewlineAtEndOfFile: hunk.noNewlineAtEndOfFile === true,
    markers,
    ...(legacyOutputAtEof === undefined ? {} : { legacyOutputAtEof }),
  }
}

function effectiveHints(hints: readonly string[]): string[] {
  return hints.map(hint => hint.trim()).filter(hint => hint.length > 0)
}

function fingerprint(hunk: EffectiveHunk): string[] {
  return hunk.lines.filter(line => line.kind !== 'add').map(line => line.text)
}

function candidateBoundary(
  hunk: EffectiveHunk,
  start: number,
  sourceLength: number,
): PlannerCandidateBoundary {
  if (start === sourceLength && hunk.isEndOfFile) return 'eof'
  if (start === 0 && hunk.lines.every(line => line.kind === 'add')) return 'bof'
  return 'none'
}

function findHintWitnesses(
  sourceLines: readonly string[],
  hints: readonly string[],
  sourceStart: number,
  counters: PlannerCounters,
): number[] | undefined {
  if (hints.length === 0) return []

  const witnesses: number[] = []
  let searchFrom = 0
  for (const hint of hints) {
    let found = -1
    for (let sourceLine = searchFrom; sourceLine <= sourceStart; sourceLine += 1) {
      charge(counters, 'hintComparisons')
      if (sourceLines[sourceLine]!.trim() === hint) {
        found = sourceLine
        break
      }
    }
    if (found < 0) return undefined
    witnesses.push(found)
    searchFrom = found + 1
  }
  return witnesses
}

function makeCandidate(
  hunkIndex: number,
  hunk: EffectiveHunk,
  start: number,
  end: number,
  sourceLines: readonly string[],
  counters: PlannerCounters,
  totalCandidates: { value: number },
): HunkCandidate | undefined {
  const hints = effectiveHints(hunk.hints)
  const witnesses = findHintWitnesses(sourceLines, hints, start, counters)
  if (witnesses === undefined) return undefined

  charge(counters, 'candidatesRetained')
  totalCandidates.value += 1
  const candidate: HunkCandidate = {
    hunkIndex,
    sourceStart: start,
    sourceEnd: end,
    boundary: candidateBoundary(hunk, start, sourceLines.length),
    matchTier: 'exact',
  }
  if (witnesses.length > 0) candidate.diagnosticHintLines = witnesses
  return candidate
}

function discoverCandidates(
  hunk: EffectiveHunk,
  hunkIndex: number,
  hunkCount: number,
  sourceLines: readonly string[],
  counters: PlannerCounters,
  totalCandidates: { value: number },
): CandidateSet {
  const hints = effectiveHints(hunk.hints)
  const fp = fingerprint(hunk)

  if (fp.length === 0) {
    if (hunk.isEndOfFile) {
      if (hunkIndex !== hunkCount - 1) {
        return {
          candidates: [],
          exactCoordinates: [],
          effectiveHintCount: hints.length,
          fingerprintLength: 0,
          invalidInsertion: failureBase(
            'PATCH_HARD_EOF_CONFLICT',
            'hard-eof',
            `EOF-marked context-free hunk ${hunkIndex + 1} must be the final hunk.`,
            hunkIndex,
            hunkCount,
            counters,
          ),
        }
      }
      const candidate = makeCandidate(
        hunkIndex,
        hunk,
        sourceLines.length,
        sourceLines.length,
        sourceLines,
        counters,
        totalCandidates,
      )
      if (candidate && 1 > counters.limits.maxCandidatesPerHunk) {
        throw new PlannerLimitError('candidatesRetained')
      }
      return {
        candidates: candidate ? [candidate] : [],
        exactCoordinates: [{ start: sourceLines.length, end: sourceLines.length }],
        effectiveHintCount: hints.length,
        fingerprintLength: 0,
      }
    }

    if (hunkIndex !== 0) {
      return {
        candidates: [],
        exactCoordinates: [],
        effectiveHintCount: hints.length,
        fingerprintLength: 0,
        invalidInsertion: failureBase(
          'PATCH_INVALID_INSERTION',
          'invalid-insertion',
          `Context-free insertion hunk ${hunkIndex + 1} requires the first hunk or an EOF marker.`,
          hunkIndex,
          hunkCount,
          counters,
        ),
      }
    }

    const candidate = makeCandidate(
      hunkIndex,
      hunk,
      0,
      0,
      sourceLines,
      counters,
      totalCandidates,
    )
    if (candidate && 1 > counters.limits.maxCandidatesPerHunk) {
      throw new PlannerLimitError('candidatesRetained')
    }
    return {
      candidates: candidate ? [candidate] : [],
      exactCoordinates: [{ start: 0, end: 0 }],
      effectiveHintCount: hints.length,
      fingerprintLength: 0,
    }
  }

  if (hunk.isEndOfFile && hunkIndex !== hunkCount - 1) {
    return {
      candidates: [],
      exactCoordinates: [],
      effectiveHintCount: hints.length,
      fingerprintLength: fp.length,
      invalidInsertion: failureBase(
        'PATCH_HARD_EOF_CONFLICT',
        'hard-eof',
        `EOF-marked hunk ${hunkIndex + 1} must be the final hunk.`,
        hunkIndex,
        hunkCount,
        counters,
      ),
    }
  }

  const maxStart = sourceLines.length - fp.length
  // EOF is a hard constraint, but scan the other exact positions as evidence
  // so a misplaced interior match can be reported as a hard-EOF conflict
  // rather than silently looking like an ordinary missing anchor.
  const exactCoordinates: Array<{ start: number; end: number }> = []
  const candidates: HunkCandidate[] = []
  let boundaryExactMatch = false

  for (let start = 0; start <= maxStart; start += 1) {
    let matches = true
    for (let offset = 0; offset < fp.length; offset += 1) {
      // Charge the actual line comparisons, not merely the candidate-window
      // starts. This prevents a long repeated fingerprint from doing
      // quadratic unaccounted work before the planner fails closed.
      charge(counters, 'sourcePositionsScanned')
      if (sourceLines[start + offset] !== fp[offset]) {
        matches = false
        break
      }
    }
    if (!matches) continue

    if (exactCoordinates.length < 40) {
      exactCoordinates.push({ start, end: start + fp.length })
    }
    if (hunk.isEndOfFile && start === maxStart) boundaryExactMatch = true
    if (hunk.isEndOfFile && start !== maxStart) continue
    const before = candidates.length
    const candidate = makeCandidate(
      hunkIndex,
      hunk,
      start,
      start + fp.length,
      sourceLines,
      counters,
      totalCandidates,
    )
    if (candidate) candidates.push(candidate)
    if (candidates.length > before && candidates.length > counters.limits.maxCandidatesPerHunk) {
      throw new PlannerLimitError('candidatesRetained')
    }
    if (totalCandidates.value > counters.limits.maxCandidatesTotal) {
      throw new PlannerLimitError('candidatesRetained')
    }
  }

  return {
    candidates,
    exactCoordinates,
    effectiveHintCount: hints.length,
    fingerprintLength: fp.length,
    ...(hunk.isEndOfFile ? { boundaryExactMatch } : {}),
  }
}

function failureBase(
  code: PlannerFailureCode,
  kind: PlannerFailureKind,
  message: string,
  hunkIndex: number | undefined,
  hunkCount: number,
  counters: PlannerCounters,
  extra: Partial<PlannerFailure> = {},
): PlannerFailure {
  return {
    code,
    kind,
    path: '',
    ...(hunkIndex === undefined ? {} : { hunkIndex }),
    hunkCount,
    message,
    usage: snapshotUsage(counters),
    ...extra,
  }
}

function withPath(failure: PlannerFailure, path: string): PlannerFailure {
  return { ...failure, path }
}

function failureFromCandidateSet(
  set: CandidateSet,
  isEndOfFile: boolean,
  hunkIndex: number,
  hunkCount: number,
  path: string,
  counters: PlannerCounters,
): PlannerFailure | undefined {
  if (set.invalidInsertion) return withPath(set.invalidInsertion, path)
  if (set.candidates.length > 0) return undefined
  if (set.fingerprintLength > 0 && set.exactCoordinates.length > 0) {
    // A fingerprint exists, but only away from the mandated EOF boundary.
    // This is intentionally distinct from a missing fingerprint.
    if (isEndOfFile && set.boundaryExactMatch !== true) {
      return withPath(
        failureBase(
          'PATCH_HARD_EOF_CONFLICT',
          'hard-eof',
          `The exact fingerprint for hunk ${hunkIndex + 1} exists away from the required source EOF.`,
          hunkIndex,
          hunkCount,
          counters,
          { candidateCoordinates: set.exactCoordinates.slice(0, 40) },
        ),
        path,
      )
    }
  }
  if (set.effectiveHintCount > 0 && set.exactCoordinates.length > 0) {
    return withPath(
      failureBase(
        'PATCH_HINT_NOT_FOUND',
        'missing-hint',
        `No exact placement for hunk ${hunkIndex + 1} satisfies all trimmed, whole-line hints.`,
        hunkIndex,
        hunkCount,
        counters,
        { candidateCoordinates: set.exactCoordinates.slice(0, 40) },
      ),
      path,
    )
  }
  return withPath(
    failureBase(
      'PATCH_ANCHOR_NOT_FOUND',
      'missing-fingerprint',
      `The exact old-side fingerprint for hunk ${hunkIndex + 1} does not occur in the immutable source snapshot.`,
      hunkIndex,
      hunkCount,
      counters,
    ),
    path,
  )
}

type Continuation = { count: 0 | 1 | 2; path?: HunkCandidate[] }

function countPlans(
  candidateSets: readonly CandidateSet[],
  counters: PlannerCounters,
  isValidCompletePlan: (path: readonly HunkCandidate[]) => boolean,
): Continuation {
  // Newline constraints are properties of the complete output, not of a
  // single candidate or `(hunkIndex, previousEnd)` frontier.  Consequently
  // the validator is part of the bounded search and structural memoization
  // cannot be reused here without losing that state.  The transition budget
  // still makes this fail closed before an unbounded search can run.
  const visit = (
    hunkIndex: number,
    previousEnd: number,
    prefix: readonly HunkCandidate[],
  ): Continuation => {
    if (hunkIndex === candidateSets.length) {
      return isValidCompletePlan(prefix) ? { count: 1, path: [] } : { count: 0 }
    }

    let count: 0 | 1 | 2 = 0
    let uniquePath: HunkCandidate[] | undefined
    for (const candidate of candidateSets[hunkIndex]!.candidates) {
      charge(counters, 'dpTransitions')
      if (candidate.sourceStart < previousEnd) continue
      charge(counters, 'predecessorsStored')
      const continuation = visit(hunkIndex + 1, candidate.sourceEnd, [...prefix, candidate])
      if (continuation.count === 0) continue
      if (continuation.count === 2 || count === 1) {
        count = 2
        uniquePath = undefined
        break
      }
      if (count === 0 && continuation.count === 1) {
        count = 1
        uniquePath = [candidate, ...(continuation.path ?? [])]
      }
    }

    return { count, ...(uniquePath ? { path: uniquePath } : {}) }
  }

  return visit(0, -1, [])
}

function buildOutput(
  source: PlannerSource,
  hunks: readonly EffectiveHunk[],
  planHunks: readonly HunkCandidate[],
  counters: PlannerCounters,
): InternalOutputLine[] {
  const output: InternalOutputLine[] = []
  let cursor = 0
  for (const candidate of planHunks) {
    while (cursor < candidate.sourceStart) {
      // Complete-plan newline validation is part of planning, so source
      // copying here must consume a planning budget too. Otherwise a large
      // source would be rescanned once per structural path for free.
      charge(counters, 'dpTransitions')
      output.push({ text: source.lines[cursor]!, sourceIndex: cursor })
      cursor += 1
    }
    const hunk = hunks[candidate.hunkIndex]!
    let sourceCursor = candidate.sourceStart
    for (let lineIndex = 0; lineIndex < hunk.lines.length; lineIndex += 1) {
      const line = hunk.lines[lineIndex]!
      charge(counters, 'dpTransitions')
      if (line.kind === 'add') {
        output.push({
          text: line.text,
          hunkIndex: candidate.hunkIndex,
          hunkLineIndex: lineIndex,
        })
      } else if (line.kind === 'context') {
        output.push({
          text: source.lines[sourceCursor]!,
          sourceIndex: sourceCursor,
          hunkIndex: candidate.hunkIndex,
          hunkLineIndex: lineIndex,
        })
        sourceCursor += 1
      } else {
        sourceCursor += 1
      }
    }
    cursor = candidate.sourceEnd
  }
  while (cursor < source.lines.length) {
    charge(counters, 'dpTransitions')
    output.push({ text: source.lines[cursor]!, sourceIndex: cursor })
    cursor += 1
  }
  return output
}

function markerForHunk(hunk: EffectiveHunk): readonly PlannerNewlineMarker[] {
  return hunk.markers
}

function validateNewlines(
  source: PlannerSource,
  hunks: readonly EffectiveHunk[],
  planHunks: readonly HunkCandidate[],
  counters: PlannerCounters,
): { output: PlannerOutputEvidence } | PlannerFailure {
  const outputLines = buildOutput(source, hunks, planHunks, counters)
  const outputLast = outputLines.length - 1
  const newMarkers: Array<{ hunkIndex: number; lineIndex: number }> = []
  let outputEofAffected = false
  const legacyOutputAtEof = new Map<number, 'present' | 'absent'>()

  for (const candidate of planHunks) {
    const hunk = hunks[candidate.hunkIndex]!
    const fp = fingerprint(hunk)
    const oldLinePositions: number[] = []
    let oldOffset = candidate.sourceStart
    for (let lineIndex = 0; lineIndex < hunk.lines.length; lineIndex += 1) {
      const line = hunk.lines[lineIndex]!
      charge(counters, 'dpTransitions')
      if (line.kind !== 'add') {
        oldLinePositions[lineIndex] = oldOffset
        oldOffset += 1
      }
    }
    for (const marker of markerForHunk(hunk)) {
      const line = hunk.lines[marker.afterHunkLine]
      if (!line) {
        return failureBase(
          'PATCH_NEWLINE_CONFLICT',
          'newline',
          `No-newline marker for hunk ${candidate.hunkIndex + 1} is not attached to a hunk line.`,
          candidate.hunkIndex,
          hunks.length,
          counters,
        )
      }
      const oldCompatible = line.kind === 'context' || line.kind === 'delete'
      const newCompatible = line.kind === 'context' || line.kind === 'add'
      if ((marker.appliesTo === 'old' || marker.appliesTo === 'both') && !oldCompatible) {
        return failureBase(
          'PATCH_NEWLINE_CONFLICT',
          'newline',
          `Old-side no-newline marker for hunk ${candidate.hunkIndex + 1} is attached to an added line.`,
          candidate.hunkIndex,
          hunks.length,
          counters,
        )
      }
      if ((marker.appliesTo === 'new' || marker.appliesTo === 'both') && !newCompatible) {
        return failureBase(
          'PATCH_NEWLINE_CONFLICT',
          'newline',
          `New-side no-newline marker for hunk ${candidate.hunkIndex + 1} is attached to a deleted line.`,
          candidate.hunkIndex,
          hunks.length,
          counters,
        )
      }
      if (marker.appliesTo === 'old' || marker.appliesTo === 'both') {
        const oldPosition = oldLinePositions[marker.afterHunkLine]
        if (oldPosition === undefined || oldPosition !== source.lines.length - 1 || candidate.sourceEnd !== source.lines.length) {
          return failureBase(
            'PATCH_NEWLINE_CONFLICT',
            'newline',
            `Old-side no-newline marker for hunk ${candidate.hunkIndex + 1} does not attach to the source EOF.`,
            candidate.hunkIndex,
            hunks.length,
            counters,
          )
        }
        if (source.hasFinalNewline) {
          return failureBase(
            'PATCH_NEWLINE_CONFLICT',
            'newline',
            `Old-side no-newline marker for hunk ${candidate.hunkIndex + 1} conflicts with a newline in the source snapshot.`,
            candidate.hunkIndex,
            hunks.length,
            counters,
          )
        }
      }
      if (marker.appliesTo === 'new' || marker.appliesTo === 'both') {
        newMarkers.push({ hunkIndex: candidate.hunkIndex, lineIndex: marker.afterHunkLine })
      }
    }

    const changesOutput = hunk.lines.some(line => line.kind !== 'context')
    if (changesOutput && candidate.sourceEnd === source.lines.length) {
      outputEofAffected = true
    }
    if (hunk.legacyOutputAtEof !== undefined) {
      legacyOutputAtEof.set(candidate.hunkIndex, hunk.legacyOutputAtEof)
    }
    // Keep fp referenced here: it documents that a fingerprinted EOF hunk is
    // validated by its candidate range, while a context-free EOF hunk is zero-width.
    void fp
  }

  for (const marker of newMarkers) {
    let matchingOutput = -1
    for (let lineIndex = 0; lineIndex < outputLines.length; lineIndex += 1) {
      charge(counters, 'dpTransitions')
      const line = outputLines[lineIndex]!
      if (line.hunkIndex === marker.hunkIndex && line.hunkLineIndex === marker.lineIndex) {
        matchingOutput = lineIndex
        break
      }
    }
    if (matchingOutput < 0 || matchingOutput !== outputLast) {
      return failureBase(
        'PATCH_NEWLINE_CONFLICT',
        'newline',
        `New-side no-newline marker for hunk ${marker.hunkIndex + 1} does not reach the final output line.`,
        marker.hunkIndex,
        hunks.length,
        counters,
      )
    }
  }

  const finalLine = outputLines[outputLast]
  let outputEofOwner: number | undefined = finalLine?.hunkIndex
  if (outputEofOwner === undefined) {
    // Deleting the source tail can leave a sourced line as the final output
    // line. In that case the tail-deleting hunk still owns output EOF.
    for (let i = planHunks.length - 1; i >= 0; i -= 1) {
      charge(counters, 'dpTransitions')
      const candidate = planHunks[i]!
      const hunk = hunks[candidate.hunkIndex]!
      if (candidate.sourceEnd === source.lines.length && hunk.lines.some(line => line.kind !== 'context')) {
        outputEofOwner = candidate.hunkIndex
        break
      }
    }
  }

  let hasFinalNewline = false
  if (outputLines.length === 0) {
    hasFinalNewline = false
  } else if (newMarkers.length > 0) {
    hasFinalNewline = false
  } else if (
    outputEofAffected &&
    outputEofOwner !== undefined &&
    legacyOutputAtEof.get(outputEofOwner) === 'absent'
  ) {
    hasFinalNewline = false
  } else if (
    outputEofAffected &&
    outputEofOwner !== undefined &&
    legacyOutputAtEof.get(outputEofOwner) === 'present'
  ) {
    hasFinalNewline = true
  } else if (outputEofAffected) {
    // An unmarked output line introduced or retained by an EOF-affecting hunk
    // gets the canonical default final newline.
    hasFinalNewline = true
  } else {
    hasFinalNewline = source.hasFinalNewline
  }

  return {
    output: {
      lineCount: outputLines.length,
      hasFinalNewline,
      outputEofAffected,
    },
  }
}

function addDiagnostics(
  failure: PlannerFailure,
  sourceLines: readonly string[],
  hunks: readonly EffectiveHunk[],
  counters: PlannerCounters,
): PlannerFailure {
  const diagnostics: PlannerDiagnostic[] = []
  let truncated = false
  for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex += 1) {
    const first = fingerprint(hunks[hunkIndex]!)[0]
    if (first === undefined) continue
    for (let sourceLine = 0; sourceLine < sourceLines.length; sourceLine += 1) {
      try {
        charge(counters, 'approximateComparisons')
      } catch (error) {
        if (error instanceof PlannerLimitError) {
          truncated = true
          break
        }
        throw error
      }
      if (sourceLines[sourceLine]!.trim() === first.trim() && sourceLines[sourceLine] !== first) {
        diagnostics.push({ hunkIndex, sourceLine, reason: 'trimmed-line-near-match' })
        if (diagnostics.length >= 20) {
          truncated = true
          break
        }
      }
    }
    if (truncated) break
  }
  return {
    ...failure,
    usage: snapshotUsage(counters),
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    ...(truncated ? { diagnosticsTruncated: true } : {}),
  }
}

function limitFailure(
  error: PlannerLimitError,
  path: string,
  hunkCount: number,
  counters: PlannerCounters,
): PlannerFailure {
  return {
    code: 'PATCH_PLANNER_LIMIT',
    kind: 'limit',
    path,
    hunkCount,
    message: `Patch placement exceeded the ${error.counter} planning budget; no placement is authorized.`,
    usage: snapshotUsage(counters),
  }
}

/** Plan one complete update against one immutable source snapshot. */
export function planUpdateHunks(input: PlanUpdateInput): PlannerResult {
  const source = normalizeSource(input.source)
  const limits = mergedLimits(input.limits)
  const counters = newCounters(limits)
  const hunks = input.hunks.map(effectiveHunk)
  const totalCandidates = { value: 0 }

  if (hunks.length === 0) {
    return {
      ok: false,
      failure: {
        code: 'PATCH_ANCHOR_NOT_FOUND',
        kind: 'missing-fingerprint',
        path: input.path,
        hunkCount: 0,
        message: 'An update must contain at least one hunk.',
        usage: snapshotUsage(counters),
      },
    }
  }

  try {
    const candidateSets: CandidateSet[] = []
    for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex += 1) {
      const set = discoverCandidates(
        hunks[hunkIndex]!,
        hunkIndex,
        hunks.length,
        source.lines,
        counters,
        totalCandidates,
      )
      const candidateFailure = failureFromCandidateSet(
        set,
        hunks[hunkIndex]!.isEndOfFile,
        hunkIndex,
        hunks.length,
        input.path,
        counters,
      )
      if (candidateFailure) {
        return {
          ok: false,
          failure: input.diagnostics
            ? addDiagnostics(candidateFailure, source.lines, hunks, counters)
            : candidateFailure,
        }
      }
      candidateSets.push(set)
    }

    let firstNewlineFailure: PlannerFailure | undefined
    let validatedUniqueOutput: PlannerOutputEvidence | undefined
    let validatedUniquePathKey: string | undefined
    const continuation = countPlans(candidateSets, counters, completePlan => {
      const newlineResult = validateNewlines(source, hunks, completePlan, counters)
      if ('code' in newlineResult) {
        firstNewlineFailure ??= newlineResult
        return false
      }
      validatedUniqueOutput = newlineResult.output
      validatedUniquePathKey = completePlan
        .map(candidate => `${candidate.hunkIndex}:${candidate.sourceStart}:${candidate.sourceEnd}:${candidate.boundary}`)
        .join('|')
      return true
    })
    if (continuation.count === 0) {
      if (firstNewlineFailure !== undefined) {
        const failure = withPath(firstNewlineFailure, input.path)
        return {
          ok: false,
          failure: input.diagnostics
            ? addDiagnostics(failure, source.lines, hunks, counters)
            : failure,
        }
      }
      const failure = withPath(
        failureBase(
          'PATCH_ORDER_CONFLICT',
          'ordering',
          'The exact hunk candidates cannot form one ordered, non-overlapping plan in the immutable source snapshot.',
          undefined,
          hunks.length,
          counters,
          {
            candidateCoordinates: candidateSets
              .flatMap(set => set.candidates.map(candidate => ({ start: candidate.sourceStart, end: candidate.sourceEnd })))
              .slice(0, 40),
          },
        ),
        input.path,
      )
      return {
        ok: false,
        failure: input.diagnostics ? addDiagnostics(failure, source.lines, hunks, counters) : failure,
      }
    }
    if (continuation.count === 2 || !continuation.path) {
      const failure = withPath(
        failureBase(
          'PATCH_ANCHOR_AMBIGUOUS',
          'ambiguity',
          'The complete ordered update has more than one exact placement plan; no first candidate is selected.',
          undefined,
          hunks.length,
          counters,
          {
            candidateCoordinates: candidateSets
              .flatMap(set => set.candidates.map(candidate => ({ start: candidate.sourceStart, end: candidate.sourceEnd })))
              .slice(0, 40),
          },
        ),
        input.path,
      )
      return {
        ok: false,
        failure: input.diagnostics ? addDiagnostics(failure, source.lines, hunks, counters) : failure,
      }
    }

    const planHunks = continuation.path
    const planKey = planHunks
      .map(candidate => `${candidate.hunkIndex}:${candidate.sourceStart}:${candidate.sourceEnd}:${candidate.boundary}`)
      .join('|')
    // The complete-plan validator already produced this output evidence while
    // determining 0/1/many. Re-running it would charge and scan the whole
    // source a second time for the unique path.
    if (validatedUniquePathKey !== planKey || validatedUniqueOutput === undefined) {
      const newlineResult = validateNewlines(source, hunks, planHunks, counters)
      if ('code' in newlineResult) {
        const failure = withPath(newlineResult, input.path)
        return {
          ok: false,
          failure: input.diagnostics ? addDiagnostics(failure, source.lines, hunks, counters) : failure,
        }
      }
      validatedUniqueOutput = newlineResult.output
    }

    return {
      ok: true,
      plan: { path: input.path, hunks: planHunks, output: validatedUniqueOutput },
      usage: snapshotUsage(counters),
    }
  } catch (error) {
    if (!(error instanceof PlannerLimitError)) throw error
    return {
      ok: false,
      failure: limitFailure(error, input.path, hunks.length, counters),
    }
  }
}

/** Alias with a file-oriented name for callers that prefer the plan terminology. */
export const planFilePatchUpdate = planUpdateHunks
