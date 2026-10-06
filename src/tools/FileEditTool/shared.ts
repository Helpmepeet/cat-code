import { dirname, isAbsolute } from 'path'
import { diagnosticTracker } from '../../services/diagnosticTracking.js'
import { clearDeliveredDiagnosticsForFile } from '../../services/lsp/LSPDiagnosticRegistry.js'
import { getLspServerManager } from '../../services/lsp/manager.js'
import { notifyVscodeFileUpdated } from '../../services/mcp/vscodeSdkMcp.js'
import { checkTeamMemSecrets } from '../../services/teamMemorySync/teamMemSecretGuard.js'
import type { Tool, ToolUseContext } from '../../Tool.js'
import { isENOENT } from '../../utils/errors.js'
import {
  deleteFileWithVerifiedIdentity,
  fileIdentitiesEqual,
  getFileIdentity,
  getFileModificationTime,
  type FileIdentity,
  writeTextContentWithVerifiedIdentity,
} from '../../utils/file.js'
import {
  readPreparedFileMetadata,
  type PreparedFileMutation,
} from '../../utils/fileAuthorization.js'
export { readPreparedFileMetadata } from '../../utils/fileAuthorization.js'
import {
  fileHistoryEnabled,
  fileHistoryTrackEdit,
  type FileHistoryTrackSource,
} from '../../utils/fileHistory.js'
import {
  type LineEndingType,
  readFileSyncWithMetadata,
} from '../../utils/fileRead.js'
import { formatFileSize } from '../../utils/format.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import type { ContainedFileCapability } from '../../utils/containedFs.js'
import { logError } from '../../utils/log.js'
import { expandPath } from '../../utils/path.js'
import {
  checkWritePermissionForTool,
  matchingRuleForInput,
} from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import type { ValidationResult } from '../../Tool.js'
import { FILE_UNEXPECTEDLY_MODIFIED_ERROR } from './constants.js'

export const MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024 // 1 GiB (stat bytes)

export type FileMutationPublication = {
  absoluteFilePath: string
  beforeContent: string | null
  afterContent: string | null
  encoding: BufferEncoding
  lineEndings: LineEndingType
  existedBefore: boolean
  expectedIdentity?: FileIdentity
  publishedIdentity?: FileIdentity
  preparedMutation?: PreparedFileMutation
  publicationConflict?: true
}

export type FileMutationRestoration = 'restored' | 'conflict'

type ValidationFailure = Extract<ValidationResult, { result: false }> & {
  behavior?: 'ask'
}

export function backfillObservableFilePath(input: Record<string, unknown>): void {
  if (typeof input.file_path === 'string') {
    input.file_path = expandPath(input.file_path)
  }
}

export function prepareFilePermissionMatcher(filePath: string): (pattern: string) => boolean {
  return pattern => matchWildcardPattern(pattern, filePath)
}

export function checkSingleFileWritePermissions(
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext,
  precomputedPathsToCheck?: readonly string[],
): PermissionDecision {
  const appState = context.getAppState()
  return checkWritePermissionForTool(
    tool,
    input,
    appState.toolPermissionContext,
    precomputedPathsToCheck,
  )
}

export function validateTeamMemorySecrets(
  filePath: string,
  content: string,
): ValidationFailure | null {
  const secretError = checkTeamMemSecrets(filePath, content)
  if (!secretError) {
    return null
  }
  return { result: false, message: secretError, errorCode: 0 }
}

export function validateEditDenyRule(
  fullFilePath: string,
  toolUseContext: ToolUseContext,
  errorCode: number,
): ValidationFailure | null {
  const appState = toolUseContext.getAppState()
  const denyRule = matchingRuleForInput(
    fullFilePath,
    appState.toolPermissionContext,
    'edit',
    'deny',
  )
  if (denyRule === null) {
    return null
  }
  return {
    result: false,
    behavior: 'ask',
    message: 'File is in a directory that is denied by your permission settings.',
    errorCode,
  }
}

export function isUncPath(filePath: string): boolean {
  return filePath.startsWith('\\\\') || filePath.startsWith('//')
}

export async function validateEditableFileSize(
  fullFilePath: string | ContainedFileCapability,
  maxSizeBytes: number = MAX_EDIT_FILE_SIZE,
  errorCode: number = 10,
): Promise<ValidationFailure | null> {
  if (typeof fullFilePath !== 'string') {
    return validateEditableFileSizeValue(
      fullFilePath.identity.size,
      maxSizeBytes,
      errorCode,
    )
  }
  const fs = getFsImplementation()
  try {
    const { size } = await fs.stat(fullFilePath)
    return validateEditableFileSizeValue(size, maxSizeBytes, errorCode)
  } catch (e) {
    if (!isENOENT(e)) {
      throw e
    }
    return null
  }
}

