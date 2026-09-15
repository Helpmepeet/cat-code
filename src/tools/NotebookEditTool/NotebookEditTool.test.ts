import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, test } from 'bun:test'
import { acquireFileMutationLock } from '../../utils/atomicFile.js'
import { getFileIdentity } from '../../utils/file.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import { FileReadTool } from '../FileReadTool/FileReadTool.js'
import { NotebookEditTool, outputSchema } from './NotebookEditTool.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function notebookWithBulkCell(bulk: string): string {
  return JSON.stringify({
    cells: [
      {
        id: 'cell-1',
        cell_type: 'code',
        source: [bulk],
        metadata: {},
        outputs: [],
        execution_count: null,
      },
      {
        id: 'cell-2',
        cell_type: 'code',
        source: ['print(1)'],
        metadata: {},
        outputs: [],
        execution_count: null,
      },
    ],
    metadata: { language_info: { name: 'python' } },
    nbformat: 4,
    nbformat_minor: 5,
  })
}

function callNotebookEdit(notebookPath: string, contents: string) {
  const readFileState = createFileStateCacheWithSizeLimit(10)
  readFileState.set(notebookPath, {
    content: contents,
    timestamp: Date.now(),
    fileIdentity: getFileIdentity(notebookPath),
    offset: undefined,
    limit: undefined,
  })
  return NotebookEditTool.call(
    {
      notebook_path: notebookPath,
      cell_id: 'cell-2',
      new_source: 'print(2)',
      edit_mode: 'replace',
    },
    { readFileState, updateFileHistoryState: () => undefined } as never,
    undefined as never,
    { uuid: 'test-parent' } as never,
  )
}

describe('NotebookEditTool persisted result size', () => {
  test('editing one cell does not put the whole notebook on the transcript', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'notebook-edit-tool-'))
    tempDirs.push(tempDir)

    // The pre- and post-edit notebook JSON used to be persisted in full, side
    // by side, so one cell edit wrote the whole notebook twice.
    const notebookPath = join(tempDir, 'analysis.ipynb')
    const contents = notebookWithBulkCell('x = "' + 'BULK_SENTINEL'.repeat(20_000) + '"')
    writeFileSync(notebookPath, contents)

    const result = await callNotebookEdit(notebookPath, contents)

    expect(result.data.error).toBe('')
    expect(result.data).not.toHaveProperty('original_file')
    expect(result.data).not.toHaveProperty('updated_file')
    expect(JSON.stringify(result.data)).not.toContain('BULK_SENTINEL')

    // The edit still lands on disk; only the transcript copy is gone.
    expect(readFileSync(notebookPath, 'utf8')).toContain('print(2)')
  })

  test('an error result carries no notebook copy either', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'notebook-edit-tool-'))
    tempDirs.push(tempDir)

    const notebookPath = join(tempDir, 'broken.ipynb')
    const contents = 'BULK_SENTINEL not valid json'
    writeFileSync(notebookPath, contents)

    const result = await callNotebookEdit(notebookPath, contents)

    expect(result.data.error).toBe('Notebook is not valid JSON.')
    expect(result.data).not.toHaveProperty('original_file')
    expect(result.data).not.toHaveProperty('updated_file')
  })
})

function notebookWithCell(cell: Record<string, unknown>): string {
  return JSON.stringify({
    cells: [cell],
    metadata: { language_info: { name: 'python' } },
    nbformat: 4,
    nbformat_minor: 5,
  })
}

async function convertCell(
  cellType: 'code' | 'markdown',
  cell: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const tempDir = mkdtempSync(join(tmpdir(), 'notebook-edit-tool-'))
  tempDirs.push(tempDir)

  const notebookPath = join(tempDir, 'convert.ipynb')
  const contents = notebookWithCell(cell)
  writeFileSync(notebookPath, contents)

  const readFileState = createFileStateCacheWithSizeLimit(10)
  readFileState.set(notebookPath, {
    content: contents,
    timestamp: Date.now(),
    fileIdentity: getFileIdentity(notebookPath),
    offset: undefined,
    limit: undefined,
  })
  const result = await NotebookEditTool.call(
    {
      notebook_path: notebookPath,
      cell_id: 'cell-1',
      new_source: 'converted',
      cell_type: cellType,
      edit_mode: 'replace',
    },
    { readFileState, updateFileHistoryState: () => undefined } as never,
    undefined as never,
    { uuid: 'test-parent' } as never,
  )
  expect(result.data.error).toBe('')

  return JSON.parse(readFileSync(notebookPath, 'utf8')).cells[0]
}

