import { logFileOperation } from '../../utils/fileOperationAnalytics.js'
import { logError } from '../../utils/log.js'
import type { ToolUseContext } from '../../Tool.js'
import { buildTool, type ToolDef, type ValidationResult } from '../../Tool.js'
import {
  boundPatchLinesForPersistence,
  firstLineForLanguageDetection,
  getPatchFromContents,
} from '../../utils/diff.js'
import { expandPath } from '../../utils/path.js'
import { validateInputForSettingsFileEdit } from '../../utils/settings/validateEditTool.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../NotebookEditTool/constants.js'
import { FILE_UNEXPECTEDLY_MODIFIED_ERROR } from '../FileEditTool/constants.js'
import {
  assertFileUnchangedSinceRead,
  checkSingleFileWritePermissions,
  deleteFileWithSideEffects,
  isUncPath,
  prepareFileMutation,
  prepareFilePermissionMatcher,
  readFileContentForValidation,
  readFileForEdit,
  validateEditableFileSize,
  validateEditDenyRule,
  validateFileNotModifiedSinceRead,
  validateTeamMemorySecrets,
  writeFileWithSideEffects,
} from '../FileEditTool/shared.js'
import { applyPatchToBuffers } from './applier.js'
import { FILE_PATCH_TOOL_NAME } from './constants.js'
import { parseFilePatch } from './parser.js'
import { getFilePatchToolDescription } from './prompt.js'
import {
  type ApplyPatchFileState,
  FilePatchError,
  type FilePatchOperation,
  type FilePatchToolInput,
  type FilePatchToolOutput,
  inputSchema,
  outputSchema,
} from './types.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'