export async function readFileContentForValidation(
  fullFilePath: string | ContainedFileCapability,
): Promise<string | null> {
  if (typeof fullFilePath !== 'string') {
    return decodeFileContentForValidation(await fullFilePath.readFile())
  }
  const fs = getFsImplementation()
  try {
    return decodeFileContentForValidation(await fs.readFileBytes(fullFilePath))
  } catch (e) {
    if (isENOENT(e)) {
      return null
    }
    throw e
  }
}

function decodeFileContentForValidation(fileBuffer: Buffer): string {
  const encoding: BufferEncoding =
    fileBuffer.length >= 2 &&
    fileBuffer[0] === 0xff &&
    fileBuffer[1] === 0xfe
      ? 'utf16le'
      : 'utf8'
  return fileBuffer.toString(encoding).replaceAll('\r\n', '\n')
}

function validateEditableFileSizeValue(
  size: number,
  maxSizeBytes: number,
  errorCode: number,
): ValidationFailure | null {
  if (size <= maxSizeBytes) return null
  return {
    result: false,
    behavior: 'ask',
    message: `File is too large to edit (${formatFileSize(size)}). Maximum editable file size is ${formatFileSize(maxSizeBytes)}.`,
    errorCode,
  }
}

export function validateFileWasRead(
  fullFilePath: string,
  filePathForUser: string,
  toolUseContext: ToolUseContext,
  errorCode: number,
): ValidationFailure | null {
  const readTimestamp = toolUseContext.readFileState.get(fullFilePath)
  if (readTimestamp && !readTimestamp.isPartialView) {
    return null
  }
  return {
    result: false,
    behavior: 'ask',
    message: 'File has not been read yet. Read it first before writing to it.',
    meta: {
      isFilePathAbsolute: String(isAbsolute(filePathForUser)),
    },
    errorCode,
  }
}

export function validateFileNotModifiedSinceRead(
  fullFilePath: string,
  fileContent: string,
  toolUseContext: ToolUseContext,
  errorCode: number,
): ValidationFailure | null {
  const readTimestamp = toolUseContext.readFileState.get(fullFilePath)
  if (!readTimestamp) {
    return null
  }

  const lastWriteTime = getFileModificationTime(fullFilePath)
  if (lastWriteTime <= readTimestamp.timestamp) {
    return null
  }

  const isFullRead =
    readTimestamp.offset === undefined && readTimestamp.limit === undefined
  if (isFullRead && fileContent === readTimestamp.content) {
    return null
  }

  return {
    result: false,
    behavior: 'ask',
    message:
      'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.',
    errorCode,
  }
}

export async function readFileForEdit(
  absoluteFilePath: string,
  prepared?: PreparedFileMutation,
): Promise<{
  content: string
  fileExists: boolean
  encoding: BufferEncoding
  lineEndings: LineEndingType
  identity?: FileIdentity
}> {
  if (prepared?.pathnameLimited) {
    return readFileForEdit(absoluteFilePath)
  }
  if (prepared !== undefined) {
    if (prepared.existing === undefined) {
      return {
        content: '',
        fileExists: false,
        encoding: 'utf8',
        lineEndings: 'LF',
      }
    }
    const meta = await readPreparedFileMetadata(prepared)
    return {
      content: meta.content,
      fileExists: true,
      encoding: meta.encoding,
      lineEndings: meta.lineEndings,
      identity: meta.identity,
    }
  }
  try {
    const meta = readFileSyncWithMetadata(absoluteFilePath)
    const identity = getFileIdentity(absoluteFilePath)
    return {
      content: meta.content,
      fileExists: true,
      encoding: meta.encoding,
      lineEndings: meta.lineEndings,
      identity,
    }
  } catch (e) {
    if (isENOENT(e)) {
      return {
        content: '',
        fileExists: false,
        encoding: 'utf8',
        lineEndings: 'LF',
      }
    }
    throw e
  }
}

export function assertFileUnchangedSinceRead(
  absoluteFilePath: string,
  originalFileContents: string,
  readFileState: ToolUseContext['readFileState'],
): void {
  const lastRead = readFileState.get(absoluteFilePath)
  // No baseline means we can't detect external modification — skip the check.
  // validateFileWasRead (FileEditTool) or validateFileNotModifiedSinceRead
  // (FilePatchTool) already return cleanly on !lastRead, so this is consistent.
  if (!lastRead) return
  const lastWriteTime = getFileModificationTime(absoluteFilePath)
  if (lastWriteTime > lastRead.timestamp) {
    const isFullRead = lastRead.offset === undefined && lastRead.limit === undefined
    const contentUnchanged = isFullRead && originalFileContents === lastRead.content
    if (!contentUnchanged) {
      throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
    }
  }
}

