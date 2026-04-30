import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
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
