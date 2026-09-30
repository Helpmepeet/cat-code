import {
  MAX_FILE_PATCH_COMPLETE_WITNESSES,
  candidateOmissions,
  sampleHunkCoordinates,
} from './evidence.js'
import {
  boundFilePatchErrorText,
  type FilePatchDiagnosticMetadata,
  type FilePatchModelError,
  type FilePatchMutationOutcome,
  type FilePatchOperationType,
  type PatchSourceSpan,
} from './types.js'

export const MAX_MODEL_PATCH_FAILURES = 8
export const MAX_MODEL_PATCH_CANDIDATES = 6
export const MAX_MODEL_PATCH_ERROR_LENGTH = 8_000

type CandidateLocation = { hunk?: number } & (
  | { kind: 'lines'; startLine: number; endLine: number }
  /** afterLine: 0 means before the first source line. */
  | { kind: 'insertion'; afterLine: number }
)

type ModelFailure = {
  code: string
  operation?: FilePatchOperationType
  path?: string
  moveTo?: string
  hunk?: number
  hunkCount?: number
  /** One-based inclusive lines in the patch envelope, not the target file. */
  patchSourceSpan?: PatchSourceSpan & { kind: 'patch-envelope-lines' }
  message: string
  repair: string
  witnesses?: Array<{
    kind: 'complete-plan-witness' | 'complete-plan-witness-excerpt'
    lineConvention: 'one-based-inclusive'
    placements: CandidateLocation[]
    omittedPlacementCount: number
  }>
  omittedWitnessCount?: number
  witnessReconstructionTruncated?: boolean
  evidence?: {
    kind: 'raw-hunk-candidates'
    lineConvention: 'one-based-inclusive'
    candidates: CandidateLocation[]
    omittedCandidateCount?: number
    diagnosticsTruncated?: boolean
  }
}

export type FilePatchModelErrorView = {
  type: 'file_patch_error'
  mutationOutcome?: FilePatchMutationOutcome
  failures: ModelFailure[]
  omittedFailureCount?: number
  recovery?: string
}

const plannerGuidance: Record<string, readonly [string, string]> = {
  PATCH_ANCHOR_AMBIGUOUS: [
    'The complete ordered update has more than one valid placement plan.',
    'Read the intended regions, add distinctive consecutive context, keep hunks in source order, and retry. Do not force or fuzzy-apply the patch.',
  ],
  PATCH_ANCHOR_NOT_FOUND: [
    'The exact old-side fingerprint was not found.',
    'Read the current target region and rebuild the hunk with exact consecutive source lines before retrying.',
  ],
  PATCH_ANCHOR_NONCONSECUTIVE: [
    'The old-side lines do not form a consecutive ordered block.',
    'Read the target region and include unchanged lines connecting the old-side lines before retrying.',
  ],
  PATCH_HINT_NOT_FOUND: [
    'No exact placement satisfies all scope hints.',
    'Read the target region and correct the whole-line hints or add distinctive consecutive context before retrying.',
  ],
  PATCH_INVALID_INSERTION: [
    'The insertion has no supported source boundary.',
    'Anchor the insertion with exact source context or an explicit supported file boundary before retrying.',
  ],
  PATCH_HARD_EOF_CONFLICT: [
    'The exact fingerprint conflicts with the required end of file.',
    'Read the end of the file and correct the hunk context or end-of-file requirement before retrying.',
  ],
  PATCH_ORDER_CONFLICT: [
    'The raw hunk candidates cannot form an ordered, non-overlapping placement plan.',
    'Read the intended regions, order the hunks by source position, and remove overlapping old-side ranges before retrying.',
  ],
  PATCH_NEWLINE_CONFLICT: [
    'The patch newline requirements conflict with the source or planned output.',
    'Inspect the file ending and patch newline markers, then correct the requirements before retrying.',
  ],
  PATCH_PLANNER_LIMIT: [
    'Exact placement exceeded the planning budget.',
    'Read the intended regions and narrow the patch with distinctive consecutive context or smaller independent updates before retrying.',
  ],
}

function sourceLocation(coordinate: { start: number; end: number; hunk?: number }): CandidateLocation {
  return {
    ...(coordinate.hunk === undefined ? {} : { hunk: coordinate.hunk }),
    ...(coordinate.start === coordinate.end
      ? { kind: 'insertion', afterLine: coordinate.start }
      : { kind: 'lines', startLine: coordinate.start + 1, endLine: coordinate.end }),
  }
}

function projectWitnesses(metadata: FilePatchDiagnosticMetadata): Pick<ModelFailure,
  'witnesses' | 'omittedWitnessCount' | 'witnessReconstructionTruncated'> {
  const witnesses = metadata.completePlanWitnesses?.slice(0, MAX_FILE_PATCH_COMPLETE_WITNESSES).map(witness => {
    const retained = sampleHunkCoordinates(witness.placements.map(placement => ({
      ...placement, hunkIndex: placement.hunk,
    })), MAX_MODEL_PATCH_CANDIDATES)
    const omitted = witness.placementsOmitted + witness.placements.length - retained.length
    return {
      kind: omitted > 0 ? 'complete-plan-witness-excerpt' as const : 'complete-plan-witness' as const,
      lineConvention: 'one-based-inclusive' as const,
      placements: retained.map(sourceLocation), omittedPlacementCount: omitted,
    }
  })
  return {
    ...(witnesses === undefined ? {} : {
      witnesses,
      omittedWitnessCount: (metadata.completePlanWitnessesOmitted ?? 0) +
        metadata.completePlanWitnesses!.length - witnesses.length,
    }),
    ...(metadata.witnessReconstructionTruncated === undefined ? {} : {
      witnessReconstructionTruncated: metadata.witnessReconstructionTruncated,
    }),
  }
}

