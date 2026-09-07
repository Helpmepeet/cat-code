import { basename, dirname, join, normalize, sep } from 'path'
import { logFileOperation } from '../../utils/fileOperationAnalytics.js'
import { logError } from '../../utils/log.js'
import type { ToolUseContext } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { acquireFileMutationLocks } from '../../utils/atomicFile.js'
import {
  boundPatchLinesForPersistence,
  firstLineForLanguageDetection,
  getPatchFromContents,
} from '../../utils/diff.js'
import { getCwd } from '../../utils/cwd.js'
import {
  fileIdentitiesEqual,
  getFileIdentity,
} from '../../utils/file.js'
import { isCompleteUnboundedRead } from '../../utils/fileStateCache.js'
import {
  getFsImplementation,
  resolveDeepestExistingAncestorSync,
} from '../../utils/fsOperations.js'
import { isENOENT } from '../../utils/errors.js'
import { expandPath } from '../../utils/path.js'
import { validateInputForSettingsFileEdit } from '../../utils/settings/validateEditTool.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../NotebookEditTool/constants.js'
import { FILE_UNEXPECTEDLY_MODIFIED_ERROR } from '../FileEditTool/constants.js'
import {
  checkSingleFileWritePermissions,
  deleteFileWithSideEffects,
  isUncPath,
  prepareFileMutation,
  prepareFilePermissionMatcher,
  readFileContentForValidation,
  readFileForEdit,
  validateEditableFileSize,
  validateEditDenyRule,
  validateTeamMemorySecrets,
  applyFileMutationSideEffects,
  type FileMutationPublication,
  restoreFileMutation,
  writeFileWithSideEffects,
} from '../FileEditTool/shared.js'
import { applyPatchToBuffers } from './applier.js'
import { FILE_PATCH_TOOL_NAME } from './constants.js'
import { parseFilePatch } from './parser.js'
import { getFilePatchToolDescription } from './prompt.js'
import {
  type ApplyPatchFileState,
  type ApplyPatchSuccess,
  FilePatchError,
  type FilePatchMutationOutcome,
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
    let firstDenied: ReturnType<typeof checkSingleFileWritePermissions> | undefined
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
        if (decision.behavior !== 'allow' && firstDenied === undefined) {
          firstDenied = decision
        }
      }
    }
    if (firstDenied !== undefined) {
      return firstDenied
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
        if (operation.type !== 'delete') {
          const nextContent = getOperationContentPreview(operation)
          for (const { path } of operationPathRefs([operation])) {
            const secretValidation = validateTeamMemorySecrets(path, nextContent)
            if (secretValidation) {
              return secretValidation
            }
          }
        }
      }

      for (const { path } of operationPathRefs(operations)) {
        const denyValidation = validateEditDenyRule(path, toolUseContext, 2)
        if (denyValidation) {
          return denyValidation
        }
      }

      validateOperationIndependence(operations)

      for (const operation of operations) {
        const fullFilePath = operation.path
        if (isUncPath(fullFilePath)) continue

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
              message: `Cannot add ${fullFilePath} because it already exists. Use "*** Update File:" to modify it, or choose a different path.`,
              errorCode: 3,
              meta: {
                code: 'PATCH_TARGET_EXISTS',
                operation: 'add',
                path: fullFilePath,
              },
            }
          }
          continue
        }

        const fileContent = await readFileContentForValidation(fullFilePath)
        if (fileContent === null) {
          return {
            result: false,
            behavior: 'ask',
            message: `Cannot ${operation.type} ${fullFilePath} because it does not exist. Apply_patch resolved it relative to the current session working directory ${getCwd()}. Check the path, or use "*** Add File:" to create a new file.`,
            errorCode: 4,
            meta: {
              code: 'PATCH_TARGET_MISSING',
              operation: operation.type,
              path: fullFilePath,
            },
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

        if (operation.type === 'delete') {
          const readState = toolUseContext.readFileState.get(fullFilePath)
          if (
            !isCompleteUnboundedRead(readState) ||
            readState.fileIdentity === undefined
          ) {
            return {
              result: false,
              behavior: 'ask',
              message: `Cannot delete ${fullFilePath} without a complete, unbounded model-visible Read from the beginning that recorded its file identity. Read it completely before deleting it.`,
              errorCode: 7,
              meta: {
                code: 'PATCH_DELETE_REQUIRES_FULL_READ',
                operation: 'delete',
                path: fullFilePath,
              },
            }
          }
          const currentIdentity = getFileIdentity(fullFilePath)
          if (!fileIdentitiesEqual(readState.fileIdentity, currentIdentity)) {
            return {
              result: false,
              behavior: 'ask',
              message: `${FILE_UNEXPECTEDLY_MODIFIED_ERROR} The delete target snapshot for ${fullFilePath} no longer matches the stored Read identity.`,
              errorCode: 7,
              meta: {
                code: 'PATCH_SNAPSHOT_CONFLICT',
                operation: 'delete',
                path: fullFilePath,
              },
            }
          }
          continue
        }

        if (operation.type === 'update') {
          const settingsValidationResult = validateInputForSettingsFileEdit(
            operation.moveTo ?? fullFilePath,
            operation.moveTo ? '{}' : fileContent,
            () =>
              applyPatchToSingleFile(
                operation,
                currentFileState(fullFilePath, fileContent),
              ),
          )
          if (settingsValidationResult !== null) {
            return {
              ...settingsValidationResult,
              meta: {
                code: 'SETTINGS_VALIDATION_FAILED',
                operation: 'update',
                path: operation.moveTo ?? fullFilePath,
                ...(operation.moveTo
                  ? { moveTo: operation.moveTo }
                  : {}),
                hunkCount: operation.hunks.length,
              },
            }
          }
        }
      }

      for (const operation of operations) {
        if (operation.type !== 'update' || !operation.moveTo) {
          continue
        }
        const destPath = operation.moveTo

        if (destPath.endsWith('.ipynb')) {
          return {
            result: false,
            behavior: 'ask',
            message: `File is a Jupyter Notebook. Use the ${NOTEBOOK_EDIT_TOOL_NAME} to edit this file.`,
            errorCode: 5,
          }
        }

        if (isUncPath(destPath)) continue

        const destContent = await readFileContentForValidation(destPath)
        if (destContent !== null) {
          return {
            result: false,
            behavior: 'ask',
            message: `Cannot move ${operation.path} to ${destPath} because the target already exists.`,
            errorCode: 6,
            meta: {
              code: 'PATCH_TARGET_EXISTS',
              operation: 'update',
              path: destPath,
              moveTo: destPath,
              hunkCount: operation.hunks.length,
            },
          }
        }
      }

      return { result: true }
    } catch (error) {
      if (error instanceof FilePatchError) {
        return {
          result: false,
          behavior: 'ask',
          message: error.message,
          errorCode: 1,
          meta: {
            code: error.code,
            ...(error.operation !== undefined
              ? { operation: error.operation }
              : {}),
            ...(error.path !== undefined ? { path: error.path } : {}),
            ...(error.moveTo !== undefined ? { moveTo: error.moveTo } : {}),
            ...(error.hunkIndex !== undefined
              ? { hunkIndex: error.hunkIndex }
              : {}),
            ...(error.hunkCount !== undefined
              ? { hunkCount: error.hunkCount }
              : {}),
            ...(error.details !== undefined ? { details: error.details } : {}),
          },
        }
      }
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
    let operations: FilePatchOperation[]
    try {
      operations = normalizeOperations(input)
    } catch (error) {
      throw errorWithMutationOutcome(error, 'no-mutation')
    }

    try {
      validateOperationIndependence(operations)
    } catch (error) {
      throw errorWithMutationOutcome(error, 'no-mutation')
    }

    let releaseMutationLocks: () => Promise<void>
    try {
      releaseMutationLocks = await acquireFileMutationLocks(
        mutationPathsForOperations(operations),
      )
    } catch (error) {
      throw errorWithMutationOutcome(error, 'no-mutation')
    }

    try {
    const currentFiles = new Map<string, ApplyPatchFileState>()

    // Read-only phase: gather every affected path before mutating disk.
    for (const path of mutationPathsForOperations(operations)) {
      const {
        content,
        fileExists,
        encoding,
        lineEndings,
        identity,
      } = readFileForEdit(path)
      currentFiles.set(path, {
        path,
        exists: fileExists,
        identity,
        buffer: {
          content,
          encoding,
          lineEndings,
          noNewlineAtEndOfFile: content.length > 0 && !content.endsWith('\n'),
        },
      })
    }

    validateOperationIndependence(operations, currentFiles)

    for (const operation of operations) {
      if (operation.type !== 'delete') continue
      const readState = readFileState.get(operation.path)
      const current = currentFiles.get(operation.path)
      if (
        !isCompleteUnboundedRead(readState) ||
        readState.fileIdentity === undefined
      ) {
        throw new FilePatchError(
          `Cannot delete ${operation.path} without a complete, unbounded model-visible Read from the beginning that recorded its file identity. Read it completely before deleting it.`,
          {
            code: 'PATCH_DELETE_REQUIRES_FULL_READ',
            path: operation.path,
            operation: 'delete',
          },
        )
      }
      if (
        current?.exists === true &&
        (current.identity === undefined ||
          !fileIdentitiesEqual(readState.fileIdentity, current.identity))
      ) {
        throw new FilePatchError(
          `${FILE_UNEXPECTEDLY_MODIFIED_ERROR} The delete target snapshot for ${operation.path} no longer matches the stored Read identity.`,
          {
            code: 'PATCH_SNAPSHOT_CONFLICT',
            path: operation.path,
            operation: 'delete',
          },
        )
      }
    }

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

    const applied = applyPatchToBuffers(operations, currentFiles)

    for (const file of applied.files) {
      if (file.after === null) continue
      const operation = operationForResultFile(file, operations)
      const secretFailure = validateTeamMemorySecrets(file.path, file.after)
      if (secretFailure) {
        throw new FilePatchError(secretFailure.message, {
          code: 'TEAM_MEMORY_SECRET',
          path: file.path,
          ...(operation === undefined ? {} : { operation: operation.type }),
        })
      }
    }

    validateAppliedSettings(operations, currentFiles, applied.files)

    const moveDestinations = new Set(
      operations
        .filter(
          (op): op is Extract<FilePatchOperation, { type: 'update' }> =>
            op.type === 'update' && op.moveTo !== undefined,
        )
        .map(op => op.moveTo as string),
    )
    const moveSourcePaths = new Set(
      operations
        .filter(
          (op): op is Extract<FilePatchOperation, { type: 'update' }> =>
            op.type === 'update' && op.moveTo !== undefined,
        )
        .map(op => op.path),
    )
    const filesForMutation = [
      ...applied.files.filter(file => moveDestinations.has(file.path)),
      ...applied.files.filter(
        file =>
          !moveDestinations.has(file.path) && !moveSourcePaths.has(file.path),
      ),
      ...applied.files.filter(file => moveSourcePaths.has(file.path)),
    ]
    const writtenFiles: FileMutationPublication[] = []
    let mutatingFile: ApplyPatchSuccess | undefined

    try {
      for (const file of filesForMutation) {
        mutatingFile = file
        const originalState = currentFiles.get(file.path)
        const fileOperation = operationForResultFile(file, operations)
        const moveMeta = moveTargetMeta.get(file.path)
        if (!originalState && !moveMeta) {
          continue
        }

        const encoding =
          (originalState?.exists ? originalState.buffer.encoding : undefined) ??
          moveMeta?.encoding ??
          'utf8'
        const lineEndings =
          (originalState?.exists ? originalState.buffer.lineEndings : undefined) ??
          moveMeta?.lineEndings ??
          'LF'

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
          onDisk.content !== (originalState?.buffer.content ?? '') ||
          (originalState?.exists === true &&
            (originalState.identity === undefined ||
              onDisk.identity === undefined ||
              !fileIdentitiesEqual(originalState.identity, onDisk.identity)))
        ) {
          throw new FilePatchError(
            `${FILE_UNEXPECTEDLY_MODIFIED_ERROR} The execution snapshot for ${file.path} no longer matches.`,
            {
              code: 'PATCH_SNAPSHOT_CONFLICT',
              path: file.path,
              ...(fileOperation === undefined
                ? {}
                : { operation: fileOperation.type }),
              ...(fileOperation?.type === 'update'
                ? {
                    hunkCount: fileOperation.hunks.length,
                  }
                : {}),
            },
          )
        }

        if (file.type === 'delete') {
          if (originalState?.identity === undefined) {
            throw new FilePatchError(
              `${FILE_UNEXPECTEDLY_MODIFIED_ERROR} The execution snapshot for ${file.path} has no file identity.`,
              {
                code: 'PATCH_SNAPSHOT_CONFLICT',
                path: file.path,
                ...(fileOperation === undefined
                  ? {}
                  : { operation: fileOperation.type }),
                ...(fileOperation?.type === 'update'
                  ? {
                      hunkCount: fileOperation.hunks.length,
                    }
                  : {}),
              },
            )
          }
          await deleteFileWithSideEffects({
            absoluteFilePath: file.path,
            originalFileContents: file.before ?? '',
            encoding,
            lineEndings,
            readFileState,
            expectedIdentity: originalState.identity,
            onPublished: publication => writtenFiles.push(publication),
          })
          continue
        }

        writeFileWithSideEffects({
          absoluteFilePath: file.path,
          originalFileContents: file.before,
          updatedFile: file.after ?? '',
          encoding,
          lineEndings,
          readFileState,
          expectedIdentity: originalState?.identity,
          onPublished: publication => writtenFiles.push(publication),
        })
      }
    } catch (error) {
      const rollback = await rollbackAppliedFiles(writtenFiles, readFileState)
      throw errorWithMutationOutcome(
        addMutationContext(
          error,
          operationForResultFile(mutatingFile, operations),
        ),
        writtenFiles.length === 0
          ? 'no-mutation'
          : rollback === 'complete-rollback'
            ? 'complete-rollback'
            : 'incomplete-recovery',
      )
    }

    try {
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
          return entry
        }),
      }

      return { data: output }
    } catch (error) {
      const rollback = await rollbackAppliedFiles(writtenFiles, readFileState)
      throw errorWithMutationOutcome(
        addMutationContext(
          error,
          operationForResultFile(mutatingFile, operations),
          mutatingFile,
        ),
        writtenFiles.length === 0
          ? 'no-mutation'
          : rollback === 'complete-rollback'
            ? 'complete-rollback'
            : 'incomplete-recovery',
      )
    }
    } catch (error) {
      throw errorWithMutationOutcome(
        error,
        error instanceof FilePatchError ? error.mutationOutcome : 'no-mutation',
      )
    } finally {
      await releaseMutationLocks()
    }
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
      return `${verb} ${file.path}`
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

  const operations = parsed.map(operation => {
    const path = expandPath(operation.path)

    return {
      ...operation,
      path,
      ...(operation.type === 'update' && operation.moveTo
        ? { moveTo: expandPath(operation.moveTo) }
        : {}),
    }
  })

  const seen = new Set<string>()
  for (const operation of operations) {
    const paths = [
      operation.path,
      ...(operation.type === 'update' && operation.moveTo
        ? [operation.moveTo]
        : []),
    ]
    for (const path of paths) {
      if (seen.has(path)) {
        throw new FilePatchError(
          `Patch contains overlapping mutation paths: ${path}.`,
          {
            code: 'PATCH_OVERLAPPING_PATHS',
            path,
            operation: operation.type,
            ...(operation.type === 'update' && operation.moveTo
              ? { moveTo: operation.moveTo }
              : {}),
          },
        )
      }
      seen.add(path)
    }
  }

  return operations
}

