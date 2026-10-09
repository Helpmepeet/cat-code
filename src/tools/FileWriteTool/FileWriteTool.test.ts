import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { randomUUID } from 'crypto'
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

async function validateWithPrepared(
  input: { file_path: string; content: string },
  context: ReturnType<typeof createContext>,
) {
  const prepared = await FileWriteTool.prepareExecution!(input as never)
  Object.assign(context, {
    preparedExecution: {
      toolName: FileWriteTool.name,
      input,
      state: prepared.state,
    },
  })
  try {
    return await FileWriteTool.validateInput(input as never, context)
  } finally {
    await prepared.cleanup()
  }
}

describe('read-before-write gate', () => {
  test('canonical-path permission checks return the original Write input shape', async () => {
    const filePath = writeFixture('permission-shape.txt')
    const input = { file_path: filePath, content: 'replacement\n' }
    const context = {
      readFileState: createFileStateCacheWithSizeLimit(10),
      getAppState: () => ({
        toolPermissionContext: {
          ...getEmptyToolPermissionContext(),
          mode: 'acceptEdits',
          additionalWorkingDirectories: new Map([[tmpDir, tmpDir]]),
        },
      }),
    }
    const prepared = await FileWriteTool.prepareExecution!(input as never)
    Object.assign(context, {
      preparedExecution: {
        toolName: FileWriteTool.name,
        input,
        state: prepared.state,
      },
    })
    try {
      const parsed = FileWriteTool.inputSchema.parse(input)
      const decision = await FileWriteTool.checkPermissions(
        parsed as never,
        context as never,
      )
      expect(decision.behavior).toBe('allow')
      if (decision.behavior === 'allow') {
        expect(decision.updatedInput).toBe(input)
      }
    } finally {
      await prepared.cleanup()
    }
  })

  test('rejects a write when only the head of the file was read', async () => {
    // Read caps a no-limit read at MAX_LINES_TO_READ, so a long file comes
    // back truncated by default. A write replaces the whole file, so that is
    // not enough to have seen.
    const filePath = writeFixture('truncated.txt')

    const result = await validateWithPrepared(
      { file_path: filePath, content: 'replacement' },
      createContext({ filePath, isTruncatedView: true }),
    )

    expect(result.result).toBe(false)
    expect(result.message).toContain('not been read completely')
  })

  test('allows a write when the whole file was read', async () => {
    const filePath = writeFixture('complete.txt')

    const result = await validateWithPrepared(
      { file_path: filePath, content: 'replacement' },
      createContext({ filePath }),
    )

    expect(result.result).toBe(true)
  })

  test('rejects a write after an explicit range read', async () => {
    const filePath = writeFixture('range-only.txt')

    const result = await validateWithPrepared(
      { file_path: filePath, content: 'replacement' },
      createContext({ filePath, offset: 1, limit: 1 }),
    )

    expect(result.result).toBe(false)
    expect(result.message).toContain('use an unbounded Read first')
    expect(result.message).toContain('targeted edit tool')
  })

  test('rejects a complete internal read that was not returned to the model', async () => {
    const filePath = writeFixture('internal-read.txt')

    const result = await validateWithPrepared(
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

    const result = await validateWithPrepared(
      { file_path: filePath, content: 'replacement' },
      context,
    )

    expect(result.result).toBe(false)
    expect(result.message).toContain('modified since read')
  })
})

test('new nested file creation stays in its prepared parent after a symlink swap', async () => {
  const allowed = join(tmpDir, 'allowed-parent')
  const outside = join(tmpDir, 'outside-parent')
  const parentAlias = join(tmpDir, 'write-parent-link')
  mkdirSync(allowed)
  mkdirSync(outside)
  symlinkSync(allowed, parentAlias)
  const input = {
    file_path: join(parentAlias, 'nested', 'deep', 'created.txt'),
    content: 'allowed-content',
  }
  const context = {
    readFileState: createFileStateCacheWithSizeLimit(10),
    updateFileHistoryState: () => undefined,
    dynamicSkillDirTriggers: new Set<string>(),
  }
  const previousSimple = process.env.CLAUDE_CODE_SIMPLE
  const previousHistory = process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
  process.env.CLAUDE_CODE_SIMPLE = '1'
  process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = '1'
  const prepared = await FileWriteTool.prepareExecution!(input as never)
  Object.assign(context, {
    preparedExecution: {
      toolName: FileWriteTool.name,
      input,
      state: prepared.state,
    },
  })
  try {
    unlinkSync(parentAlias)
    symlinkSync(outside, parentAlias)
    await FileWriteTool.call(
      input as never,
      context as never,
      undefined,
      { uuid: randomUUID() } as never,
    )
    expect(readFileSync(join(allowed, 'nested', 'deep', 'created.txt'), 'utf8')).toBe(
      'allowed-content',
    )
    expect(() =>
      readFileSync(join(outside, 'nested', 'deep', 'created.txt'), 'utf8'),
    ).toThrow()
  } finally {
    await prepared.cleanup()
    if (previousSimple === undefined) delete process.env.CLAUDE_CODE_SIMPLE
    else process.env.CLAUDE_CODE_SIMPLE = previousSimple
    if (previousHistory === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
    } else {
      process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = previousHistory
    }
  }
})

test('an ordinary file symlink continues to write its authorized target', async () => {
  const target = writeFixture('symlink-target.txt')
  const alias = join(tmpDir, 'symlink-write.txt')
  symlinkSync(target, alias)
  const input = { file_path: alias, content: 'symlink replacement\n' }
  const readFileState = createFileStateCacheWithSizeLimit(10)
  readFileState.set(alias, {
    content: 'existing content\n',
    timestamp: Date.now() + 60_000,
    offset: 1,
    limit: undefined,
    isWriteAuthorizedRead: true,
    fileIdentity: getFileIdentity(alias),
  })
  const context = {
    readFileState,
    updateFileHistoryState: () => undefined,
    dynamicSkillDirTriggers: new Set<string>(),
  }
  const previousSimple = process.env.CLAUDE_CODE_SIMPLE
  const previousHistory = process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
  process.env.CLAUDE_CODE_SIMPLE = '1'
  process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = '1'
  const prepared = await FileWriteTool.prepareExecution!(input as never)
  Object.assign(context, {
    preparedExecution: {
      toolName: FileWriteTool.name,
      input,
      state: prepared.state,
    },
  })
  try {
    await FileWriteTool.call(
      input as never,
      context as never,
      undefined,
      { uuid: randomUUID() } as never,
    )
    expect(readFileSync(target, 'utf8')).toBe('symlink replacement\n')
    expect(readFileSync(alias, 'utf8')).toBe('symlink replacement\n')
  } finally {
    await prepared.cleanup()
    if (previousSimple === undefined) delete process.env.CLAUDE_CODE_SIMPLE
    else process.env.CLAUDE_CODE_SIMPLE = previousSimple
    if (previousHistory === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
    } else {
      process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = previousHistory
    }
  }
})