describe('NotebookEditTool cell type conversion', () => {
  test('markdown to code writes a cell carrying the fields nbformat requires', async () => {
    const written = await convertCell('code', {
      id: 'cell-1',
      cell_type: 'markdown',
      source: ['# heading'],
      metadata: {},
    })

    expect(written.cell_type).toBe('code')
    // Both are `required` in the nbformat v4 code_cell schema, so a code cell
    // missing either one is rejected by nbformat.read.
    expect(written).toHaveProperty('execution_count')
    expect(written.execution_count).toBe(null)
    expect(written.outputs).toEqual([])
  })

  test('code to markdown drops the fields a markdown cell may not carry', async () => {
    const written = await convertCell('markdown', {
      id: 'cell-1',
      cell_type: 'code',
      source: ['print(1)'],
      metadata: {},
      outputs: [{ output_type: 'stream', name: 'stdout', text: ['1\n'] }],
      execution_count: 3,
    })

    expect(written.cell_type).toBe('markdown')
    // markdown_cell is additionalProperties:false, so either leftover invalidates it.
    expect(written).not.toHaveProperty('execution_count')
    expect(written).not.toHaveProperty('outputs')
  })

  test('replacing a code cell with the same type still clears its outputs', async () => {
    const written = await convertCell('code', {
      id: 'cell-1',
      cell_type: 'code',
      source: ['print(1)'],
      metadata: {},
      outputs: [{ output_type: 'stream', name: 'stdout', text: ['1\n'] }],
      execution_count: 3,
    })

    expect(written.cell_type).toBe('code')
    expect(written.execution_count).toBe(null)
    expect(written.outputs).toEqual([])
  })
})

describe('NotebookEditTool mutation safety', () => {
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'notebook-edit-safety-'))
    tempDirs.push(dir)
    const notebookPath = join(dir, 'analysis.ipynb')
    const contents = notebookWithBulkCell('original')
    writeFileSync(notebookPath, contents)
    const readFileState = createFileStateCacheWithSizeLimit(10)
    readFileState.set(notebookPath, {
      content: contents,
      timestamp: Date.now() + 60_000,
      fileIdentity: getFileIdentity(notebookPath),
      offset: 1,
      limit: undefined,
    })
    return {
      dir,
      notebookPath,
      contents,
      context: { readFileState, updateFileHistoryState: () => undefined },
      input: {
        notebook_path: notebookPath,
        cell_id: 'cell-2',
        new_source: 'print(2)',
        edit_mode: 'replace' as const,
      },
    }
  }

  test('validation rejects a replaced notebook even when its timestamp is not newer', async () => {
    const { notebookPath, context, input } = fixture()
    unlinkSync(notebookPath)
    const replacement = notebookWithBulkCell('replacement')
    writeFileSync(notebookPath, replacement)

    const result = await NotebookEditTool.validateInput(input, context as never)

    expect(result.result).toBe(false)
    expect(result.message).toContain('Read it again')
    expect(readFileSync(notebookPath, 'utf8')).toBe(replacement)
  })

  test('execution preserves a notebook replaced after validation', async () => {
    const { notebookPath, context, input } = fixture()
    const priorRead = context.readFileState.get(notebookPath)
    expect(
      (await NotebookEditTool.validateInput(input, context as never)).result,
    ).toBe(true)
    const replacement = notebookWithBulkCell('external edit').replace(
      'print(1)',
      'external work',
    )
    writeFileSync(notebookPath, replacement)

    const result = await NotebookEditTool.call(
      input,
      context as never,
      undefined as never,
      { uuid: 'test-parent' } as never,
    )

    expect(result.data.error).toContain('Read it again')
    expect(readFileSync(notebookPath, 'utf8')).toBe(replacement)
    expect(context.readFileState.get(notebookPath)).toBe(priorRead)
  })

  test('execution preserves both notebooks when a symlink is retargeted after validation', async () => {
    const { dir, notebookPath, contents, context, input } = fixture()
    const link = join(dir, 'link.ipynb')
    const otherPath = join(dir, 'other.ipynb')
    const otherContents = notebookWithBulkCell('unread').replace(
      'print(1)',
      'unread work',
    )
    writeFileSync(otherPath, otherContents)
    symlinkSync(notebookPath, link)
    context.readFileState.set(link, context.readFileState.get(notebookPath)!)
    const linkInput = { ...input, notebook_path: link }
    expect(
      (await NotebookEditTool.validateInput(linkInput, context as never)).result,
    ).toBe(true)
    unlinkSync(link)
    symlinkSync(otherPath, link)

    const result = await NotebookEditTool.call(
      linkInput,
      context as never,
      undefined as never,
      { uuid: 'test-parent' } as never,
    )

    expect(result.data.error).toContain('Read it again')
    expect(readFileSync(notebookPath, 'utf8')).toBe(contents)
    expect(readFileSync(otherPath, 'utf8')).toBe(otherContents)
  })

  test('execution waits for cooperative writers and checks the read again after the wait', async () => {
    const { notebookPath, context, input } = fixture()
    const release = await acquireFileMutationLock(notebookPath)
    let settled = false
    const pending = NotebookEditTool.call(
      input,
      context as never,
      undefined as never,
      { uuid: 'test-parent' } as never,
    ).then(result => {
      settled = true
      return result
    })
    const replacement = notebookWithBulkCell('cooperative writer')
    try {
      await Bun.sleep(20)
      expect(settled).toBe(false)
      writeFileSync(notebookPath, replacement)
    } finally {
      await release()
    }

    const result = await pending
    expect(result.data.error).toContain('Read it again')
    expect(readFileSync(notebookPath, 'utf8')).toBe(replacement)
  })

  test('a real Read permits successive notebook edits and a fresh Read sees the final source', async () => {
    const { notebookPath, context, input } = fixture()
    context.readFileState.clear()
    const readContext = { ...context, abortController: new AbortController() }
    const priorSimple = process.env.CLAUDE_CODE_SIMPLE
    process.env.CLAUDE_CODE_SIMPLE = '1'
    try {
      await FileReadTool.call({ file_path: notebookPath }, readContext as never)
      expect(
        (await NotebookEditTool.validateInput(input, context as never)).result,
      ).toBe(true)

      for (const newSource of ['print(2)', 'print(3)']) {
        const result = await NotebookEditTool.call(
          { ...input, new_source: newSource },
          context as never,
          undefined as never,
          { uuid: 'test-parent' } as never,
        )
        expect(result.data.error).toBe('')
        expect(context.readFileState.get(notebookPath)?.fileIdentity).toEqual(
          getFileIdentity(notebookPath),
        )
      }

      const result = await FileReadTool.call(
        { file_path: notebookPath },
        readContext as never,
      )
      expect(result.data.type).toBe('notebook')
      if (result.data.type === 'notebook') {
        expect(result.data.file.cells[1].source).toBe('print(3)')
      }
    } finally {
      if (priorSimple === undefined) delete process.env.CLAUDE_CODE_SIMPLE
      else process.env.CLAUDE_CODE_SIMPLE = priorSimple
    }
  })
})

