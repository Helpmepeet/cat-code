import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, test } from 'bun:test'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
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
