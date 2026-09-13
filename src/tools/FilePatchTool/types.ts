import type { StructuredPatchHunk } from 'diff'
import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'
import type { FileIdentity } from '../../utils/file.js'
import type { LineEndingType } from '../../utils/fileRead.js'

export type FilePatchOperationType = 'update' | 'add' | 'delete'

export type FilePatchLine = {
  kind: 'context' | 'delete' | 'add'
  text: string
}

/** A one-based inclusive location in the raw patch envelope. */
export type PatchSourceSpan = {
  startLine: number
  endLine: number
}

export type FilePatchNewlineMarker = {
  /** Zero-based index of the hunk line immediately before this marker. */
  afterHunkLine: number
  appliesTo: 'old' | 'new' | 'both'
  sourceSpan: PatchSourceSpan
}

export type FilePatchNewline =
  | {
      kind: 'canonical'
      markers: FilePatchNewlineMarker[]
    }
  | {
      /** Structured legacy input carried an output-level directive only. */
      kind: 'legacy-output'
      outputAtEof: 'present' | 'absent'
    }

export type FilePatchHunk = {
  /** Canonical spelling. Structured historical input may provide scopeHints. */
  hints?: string[]
  /** @deprecated Read through hints; retained for old structured callers. */
  scopeHints?: string[]
  lines: FilePatchLine[]
  isEndOfFile: boolean
  /** @deprecated Derived only for legacy applier callers. */
  noNewlineAtEndOfFile?: boolean
  newline?: FilePatchNewline
  sourceSpan?: PatchSourceSpan
}

export type FilePatchOperation =
  | {
      type: 'update'
      path: string
      moveTo?: string
      hunks: FilePatchHunk[]
    }
  | {
      type: 'add'
      path: string
      lines: string[]
      noNewlineAtEndOfFile: boolean
    }
  | {
      type: 'delete'
      path: string
    }

export type ParsedFilePatch = {
  ops: FilePatchOperation[]
}

export type FilePatchInput =
  | {
      input: string
      ops?: never
    }
  | {
      ops: FilePatchOperation[]
      input?: never
    }

export type FilePatchBuffer = {
  content: string
  encoding?: BufferEncoding
  lineEndings?: LineEndingType
  noNewlineAtEndOfFile?: boolean
}

export type ApplyPatchFileState = {
  path: string
  exists: boolean
  identity?: FileIdentity
  buffer: FilePatchBuffer
}

export type ApplyPatchSuccess = {
  path: string
  type: FilePatchOperationType
  before: string | null
  after: string | null
  placements?: FilePatchPlacement[]
  placementOmittedCount?: number
}

export type FilePatchPlacement = {
  /** One-based hunk ordinal at the public result boundary. */
  hunk: number
  /** Zero-based inclusive old-source line (or insertion boundary). */
  oldStart: number
  /** Zero-based exclusive old-source line. */
  oldEnd: number
  reason: 'exact' | 'exact+hint' | 'bof' | 'eof'
}

export type FilePatchNearMatch = {
  sourceStart: number
  sourceEnd: number
  score: number
  divergence: {
    expectedLine: number
    sourceLine: number
    column: number
  }
  expected: string
  /** Source text is never persisted or returned across the Read boundary. */
  actualLength: number
}

/** Bounded evidence attached to a planner failure; never placement authority. */
export type FilePatchDiagnosticMetadata = {
  code: string
  kind: string
  path: string
  hunkIndex?: number
  hunkCount: number
  candidateCoordinates: Array<{ start: number; end: number }>
  nearMatches: FilePatchNearMatch[]
  diagnosticsTruncated: boolean
}

export const MAX_FILE_PATCH_PLACEMENTS = 40

export type FilePatchFailureDetail = {
  code: string
  operation: FilePatchOperationType
  path: string
  moveTo?: string
  hunkIndex?: number
  hunkCount?: number
  message: string
  diagnostics?: FilePatchDiagnosticMetadata
}

