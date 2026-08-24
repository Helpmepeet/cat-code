import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { getFileIdentity } from '../../utils/file.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import { FileWriteTool } from './FileWriteTool.js'

let tmpDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'file-write-tool-'))
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function writeFixture(name: string): string {
  const filePath = join(tmpDir, name)
  writeFileSync(filePath, 'existing content\n', 'utf-8')
  return filePath
}

function createContext(state: {
  filePath: string
  isTruncatedView?: boolean
  isWriteAuthorizedRead?: boolean
  offset?: number
  limit?: number
}) {
  const readFileState = createFileStateCacheWithSizeLimit(10)
  readFileState.set(state.filePath, {
    content: 'existing content\n',
    // Comfortably ahead of the fixture's mtime, so the modified-since-read
    // guard cannot be what rejects the write.
    timestamp: Date.now() + 60_000,
    offset: state.offset ?? 1,
    limit: state.limit,
    isWriteAuthorizedRead: state.isWriteAuthorizedRead ?? true,
    fileIdentity: getFileIdentity(state.filePath),
    ...(state.isTruncatedView ? { isTruncatedView: true } : {}),
  })
  return {
    readFileState,
    getAppState: () => ({
      toolPermissionContext: getEmptyToolPermissionContext(),
    }),
  } as never
}

describe('read-before-write gate', () => {
  test('rejects a write when only the head of the file was read', async () => {
    // Read caps a no-limit read at MAX_LINES_TO_READ, so a long file comes
    // back truncated by default. A write replaces the whole file, so that is
    // not enough to have seen.
    const filePath = writeFixture('truncated.txt')

    const result = await FileWriteTool.validateInput(
      { file_path: filePath, content: 'replacement' },
      createContext({ filePath, isTruncatedView: true }),
    )

    expect(result.result).toBe(false)
    expect(result.message).toContain('not been read completely')
  })

  test('allows a write when the whole file was read', async () => {
    const filePath = writeFixture('complete.txt')

    const result = await FileWriteTool.validateInput(
      { file_path: filePath, content: 'replacement' },
      createContext({ filePath }),
    )

    expect(result.result).toBe(true)
  })

  test('rejects a write after an explicit range read', async () => {
    const filePath = writeFixture('range-only.txt')

    const result = await FileWriteTool.validateInput(
      { file_path: filePath, content: 'replacement' },
      createContext({ filePath, offset: 1, limit: 1 }),
    )

    expect(result.result).toBe(false)
    expect(result.message).toContain('use an unbounded Read first')
    expect(result.message).toContain('targeted edit tool')
  })

  test('rejects a complete internal read that was not returned to the model', async () => {
    const filePath = writeFixture('internal-read.txt')

    const result = await FileWriteTool.validateInput(
      { file_path: filePath, content: 'replacement' },
      createContext({ filePath, isWriteAuthorizedRead: false }),
    )

    expect(result.result).toBe(false)
    expect(result.message).toContain('not been read completely')
  })

  test('rejects a write when a symlink is retargeted after Read', async () => {
    const authorizedTarget = writeFixture('authorized-target.txt')
    const unreadTarget = writeFixture('unread-target.txt')
    const filePath = join(tmpDir, 'retargeted-link.txt')
    symlinkSync(authorizedTarget, filePath)
    const context = createContext({ filePath })
    unlinkSync(filePath)
    symlinkSync(unreadTarget, filePath)

    const result = await FileWriteTool.validateInput(
      { file_path: filePath, content: 'replacement' },
      context,
    )

    expect(result.result).toBe(false)
    expect(result.message).toContain('modified since read')
  })
})
