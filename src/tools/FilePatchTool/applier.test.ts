import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  getFsImplementation,
  setFsImplementation,
  setOriginalFsImplementation,
} from '../../utils/fsOperations.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import { FilePatchTool } from './FilePatchTool.js'
import {
  applyPatchToBuffers,
  applyUpdateHunks,
  serializeBuffer,
} from './applier.js'
import type { ApplyPatchFileState, FilePatchHunk, FilePatchOperation } from './types.js'

const tempDirs: string[] = []

afterEach(() => {
  setOriginalFsImplementation()
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function fileState(
  path: string,
  content: string,
  options?: { lineEndings?: 'LF' | 'CRLF'; exists?: boolean; noNewlineAtEndOfFile?: boolean },
): ApplyPatchFileState {
  return {
    path,
    exists: options?.exists ?? true,
    buffer: {
      content,
      encoding: 'utf8',
      lineEndings: options?.lineEndings ?? 'LF',
      noNewlineAtEndOfFile:
        options?.noNewlineAtEndOfFile ??
        (content.length > 0 && !content.endsWith('\n')),
    },
  }
}

function hunk(overrides: Partial<FilePatchHunk> & { lines: FilePatchHunk['lines'] }): FilePatchHunk {
  return {
    scopeHints: [],
    isEndOfFile: false,
    noNewlineAtEndOfFile: false,
    ...overrides,
  }
}

describe('applyUpdateHunks', () => {
  test('applies multiple hunks against the mutated buffer', () => {
    const result = applyUpdateHunks(
      { content: 'alpha\nbeta\ngamma\ndelta\n', lineEndings: 'LF' },
      [
        hunk({
          lines: [
            { kind: 'context', text: 'alpha' },
            { kind: 'delete', text: 'beta' },
            { kind: 'add', text: 'beta updated' },
            { kind: 'context', text: 'gamma' },
          ],
        }),
        hunk({
          lines: [
            { kind: 'context', text: 'gamma' },
            { kind: 'delete', text: 'delta' },
            { kind: 'add', text: 'delta updated' },
          ],
        }),
      ],
      '/tmp/example.txt',
    )

    expect(result.content).toBe('alpha\nbeta updated\ngamma\ndelta updated\n')
  })

  test('fails when the context no longer matches the mutated buffer', () => {
    expect(() =>
      applyUpdateHunks(
        { content: 'target\nremove me\n', lineEndings: 'LF' },
        [
          hunk({
            lines: [
              { kind: 'context', text: 'target' },
              { kind: 'delete', text: 'remove me' },
            ],
          }),
          hunk({
            lines: [
              { kind: 'context', text: 'target' },
              { kind: 'delete', text: 'remove me' },
              { kind: 'add', text: 'replacement' },
            ],
          }),
        ],
        '/tmp/example.txt',
      ),
    ).toThrow('anchor not found')
  })

  test('preserves no-newline markers and CRLF metadata', () => {
    const result = applyUpdateHunks(
      { content: 'alpha\nbeta\n', lineEndings: 'CRLF', noNewlineAtEndOfFile: false },
      [
        hunk({
          lines: [
            { kind: 'context', text: 'alpha' },
            { kind: 'delete', text: 'beta' },
            { kind: 'add', text: 'beta updated' },
          ],
          noNewlineAtEndOfFile: true,
        }),
      ],
      '/tmp/example.txt',
    )

    expect(result.content).toBe('alpha\nbeta updated')
    expect(serializeBuffer(result)).toBe('alpha\r\nbeta updated')
  })
})

describe('BOF and EOF (canonical Codex V4A)', () => {
  test('pure-insert hunk at position 2+ throws instead of silently prepending', () => {
    expect(() =>
      applyUpdateHunks(
        { content: 'line1\nline2\n', lineEndings: 'LF' },
        [
          hunk({ lines: [{ kind: 'context', text: 'line1' }, { kind: 'add', text: 'inserted' }] }),
          hunk({ lines: [{ kind: 'add', text: 'bad pure insert' }] }),
        ],
        '/tmp/example.ts',
      ),
    ).toThrow('pure-insert')
  })

  test('pure-insert first hunk with no scope hints prepends (BOF)', () => {
    const result = applyUpdateHunks(
      { content: 'line1\nline2\n', lineEndings: 'LF' },
      [hunk({ lines: [{ kind: 'add', text: '// top' }] })],
      '/tmp/example.ts',
    )
    expect(result.content).toBe('// top\nline1\nline2\n')
  })

  test('pure-insert first hunk on empty file produces only the added lines', () => {
    const result = applyUpdateHunks(
      { content: '', lineEndings: 'LF', noNewlineAtEndOfFile: false },
      [hunk({ lines: [{ kind: 'add', text: 'first' }] })],
      '/tmp/empty.ts',
    )
    expect(result.content).toBe('first\n')
  })

  test('isEndOfFile appends lines to a file', () => {
    const result = applyUpdateHunks(
      { content: 'line1\nline2\n', lineEndings: 'LF' },
      [hunk({ isEndOfFile: true, lines: [{ kind: 'add', text: '// end' }] })],
      '/tmp/example.ts',
    )
    expect(result.content).toBe('line1\nline2\n// end\n')
  })

  test('isEndOfFile pure-insert on empty file produces only the added lines', () => {
    const result = applyUpdateHunks(
      { content: '', lineEndings: 'LF', noNewlineAtEndOfFile: false },
      [hunk({ isEndOfFile: true, lines: [{ kind: 'add', text: 'first' }] })],
      '/tmp/empty.ts',
    )
    expect(result.content).toBe('first\n')
  })

  test('full-fingerprint uniqueness rejects ambiguous hunks', () => {
    expect(() =>
      applyUpdateHunks(
        { content: 'foo\nbar\nfoo\nbar\n', lineEndings: 'LF' },
        [
          hunk({
            lines: [
              { kind: 'context', text: 'foo' },
              { kind: 'context', text: 'bar' },
              { kind: 'add', text: 'inserted' },
            ],
          }),
        ],
        '/tmp/example.ts',
      ),
    ).toThrow('ambiguous')
  })

  test('full-fingerprint uniqueness succeeds when body is unique despite repeated context line', () => {
    const result = applyUpdateHunks(
      { content: 'foo\nbar\nfoo\nbaz\n', lineEndings: 'LF' },
      [
        hunk({
          lines: [
            { kind: 'context', text: 'foo' },
            { kind: 'context', text: 'baz' },
            { kind: 'add', text: 'inserted' },
          ],
        }),
      ],
      '/tmp/example.ts',
    )
    expect(result.content).toBe('foo\nbar\nfoo\nbaz\ninserted\n')
  })
})

describe('fuzzy matching tiers', () => {
  test('tier 2: matches context lines with trailing whitespace in file', () => {
    const result = applyUpdateHunks(
      { content: 'alpha   \nbeta\t\n', lineEndings: 'LF' },
      [
        hunk({
          lines: [
            { kind: 'context', text: 'alpha' },
            { kind: 'delete', text: 'beta' },
            { kind: 'add', text: 'beta updated' },
          ],
        }),
      ],
      '/tmp/example.ts',
    )
    expect(result.content).toBe('alpha   \nbeta updated\n')
  })

  test('tier 3: matches context lines with leading and trailing whitespace in file', () => {
    const result = applyUpdateHunks(
      { content: '    alpha   \n   beta\t\n', lineEndings: 'LF' },
      [
        hunk({
          lines: [
            { kind: 'context', text: 'alpha' },
            { kind: 'delete', text: 'beta' },
            { kind: 'add', text: 'beta updated' },
          ],
        }),
      ],
      '/tmp/example.ts',
    )
    expect(result.content).toBe('    alpha   \nbeta updated\n')
  })

  test('tier 4: matches context with unicode dashes normalized to ASCII', () => {
    // File contains en-dash (U+2013); patch uses ASCII hyphen
    const result = applyUpdateHunks(
      { content: 'foo \u2013 bar\nremove me\n', lineEndings: 'LF' },
      [
        hunk({
          lines: [
            { kind: 'context', text: 'foo - bar' },
            { kind: 'delete', text: 'remove me' },
          ],
        }),
      ],
      '/tmp/example.ts',
    )
    // Context line preserved as original file bytes
    expect(result.content).toBe('foo \u2013 bar\n')
  })

  test('tier 4: matches context with curly quotes normalized to ASCII', () => {
    // File contains left/right double quotes (U+201C, U+201D); patch uses straight quotes
    const result = applyUpdateHunks(
      { content: '\u201chello\u201d\nremove me\n', lineEndings: 'LF' },
      [
        hunk({
          lines: [
            { kind: 'context', text: '"hello"' },
            { kind: 'delete', text: 'remove me' },
          ],
        }),
      ],
      '/tmp/example.ts',
    )
    expect(result.content).toBe('\u201chello\u201d\n')
  })
})

describe('scope hint disambiguation', () => {
  test('uses @@ scope hint to pick between two ambiguous positions', () => {
    const content = [
      'class A {',
      '  getValue() {',
      '    return 1',
      '  }',
      '}',
      'class B {',
      '  getValue() {',
      '    return 2',
      '  }',
      '}',
    ].join('\n') + '\n'

    const result = applyUpdateHunks(
      { content, lineEndings: 'LF' },
      [
        hunk({
          scopeHints: ['class B'],
          lines: [
            { kind: 'context', text: '  getValue() {' },
            { kind: 'delete', text: '    return 2' },
            { kind: 'add', text: '    return 99' },
            { kind: 'context', text: '  }' },
          ],
        }),
      ],
      '/tmp/example.ts',
    )

    expect(result.content).toContain('    return 99')
    expect(result.content).toContain('    return 1')
    expect(result.content).not.toContain('    return 2')
  })
})

describe('applyPatchToBuffers', () => {
  test('applies add, update, and delete atomically in memory', () => {
    const currentFiles = new Map<string, ApplyPatchFileState>([
      ['/tmp/existing.txt', fileState('/tmp/existing.txt', 'one\ntwo\n')],
      ['/tmp/delete-me.txt', fileState('/tmp/delete-me.txt', 'gone\n')],
    ])

    const operations: FilePatchOperation[] = [
      {
        type: 'update',
        path: '/tmp/existing.txt',
        hunks: [
          hunk({
            lines: [
              { kind: 'context', text: 'one' },
              { kind: 'delete', text: 'two' },
              { kind: 'add', text: 'two updated' },
            ],
          }),
        ],
      },
      {
        type: 'add',
        path: '/tmp/new.txt',
        lines: ['created'],
        noNewlineAtEndOfFile: false,
      },
      {
        type: 'delete',
        path: '/tmp/delete-me.txt',
      },
    ]

    const result = applyPatchToBuffers(operations, currentFiles)

    expect(result.files).toEqual([
      {
        path: '/tmp/existing.txt',
        type: 'update',
        before: 'one\ntwo\n',
        after: 'one\ntwo updated\n',
      },
      {
        path: '/tmp/new.txt',
        type: 'add',
        before: null,
        after: 'created\n',
      },
      {
        path: '/tmp/delete-me.txt',
        type: 'delete',
        before: 'gone\n',
        after: null,
      },
    ])

    expect(currentFiles.get('/tmp/existing.txt')?.buffer.content).toBe('one\ntwo\n')
    expect(currentFiles.has('/tmp/new.txt')).toBe(false)
  })

  test('throws on ambiguous anchors', () => {
    const currentFiles = new Map<string, ApplyPatchFileState>([
      ['/tmp/example.txt', fileState('/tmp/example.txt', 'dup\nmid\ndup\n')],
    ])

    expect(() =>
      applyPatchToBuffers(
        [
          {
            type: 'update',
            path: '/tmp/example.txt',
            hunks: [
              hunk({
                lines: [
                  { kind: 'context', text: 'dup' },
                  { kind: 'add', text: 'inserted' },
                ],
              }),
            ],
          },
        ],
        currentFiles,
      ),
    ).toThrow('ambiguous')
  })

  test('bare @@ scope hint (empty string) does not act as universal match', () => {
    // Two identical regions — bare @@ should NOT disambiguate (empty hint = no-op)
    expect(() =>
      applyUpdateHunks(
        { content: 'foo\nbar\nfoo\nbar\n', lineEndings: 'LF' },
        [
          hunk({
            scopeHints: [''],
            lines: [
              { kind: 'context', text: 'foo' },
              { kind: 'context', text: 'bar' },
              { kind: 'add', text: 'inserted' },
            ],
          }),
        ],
        '/tmp/example.ts',
      ),
    ).toThrow('ambiguous')
  })

  test('move emits delete + add results', () => {
    const currentFiles = new Map<string, ApplyPatchFileState>([
      ['/tmp/old.txt', fileState('/tmp/old.txt', 'content\n')],
    ])

    const result = applyPatchToBuffers(
      [
        {
          type: 'update',
          path: '/tmp/old.txt',
          moveTo: '/tmp/new.txt',
          hunks: [
            hunk({
              lines: [
                { kind: 'context', text: 'content' },
                { kind: 'add', text: 'added' },
              ],
            }),
          ],
        },
      ],
      currentFiles,
    )

    expect(result.files[0]).toMatchObject({ path: '/tmp/old.txt', type: 'delete' })
    expect(result.files[1]).toMatchObject({ path: '/tmp/new.txt', type: 'add', after: 'content\nadded\n' })
  })

  test('restores earlier files if a later disk write fails', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'file-patch-tool-'))
    tempDirs.push(tempDir)

    const firstPath = join(tempDir, 'first.txt')
    const secondPath = join(tempDir, 'second.txt')
    writeFileSync(firstPath, 'one\ntwo\n')
    writeFileSync(secondPath, 'alpha\nbeta\n')

    const readFileState = createFileStateCacheWithSizeLimit(10)
    readFileState.set(firstPath, {
      content: 'one\ntwo\n',
      timestamp: Math.floor(Date.now()),
      offset: undefined,
      limit: undefined,
    })
    readFileState.set(secondPath, {
      content: 'alpha\nbeta\n',
      timestamp: Math.floor(Date.now()),
      offset: undefined,
      limit: undefined,
    })

    const originalFs = getFsImplementation()
    setFsImplementation({
      ...originalFs,
      async unlink(path) {
        if (path === secondPath) {
          throw new Error('forced unlink failure')
        }
        return originalFs.unlink(path)
      },
    })

    await expect(
      FilePatchTool.call(
        {
          ops: [
            {
              type: 'update',
              path: firstPath,
              hunks: [
                hunk({
                  lines: [
                    { kind: 'context', text: 'one' },
                    { kind: 'delete', text: 'two' },
                    { kind: 'add', text: 'two updated' },
                  ],
                }),
              ],
            },
            {
              type: 'delete',
              path: secondPath,
            },
          ],
        },
        {
          readFileState,
          updateFileHistoryState: () => undefined,
        } as never,
        undefined,
        { uuid: 'test-parent' } as never,
      ),
    ).rejects.toThrow('forced unlink failure')

    expect(readFileSync(firstPath, 'utf8')).toBe('one\ntwo\n')
    expect(readFileSync(secondPath, 'utf8')).toBe('alpha\nbeta\n')
    expect(readFileState.get(firstPath)?.content).toBe('one\ntwo\n')
    expect(readFileState.get(secondPath)?.content).toBe('alpha\nbeta\n')
  })
})

