import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, test } from 'bun:test'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import {
  MAX_PERSISTED_FIRST_LINE_LENGTH,
  MAX_PERSISTED_PATCH_LINE_LENGTH,
} from '../../utils/diff.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import { getPreparedFileMutation } from '../../utils/fileAuthorization.js'
import {
  readFileContentForValidation,
  validateEditableFileSize,
} from './shared.js'
import { FileEditTool } from './FileEditTool.js'
import { outputSchema } from './types.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function callEdit(
  input: { file_path: string; old_string: string; new_string: string },
  readFileState = createFileStateCacheWithSizeLimit(10),
  beforeCall?: () => void,
) {
  const toolInput = { ...input, replace_all: false }
  const context = {
      readFileState,
      updateFileHistoryState: () => undefined,
      getAppState: () => ({
        toolPermissionContext: getEmptyToolPermissionContext(),
      }),
  }
  return FileEditTool.prepareExecution!(toolInput as never).then(
    async prepared => {
      Object.assign(context, {
        preparedExecution: {
          toolName: FileEditTool.name,
          input: toolInput,
          state: prepared.state,
        },
      })
      try {
        const validation = await FileEditTool.validateInput(toolInput as never, context as never)
        if (!validation.result) throw new Error(validation.message)
        beforeCall?.()
        return await FileEditTool.call(
          toolInput as never,
          context as never,
          undefined as never,
          { uuid: 'test-parent' } as never,
        )
      } finally {
        await prepared.cleanup()
      }
    },
  )
}

describe('Edit indentation repair', () => {
  test.each(['\n', '\r\n'])('preserves Python block indentation with %j endings', async ending => {
    const tempDir = mkdtempSync(join(tmpdir(), 'file-edit-indent-'))
    tempDirs.push(tempDir)
    const filePath = join(tempDir, 'target.py')
    writeFileSync(filePath, ['def f():', '    if enabled:', '        first()', '        second()', ''].join(ending))
    const result = await callEdit({
      file_path: filePath,
      old_string: 'first()\nsecond()',
      new_string: 'first()\nchanged()',
    })
    expect(readFileSync(filePath, 'utf8')).toBe(
      ['def f():', '    if enabled:', '        first()', '        changed()', ''].join(ending),
    )
    expect(result.data.indentationAdjustment).toEqual({ from: '', to: '        ' })
    expect(result.data.newString).toBe('        first()\n        changed()')
    const persisted = outputSchema().parse(result.data)
    const message = FileEditTool.mapToolResultToToolResultBlockParam(persisted, 'edit-indent')
    expect(message.content).toContain('Leading indentation was adjusted consistently')
    expect(message.content).toContain('"" to "        "')
  })

  test.each([
    { source: '  first()\n    second()\n', old: 'first()\nsecond()', replacement: 'changed()' },
    { source: '  first()\n  second()\n', old: '    first()\n    second()', replacement: 'new()\n    changed()' },
    { source: '  first()\n  second()\n    first()\n    second()\n', old: 'first()\nsecond()', replacement: 'changed()' },
  ])('rejects unsafe or ambiguous indentation without writing: $source', async ({ source, old, replacement }) => {
    const tempDir = mkdtempSync(join(tmpdir(), 'file-edit-indent-reject-'))
    tempDirs.push(tempDir)
    const filePath = join(tempDir, 'target.py')
    writeFileSync(filePath, source)
    await expect(callEdit({
      file_path: filePath, old_string: old, new_string: replacement,
    })).rejects.toThrow('consistent indentation adjustment')
    expect(readFileSync(filePath, 'utf8')).toBe(source)
  })

  test('does not persist adjustment metadata for exact edits', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'file-edit-indent-exact-'))
    tempDirs.push(tempDir)
    const filePath = join(tempDir, 'target.py')
    writeFileSync(filePath, '    first()\n')
    const result = await callEdit({ file_path: filePath, old_string: 'first()', new_string: 'changed()' })
    expect(readFileSync(filePath, 'utf8')).toBe('    changed()\n')
    expect(result.data.indentationAdjustment).toBeUndefined()
    expect(FileEditTool.mapToolResultToToolResultBlockParam(result.data, 'edit-exact').content)
      .not.toContain('indentation')
  })

  test('revalidates an indentation edit against the execution snapshot', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'file-edit-indent-race-'))
    tempDirs.push(tempDir)
    const filePath = join(tempDir, 'target.py')
    writeFileSync(filePath, '  first()\n  second()\n')
    await expect(callEdit({
      file_path: filePath, old_string: 'first()\nsecond()', new_string: 'changed()',
    }, undefined, () => {
      writeFileSync(filePath, '  first()\n    second()\n')
    })).rejects.toThrow()
    expect(readFileSync(filePath, 'utf8')).toBe('  first()\n    second()\n')
  })
})