export const FilePatchTool = buildTool({
  name: FILE_PATCH_TOOL_NAME,
  searchHint: 'apply unified diff patches',
  maxResultSizeChars: 100_000,
  strict: false,
  async description() {
    return 'Apply one or more file patches.'
  },
  async prompt() {
    return getFilePatchToolDescription()
  },
  userFacingName,
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Patching ${summary}` : 'Patching files'
  },
  get inputSchema() {
    return inputSchema()
  },
  get outputSchema() {
    return outputSchema()
  },
  toAutoClassifierInput(input) {
    if ('input' in input) {
      return input.input
    }
    return JSON.stringify(input.ops)
  },
  getPath(input) {
    const firstPath = firstOperationPath(input)
    return firstPath ? expandPath(firstPath) : ''
  },
  backfillObservableInput(input) {
    if ('ops' in input && Array.isArray(input.ops)) {
      for (const operation of input.ops) {
        if (typeof operation?.path === 'string') {
          operation.path = expandPath(operation.path)
        }
      }
    }
  },
  async preparePermissionMatcher(input) {
    return prepareFilePermissionMatcher(firstOperationPath(input) ?? '')
  },
  async checkPermissions(input, context) {
    const operations = normalizeOperations(input)
    const appState = context.getAppState()
    for (const operation of operations) {
      const pathsToCheck = [operation.path]
      if (operation.type === 'update' && operation.moveTo) {
        pathsToCheck.push(operation.moveTo)
      }
      for (const filePath of pathsToCheck) {
        const decision = checkSingleFileWritePermissions(
          FilePatchTool,
          { file_path: filePath },
          context,
        )
        if (decision.behavior !== 'allow') {
          return decision
        }
      }
    }
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: { type: 'mode', mode: appState.toolPermissionContext.mode },
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  async validateInput(input: FilePatchToolInput, toolUseContext: ToolUseContext) {
    try {
      const operations = normalizeOperations(input)
      for (const operation of operations) {
        const fullFilePath = operation.path

        if (operation.type !== 'delete') {
          const nextContent = getOperationContentPreview(operation)
          const secretValidation = validateTeamMemorySecrets(fullFilePath, nextContent)
          if (secretValidation) {
            return secretValidation
          }
        }

        const denyValidation = validateEditDenyRule(fullFilePath, toolUseContext, 2)
        if (denyValidation) {
          return denyValidation
        }

        if (isUncPath(fullFilePath)) {
          continue
        }

        const sizeValidation = await validateEditableFileSize(fullFilePath)
        if (sizeValidation) {
          return sizeValidation
        }

        if (operation.type === 'add') {
          const fileContent = await readFileContentForValidation(fullFilePath)
          if (fileContent !== null) {
            return {
              result: false,
              behavior: 'ask',
              message: `Cannot add ${fullFilePath} because it already exists — use "*** Update File:" to modify it, or choose a different path.`,
              errorCode: 3,
            }
          }
          continue
        }

        const fileContent = await readFileContentForValidation(fullFilePath)
        if (fileContent === null) {
          return {
            result: false,
            behavior: 'ask',
            message: `Cannot ${operation.type} ${fullFilePath} because it does not exist — check the path, or use "*** Add File:" to create a new file.`,
            errorCode: 4,
          }
        }

        if (fullFilePath.endsWith('.ipynb')) {
          return {
            result: false,
            behavior: 'ask',
            message: `File is a Jupyter Notebook. Use the ${NOTEBOOK_EDIT_TOOL_NAME} to edit this file.`,
            errorCode: 5,
          }
        }

        const staleValidation = validateFileNotModifiedSinceRead(
          fullFilePath,
          fileContent,
          toolUseContext,
          7,
        )
        if (staleValidation) {
          return staleValidation
        }

        if (operation.type === 'update') {
          const settingsValidationResult = validateInputForSettingsFileEdit(
            fullFilePath,
            fileContent,
            () => applyPatchToSingleFile(operation, currentFileState(fullFilePath, fileContent)),
          )
          if (settingsValidationResult !== null) {
            return settingsValidationResult
          }
        }
      }

      // Move destinations get their own pass so destination-type invariants key
      // to where the content lands, not the source, and are not short-circuited
      // by a source-path early exit above (e.g. a UNC source). The moved content
      // is the full patched source file, which is what will exist at the
      // destination. (No settings-schema check here: a move requires an absent
      // destination — errorCode 6 — so the target is always a new file, and
      // validateInputForSettingsFileEdit is a no-op when the before-content is
      // empty; a settings-path destination is gated by the dangerous-path
      // safety check in checkPermissions instead.)
      for (const operation of operations) {
        if (operation.type !== 'update' || !operation.moveTo) {
          continue
        }
        const destPath = operation.moveTo

        const moveDenyValidation = validateEditDenyRule(destPath, toolUseContext, 2)
        if (moveDenyValidation) {
          return moveDenyValidation
        }

        // Pure suffix check — no filesystem access, so it applies to UNC
        // destinations too (which skip the fs-dependent checks below).
        if (destPath.endsWith('.ipynb')) {
          return {
            result: false,
            behavior: 'ask',
            message: `File is a Jupyter Notebook. Use the ${NOTEBOOK_EDIT_TOOL_NAME} to edit this file.`,
            errorCode: 5,
          }
        }

        if (isUncPath(destPath)) {
          continue
        }

        const destContent = await readFileContentForValidation(destPath)
        if (destContent !== null) {
          return {
            result: false,
            behavior: 'ask',
            message: `Cannot move ${operation.path} to ${destPath} because the target already exists.`,
            errorCode: 6,
          }
        }
        // The team-memory secret scan for a move destination runs in call() on
        // the actual moved content: it needs the source content, which for a
        // UNC source must NOT be read here (a speculative read of a UNC path
        // during validation risks an NTLM credential leak) but IS read at
        // execution. See the guard in call().
      }

      return { result: true }
    } catch (error) {
      if (error instanceof Error) {
        return {
          result: false,
          message: error.message,
          errorCode: 1,
        }
      }
      throw error
    }
  },
  async call(input, { readFileState, updateFileHistoryState }, _, parentMessage) {
    const operations = normalizeOperations(input)
    const currentFiles = new Map<string, ApplyPatchFileState>()

    // Read-only phase: gather every file's current state before mutating disk.
    // No prepareFileMutation here — that mkdir + file-history side effect must
    // not fire until the in-memory apply below has proven the patch applies.
    for (const operation of operations) {
      const {
        content: originalFileContents,
        fileExists,
        encoding,
        lineEndings,
      } = readFileForEdit(operation.path)

      if (fileExists) {
        assertFileUnchangedSinceRead(
          operation.path,
          originalFileContents,
          readFileState,
        )
      }

      currentFiles.set(operation.path, {
        path: operation.path,
        exists: fileExists,
        buffer: {
          content: originalFileContents,
          encoding,
          lineEndings,
          noNewlineAtEndOfFile:
            originalFileContents.length > 0 && !originalFileContents.endsWith('\n'),
        },
      })

      if (operation.type === 'update' && operation.moveTo) {
        // Re-read the destination at call time. validateInput checked it was
        // absent, but it may have appeared since (TOCTOU). Only seed
        // currentFiles when it now exists — that trips the applier's
        // target-exists guard instead of silently overwriting; when it's still
        // absent we leave it out so moveTargetMeta keeps carrying the source's
        // encoding/line-endings forward.
        const moveTarget = readFileForEdit(operation.moveTo)
        if (moveTarget.fileExists) {
          currentFiles.set(operation.moveTo, {
            path: operation.moveTo,
            exists: true,
            buffer: {
              content: moveTarget.content,
              encoding: moveTarget.encoding,
              lineEndings: moveTarget.lineEndings,
              noNewlineAtEndOfFile:
                moveTarget.content.length > 0 && !moveTarget.content.endsWith('\n'),
            },
          })
        }
      }
    }

    // For move operations: the applier emits delete(src) + add(dst).
    // currentFiles has no entry for dst, so we carry source metadata forward.
    const moveTargetMeta = new Map<string, { encoding: BufferEncoding; lineEndings: 'LF' | 'CRLF' }>()
    for (const op of operations) {
      if (op.type === 'update' && op.moveTo) {
        const src = currentFiles.get(op.path)
        if (src) {
          moveTargetMeta.set(op.moveTo, {
            encoding: src.buffer.encoding ?? 'utf8',
            lineEndings: src.buffer.lineEndings ?? 'LF',
          })
        }
      }
    }

    // Build a cache map so the applier can detect "file changed since last read" on anchor failures.
    const cachedFiles = new Map<string, string>()
    for (const operation of operations) {
      const cached = readFileState.get(operation.path)
      if (cached && !cached.isPartialView) {
        cachedFiles.set(operation.path, cached.content)
      }
    }

    const applied = applyPatchToBuffers(operations, currentFiles, cachedFiles)

    // Team-memory secret guard on the actual content being written to a move
    // destination, keyed to the real destination path. validateInput cannot
    // scan a UNC source's content (a speculative read of a UNC path during
    // validation risks an NTLM credential leak), but the move reads the source
    // here — so scan the moved buffer now, before any disk mutation, so a
    // secret can't be moved into team memory unscanned. Runs only for move
    // destinations (the moved buffer is entirely new content at that path).
    const moveDestinations = new Set(
      operations
        .filter(
          (op): op is Extract<FilePatchOperation, { type: 'update' }> =>
            op.type === 'update' && op.moveTo !== undefined,
        )
        .map(op => op.moveTo as string),
    )
    for (const file of applied.files) {
      if (file.after === null || !moveDestinations.has(file.path)) {
        continue
      }
      const secretFailure = validateTeamMemorySecrets(file.path, file.after)
      if (secretFailure) {
        throw new FilePatchError(secretFailure.message, {
          code: 'TEAM_MEMORY_SECRET',
          path: file.path,
        })
      }
    }

    const writtenFiles: Array<{
      path: string
      before: string | null
      after: string | null
      encoding: BufferEncoding
      lineEndings: 'LF' | 'CRLF'
      existedBefore: boolean
    }> = []

    try {
      for (const file of applied.files) {
        const originalState = currentFiles.get(file.path)
        const moveMeta = moveTargetMeta.get(file.path)
        if (!originalState && !moveMeta) {
          continue
        }

        const encoding = originalState?.buffer.encoding ?? moveMeta?.encoding ?? 'utf8'
        const lineEndings = originalState?.buffer.lineEndings ?? moveMeta?.lineEndings ?? 'LF'

        // Deferred until the in-memory apply succeeded (above): create the
        // parent dir (covers a move into a not-yet-existing directory) and
        // record file history right before we touch disk.
        if (!isUncPath(file.path)) {
          await prepareFileMutation(
            file.path,
            updateFileHistoryState,
            parentMessage.uuid,
          )
        }

        // Every await above yields, and `file.after` was computed from the
        // read-only phase's buffer, so a write landing in between would be
        // overwritten silently. Re-read and compare against that same buffer
        // right before touching disk. Please avoid async operations between
        // here and the mutation below to preserve atomicity.
        const onDisk = readFileForEdit(file.path)
        if (
          onDisk.fileExists !== (originalState?.exists ?? false) ||
          onDisk.content !== (originalState?.buffer.content ?? '')
        ) {
          throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
        }

        if (file.type === 'delete') {
          await deleteFileWithSideEffects({
            absoluteFilePath: file.path,
            originalFileContents: file.before ?? '',
            readFileState,
          })
          writtenFiles.push({
            path: file.path,
            before: file.before,
            after: file.after,
            encoding,
            lineEndings,
            existedBefore: true,
          })
          continue
        }

        writeFileWithSideEffects({
          absoluteFilePath: file.path,
          originalFileContents: file.before ?? '',
          updatedFile: file.after ?? '',
          encoding,
          lineEndings,
          readFileState,
        })
        writtenFiles.push({
          path: file.path,
          before: file.before,
          after: file.after,
          encoding,
          lineEndings,
          existedBefore: originalState?.exists ?? false,
        })
      }
    } catch (error) {
      await rollbackAppliedFiles(writtenFiles, readFileState)
      throw error
    }

    for (const file of applied.files) {
      const op = file.type === 'add' ? 'write' : file.type === 'update' ? 'edit' : null
      if (op) {
        logFileOperation({ operation: op, tool: 'FilePatchTool', filePath: file.path })
      }
    }

    // Built field by field, never spread from the applier result: `before`/
    // `after` hold the whole file twice and this object is serialized verbatim
    // onto the transcript. structuredPatch plus a bounded firstLine is
    // everything any reader uses.
    const output: FilePatchToolOutput = {
      files: applied.files.map(file => {
        const entry: FilePatchToolOutput['files'][number] = {
          path: file.path,
          type: file.type,
          firstLine: firstLineForLanguageDetection(file.before ?? file.after),
          structuredPatch: boundPatchLinesForPersistence(
            getPatchFromContents({
              filePath: file.path,
              oldContent: file.before ?? '',
              newContent: file.after ?? '',
            }),
          ),
        }
        if (file.notes && file.notes.length > 0) {
          entry.notes = file.notes
        }
        return entry
      }),
    }

    return { data: output }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const count = output.files.length
    const noun = count === 1 ? 'file' : 'files'
    // Enumerate the resolved path + operation per file so the model can verify
    // what actually changed — with fuzzy anchor matching a hunk can land at a
    // slightly different location than intended, and the summary count alone
    // gave no confirmation of which paths were touched.
    const lines = output.files.map(file => {
      const verb =
        file.type === 'add'
          ? 'Added'
          : file.type === 'delete'
            ? 'Deleted'
            : 'Updated'
      // Placement disclosures ride on their own file's line: a multi-file
      // patch otherwise leaves the model guessing which target moved.
      const notes = file.notes?.length ? `: ${file.notes.join('; ')}` : ''
      return `${verb} ${file.path}${notes}`
    })
    const detail = lines.length > 0 ? `:\n${lines.join('\n')}` : '.'
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Applied patch to ${count} ${noun}${detail}`,
    }
  },
} satisfies ToolDef<ReturnType<typeof inputSchema>, FilePatchToolOutput>)