describe('FilePatchTool.call disk-mutation safety', () => {
  function seedReadState(path: string, content: string) {
    const readFileState = createFileStateCacheWithSizeLimit(10)
    readFileState.set(path, {
      content,
      timestamp: Math.floor(Date.now()),
      offset: undefined,
      limit: undefined,
    })
    return readFileState
  }

  test('M4: a failing in-memory apply performs no filesystem mutation setup', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'file-patch-tool-'))
    tempDirs.push(tempDir)
    const filePath = join(tempDir, 'a.txt')
    writeFileSync(filePath, 'hello\n')
    const readFileState = seedReadState(filePath, 'hello\n')

    let mkdirCalls = 0
    const originalFs = getFsImplementation()
    setFsImplementation({
      ...originalFs,
      async mkdir(...args: Parameters<typeof originalFs.mkdir>) {
        mkdirCalls += 1
        return originalFs.mkdir(...args)
      },
    })

    await expect(
      FilePatchTool.call(
        {
          ops: [
            {
              type: 'update',
              path: filePath,
              hunks: [
                hunk({
                  lines: [
                    { kind: 'context', text: 'no-such-anchor-line' },
                    { kind: 'delete', text: 'hello' },
                  ],
                }),
              ],
            },
          ],
        },
        {
          readFileState,
          updateFileHistoryState: () => undefined,
        } as never,
        undefined,
        { uuid: 'test-parent' } as never,
      ),
    ).rejects.toThrow()

    // The patch never applied in memory, so mkdir/file-history setup must not
    // have run and the file must be untouched.
    expect(mkdirCalls).toBe(0)
    expect(readFileSync(filePath, 'utf8')).toBe('hello\n')
  })

  test('M2: a move whose destination appeared after validation is refused, not overwritten', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'file-patch-tool-'))
    tempDirs.push(tempDir)
    const srcPath = join(tempDir, 'src.txt')
    const dstPath = join(tempDir, 'dst.txt')
    writeFileSync(srcPath, 'content\n')
    // Destination did not exist when validateInput ran; it appeared before call.
    writeFileSync(dstPath, 'PRE-EXISTING\n')
    const readFileState = seedReadState(srcPath, 'content\n')

    await expect(
      FilePatchTool.call(
        {
          ops: [
            {
              type: 'update',
              path: srcPath,
              moveTo: dstPath,
              hunks: [
                hunk({
                  lines: [
                    { kind: 'context', text: 'content' },
                    { kind: 'add', text: 'added' },
                  ],
                }),
              ],
            },
          ],
        },
        {
          readFileState,
          updateFileHistoryState: () => undefined,
        } as never,
        undefined,
        { uuid: 'test-parent' } as never,
      ),
    ).rejects.toThrow('already exists')

    expect(readFileSync(dstPath, 'utf8')).toBe('PRE-EXISTING\n')
    expect(readFileSync(srcPath, 'utf8')).toBe('content\n')
  })

  test('M3: a rollback failure does not mask the original write error', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'file-patch-tool-'))
    tempDirs.push(tempDir)
    const addPath = join(tempDir, 'new.txt')
    const deletePath = join(tempDir, 'second.txt')
    writeFileSync(deletePath, 'bye\n')
    const readFileState = seedReadState(deletePath, 'bye\n')

    const originalFs = getFsImplementation()
    setFsImplementation({
      ...originalFs,
      async unlink(path: string) {
        if (path === deletePath) throw new Error('ORIGINAL delete failure')
        if (path === addPath) throw new Error('ROLLBACK delete failure')
        return originalFs.unlink(path)
      },
    })

    // add new.txt succeeds, then delete second.txt throws (original error);
    // rolling back the add re-throws (rollback error). The original must win.
    await expect(
      FilePatchTool.call(
        {
          ops: [
            {
              type: 'add',
              path: addPath,
              lines: ['created'],
              noNewlineAtEndOfFile: false,
            },
            { type: 'delete', path: deletePath },
          ],
        },
        {
          readFileState,
          updateFileHistoryState: () => undefined,
        } as never,
        undefined,
        { uuid: 'test-parent' } as never,
      ),
    ).rejects.toThrow('ORIGINAL delete failure')
  })
})