describe('Edit execution snapshots', () => {
  test.each(['absent', 'partial', 'stale'])('edits with %s read history', async history => {
    const tempDir = mkdtempSync(join(tmpdir(), 'file-edit-history-'))
    tempDirs.push(tempDir)
    const filePath = join(tempDir, 'target.txt')
    writeFileSync(filePath, 'current\nkeep\n')
    const readFileState = createFileStateCacheWithSizeLimit(10)
    if (history !== 'absent') {
      readFileState.set(filePath, {
        content: 'old content\n',
        timestamp: 0,
        offset: 1,
        limit: 1,
        isPartialView: history === 'partial',
      })
    }

    await callEdit({
      file_path: filePath,
      old_string: 'current',
      new_string: 'updated',
    }, readFileState)

    expect(readFileSync(filePath, 'utf8')).toBe('updated\nkeep\n')
  })

  test.each([
    { contents: 'other\n', message: 'String to replace not found' },
    { contents: 'target\ntarget\n', message: 'Found 2 matches' },
  ])('rejects an invalid current match: $message', async ({ contents, message }) => {
    const tempDir = mkdtempSync(join(tmpdir(), 'file-edit-match-'))
    tempDirs.push(tempDir)
    const filePath = join(tempDir, 'target.txt')
    writeFileSync(filePath, contents)

    await expect(callEdit({
      file_path: filePath,
      old_string: 'target',
      new_string: 'updated',
    })).rejects.toThrow(message)
    expect(readFileSync(filePath, 'utf8')).toBe(contents)
  })

  test('preserves an external edit after validation without a prior Read', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'file-edit-conflict-'))
    tempDirs.push(tempDir)
    const filePath = join(tempDir, 'target.txt')
    writeFileSync(filePath, 'target\nkeep\n')

    await expect(callEdit({
      file_path: filePath,
      old_string: 'target',
      new_string: 'updated',
    }, undefined, () => {
      writeFileSync(filePath, 'target\nexternal change\n')
    })).rejects.toThrow()
    expect(readFileSync(filePath, 'utf8')).toBe('target\nexternal change\n')
  })
})

describe('FileEditTool persisted result size', () => {
  test('validates content and size from the retained capability without pathname access', async () => {
    const capability = {
      identity: { size: 4 },
      get descriptorPath(): never {
        throw new Error('pathname validation is forbidden')
      },
      readFile: async () => Buffer.from('data'),
    }

    expect(await readFileContentForValidation(capability as never)).toBe('data')
    const tooLarge = await validateEditableFileSize(capability as never, 3)
    expect(tooLarge?.message).toContain('File is too large to edit')
    expect(await validateEditableFileSize(capability as never, 4)).toBeNull()
  })

  test('schema-parsed permission input reuses only its prepared path binding', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'file-edit-tool-'))
    tempDirs.push(tempDir)
    const filePath = join(tempDir, 'canonical-input.txt')
    writeFileSync(filePath, 'before\n')
    const input = {
      file_path: filePath,
      old_string: 'before',
      new_string: 'after',
    }
    const context = {
      readFileState: createFileStateCacheWithSizeLimit(10),
      updateFileHistoryState: () => undefined,
      getAppState: () => ({
        toolPermissionContext: {
          mode: 'acceptEdits',
          additionalWorkingDirectories: new Map([[tempDir, tempDir]]),
          alwaysAllowRules: {},
          alwaysDenyRules: {},
          alwaysAskRules: {},
          isBypassPermissionsModeAvailable: true,
        },
      }),
    }
    const prepared = await FileEditTool.prepareExecution!(input as never)
    Object.assign(context, {
      preparedExecution: {
        toolName: FileEditTool.name,
        input,
        state: prepared.state,
      },
    })
    try {
      const parsed = FileEditTool.inputSchema.parse(input)
      expect(
        getPreparedFileMutation(
          context as never,
          FileEditTool.name,
          parsed,
        ),
      ).toBe(prepared.state)
      expect(
        getPreparedFileMutation(
          context as never,
          FileEditTool.name,
          { ...parsed, file_path: join(tempDir, 'other.txt') },
        ),
      ).toBeUndefined()
      const decision = await FileEditTool.checkPermissions(
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
    const added = lines.filter(line => line.startsWith('+'))
    const removed = lines.filter(line => line.startsWith('-'))
    expect(added).toHaveLength(1)
    expect(removed).toHaveLength(1)
    // Tie the counts to the bounded case: a wrong implementation that split a
    // long line into several would still satisfy the counts above.
    expect(added[0]).toHaveLength(MAX_PERSISTED_PATCH_LINE_LENGTH + 1)
    expect(removed[0]).toHaveLength(MAX_PERSISTED_PATCH_LINE_LENGTH + 1)
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
