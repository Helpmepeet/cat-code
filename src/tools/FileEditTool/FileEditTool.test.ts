import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  MAX_PERSISTED_FIRST_LINE_LENGTH,
  MAX_PERSISTED_PATCH_LINE_LENGTH,
} from '../../utils/diff.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import { FileEditTool } from './FileEditTool.js'
import { outputSchema } from './types.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function callEdit(input: {
  file_path: string
  old_string: string
  new_string: string
}) {
  return FileEditTool.call(
    { ...input, replace_all: false },
    {
      readFileState: createFileStateCacheWithSizeLimit(10),
      updateFileHistoryState: () => undefined,
    } as never,
    undefined as never,
    { uuid: 'test-parent' } as never,
  )
}

describe('FileEditTool persisted result size', () => {
  test('does not put the edited file onto the transcript', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'file-edit-tool-'))
    tempDirs.push(tempDir)

    // Two independent routes by which a whole file used to be persisted: the
    // bulk on line one (firstLine) and the bulk on a line adjacent to the edit
    // (pulled into the hunk as a diff context line).
    const filePath = join(tempDir, 'data.js')
    const longFirstLine = `var head=[${'HEAD_SENTINEL'.repeat(20_000)}]`
    const longNeighbour = `var data=[${'BULK_SENTINEL'.repeat(20_000)}]`
    writeFileSync(
      filePath,
      `${longFirstLine}\n${'filler\n'.repeat(10)}${longNeighbour}\ntarget\n`,
    )

    const result = await callEdit({
      file_path: filePath,
      old_string: 'target',
      new_string: 'target edited',
    })

    // The pre-edit file used to ride along here in full.
    expect(result.data).not.toHaveProperty('originalFile')
    expect(result.data.firstLine).toHaveLength(MAX_PERSISTED_FIRST_LINE_LENGTH)

    const contextLine = result.data.structuredPatch
      .flatMap(hunk => hunk.lines)
      .find(line => line.includes('BULK_SENTINEL'))!
    // Still present and still marked as context, just bounded.
    expect(contextLine.startsWith(' ')).toBe(true)
    expect(contextLine).toHaveLength(MAX_PERSISTED_PATCH_LINE_LENGTH + 1)
    expect(contextLine.endsWith('…')).toBe(true)

    // Near the size of the diff, not of the 520 KB file.
    expect(JSON.stringify(result.data).length).toBeLessThan(5_000)
  })

  test('keeps add/delete line counts exact when a line is bounded', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'file-edit-tool-'))
    tempDirs.push(tempDir)

    // Every reader of a persisted patch counts +/- markers rather than reading
    // the text, so bounding must not disturb the markers or the line count.
    const filePath = join(tempDir, 'wide.txt')
    writeFileSync(filePath, `${'x'.repeat(9_000)}\nkeep\n`)

    const result = await callEdit({
      file_path: filePath,
      old_string: 'x'.repeat(9_000),
      new_string: 'y'.repeat(9_000),
    })

    const lines = result.data.structuredPatch.flatMap(hunk => hunk.lines)
    expect(lines.filter(line => line.startsWith('+'))).toHaveLength(1)
    expect(lines.filter(line => line.startsWith('-'))).toHaveLength(1)
  })
})

describe('FileEditTool.outputSchema back-compat', () => {
  const base = {
    filePath: '/x/a.ts',
    oldString: 'const a = 1',
    newString: 'const a = 2',
    userModified: false,
    replaceAll: false,
    structuredPatch: [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ['-const a = 1', '+const a = 2'],
      },
    ],
  }

  test('accepts a pre-2026-08 result carrying originalFile', () => {
    const parsed = outputSchema().safeParse({
      ...base,
      originalFile: 'const a = 1\n',
    })
    expect(parsed.success).toBe(true)
  })

  test('accepts the compact result carrying firstLine', () => {
    const parsed = outputSchema().safeParse({ ...base, firstLine: 'const a = 1' })
    expect(parsed.success).toBe(true)
  })
})
