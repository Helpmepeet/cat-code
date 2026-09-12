import { feature } from 'bun:bundle'
import { extname, isAbsolute, resolve } from 'path'
import {
  fileHistoryEnabled,
  fileHistoryTrackEdit,
} from 'src/utils/fileHistory.js'
import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import type { NotebookCell, NotebookContent } from '../../types/notebook.js'
import { acquireFileMutationLock } from '../../utils/atomicFile.js'
import { getCwd } from '../../utils/cwd.js'
import { isENOENT } from '../../utils/errors.js'
import {
  fileIdentitiesEqual,
  getFileIdentity,
  writeTextContentWithVerifiedIdentity,
} from '../../utils/file.js'
import { readFileSyncWithMetadata } from '../../utils/fileRead.js'
import { safeParseJSON } from '../../utils/json.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { parseCellId } from '../../utils/notebook.js'
import { checkWritePermissionForTool } from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'
import { FILE_UNEXPECTEDLY_MODIFIED_ERROR } from '../FileEditTool/constants.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from './constants.js'
import { DESCRIPTION, PROMPT } from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
} from './UI.js'

export const inputSchema = lazySchema(() =>
  z.strictObject({
    notebook_path: z
      .string()
      .describe(
        'The absolute path to the Jupyter notebook file to edit (must be absolute, not relative)',
      ),
    cell_id: z
      .string()
      .optional()
      .describe(
        'The ID of the cell to edit. When inserting a new cell, the new cell will be inserted after the cell with this ID, or at the beginning if not specified.',
      ),
    new_source: z.string().describe('The new source for the cell'),
    cell_type: z
      .enum(['code', 'markdown'])
      .optional()
      .describe(
        'The type of the cell (code or markdown). If not specified, it defaults to the current cell type. If using edit_mode=insert, this is required.',
      ),
    edit_mode: z
      .enum(['replace', 'insert', 'delete'])
      .optional()
      .describe(
        'The type of edit to make (replace, insert, delete). Defaults to replace.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export const outputSchema = lazySchema(() =>
  z.object({
    new_source: z
      .string()
      .describe('The new source code that was written to the cell'),
    cell_id: z
      .string()
      .optional()
      .describe('The ID of the cell that was edited'),
    cell_type: z.enum(['code', 'markdown']).describe('The type of the cell'),
    language: z.string().describe('The programming language of the notebook'),
    edit_mode: z.string().describe('The edit mode that was used'),
    error: z
      .string()
      .optional()
      .describe('Error message if the operation failed'),
    // Fields for attribution tracking
    notebook_path: z.string().describe('The path to the notebook file'),
    // Legacy: pre-2026-08 transcripts persisted the whole notebook TWICE here,
    // before and after, on every cell edit. Nothing ever read either one, so
    // they are no longer written. Still declared because the read-back parse
    // strips undeclared keys, which keeps a resumed record intact.
    original_file: z
      .string()
      .optional()
      .describe('The original notebook content before modification'),
    updated_file: z
      .string()
      .optional()
      .describe('The updated notebook content after modification'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

const NOTEBOOK_NOT_READ_ERROR =
  'File has not been read yet. Read it first before writing to it.'

function readNotebookForEdit(
  fullPath: string,
  readFileState: ToolUseContext['readFileState'],
) {
  const lastRead = readFileState.get(fullPath)
  if (!lastRead || lastRead.isPartialView) {
    throw new Error(NOTEBOOK_NOT_READ_ERROR)
  }

  const identity = getFileIdentity(fullPath)
  if (
    lastRead.fileIdentity === undefined ||
    !fileIdentitiesEqual(lastRead.fileIdentity, identity)
  ) {
    throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
  }

  const metadata = readFileSyncWithMetadata(fullPath)
  if (!fileIdentitiesEqual(identity, getFileIdentity(fullPath))) {
    throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
  }
  return { ...metadata, identity }
}

export const NotebookEditTool = buildTool({
  name: NOTEBOOK_EDIT_TOOL_NAME,
  searchHint: 'edit Jupyter notebook cells (.ipynb)',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  userFacingName() {
    return 'Edit Notebook'
  },
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Editing notebook ${summary}` : 'Editing notebook'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  toAutoClassifierInput(input) {
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      const mode = input.edit_mode ?? 'replace'
      return `${input.notebook_path} ${mode}: ${input.new_source}`
    }
    return ''
  },
  getPath(input): string {
    return input.notebook_path
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const appState = context.getAppState()
    return checkWritePermissionForTool(
      NotebookEditTool,
      input,
      appState.toolPermissionContext,
    )
  },
  mapToolResultToToolResultBlockParam(
    { cell_id, edit_mode, new_source, error },
    toolUseID,
  ) {
    if (error) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: error,
        is_error: true,
      }
    }
    switch (edit_mode) {
      case 'replace':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `Updated cell ${cell_id} with ${new_source}`,
        }
      case 'insert':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `Inserted cell ${cell_id} with ${new_source}`,
        }
      case 'delete':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `Deleted cell ${cell_id}`,
        }
      default:
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: 'Unknown edit mode',
        }
    }
  },
  renderToolUseMessage,
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  async validateInput(
    { notebook_path, cell_type, cell_id, edit_mode = 'replace' },
    toolUseContext: ToolUseContext,
  ) {
    const fullPath = isAbsolute(notebook_path)
      ? notebook_path
      : resolve(getCwd(), notebook_path)

    // SECURITY: Skip filesystem operations for UNC paths to prevent NTLM credential leaks.
    if (fullPath.startsWith('\\\\') || fullPath.startsWith('//')) {
      return { result: true }
    }

    if (extname(fullPath) !== '.ipynb') {
      return {
        result: false,
        message:
          'File must be a Jupyter notebook (.ipynb file). For editing other file types, use the FileEdit tool.',
        errorCode: 2,
      }
    }

    if (
      edit_mode !== 'replace' &&
      edit_mode !== 'insert' &&
      edit_mode !== 'delete'
    ) {
      return {
        result: false,
        message: 'Edit mode must be replace, insert, or delete.',
        errorCode: 4,
      }
    }

    if (edit_mode === 'insert' && !cell_type) {
      return {
        result: false,
        message: 'Cell type is required when using edit_mode=insert.',
        errorCode: 5,
      }
    }

    let content: string
    try {
      content = readNotebookForEdit(fullPath, toolUseContext.readFileState).content
    } catch (e) {
      if (
        e instanceof Error &&
        (e.message === NOTEBOOK_NOT_READ_ERROR ||
          e.message === FILE_UNEXPECTEDLY_MODIFIED_ERROR)
      ) {
        return {
          result: false,
          message: e.message,
          errorCode: e.message === NOTEBOOK_NOT_READ_ERROR ? 9 : 10,
        }
      }
      if (isENOENT(e)) {
        return {
          result: false,
          message: 'Notebook file does not exist.',
          errorCode: 1,
        }
      }
      throw e
    }
    const notebook = safeParseJSON(content) as NotebookContent | null
    if (!notebook) {
      return {
        result: false,
        message: 'Notebook is not valid JSON.',
        errorCode: 6,
      }
    }
    if (!cell_id) {
      if (edit_mode !== 'insert') {
        return {
          result: false,
          message: 'Cell ID must be specified when not inserting a new cell.',
          errorCode: 7,
        }
      }
    } else {
      // First try to find the cell by its actual ID
      const cellIndex = notebook.cells.findIndex(cell => cell.id === cell_id)

      if (cellIndex === -1) {
        // If not found, try to parse as a numeric index (cell-N format)
        const parsedCellIndex = parseCellId(cell_id)
        if (parsedCellIndex !== undefined) {
          if (!notebook.cells[parsedCellIndex]) {
            return {
              result: false,
              message: `Cell with index ${parsedCellIndex} does not exist in notebook.`,
              errorCode: 7,
            }
          }
        } else {
          return {
            result: false,
            message: `Cell with ID "${cell_id}" not found in notebook.`,
            errorCode: 8,
          }
        }
      }
    }

    return { result: true }
  },
  async call(
    {
      notebook_path,
      new_source,
      cell_id,
      cell_type,
      edit_mode: originalEditMode,
    },
    { readFileState, updateFileHistoryState },
    _,
    parentMessage,
  ) {
    const fullPath = isAbsolute(notebook_path)
      ? notebook_path
      : resolve(getCwd(), notebook_path)

    const release = await acquireFileMutationLock(fullPath)
    try {
      // Permissions and the mutation lock can wait while another writer edits
      // the notebook. Recheck the Read identity after those waits.
      const { content, encoding, lineEndings, identity } =
        readNotebookForEdit(fullPath, readFileState)

      if (fileHistoryEnabled()) {
        await fileHistoryTrackEdit(
          updateFileHistoryState,
          fullPath,
          parentMessage.uuid,
        )
      }

      // Must use non-memoized jsonParse here: safeParseJSON caches by content
      // string and returns a shared object reference, but we mutate the
      // notebook in place below (cells.splice, targetCell.source = ...).
      // Using the memoized version poisons the cache for validateInput() and
      // any subsequent call() with the same file content.
      let notebook: NotebookContent
      try {
        notebook = jsonParse(content) as NotebookContent
      } catch {
        return {
          data: {
            new_source,
            cell_type: cell_type ?? 'code',
            language: 'python',
            edit_mode: 'replace',
            error: 'Notebook is not valid JSON.',
            cell_id,
            notebook_path: fullPath,
          },
        }
      }

      let cellIndex
      if (!cell_id) {
        cellIndex = 0 // Default to inserting at the beginning if no cell_id is provided
      } else {
        // First try to find the cell by its actual ID
        cellIndex = notebook.cells.findIndex(cell => cell.id === cell_id)

        // If not found, try to parse as a numeric index (cell-N format)
        if (cellIndex === -1) {
          const parsedCellIndex = parseCellId(cell_id)
          if (parsedCellIndex !== undefined) {
            cellIndex = parsedCellIndex
          }
        }

        if (originalEditMode === 'insert') {
          cellIndex += 1 // Insert after the cell with this ID
        }
      }

      // Convert replace to insert if trying to replace one past the end
      let edit_mode = originalEditMode
      if (edit_mode === 'replace' && cellIndex === notebook.cells.length) {
        edit_mode = 'insert'
        if (!cell_type) {
          cell_type = 'code' // Default to code if no cell_type specified
        }
      }

      const language = notebook.metadata.language_info?.name ?? 'python'
      let new_cell_id = undefined
      if (
        notebook.nbformat > 4 ||
        (notebook.nbformat === 4 && notebook.nbformat_minor >= 5)
      ) {
        if (edit_mode === 'insert') {
          new_cell_id = Math.random().toString(36).substring(2, 15)
        } else if (cell_id !== null) {
          new_cell_id = cell_id
        }
      }

      if (edit_mode === 'delete') {
        // Delete the specified cell
        notebook.cells.splice(cellIndex, 1)
      } else if (edit_mode === 'insert') {
        let new_cell: NotebookCell
        if (cell_type === 'markdown') {
          new_cell = {
            cell_type: 'markdown',
            id: new_cell_id,
            source: new_source,
            metadata: {},
          }
        } else {
          new_cell = {
            cell_type: 'code',
            id: new_cell_id,
            source: new_source,
            metadata: {},
            execution_count: null,
            outputs: [],
          }
        }
        // Insert the new cell
        notebook.cells.splice(cellIndex, 0, new_cell)
      } else {
        // Find the specified cell
        const targetCell = notebook.cells[cellIndex]! // validateInput ensures cell_id resolves in bounds
        targetCell.source = new_source
        if (cell_type && cell_type !== targetCell.cell_type) {
          targetCell.cell_type = cell_type
        }
        // Normalize against the type the cell ENDS UP as: nbformat v4 requires
        // both fields on a code cell and forbids them on a markdown one
        // (markdown_cell is additionalProperties:false).
        if (targetCell.cell_type === 'code') {
          // Reset execution count and clear outputs since cell was modified
          targetCell.execution_count = null
          targetCell.outputs = []
        } else {
          delete targetCell.execution_count
          delete targetCell.outputs
        }
      }
      // Write back to file
      const IPYNB_INDENT = 1
      const updatedContent = jsonStringify(notebook, null, IPYNB_INDENT)
      if (
        !writeTextContentWithVerifiedIdentity(
          fullPath,
          updatedContent,
          encoding,
          lineEndings,
          identity,
        )
      ) {
        throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
      }
      // Update readFileState with post-write mtime (matches FileEditTool/
      // FileWriteTool). offset:undefined breaks FileReadTool's dedup match —
      // without this, Read→NotebookEdit→Read in the same millisecond would
      // return the file_unchanged stub against stale in-context content.
      const publishedIdentity = getFileIdentity(fullPath)
      readFileState.set(fullPath, {
        content: updatedContent,
        timestamp: Math.floor(publishedIdentity.modifiedAtMs),
        offset: undefined,
        limit: undefined,
        fileIdentity: publishedIdentity,
      })
      const data = {
        new_source,
        cell_type: cell_type ?? 'code',
        language,
        edit_mode: edit_mode ?? 'replace',
        cell_id: new_cell_id || undefined,
        error: '',
        notebook_path: fullPath,
      }
      return {
        data,
      }
    } catch (error) {
      if (error instanceof Error) {
        const data = {
          new_source,
          cell_type: cell_type ?? 'code',
          language: 'python',
          edit_mode: 'replace',
          error: error.message,
          cell_id,
          notebook_path: fullPath,
        }
        return {
          data,
        }
      }
      const data = {
        new_source,
        cell_type: cell_type ?? 'code',
        language: 'python',
        edit_mode: 'replace',
        error: 'Unknown error occurred while editing notebook',
        cell_id,
        notebook_path: fullPath,
      }
      return {
        data,
      }
    } finally {
      await release()
    }
  },
} satisfies ToolDef<InputSchema, Output>)