type OperationPathRef = {
  path: string
  operation: FilePatchOperation
}

function operationPathRefs(
  operations: FilePatchOperation[],
): OperationPathRef[] {
  return operations.flatMap(operation => [
    { path: operation.path, operation },
    ...(operation.type === 'update' && operation.moveTo
      ? [{ path: operation.moveTo, operation }]
      : []),
  ])
}

function validateOperationIndependence(
  operations: FilePatchOperation[],
  currentFiles?: Map<string, ApplyPatchFileState>,
): void {
  const refs = operationPathRefs(operations)
  const routes: Array<{ key: string; ref: OperationPathRef }> = []

  for (const ref of refs) {
    const key = pathRouteKey(ref.path)
    const collision = routes.find(previous => pathsOverlap(previous.key, key))
    if (collision) {
      throw new FilePatchError(
        `Patch operations use overlapping paths ${collision.ref.path} and ${ref.path}. Keep every source and move destination disjoint.`,
        {
          code: 'PATCH_OVERLAPPING_PATHS',
          path: ref.path,
          operation: ref.operation.type,
          ...(ref.operation.type === 'update' && ref.operation.moveTo
            ? { moveTo: ref.operation.moveTo }
            : {}),
        },
      )
    }
    routes.push({ key, ref })
  }

  const objects = new Map<string, OperationPathRef>()
  for (const ref of refs) {
    if (isUncPath(ref.path)) continue
    const state = currentFiles?.get(ref.path)
    let identity = state?.exists ? state.identity : undefined
    if (currentFiles === undefined) {
      try {
        identity = getFileIdentity(ref.path)
      } catch (error) {
        if (isENOENT(error)) continue
        throw error
      }
    }
    if (identity === undefined) continue

    const identityKey =
      identity.inode === 0
        ? `path:${identity.canonicalPath}`
        : `object:${identity.device}:${identity.inode}`
    const previous = objects.get(identityKey)
    if (previous) {
      throw new FilePatchError(
        `Patch paths ${previous.path} and ${ref.path} name the same filesystem object. Keep every source and move destination independent.`,
        {
          code: 'PATCH_ALIASED_PATHS',
          path: ref.path,
          operation: ref.operation.type,
          ...(ref.operation.type === 'update' && ref.operation.moveTo
            ? { moveTo: ref.operation.moveTo }
            : {}),
        },
      )
    }
    objects.set(identityKey, ref)
  }
}