export const MAX_FILE_PATCH_FAILURE_DETAILS = 8
export const MAX_FILE_PATCH_FAILURE_DETAIL_MESSAGE_LENGTH = 800
export const MAX_FILE_PATCH_ERROR_REPAIR_LENGTH = 1_200
export const MAX_FILE_PATCH_PATH_LENGTH = 512
export const MAX_FILE_PATCH_CODE_LENGTH = 120
export const MAX_FILE_PATCH_DIAGNOSTIC_TEXT_LENGTH = 200
export const MAX_FILE_PATCH_DIAGNOSTIC_COORDINATES = 40
export const MAX_FILE_PATCH_NEAR_MATCHES = 4

export type ApplyPatchResult = {
  contractVersion?: 2
  files: ApplyPatchSuccess[]
}

export class FilePatchError extends Error {
  readonly code: string
  readonly path?: string
  readonly operation?: FilePatchOperationType
  readonly moveTo?: string
  readonly hunkIndex?: number
  readonly hunkCount?: number
  readonly details?: FilePatchFailureDetail[]
  readonly diagnostics?: FilePatchDiagnosticMetadata
  readonly patchSourceSpan?: PatchSourceSpan
  readonly mutationOutcome: FilePatchMutationOutcome

  constructor(
    message: string,
    options?: {
      code?: string
      path?: string
      operation?: FilePatchOperationType
      moveTo?: string
      hunkIndex?: number
      hunkCount?: number
      details?: readonly FilePatchFailureDetail[]
      diagnostics?: FilePatchDiagnosticMetadata
      patchSourceSpan?: PatchSourceSpan
      mutationOutcome?: FilePatchMutationOutcome
    },
  ) {
    super(boundFilePatchErrorText(message, MAX_FILE_PATCH_ERROR_REPAIR_LENGTH))
    this.name = 'FilePatchError'
    this.code = boundFilePatchErrorText(
      options?.code ?? 'FILE_PATCH_ERROR',
      MAX_FILE_PATCH_CODE_LENGTH,
    )
    this.path = boundOptionalFilePatchText(
      options?.path,
      MAX_FILE_PATCH_PATH_LENGTH,
    )
    this.operation = options?.operation
    this.moveTo = boundOptionalFilePatchText(
      options?.moveTo,
      MAX_FILE_PATCH_PATH_LENGTH,
    )
    this.hunkIndex = options?.hunkIndex
    this.hunkCount = options?.hunkCount
    this.details =
      options?.details === undefined
        ? undefined
        : options.details
            .slice(0, MAX_FILE_PATCH_FAILURE_DETAILS)
            .map(detail => ({
              ...detail,
              code: boundFilePatchErrorText(
                detail.code,
                MAX_FILE_PATCH_CODE_LENGTH,
              ),
              path: boundFilePatchErrorText(
                detail.path,
                MAX_FILE_PATCH_PATH_LENGTH,
              ),
              ...(detail.moveTo === undefined
                ? {}
                : {
                    moveTo: boundFilePatchErrorText(
                      detail.moveTo,
                      MAX_FILE_PATCH_PATH_LENGTH,
                    ),
                  }),
              message: boundFilePatchErrorText(
                detail.message,
                MAX_FILE_PATCH_FAILURE_DETAIL_MESSAGE_LENGTH,
              ),
              ...(detail.diagnostics === undefined
                ? {}
                : { diagnostics: boundFilePatchDiagnosticMetadata(detail.diagnostics) }),
            }))
    this.diagnostics =
      options?.diagnostics === undefined
        ? undefined
        : boundFilePatchDiagnosticMetadata(options.diagnostics)
    this.patchSourceSpan = options?.patchSourceSpan
    this.mutationOutcome = options?.mutationOutcome ?? 'no-mutation'
  }
}

export type FilePatchMutationOutcome =
  | 'no-mutation'
  | 'complete-rollback'
  | 'incomplete-recovery'

