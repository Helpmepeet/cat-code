import type { StructuredPatchHunk } from 'diff'
import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'
import type { LineEndingType } from '../../utils/fileRead.js'

export type FilePatchOperationType = 'update' | 'add' | 'delete'

export type FilePatchLine = {
  kind: 'context' | 'delete' | 'add'
  text: string
}

export type FilePatchHunk = {
  scopeHints: string[]
  lines: FilePatchLine[]
  isEndOfFile: boolean
  noNewlineAtEndOfFile: boolean
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
  buffer: FilePatchBuffer
}

export type ApplyPatchSuccess = {
  path: string
  type: FilePatchOperationType
  before: string | null
  after: string | null
}

export type ApplyPatchResult = {
  files: ApplyPatchSuccess[]
}

export class FilePatchError extends Error {
  readonly code: string
  readonly path?: string

  constructor(message: string, options?: { code?: string; path?: string }) {
    super(message)
    this.name = 'FilePatchError'
    this.code = options?.code ?? 'FILE_PATCH_ERROR'
    this.path = options?.path
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
    scopeHints: z.array(z.string()).default([]),
    lines: z.array(hunkLineSchema()),
    isEndOfFile: z.boolean().default(false),
    noNewlineAtEndOfFile: z.boolean().default(false),
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
      input: z.string().describe('The full Apply_patch envelope text'),
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
    before: z.string().nullable(),
    after: z.string().nullable(),
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
  }),
)

const outputSchema = lazySchema(() =>
  z.strictObject({
    files: z.array(outputFileSchema()),
  }),
)

export type FilePatchToolInput = z.infer<ReturnType<typeof inputSchema>>

export type FilePatchToolOutput = {
  files: Array<
    ApplyPatchSuccess & {
      structuredPatch: StructuredPatchHunk[]
    }
  >
}

export { inputSchema, operationSchema, outputSchema }