function pathRouteKey(path: string): string {
  if (isUncPath(path)) return path

  const fs = getFsImplementation()
  const normalizedPath = normalize(path).normalize('NFC')
  const route =
    resolveDeepestExistingAncestorSync(fs, normalizedPath) ?? normalizedPath
  return isCaseInsensitiveDirectory(dirname(route))
    ? route.toLocaleLowerCase()
    : route
}

function pathsOverlap(first: string, second: string): boolean {
  if (first === second) return true
  return (
    first.startsWith(`${second}${sep}`) ||
    second.startsWith(`${first}${sep}`)
  )
}

function isCaseInsensitiveDirectory(directory: string): boolean {
  if (isUncPath(directory)) return false
  const fs = getFsImplementation()
  let current = directory

  while (true) {
    try {
      const parent = dirname(current)
      const currentName = basename(current)
      const variant = toggleAsciiCase(currentName)
      if (variant !== currentName) {
        const entries = fs.readdirStringSync(parent)
        if (entries.includes(variant)) return false
        try {
          fs.lstatSync(join(parent, variant))
          return true
        } catch {
          // The current directory did not reveal its case rule.
        }
      }

      const entries = fs.readdirStringSync(current)
      for (const entry of entries) {
        const entryVariant = toggleAsciiCase(entry)
        if (entryVariant === entry) continue
        if (entries.includes(entryVariant)) return false
        try {
          fs.lstatSync(join(current, entryVariant))
          return true
        } catch {
          // Try an ancestor when this directory does not reveal its case rule.
        }
      }
    } catch {
      // Continue with the nearest readable ancestor.
    }

    const parent = dirname(current)
    if (parent === current) return false
    current = parent
  }
}