describe('NotebookEditTool.outputSchema back-compat', () => {
  test('accepts a pre-2026-08 result carrying both notebook copies', () => {
    const parsed = outputSchema().safeParse({
      new_source: 'print(2)',
      cell_id: 'cell-2',
      cell_type: 'code',
      language: 'python',
      edit_mode: 'replace',
      error: '',
      notebook_path: '/x/a.ipynb',
      original_file: '{"cells":[]}',
      updated_file: '{"cells":[]}',
    })
    expect(parsed.success).toBe(true)
    // Declared, so a resumed record keeps them rather than having them stripped.
    expect(parsed.data?.original_file).toBe('{"cells":[]}')
  })

  test('accepts the compact result with neither copy', () => {
    const parsed = outputSchema().safeParse({
      new_source: 'print(2)',
      cell_id: 'cell-2',
      cell_type: 'code',
      language: 'python',
      edit_mode: 'replace',
      error: '',
      notebook_path: '/x/a.ipynb',
    })
    expect(parsed.success).toBe(true)
  })
})

describe('NotebookEditTool prompt matches the strict schema', () => {
  test('describes cell_id, not the cell_number the schema rejects', async () => {
    // The schema is strictObject with no cell_number key, so a call written to
    // the old prose was rejected outright.
    const prompt = await NotebookEditTool.prompt()
    const keys = Object.keys(NotebookEditTool.inputSchema.shape)

    expect(keys).toContain('cell_id')
    expect(keys).not.toContain('cell_number')
    expect(prompt).not.toContain('cell_number')
    expect(prompt).toContain('Cells are addressed by cell_id')
    expect(prompt).toContain('add a new cell after the cell with that id')
    expect(prompt).toContain('insert also requires cell_type')
  })
})