function projectEvidence(metadata: FilePatchDiagnosticMetadata): ModelFailure['evidence'] {
  const retained = sampleHunkCoordinates(
    metadata.candidateCoordinates.map(coordinate => ({ ...coordinate, hunkIndex: coordinate.hunk })),
    MAX_MODEL_PATCH_CANDIDATES,
  )
  const omitted = candidateOmissions(metadata.candidateCoordinatesOmitted,
    metadata.diagnosticsTruncated, metadata.candidateCoordinates.length - retained.length)
  return {
    kind: 'raw-hunk-candidates',
    lineConvention: 'one-based-inclusive',
    candidates: retained.map(sourceLocation),
    ...(omitted === undefined ? {} : { omittedCandidateCount: omitted }),
    ...(metadata.diagnosticsTruncated || retained.length < metadata.candidateCoordinates.length
      ? { diagnosticsTruncated: true } : {}),
  }
}

/** Pure model projection. Persisted errors and their arrays are never changed. */
export function projectFilePatchErrorForModel(error: FilePatchModelError): FilePatchModelErrorView {
  const sourceFailures = error.details?.length ? error.details : [{ ...error, message: error.repair }]
  const outcome = error.mutationOutcome
  const failures = sourceFailures.slice(0, MAX_MODEL_PATCH_FAILURES).map(detail => {
    const known = plannerGuidance[detail.code]
    let repair = known?.[1] ?? 'Inspect the patch and affected files, resolve the reported error, and verify the current state before further mutation.'
    if (outcome === 'incomplete-recovery') {
      repair = 'Inspect affected files and recovery information before further mutation. Some published changes may remain; reconcile the current state before preparing a new patch.'
    } else if (outcome === 'complete-rollback') {
      repair = `Patch changes were rolled back completely. Read the restored files before preparing a corrected patch. ${repair}`
    } else if (outcome !== 'no-mutation') {
      repair = 'Verify mutation and recovery status, then inspect the affected files and patch before further mutation.'
    }
    return {
      code: boundFilePatchErrorText(detail.code, 120),
      ...(detail.operation === undefined ? {} : { operation: detail.operation }),
      ...(detail.path === undefined ? {} : { path: boundFilePatchErrorText(detail.path, 512) }),
      ...(detail.moveTo === undefined ? {} : { moveTo: boundFilePatchErrorText(detail.moveTo, 512) }),
      ...(detail.hunkIndex === undefined ? {} : { hunk: detail.hunkIndex }),
      ...(detail.hunkCount === undefined ? {} : { hunkCount: detail.hunkCount }),
      ...(detail.patchSourceSpan === undefined ? {} : {
        patchSourceSpan: { ...detail.patchSourceSpan, kind: 'patch-envelope-lines' as const },
      }),
      message: known?.[0] ?? boundFilePatchErrorText(detail.message ?? error.repair ?? 'Patch failed.', 400),
      repair,
      ...(detail.diagnostics === undefined ? {} : {
        evidence: projectEvidence(detail.diagnostics), ...projectWitnesses(detail.diagnostics),
      }),
    } satisfies ModelFailure
  })
  const view: FilePatchModelErrorView = {
    type: 'file_patch_error',
    ...(outcome === undefined ? {} : { mutationOutcome: outcome }),
    failures,
    ...(error.omittedFailureCount === undefined && error.code === 'PATCH_PREFLIGHT_FAILED'
      ? {} : { omittedFailureCount: (error.omittedFailureCount ?? 0) + sourceFailures.length - failures.length }),
    ...(outcome === 'incomplete-recovery' ? {
      recovery: boundFilePatchErrorText(error.repair ?? 'Recovery was incomplete; inspect affected files.', 600),
    } : {}),
  }
  const size = () => JSON.stringify(view).length
  // Preserve the count even when the optional candidate locations cannot fit.
  for (let index = failures.length - 1; size() > MAX_MODEL_PATCH_ERROR_LENGTH && index >= 0; index--) {
    const failure = failures[index]!
    for (const witness of failure.witnesses ?? []) {
      if (size() <= MAX_MODEL_PATCH_ERROR_LENGTH) break
      witness.omittedPlacementCount += witness.placements.length
      witness.placements = []
      witness.kind = 'complete-plan-witness-excerpt'
    }
    if (size() <= MAX_MODEL_PATCH_ERROR_LENGTH) break
    const evidence = failure.evidence
    if (!evidence || evidence.candidates.length === 0) continue
    if (evidence.omittedCandidateCount !== undefined) {
      evidence.omittedCandidateCount += evidence.candidates.length
    }
    evidence.candidates = []
    evidence.diagnosticsTruncated = true
  }
  while (size() > MAX_MODEL_PATCH_ERROR_LENGTH && failures.length > 1) {
    failures.pop()
    if (view.omittedFailureCount !== undefined) view.omittedFailureCount++
  }
  // JSON escaping can expand even a bounded path/message sixfold. Reduce fields,
  // never the serialized string, while retaining the primary failure and safety action.
  if (size() > MAX_MODEL_PATCH_ERROR_LENGTH) {
    const first = failures[0]!
    for (const field of ['path', 'moveTo', 'message'] as const) {
      if (first[field] !== undefined) first[field] = boundFilePatchErrorText(first[field]!, 160)
    }
    if (view.recovery) view.recovery = boundFilePatchErrorText(view.recovery, 160)
  }
  return view
}