function toggleAsciiCase(value: string): string {
  return value.replace(/[A-Za-z]/g, character =>
    character === character.toLowerCase()
      ? character.toUpperCase()
      : character.toLowerCase(),
  )
}

function mutationPathsForOperations(
  operations: FilePatchOperation[],
): string[] {
  return Array.from(new Set(operations.flatMap(operation => [
    operation.path,
    ...(operation.type === 'update' && operation.moveTo
      ? [operation.moveTo]
      : []),
  ])))
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
  const result = applyPatchToBuffers(
    [operation],
    new Map([[fileState.path, fileState]]),
  )
  return (
    result.files.find(
      file => file.path === (operation.moveTo ?? operation.path) && file.after !== null,
    )?.after ?? fileState.buffer.content
  )
}

function operationForResultFile(
  file: ApplyPatchSuccess | undefined,
  operations: FilePatchOperation[],
): FilePatchOperation | undefined {
  if (file === undefined) return undefined

  if (file.type === 'delete') {
    return operations.find(
      operation =>
        operation.path === file.path &&
        (operation.type === 'delete' ||
          (operation.type === 'update' && operation.moveTo === undefined)),
    ) ??
      operations.find(
        operation =>
          operation.type === 'update' && operation.path === file.path,
      )
  }

  if (file.type === 'add') {
    return (
      operations.find(
        operation => operation.type === 'add' && operation.path === file.path,
      ) ??
      operations.find(
        operation =>
          operation.type === 'update' && operation.moveTo === file.path,
      )
    )
  }

  return operations.find(
    operation => operation.type === 'update' && operation.path === file.path,
  )
}