describe('FilePatchTool.validateInput move destination', () => {
  function validateContext() {
    return {
      getAppState: () => ({
        toolPermissionContext: {
          mode: 'default',
          additionalWorkingDirectories: new Map(),
          alwaysAllowRules: {},
          alwaysDenyRules: {},
          alwaysAskRules: {},
          isBypassPermissionsModeAvailable: true,
        },
      }),
      readFileState: createFileStateCacheWithSizeLimit(10),
    } as never
  }

  test('M2: rejects a move into a .ipynb destination (destination-type invariant keyed to the destination)', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'file-patch-tool-'))
    tempDirs.push(tempDir)
    const srcPath = join(tempDir, 'src.txt')
    const destPath = join(tempDir, 'dest.ipynb')
    writeFileSync(srcPath, 'content\n')

    const result = await FilePatchTool.validateInput(
      {
        ops: [
          {
            type: 'update',
            path: srcPath,
            moveTo: destPath,
            hunks: [
              hunk({
                lines: [
                  { kind: 'context', text: 'content' },
                  { kind: 'add', text: 'added' },
                ],
              }),
            ],
          },
        ],
      },
      validateContext(),
    )

    expect(result.result).toBe(false)
    expect((result as { message?: string }).message).toContain('Jupyter Notebook')
  })

  test('a normal move to an absent non-team-memory destination completes', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'file-patch-tool-'))
    tempDirs.push(tempDir)
    const srcPath = join(tempDir, 'src.txt')
    const dstPath = join(tempDir, 'nested', 'dst.txt')
    writeFileSync(srcPath, 'content\n')

    const readFileState = createFileStateCacheWithSizeLimit(10)
    readFileState.set(srcPath, {
      content: 'content\n',
      timestamp: Math.floor(Date.now()),
      offset: undefined,
      limit: undefined,
    })

    await FilePatchTool.call(
      {
        ops: [
          {
            type: 'update',
            path: srcPath,
            moveTo: dstPath,
            hunks: [
              hunk({
                lines: [
                  { kind: 'context', text: 'content' },
                  { kind: 'add', text: 'added' },
                ],
              }),
            ],
          },
        ],
      },
      {
        readFileState,
        updateFileHistoryState: () => undefined,
      } as never,
      undefined,
      { uuid: 'test-parent' } as never,
    )

    expect(existsSync(srcPath)).toBe(false)
    expect(readFileSync(dstPath, 'utf8')).toBe('content\nadded\n')
  })
})

describe('FilePatchTool.mapToolResultToToolResultBlockParam', () => {
  test('enumerates each affected file with its operation', () => {
    const result = FilePatchTool.mapToolResultToToolResultBlockParam(
      {
        files: [
          { path: '/x/a.ts', type: 'update', before: 'a', after: 'b', structuredPatch: [] },
          { path: '/x/new.ts', type: 'add', before: null, after: 'n', structuredPatch: [] },
          { path: '/x/gone.ts', type: 'delete', before: 'g', after: null, structuredPatch: [] },
        ],
      },
      'tool-1',
    )

    const content = result.content as string
    expect(content).toContain('Applied patch to 3 files')
    expect(content).toContain('Updated /x/a.ts')
    expect(content).toContain('Added /x/new.ts')
    expect(content).toContain('Deleted /x/gone.ts')
  })
})
