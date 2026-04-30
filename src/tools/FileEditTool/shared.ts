import { dirname, isAbsolute } from 'path'
import { diagnosticTracker } from '../../services/diagnosticTracking.js'
import { clearDeliveredDiagnosticsForFile } from '../../services/lsp/LSPDiagnosticRegistry.js'
import { getLspServerManager } from '../../services/lsp/manager.js'
import { notifyVscodeFileUpdated } from '../../services/mcp/vscodeSdkMcp.js'
import { checkTeamMemSecrets } from '../../services/teamMemorySync/teamMemSecretGuard.js'
import type { Tool, ToolUseContext } from '../../Tool.js'
import { isENOENT } from '../../utils/errors.js'
import {
  getFileModificationTime,
  writeTextContent,
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
} {
  try {
    const meta = readFileSyncWithMetadata(absoluteFilePath)
    return {
      content: meta.content,
      fileExists: true,
      encoding: meta.encoding,
      lineEndings: meta.lineEndings,
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

export function writeFileWithSideEffects({
  absoluteFilePath,
  originalFileContents,
  updatedFile,
  encoding,
  lineEndings,
  readFileState,
}: {
  absoluteFilePath: string
  originalFileContents: string
  updatedFile: string
  encoding: BufferEncoding
  lineEndings: LineEndingType
  readFileState: ToolUseContext['readFileState']
}): void {
  writeTextContent(absoluteFilePath, updatedFile, encoding, lineEndings)

  const lspManager = getLspServerManager()
  if (lspManager) {
    clearDeliveredDiagnosticsForFile(`file://${absoluteFilePath}`)
    lspManager.changeFile(absoluteFilePath, updatedFile).catch((err: Error) => {
      logError(err)
    })
    lspManager.saveFile(absoluteFilePath).catch((err: Error) => {
      logError(err)
    })
  }

  notifyVscodeFileUpdated(absoluteFilePath, originalFileContents, updatedFile)
  readFileState.set(absoluteFilePath, {
    content: updatedFile,
    timestamp: getFileModificationTime(absoluteFilePath),
    offset: undefined,
    limit: undefined,
  })
}

export async function deleteFileWithSideEffects({
  absoluteFilePath,
  originalFileContents,
  readFileState,
}: {
  absoluteFilePath: string
  originalFileContents: string
  readFileState: ToolUseContext['readFileState']
}): Promise<void> {
  await getFsImplementation().unlink(absoluteFilePath)

  const lspManager = getLspServerManager()
  if (lspManager) {
    clearDeliveredDiagnosticsForFile(`file://${absoluteFilePath}`)
    lspManager.closeFile(absoluteFilePath).catch((err: Error) => {
      logError(err)
    })
  }

  notifyVscodeFileUpdated(absoluteFilePath, originalFileContents, null)
  readFileState.delete(absoluteFilePath)
}
