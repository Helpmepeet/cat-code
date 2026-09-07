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
  getFileIdentity,
  getFileModificationTime,
  type FileIdentity,
  writeTextContentWithVerifiedIdentity,
} from '../../utils/file.js'
import {
  fileHistoryEnabled,
  fileHistoryTrackEdit,
} from '../../utils/fileHistory.js'
import {
  type LineEndingType,
  readFileSyncWithMetadata,
} from '../../utils/fileRead.js'
import { formatFileSize } from '../../utils/format.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
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
): PermissionDecision {
  const appState = context.getAppState()
  return checkWritePermissionForTool(tool, input, appState.toolPermissionContext)
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
  fullFilePath: string,
  maxSizeBytes: number = MAX_EDIT_FILE_SIZE,
  errorCode: number = 10,
): Promise<ValidationFailure | null> {
  const fs = getFsImplementation()
  try {
    const { size } = await fs.stat(fullFilePath)
    if (size <= maxSizeBytes) {
      return null
    }
    return {
      result: false,
      behavior: 'ask',
      message: `File is too large to edit (${formatFileSize(size)}). Maximum editable file size is ${formatFileSize(maxSizeBytes)}.`,
      errorCode,
    }
  } catch (e) {
    if (!isENOENT(e)) {
      throw e
    }
    return null
  }
}

export async function readFileContentForValidation(
  fullFilePath: string,
): Promise<string | null> {
  const fs = getFsImplementation()
  try {
    const fileBuffer = await fs.readFileBytes(fullFilePath)
    const encoding: BufferEncoding =
      fileBuffer.length >= 2 &&
      fileBuffer[0] === 0xff &&
      fileBuffer[1] === 0xfe
        ? 'utf16le'
        : 'utf8'
    return fileBuffer.toString(encoding).replaceAll('\r\n', '\n')
  } catch (e) {
    if (isENOENT(e)) {
      return null
    }
    throw e
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

export function readFileForEdit(absoluteFilePath: string): {
  content: string
  fileExists: boolean
  encoding: BufferEncoding
  lineEndings: LineEndingType
  identity?: FileIdentity
} {
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

export async function prepareFileMutation(
  absoluteFilePath: string,
  updateFileHistoryState: ToolUseContext['updateFileHistoryState'],
  parentMessageUUID: string,
): Promise<void> {
  const fs = getFsImplementation()
  await diagnosticTracker.beforeFileEdited(absoluteFilePath)
  await fs.mkdir(dirname(absoluteFilePath))
  if (fileHistoryEnabled()) {
    await fileHistoryTrackEdit(
      updateFileHistoryState,
      absoluteFilePath,
      parentMessageUUID,
    )
  }
}

export function writeFileMutation({
  absoluteFilePath,
  originalFileContents,
  updatedFile,
  encoding,
  lineEndings,
  expectedIdentity,
}: {
  absoluteFilePath: string
  originalFileContents: string | null
  updatedFile: string
  encoding: BufferEncoding
  lineEndings: LineEndingType
  expectedIdentity?: FileIdentity
}): FileMutationPublication {
  const didWrite = writeTextContentWithVerifiedIdentity(
    absoluteFilePath,
    updatedFile,
    encoding,
    lineEndings,
    expectedIdentity,
  )
  if (!didWrite) {
    throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
  }

  // Capture the exact object published by the filesystem before any cache,
  // LSP, VS Code, or logging observer can fail. This is optimistic conflict
  // detection plus cooperative locking, not crash-atomic multi-file state.
  const publishedIdentity = getFileIdentity(absoluteFilePath)
  return {
    absoluteFilePath,
    beforeContent: originalFileContents,
    afterContent: updatedFile,
    encoding,
    lineEndings,
    existedBefore: expectedIdentity !== undefined,
    expectedIdentity,
    publishedIdentity,
  }
}

export async function deleteFileMutation({
  absoluteFilePath,
  originalFileContents,
  encoding,
  lineEndings,
  expectedIdentity,
}: {
  absoluteFilePath: string
  originalFileContents: string
  encoding: BufferEncoding
  lineEndings: LineEndingType
  expectedIdentity: FileIdentity
}): Promise<FileMutationPublication> {
  if (!(await deleteFileWithVerifiedIdentity(absoluteFilePath, expectedIdentity))) {
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

export function writeFileWithSideEffects({
  absoluteFilePath,
  originalFileContents,
  updatedFile,
  encoding,
  lineEndings,
  readFileState,
  expectedIdentity,
  onPublished,
}: {
  absoluteFilePath: string
  originalFileContents: string | null
  updatedFile: string
  encoding: BufferEncoding
  lineEndings: LineEndingType
  readFileState: ToolUseContext['readFileState']
  expectedIdentity?: FileIdentity
  onPublished?: (publication: FileMutationPublication) => void
}): FileMutationPublication {
  const publication = writeFileMutation({
    absoluteFilePath,
    originalFileContents,
    updatedFile,
    encoding,
    lineEndings,
    expectedIdentity,
  })
  onPublished?.(publication)
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
  onPublished,
}: {
  absoluteFilePath: string
  originalFileContents: string
  encoding: BufferEncoding
  lineEndings: LineEndingType
  expectedIdentity: FileIdentity
  readFileState: ToolUseContext['readFileState']
  onPublished?: (publication: FileMutationPublication) => void
}): Promise<FileMutationPublication> {
  const publication = await deleteFileMutation({
    absoluteFilePath,
    originalFileContents,
    encoding,
    lineEndings,
    expectedIdentity,
  })
  onPublished?.(publication)
  applyFileMutationSideEffects({ publication, readFileState })
  return publication
}