export async function assertPreparedFileUnchangedSinceRead(
  absoluteFilePath: string,
  originalFileContents: string,
  readFileState: ToolUseContext['readFileState'],
  prepared: PreparedFileMutation,
): Promise<void> {
  if (prepared.pathnameLimited) {
    assertFileUnchangedSinceRead(
      absoluteFilePath,
      originalFileContents,
      readFileState,
    )
    return
  }
  const lastRead = readFileState.get(absoluteFilePath)
  if (!lastRead || prepared.existing === undefined) return
  const identity = await prepared.existing.currentIdentity()
  const lastWriteTime = Math.floor(identity.modifiedAtMs)
  if (lastWriteTime <= lastRead.timestamp) return
  const isFullRead =
    lastRead.offset === undefined && lastRead.limit === undefined
  if (isFullRead && originalFileContents === lastRead.content) return
  throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
}

export async function fileHistorySourceForPreparedMutation(
  prepared?: PreparedFileMutation,
): Promise<FileHistoryTrackSource | undefined> {
  if (prepared?.parent === undefined) return undefined
  if (prepared.existing === undefined) {
    return { sourcePath: null }
  }
  const identity = await prepared.existing.currentIdentity()
  return {
    sourcePath: prepared.existing.path,
    copyTo: destinationPath => prepared.existing!.copyTo(destinationPath),
    stats: { size: identity.size, mode: identity.mode },
  }
}

export async function prepareFileMutation(
  absoluteFilePath: string,
  updateFileHistoryState: ToolUseContext['updateFileHistoryState'],
  parentMessageUUID: Parameters<typeof fileHistoryTrackEdit>[2],
  prepared?: PreparedFileMutation,
): Promise<void> {
  const fs = getFsImplementation()
  await diagnosticTracker.beforeFileEdited(absoluteFilePath)
  if (prepared?.parent === undefined) {
    await fs.mkdir(dirname(absoluteFilePath))
  }
  if (fileHistoryEnabled()) {
    await fileHistoryTrackEdit(
      updateFileHistoryState,
      absoluteFilePath,
      parentMessageUUID,
      await fileHistorySourceForPreparedMutation(prepared),
    )
  }
}

export async function writeFileMutation({
  absoluteFilePath,
  originalFileContents,
  updatedFile,
  encoding,
  lineEndings,
  expectedIdentity,
  preparedMutation,
}: {
  absoluteFilePath: string
  originalFileContents: string | null
  updatedFile: string
  encoding: BufferEncoding
  lineEndings: LineEndingType
  expectedIdentity?: FileIdentity
  preparedMutation?: PreparedFileMutation
}): Promise<FileMutationPublication> {
  let didWrite: boolean
  let publishedIdentity: FileIdentity | undefined
  let publicationConflict = false
  if (preparedMutation?.parent !== undefined) {
    let toWrite = updatedFile
    if (lineEndings === 'CRLF') {
      toWrite = updatedFile.replaceAll('\r\n', '\n').split('\n').join('\r\n')
    }
    const expectedDigest = await preparedMutation.existing?.digest()
    const identity = await preparedMutation.parent.publishFileWithIdentity(
      preparedMutation.relativePath,
      Buffer.from(toWrite, encoding),
      preparedMutation.existing?.identity,
      undefined,
      expectedDigest,
    )
    didWrite = identity !== null
    if (identity !== null) {
      publishedIdentity = identity
      publicationConflict = identity.publicationConflict === true
    }
  } else {
    didWrite = writeTextContentWithVerifiedIdentity(
      absoluteFilePath,
      updatedFile,
      encoding,
      lineEndings,
      expectedIdentity,
    )
  }
  if (!didWrite) {
    throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
  }

  // Capture the exact object published by the filesystem before any cache,
  // LSP, VS Code, or logging observer can fail. This is optimistic conflict
  // detection plus cooperative locking, not crash-atomic multi-file state.
  if (publishedIdentity === undefined) {
    publishedIdentity = getFileIdentity(absoluteFilePath)
  }
  return {
    absoluteFilePath,
    beforeContent: originalFileContents,
    afterContent: updatedFile,
    encoding,
    lineEndings,
    existedBefore: expectedIdentity !== undefined,
    expectedIdentity,
    publishedIdentity,
    ...(preparedMutation ? { preparedMutation } : {}),
    ...(publicationConflict ? { publicationConflict: true as const } : {}),
  }
}