export type FilePatchModelError = {
  type: 'file_patch_error'
  code: string
  operation?: FilePatchOperationType
  path?: string
  moveTo?: string
  hunkIndex?: number
  hunkCount?: number
  patchSourceSpan?: PatchSourceSpan
  details: FilePatchFailureDetail[]
  diagnostics?: FilePatchDiagnosticMetadata
  mutationOutcome: FilePatchMutationOutcome
  repair: string
}

export function serializeFilePatchError(
  error: FilePatchError,
): FilePatchModelError {
  return {
    type: 'file_patch_error',
    code: error.code,
    ...(error.operation !== undefined ? { operation: error.operation } : {}),
    ...(error.path !== undefined ? { path: error.path } : {}),
    ...(error.moveTo !== undefined ? { moveTo: error.moveTo } : {}),
    ...(error.hunkIndex !== undefined ? { hunkIndex: error.hunkIndex } : {}),
    ...(error.hunkCount !== undefined ? { hunkCount: error.hunkCount } : {}),
    ...(error.patchSourceSpan !== undefined
      ? { patchSourceSpan: error.patchSourceSpan }
      : {}),
    details: error.details ?? [],
    ...(error.diagnostics !== undefined
      ? { diagnostics: error.diagnostics }
      : {}),
    mutationOutcome: error.mutationOutcome,
    repair: boundFilePatchErrorText(
      error.message,
      MAX_FILE_PATCH_ERROR_REPAIR_LENGTH,
    ),
  }
}