// Resolve the first target path from any shape getPath/preparePermissionMatcher
// can receive: the structured `{ ops }` arm, the raw `{ input: envelope }` arm
// (the only shape the GPT custom-tool path emits), and the synthetic
// `{ file_path }` that checkPermissions builds per target to reuse
// checkSingleFileWritePermissions. Returning '' here makes the shared write
// permission helper resolve the path to cwd, so every deny/safety/rule/
// working-directory check keys to the project dir instead of the real target —
// in acceptEdits (and the auto-mode acceptEdits fast path) that silently
// auto-allows a patch to ANY path. See
// docs/reports/2026-07-12-apply-patch-tool-review.md F1/M1.
function firstOperationPath(input: unknown): string | undefined {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const filePath = (input as { file_path?: unknown }).file_path
    if (typeof filePath === 'string') {
      return filePath || undefined
    }
  }
  try {
    const ops =
      input && typeof input === 'object' && 'input' in input
        ? parseFilePatch((input as { input: string }).input).ops
        : (input as { ops?: FilePatchOperation[] }).ops
    return ops?.[0]?.path
  } catch {
    return undefined
  }
}

function normalizeOperations(input: FilePatchToolInput): FilePatchOperation[] {
  const parsed = 'input' in input ? parseFilePatch(input.input).ops : input.ops

  const seen = new Set<string>()
  return parsed.map(operation => {
    const path = expandPath(operation.path)
    if (seen.has(path)) {
      throw new Error(`Patch contains duplicate file path: ${path}`)
    }
    seen.add(path)

    return {
      ...operation,
      path,
      ...(operation.type === 'update' && operation.moveTo
        ? { moveTo: expandPath(operation.moveTo) }
        : {}),
    }
  })
}

