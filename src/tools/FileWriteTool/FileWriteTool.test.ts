import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, test } from 'bun:test'
import { MAX_PERSISTED_PATCH_LINE_LENGTH } from '../../utils/diff.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import { FileWriteTool } from './FileWriteTool.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Overwriting an existing file requires a matching read baseline, otherwise
// FileWriteTool.ts:299 rejects the write as an unexpected modification.
function callWrite(
  input: { file_path: string; content: string },
  priorContents?: string,
) {
  const readFileState = createFileStateCacheWithSizeLimit(10)
  if (priorContents !== undefined) {
    readFileState.set(input.file_path, {
      content: priorContents,
      timestamp: Date.now(),
      offset: undefined,
      limit: undefined,
    })
  }
  return FileWriteTool.call(
    input,
    {
      readFileState,
      updateFileHistoryState: () => undefined,
    } as never,
    undefined as never,
    { uuid: 'test-parent' } as never,
  )
}

describe('FileWriteTool persisted result size', () => {
  test('overwriting a file does not persist the previous contents', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'file-write-tool-'))
    tempDirs.push(tempDir)

    const filePath = join(tempDir, 'data.js')
    const priorContents = `var data=[${'BULK_SENTINEL'.repeat(20_000)}]\n`
    writeFileSync(filePath, priorContents)

    const result = await callWrite(
      { file_path: filePath, content: 'small\n' },
      priorContents,
    )

    // The pre-write file used to ride along here in full, on top of the copy
    // the rewrite diff legitimately carries as its delete line.
    expect(result.data).not.toHaveProperty('originalFile')

    const deletedLine = result.data.structuredPatch
      .flatMap(hunk => hunk.lines)
      .find(line => line.includes('BULK_SENTINEL'))!
    expect(deletedLine.startsWith('-')).toBe(true)
    expect(deletedLine).toHaveLength(MAX_PERSISTED_PATCH_LINE_LENGTH + 1)

    // Near the size of the diff, not twice the size of the 260 KB file.
    expect(JSON.stringify(result.data).length).toBeLessThan(4_000)
  })

  test('bounds a long line the rewrite diff pulls in', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'file-write-tool-'))
    tempDirs.push(tempDir)

    const filePath = join(tempDir, 'wide.txt')
    writeFileSync(filePath, 'header\nkeep\n')

    const result = await callWrite(
      { file_path: filePath, content: `header\n${'y'.repeat(9_000)}\n` },
      'header\nkeep\n',
    )

    const addedLine = result.data.structuredPatch
      .flatMap(hunk => hunk.lines)
      .find(line => line.startsWith('+') && line.includes('yyy'))!
    expect(addedLine).toHaveLength(MAX_PERSISTED_PATCH_LINE_LENGTH + 1)
    expect(addedLine.endsWith('…')).toBe(true)
  })

  test('creating a file still persists its content for the create-case readers', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'file-write-tool-'))
    tempDirs.push(tempDir)

    // useTurnDiffs.ts:168 and MessageSelector.tsx:748 count a created file's
    // lines from `content`, since its structuredPatch is empty by design.
    const result = await callWrite({
      file_path: join(tempDir, 'new.txt'),
      content: 'one\ntwo\n',
    })

    expect(result.data.type).toBe('create')
    expect(result.data.content).toBe('one\ntwo\n')
    expect(result.data.structuredPatch).toEqual([])
  })
})