export async function deleteFileMutation({
  absoluteFilePath,
  originalFileContents,
  encoding,
  lineEndings,
  expectedIdentity,
  preparedMutation,
}: {
  absoluteFilePath: string
  originalFileContents: string
  encoding: BufferEncoding
  lineEndings: LineEndingType
  expectedIdentity: FileIdentity
  preparedMutation?: PreparedFileMutation
}): Promise<FileMutationPublication> {
  const deleted =
    preparedMutation?.parent === undefined
      ? await deleteFileWithVerifiedIdentity(
          absoluteFilePath,
          expectedIdentity,
        )
      : preparedMutation.existing !== undefined &&
        fileIdentitiesEqual(expectedIdentity, {
          canonicalPath: preparedMutation.canonicalPath,
          device: preparedMutation.existing.identity.device,
          inode: preparedMutation.existing.identity.inode,
          size: preparedMutation.existing.identity.size,
          modifiedAtMs: preparedMutation.existing.identity.modifiedAtMs,
          changedAtMs: preparedMutation.existing.identity.changedAtMs,
          ...(preparedMutation.existing.identity.nativeFileId === undefined
            ? {}
            : {
                nativeFileId:
                  preparedMutation.existing.identity.nativeFileId,
              }),
        }) &&
        (await preparedMutation.parent.removeFile(
          preparedMutation.relativePath,
          preparedMutation.existing.identity,
          await preparedMutation.existing.digest(),
        ))
  if (!deleted) {
    throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
  }

  return {
    absoluteFilePath,
    beforeContent: originalFileContents,
    afterContent: null,
    encoding,
    lineEndings,
    existedBefore: true,
    expectedIdentity,
    ...(preparedMutation ? { preparedMutation } : {}),
  }
}

/**
 * Restore one published mutation only while its post-publication state still
 * owns the path. A deleted file is restored with no-clobber creation, so a
 * replacement that reappeared during recovery is preserved.
 */
export async function restoreFileMutation(
  publication: FileMutationPublication,
): Promise<FileMutationRestoration> {
  const prepared = publication.preparedMutation?.parent
    ? publication.preparedMutation
    : undefined
  if (prepared !== undefined) {
    if (publication.afterContent === null) {
      if (publication.beforeContent === null) return 'conflict'
      return (await prepared.parent.publishFile(
        prepared.relativePath,
        encodeFileContent(
          publication.beforeContent,
          publication.encoding,
          publication.lineEndings,
        ),
        undefined,
        prepared.existing?.identity.mode,
      ))
        ? 'restored'
        : 'conflict'
    }

    if (publication.publishedIdentity === undefined) return 'conflict'
    let current
    try {
      current = await prepared.parent.openFileCapability(prepared.relativePath)
    } catch (error) {
      if (isENOENT(error)) {
        return publication.existedBefore ? 'conflict' : 'restored'
      }
      throw error
    }
    try {
      const identity = {
        canonicalPath: prepared.canonicalPath,
        ...current.identity,
      }
      if (!fileIdentitiesEqual(publication.publishedIdentity, identity)) {
        return 'conflict'
      }
      if (!publication.existedBefore) {
        return (await prepared.parent.removeFile(
          prepared.relativePath,
          current.identity,
          await current.digest(),
        ))
          ? 'restored'
          : 'conflict'
      }
      if (publication.beforeContent === null) return 'conflict'
      return (await prepared.parent.publishFile(
        prepared.relativePath,
        encodeFileContent(
          publication.beforeContent,
          publication.encoding,
          publication.lineEndings,
        ),
        current.identity,
        undefined,
        await current.digest(),
      ))
        ? 'restored'
        : 'conflict'
    } finally {
      await current.close()
    }
  }

  if (publication.afterContent === null) {
    if (publication.beforeContent === null) return 'conflict'
    return writeTextContentWithVerifiedIdentity(
      publication.absoluteFilePath,
      publication.beforeContent,
      publication.encoding,
      publication.lineEndings,
      undefined,
    )
      ? 'restored'
      : 'conflict'
  }

  if (!publication.existedBefore) {
    if (publication.publishedIdentity === undefined) return 'conflict'

    try {
      getFileIdentity(publication.absoluteFilePath)
    } catch (error) {
      if (isENOENT(error)) return 'restored'
      throw error
    }

    return (await deleteFileWithVerifiedIdentity(
      publication.absoluteFilePath,
      publication.publishedIdentity,
    ))
      ? 'restored'
      : 'conflict'
  }

  if (publication.publishedIdentity === undefined) return 'conflict'
  if (publication.beforeContent === null) return 'conflict'

  return writeTextContentWithVerifiedIdentity(
    publication.absoluteFilePath,
    publication.beforeContent,
    publication.encoding,
    publication.lineEndings,
    publication.publishedIdentity,
  )
    ? 'restored'
    : 'conflict'
}