function currentFileState(path: string, content: string): ApplyPatchFileState {
  return {
    path,
    exists: true,
    buffer: {
      content,
      encoding: 'utf8',
      lineEndings: 'LF',
      noNewlineAtEndOfFile: content.length > 0 && !content.endsWith('\n'),
    },
  }
}

function applyPatchToSingleFile(
  operation: Extract<FilePatchOperation, { type: 'update' }>,
  fileState: ApplyPatchFileState,
): string {
  return applyPatchToBuffers([operation], new Map([[fileState.path, fileState]])).files[0]
    ?.after ?? fileState.buffer.content
}

async function rollbackAppliedFiles(
  writtenFiles: Array<{
    path: string
    before: string | null
    after: string | null
    encoding: BufferEncoding
    lineEndings: 'LF' | 'CRLF'
    existedBefore: boolean
  }>,
  readFileState: ToolUseContext['readFileState'],
): Promise<void> {
  for (const file of [...writtenFiles].reverse()) {
    // Best-effort: isolate each file so one rollback failure neither aborts
    // recovery of the rest nor propagates out to mask the original write error
    // that triggered the rollback (the caller rethrows that error).
    try {
      if (!file.existedBefore) {
        await deleteFileWithSideEffects({
          absoluteFilePath: file.path,
          originalFileContents: file.after ?? '',
          readFileState,
        })
        continue
      }

      writeFileWithSideEffects({
        absoluteFilePath: file.path,
        originalFileContents: file.after ?? '',
        updatedFile: file.before ?? '',
        encoding: file.encoding,
        lineEndings: file.lineEndings,
        readFileState,
      })
    } catch (rollbackError) {
      logError(
        rollbackError instanceof Error
          ? rollbackError
          : new Error(String(rollbackError)),
      )
    }
  }
}

function getOperationContentPreview(operation: FilePatchOperation): string {
  switch (operation.type) {
    case 'add':
      return operation.noNewlineAtEndOfFile
        ? operation.lines.join('\n')
        : `${operation.lines.join('\n')}\n`
    case 'update':
      return operation.hunks
        .flatMap(hunk => hunk.lines)
        .filter(line => line.kind !== 'delete')
        .map(line => line.text)
        .join('\n')
    case 'delete':
      return ''
  }
}