function validateAppliedSettings(
  operations: FilePatchOperation[],
  currentFiles: Map<string, ApplyPatchFileState>,
  files: ApplyPatchSuccess[],
): void {
  for (const file of files) {
    if (file.after === null) continue
    const operation = operationForResultFile(file, operations)
    if (operation === undefined) continue
    const before = currentFiles.get(file.path)
    const validation = validateInputForSettingsFileEdit(
      file.path,
      before?.exists === true ? before.buffer.content : '{}',
      () => file.after ?? '',
    )
    if (validation !== null) {
      throw new FilePatchError(validation.message, {
        code: 'SETTINGS_VALIDATION_FAILED',
        path: file.path,
        operation: operation.type,
        ...(operation.type === 'update' && operation.moveTo
          ? { moveTo: operation.moveTo }
          : {}),
        ...(operation.type === 'update'
          ? { hunkCount: operation.hunks.length }
          : {}),
      })
    }
  }
}

function addMutationContext(
  error: unknown,
  operation: FilePatchOperation | undefined,
  file?: ApplyPatchSuccess,
): unknown {
  if (error instanceof FilePatchError && error.operation !== undefined) {
    return error
  }

  const message = error instanceof Error ? error.message : String(error)
  if (operation === undefined) {
    return error instanceof FilePatchError
      ? error
      : new FilePatchError(message, { code: 'PATCH_MUTATION_FAILED' })
  }

  return new FilePatchError(message, {
    code:
      message.includes(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
        ? 'PATCH_SNAPSHOT_CONFLICT'
        : error instanceof FilePatchError
          ? error.code
          : 'PATCH_MUTATION_FAILED',
    path: error instanceof FilePatchError ? error.path : file?.path ?? operation.path,
    operation: operation.type,
    ...(operation.type === 'update' && operation.moveTo
      ? { moveTo: operation.moveTo }
      : {}),
    ...(operation.type === 'update'
      ? {
          hunkIndex: error instanceof FilePatchError ? error.hunkIndex : undefined,
          hunkCount: operation.hunks.length,
        }
      : {}),
    ...(error instanceof FilePatchError && error.details !== undefined
      ? { details: error.details }
      : {}),
  })
}

async function rollbackAppliedFiles(
  writtenFiles: FileMutationPublication[],
  readFileState: ToolUseContext['readFileState'],
): Promise<Extract<FilePatchMutationOutcome, 'complete-rollback' | 'incomplete-recovery'>> {
  let recoveryComplete = true

  for (const file of [...writtenFiles].reverse()) {
    try {
      const result = await restoreFileMutation(file)
      if (result === 'conflict') {
        recoveryComplete = false
        continue
      }

      try {
        const restoredIdentity = file.existedBefore
          ? getFileIdentity(file.absoluteFilePath)
          : undefined
        applyFileMutationSideEffects({
          publication: {
            absoluteFilePath: file.absoluteFilePath,
            beforeContent: file.afterContent,
            afterContent: file.existedBefore ? file.beforeContent : null,
            encoding: file.encoding,
            lineEndings: file.lineEndings,
            existedBefore: true,
            publishedIdentity: restoredIdentity,
          },
          readFileState,
        })
      } catch (sideEffectError) {
        logError(
          sideEffectError instanceof Error
            ? sideEffectError
            : new Error(String(sideEffectError)),
        )
      }
    } catch (rollbackError) {
      recoveryComplete = false
      logError(
        rollbackError instanceof Error
          ? rollbackError
          : new Error(String(rollbackError)),
      )
    }
  }

  return recoveryComplete ? 'complete-rollback' : 'incomplete-recovery'
}

function errorWithMutationOutcome(
  error: unknown,
  mutationOutcome: FilePatchMutationOutcome,
): FilePatchError {
  const originalMessage = error instanceof Error ? error.message : String(error)
  const message =
    mutationOutcome === 'no-mutation'
      ? originalMessage.includes('No files were changed by this patch.')
        ? originalMessage
        : `${originalMessage} No files were changed by this patch.`
      : mutationOutcome === 'complete-rollback'
        ? originalMessage.includes('Patch changes were rolled back completely.')
          ? originalMessage
          : `${originalMessage} Patch changes were rolled back completely.`
        : originalMessage.includes(
              'Patch failed after changing files. Recovery was incomplete; some published changes may remain.',
            )
          ? originalMessage
          : `${originalMessage} Patch failed after changing files. Recovery was incomplete; some published changes may remain.`

  if (error instanceof FilePatchError) {
    return new FilePatchError(message, {
      code: error.code,
      path: error.path,
      operation: error.operation,
      moveTo: error.moveTo,
      hunkIndex: error.hunkIndex,
      hunkCount: error.hunkCount,
      details: error.details,
      mutationOutcome,
    })
  }
  return new FilePatchError(message, { mutationOutcome })
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