export function boundFilePatchErrorText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength - 20)}… [truncated]`
}

function boundOptionalFilePatchText(
  text: string | undefined,
  maxLength: number,
): string | undefined {
  return text === undefined ? undefined : boundFilePatchErrorText(text, maxLength)
}

export function boundFilePatchDiagnosticMetadata(
  metadata: FilePatchDiagnosticMetadata,
): FilePatchDiagnosticMetadata {
  const boundedCode = boundFilePatchErrorText(
    metadata.code,
    MAX_FILE_PATCH_CODE_LENGTH,
  )
  const boundedKind = boundFilePatchErrorText(
    metadata.kind,
    MAX_FILE_PATCH_CODE_LENGTH,
  )
  const boundedPath = boundFilePatchErrorText(
    metadata.path,
    MAX_FILE_PATCH_PATH_LENGTH,
  )
  let truncated =
    metadata.diagnosticsTruncated ||
    boundedCode !== metadata.code ||
    boundedKind !== metadata.kind ||
    boundedPath !== metadata.path
  const candidateCoordinates = metadata.candidateCoordinates.slice(
    0,
    MAX_FILE_PATCH_DIAGNOSTIC_COORDINATES,
  )
  const nearMatches = metadata.nearMatches
    .slice(0, MAX_FILE_PATCH_NEAR_MATCHES)
    .map(match => {
      const expected = boundFilePatchErrorText(
        match.expected,
        MAX_FILE_PATCH_DIAGNOSTIC_TEXT_LENGTH,
      )
      const actualLength =
        Number.isSafeInteger(match.actualLength) && match.actualLength >= 0
          ? match.actualLength
          : 0
      truncated ||= expected !== match.expected || actualLength !== match.actualLength
      return {
        ...match,
        expected,
        actualLength,
      }
    })
  truncated ||=
    candidateCoordinates.length !== metadata.candidateCoordinates.length ||
    nearMatches.length !== metadata.nearMatches.length
  return {
    ...metadata,
    code: boundedCode,
    kind: boundedKind,
    path: boundedPath,
    candidateCoordinates,
    nearMatches,
    diagnosticsTruncated: truncated,
  }
}

const hunkLineSchema = lazySchema(() =>
  z.strictObject({
    kind: z.enum(['context', 'delete', 'add']),
    text: z.string(),
  }),
)

const hunkSchema = lazySchema(() =>
  z.strictObject({
    hints: z.array(z.string()).optional(),
    // Historical structured callers used scopeHints. Raw canonical input is
    // parsed into hints and does not need this alias.
    scopeHints: z.array(z.string()).optional(),
    lines: z.array(hunkLineSchema()),
    isEndOfFile: z.boolean().default(false),
    noNewlineAtEndOfFile: z.boolean().optional(),
    newline: z
      .union([
        z.strictObject({
          kind: z.literal('canonical'),
          markers: z.array(
            z.strictObject({
              afterHunkLine: z.number().int().nonnegative(),
              appliesTo: z.enum(['old', 'new', 'both']),
              sourceSpan: z.strictObject({
                startLine: z.number().int().positive(),
                endLine: z.number().int().positive(),
              }),
            }),
          ),
        }),
        z.strictObject({
          kind: z.literal('legacy-output'),
          outputAtEof: z.enum(['present', 'absent']),
        }),
      ])
      .optional(),
    sourceSpan: z
      .strictObject({
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive(),
      })
      .optional(),
  }),
)

const operationSchema = lazySchema(() =>
  z.discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('update'),
      path: z.string(),
      moveTo: z.string().optional(),
      hunks: z.array(hunkSchema()).min(1),
    }),
    z.strictObject({
      type: z.literal('add'),
      path: z.string(),
      lines: z.array(z.string()),
      noNewlineAtEndOfFile: z.boolean().default(false),
    }),
    z.strictObject({
      type: z.literal('delete'),
      path: z.string(),
    }),
  ]),
)

const inputSchema = lazySchema(() =>
  z.union([
    z.strictObject({
      input: z.string().describe('The full apply_patch envelope text'),
    }),
    z.strictObject({
      ops: z
        .array(operationSchema())
        .describe('Normalized patch operations to apply'),
    }),
  ]),
)

const outputFileSchema = lazySchema(() =>
  z.strictObject({
    path: z.string(),
    type: z.enum(['update', 'add', 'delete']),
    firstLine: z.string().nullable().optional(),
    // Legacy: builds before firstLine persisted the whole file twice per edit.
    // Still accepted so resumed transcripts keep rendering — the read-back
    // components drop the whole result when safeParse fails.
    before: z.string().nullable().optional(),
    after: z.string().nullable().optional(),
    structuredPatch: z
      .array(
        z.strictObject({
          oldStart: z.number(),
          oldLines: z.number(),
          newStart: z.number(),
          newLines: z.number(),
          lines: z.array(z.string()),
        }),
      )
      .describe('Display diff for the operation'),
    // Keep accepting placement notes from old transcripts without emitting
    // them from current patch results.
    notes: z.array(z.string()).optional(),
    placements: z
      .array(
        z.strictObject({
          hunk: z.number().int().positive(),
          oldStart: z.number().int().nonnegative(),
          oldEnd: z.number().int().nonnegative(),
          reason: z.enum(['exact', 'exact+hint', 'bof', 'eof']),
        }),
      )
      .max(MAX_FILE_PATCH_PLACEMENTS)
      .optional(),
    placementOmittedCount: z.number().int().nonnegative().optional(),
  }),
)

const outputSchema = lazySchema(() =>
  z.strictObject({
    contractVersion: z.literal(2).optional(),
    files: z.array(outputFileSchema()),
  }),
)

export type FilePatchToolInput = z.infer<ReturnType<typeof inputSchema>>

// Persisted verbatim as `toolUseResult` on the transcript JSONL line, so it
// carries only what a reader needs: the compact diff plus the one line of
// content language detection keys off. `before`/`after` full file text is not
// written any more (a single edit to an 886 KB file wrote a 1.7 MB result);
// both stay optional here because old transcripts still carry them.
export type FilePatchToolOutput = {
  contractVersion?: 2
  files: Array<{
    path: string
    type: FilePatchOperationType
    firstLine?: string | null
    structuredPatch: StructuredPatchHunk[]
    before?: string | null
    after?: string | null
    notes?: string[]
    placements?: FilePatchPlacement[]
    placementOmittedCount?: number
  }>
}

export { inputSchema, operationSchema, outputSchema }