function encodeFileContent(
  content: string,
  encoding: BufferEncoding,
  endings: LineEndingType,
): Buffer {
  const normalized =
    endings === 'CRLF'
      ? content.replaceAll('\r\n', '\n').split('\n').join('\r\n')
      : content
  return Buffer.from(normalized, encoding)
}

function updateReadFileStateAfterPublication(
  publication: FileMutationPublication,
  readFileState: ToolUseContext['readFileState'],
): void {
  if (publication.afterContent === null) {
    readFileState.delete(publication.absoluteFilePath)
    return
  }

  const publishedIdentity = publication.publishedIdentity
  if (publishedIdentity === undefined) {
    throw new Error(
      `File publication did not return an identity for ${publication.absoluteFilePath}`,
    )
  }
  readFileState.set(publication.absoluteFilePath, {
    content: publication.afterContent,
    timestamp: Math.floor(publishedIdentity.modifiedAtMs),
    offset: undefined,
    limit: undefined,
    fileIdentity: publishedIdentity,
  })
}

export function applyFileMutationSideEffects({
  publication,
  readFileState,
}: {
  publication: FileMutationPublication
  readFileState: ToolUseContext['readFileState']
}): void {
  // Cache publication follows the transaction callback and precedes observers.
  // If it fails, the caller already has the exact filesystem publication.
  updateReadFileStateAfterPublication(publication, readFileState)

  const lspManager = getLspServerManager()
  if (lspManager) {
    clearDeliveredDiagnosticsForFile(
      `file://${publication.absoluteFilePath}`,
    )
    if (publication.afterContent === null) {
      lspManager
        .closeFile(publication.absoluteFilePath)
        .catch((err: Error) => {
          logError(err)
        })
    } else {
      lspManager
        .changeFile(
          publication.absoluteFilePath,
          publication.afterContent,
        )
        .catch((err: Error) => {
          logError(err)
        })
      lspManager
        .saveFile(publication.absoluteFilePath)
        .catch((err: Error) => {
          logError(err)
        })
    }
  }

  notifyVscodeFileUpdated(
    publication.absoluteFilePath,
    publication.beforeContent,
    publication.afterContent,
  )
}

export async function writeFileWithSideEffects({
  absoluteFilePath,
  originalFileContents,
  updatedFile,
  encoding,
  lineEndings,
  readFileState,
  expectedIdentity,
  preparedMutation,
  onPublished,
}: {
  absoluteFilePath: string
  originalFileContents: string | null
  updatedFile: string
  encoding: BufferEncoding
  lineEndings: LineEndingType
  readFileState: ToolUseContext['readFileState']
  expectedIdentity?: FileIdentity
  preparedMutation?: PreparedFileMutation
  onPublished?: (publication: FileMutationPublication) => void
}): Promise<FileMutationPublication> {
  const publication = await writeFileMutation({
    absoluteFilePath,
    originalFileContents,
    updatedFile,
    encoding,
    lineEndings,
    expectedIdentity,
    preparedMutation,
  })
  onPublished?.(publication)
  if (publication.publicationConflict) {
    if (!onPublished) {
      const restoration = await restoreFileMutation(publication)
      if (restoration !== 'restored') {
        throw new Error(
          `${FILE_UNEXPECTEDLY_MODIFIED_ERROR} Recovery could not restore the published file.`,
        )
      }
    }
    throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
  }
  applyFileMutationSideEffects({ publication, readFileState })
  return publication
}

export async function deleteFileWithSideEffects({
  absoluteFilePath,
  originalFileContents,
  readFileState,
  encoding,
  lineEndings,
  expectedIdentity,
  preparedMutation,
  onPublished,
}: {
  absoluteFilePath: string
  originalFileContents: string
  encoding: BufferEncoding
  lineEndings: LineEndingType
  expectedIdentity: FileIdentity
  readFileState: ToolUseContext['readFileState']
  preparedMutation?: PreparedFileMutation
  onPublished?: (publication: FileMutationPublication) => void
}): Promise<FileMutationPublication> {
  const publication = await deleteFileMutation({
    absoluteFilePath,
    originalFileContents,
    encoding,
    lineEndings,
    expectedIdentity,
    preparedMutation,
  })
  onPublished?.(publication)
  applyFileMutationSideEffects({ publication, readFileState })
  return publication
}
