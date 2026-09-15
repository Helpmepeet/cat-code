import { describe, expect, test } from 'bun:test'
import {
  getPatchMutationPaths,
  normalizeFilePatchOperations,
  parseFilePatch,
  parseFilePatchInput,
} from './parser.js'
import { FilePatchError, serializeFilePatchError } from './types.js'

describe('parseFilePatch', () => {
  test('parses update, add, and delete operations in one envelope', () => {
    const parsed = parseFilePatch(`*** Begin Patch
*** Update File: src/example.ts
@@ export function greet() {
 export function greet() {
-  return 'hello'
+  return 'hi'
 }
@@ console.log(greet())
 console.log(greet())
+console.log('done')
*** Add File: src/new.ts
+export const created = true
*** Delete File: src/old.ts
*** End Patch
`)

    expect(parsed.ops).toHaveLength(3)
    expect(parsed.ops[0]).toEqual({
      type: 'update',
      path: 'src/example.ts',
      hunks: [
        {
          hints: ['export function greet() {'],
          lines: [
            { kind: 'context', text: 'export function greet() {' },
            { kind: 'delete', text: "  return 'hello'" },
            { kind: 'add', text: "  return 'hi'" },
            { kind: 'context', text: '}' },
          ],
          isEndOfFile: false,
          newline: { kind: 'canonical', markers: [] },
          sourceSpan: { startLine: 3, endLine: 7 },
        },
        {
          hints: ['console.log(greet())'],
          lines: [
            { kind: 'context', text: 'console.log(greet())' },
            { kind: 'add', text: "console.log('done')" },
          ],
          isEndOfFile: false,
          newline: { kind: 'canonical', markers: [] },
          sourceSpan: { startLine: 8, endLine: 10 },
        },
      ],
    })
    expect(parsed.ops[1]).toEqual({
      type: 'add',
      path: 'src/new.ts',
      lines: ['export const created = true'],
      noNewlineAtEndOfFile: false,
    })
    expect(parsed.ops[2]).toEqual({
      type: 'delete',
      path: 'src/old.ts',
    })
  })

  test('rejects repeated source paths', () => {
    let error: unknown
    try {
      parseFilePatch(
        [
          '*** Begin Patch',
          '*** Update File: src/example.ts',
          '@@',
          ' old',
          '-old',
          '+new',
          '*** Update File: src/example.ts',
          '@@',
          ' another',
          '-another',
          '+changed',
          '*** End Patch',
        ].join('\n'),
      )
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(FilePatchError)
    expect((error as FilePatchError).code).toBe('DUPLICATE_PATCH_PATH')
  })

  test('tracks no-newline markers for update and add operations', () => {
    const parsed = parseFilePatch(`*** Begin Patch
*** Update File: src/example.ts
@@ const value = 1
 const value = 1
-const value = 1
+const value = 2
\\ No newline at end of file
*** Add File: src/new.ts
+one
+two
\\ No newline at end of file
*** End Patch
`)

    expect(parsed.ops[0]).toEqual({
      type: 'update',
      path: 'src/example.ts',
      hunks: [
        {
          hints: ['const value = 1'],
          lines: [
            { kind: 'context', text: 'const value = 1' },
            { kind: 'delete', text: 'const value = 1' },
            { kind: 'add', text: 'const value = 2' },
          ],
          isEndOfFile: false,
          newline: {
            kind: 'canonical',
            markers: [
              {
                afterHunkLine: 2,
                appliesTo: 'new',
                sourceSpan: { startLine: 7, endLine: 7 },
              },
            ],
          },
          sourceSpan: { startLine: 3, endLine: 7 },
        },
      ],
    })
    expect(parsed.ops[1]).toEqual({
      type: 'add',
      path: 'src/new.ts',
      lines: ['one', 'two'],
      noNewlineAtEndOfFile: true,
    })
  })

  test('requires an add-file no-newline marker to follow the final added line', () => {
    expect(() =>
      parseFilePatch(`*** Begin Patch
*** Add File: src/new.ts
\\ No newline at end of file
*** End Patch
`),
    ).toThrow('must follow an added line')

    expect(() =>
      parseFilePatch(`*** Begin Patch
*** Add File: src/new.ts
+one
\\ No newline at end of file
+two
*** End Patch
`),
    ).toThrow('must follow the final added line')
  })

  test('attaches canonical markers to the immediately preceding line and side', () => {
    const parsed = parseFilePatch(`*** Begin Patch
*** Update File: src/example.ts
@@
-old
\\ No newline at end of file
+new
*** End Patch
`)
    expect(parsed.ops[0]).toMatchObject({
      type: 'update',
      hunks: [
        {
          newline: {
            kind: 'canonical',
            markers: [
              {
                afterHunkLine: 0,
                appliesTo: 'old',
                sourceSpan: { startLine: 5, endLine: 5 },
              },
            ],
          },
        },
      ],
    })
  })

  test('rejects unattached and duplicate-side canonical markers', () => {
    expect(() =>
      parseFilePatch(`*** Begin Patch
*** Update File: src/example.ts
@@
\\ No newline at end of file
+new
*** End Patch
`),
    ).toThrow('must follow a hunk line')

    expect(() =>
      parseFilePatch(`*** Begin Patch
*** Update File: src/example.ts
@@
-old
\\ No newline at end of file
-older
\\ No newline at end of file
*** End Patch
`),
    ).toThrow('Duplicate no-newline marker side')
  })

  test('parses bare @@ with no scope hint text', () => {
    const parsed = parseFilePatch(`*** Begin Patch
*** Update File: src/example.ts
@@
 context line
-old
+new
*** End Patch
`)
    expect(parsed.ops[0]).toMatchObject({
      type: 'update',
      hunks: [
        {
          hints: [],
          lines: [
            { kind: 'context', text: 'context line' },
            { kind: 'delete', text: 'old' },
            { kind: 'add', text: 'new' },
          ],
        },
      ],
    })
  })

  test('parses stacked @@ scope hints', () => {
    const parsed = parseFilePatch(`*** Begin Patch
*** Update File: src/example.ts
@@ class BaseClass
@@   def method():
 context
-old
+new
*** End Patch
`)
    expect(parsed.ops[0]).toMatchObject({
      type: 'update',
      hunks: [
        {
          hints: ['class BaseClass', '  def method():'],
          lines: [
            { kind: 'context', text: 'context' },
            { kind: 'delete', text: 'old' },
            { kind: 'add', text: 'new' },
          ],
        },
      ],
    })
  })

  test('parses *** End of File marker', () => {
    const parsed = parseFilePatch(`*** Begin Patch
*** Update File: src/example.ts
@@
 last line
+appended
*** End of File
*** End Patch
`)
    expect(parsed.ops[0]).toMatchObject({
      type: 'update',
      hunks: [{ isEndOfFile: true, lines: expect.arrayContaining([{ kind: 'add', text: 'appended' }]) }],
    })
  })

  test('parses *** Move to: for update operations', () => {
    const parsed = parseFilePatch(`*** Begin Patch
*** Update File: src/old.ts
*** Move to: src/new.ts
@@
 content
+added
*** End Patch
`)
    expect(parsed.ops[0]).toMatchObject({
      type: 'update',
      path: 'src/old.ts',
      moveTo: 'src/new.ts',
    })
  })

  test('unwraps heredoc envelope (gpt-4.1 compatibility)', () => {
    const parsed = parseFilePatch(`<<'EOF'
*** Begin Patch
*** Add File: src/hello.ts
+export const HELLO = true
*** End Patch
EOF
`)
    expect(parsed.ops[0]).toMatchObject({ type: 'add', path: 'src/hello.ts' })
  })

  test('allows update hunks where + lines appear before context', () => {
    const parsed = parseFilePatch(`*** Begin Patch
*** Update File: src/example.ts
@@ const value = 1
+const value = 2
 const value = 1
*** End Patch
`)
    expect(parsed.ops[0]).toMatchObject({ type: 'update', path: 'src/example.ts' })
  })

  test('preserves marker-like text when it is prefixed as hunk context', () => {
    const parsed = parseFilePatch(`*** Begin Patch
*** Update File: real.ts
@@
 *** End of File
 *** Update File: fake.ts
 *** End Patch
+new
*** End Patch
`)

    expect(parsed.ops[0]).toMatchObject({
      type: 'update',
      hunks: [
        {
          lines: [
            { kind: 'context', text: '*** End of File' },
            { kind: 'context', text: '*** Update File: fake.ts' },
            { kind: 'context', text: '*** End Patch' },
            { kind: 'add', text: 'new' },
          ],
          isEndOfFile: false,
        },
      ],
    })
  })

  test('rejects unknown operation headers', () => {
    expect(() =>
      parseFilePatch(`*** Begin Patch
*** Move File: src/old.ts
*** End Patch
`),
    ).toThrow('Unsupported patch header')
  })

  test('attaches precise source spans to syntax failures', () => {
    const cases = [
      {
        input: 'narrative\n*** End Patch\n',
        span: { startLine: 1, endLine: 1 },
      },
      {
        input: '*** Begin Patch\n*** Add File: src/a.ts\n+line\n',
        span: { startLine: 3, endLine: 3 },
      },
      {
        input: '*** Begin Patch\nnot a header\n*** End Patch\n',
        span: { startLine: 2, endLine: 2 },
      },
      {
        input: '*** Begin Patch\n*** Add File:   \n*** End Patch\n',
        span: { startLine: 2, endLine: 2 },
      },
      {
        input: '*** Begin Patch\n*** Add File: src/a.ts\nnot-added\n*** End Patch\n',
        span: { startLine: 3, endLine: 3 },
      },
      {
        input: '*** Begin Patch\n*** Update File: src/a.ts\nnot a hunk\n*** End Patch\n',
        span: { startLine: 3, endLine: 3 },
      },
      {
        input: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n\\ No newline at end of file\n*** End Patch\n',
        span: { startLine: 4, endLine: 4 },
      },
      {
        input: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n*** End Patch\n',
        span: { startLine: 3, endLine: 3 },
      },
      {
        input: '*** Begin Patch\n*** End Patch\n',
        span: { startLine: 1, endLine: 2 },
      },
    ]

    for (const { input, span } of cases) {
      let caught: unknown
      try {
        parseFilePatch(input)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(FilePatchError)
      expect((caught as FilePatchError).patchSourceSpan).toEqual(span)
    }
  })

  test('does not invent source spans for structured legacy input', () => {
    const error = new FilePatchError('legacy failure', { code: 'INVALID_PATCH_FORMAT' })
    expect(error.patchSourceSpan).toBeUndefined()
    expect(serializeFilePatchError(error).patchSourceSpan).toBeUndefined()
  })

  test('includes parser source spans in the serialized model error', () => {
    let caught: unknown
    try {
      parseFilePatch('*** Begin Patch\nnot a header\n*** End Patch\n')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(FilePatchError)
    expect(serializeFilePatchError(caught as FilePatchError).patchSourceSpan).toEqual({
      startLine: 2,
      endLine: 2,
    })
  })

  test('tolerates blank lines between file blocks', () => {
    const parsed = parseFilePatch(`*** Begin Patch
*** Add File: src/a.ts
+export const A = 1

*** Add File: src/b.ts
+export const B = 2
*** End Patch
`)
    expect(parsed.ops).toHaveLength(2)
    expect(parsed.ops[0]).toMatchObject({ type: 'add', path: 'src/a.ts' })
    expect(parsed.ops[1]).toMatchObject({ type: 'add', path: 'src/b.ts' })
  })

  test('normalizes structured legacy newline directives without source spans', () => {
    const parsed = parseFilePatchInput({
      ops: [
        {
          type: 'update',
          path: 'src/example.ts',
          hunks: [
            {
              scopeHints: ['function example()'],
              lines: [{ kind: 'delete', text: 'old' }],
              isEndOfFile: false,
              noNewlineAtEndOfFile: true,
            },
          ],
        },
      ],
    })
    expect(parsed.ops[0]).toMatchObject({
      hunks: [
        {
          hints: ['function example()'],
          newline: { kind: 'legacy-output', outputAtEof: 'absent' },
        },
      ],
    })
    expect(parsed.ops[0]?.type === 'update' && parsed.ops[0].hunks[0]?.sourceSpan).toBeUndefined()
    expect(normalizeFilePatchOperations(parsed.ops)).toEqual(parsed.ops)
  })
})

describe('getPatchMutationPaths', () => {
  test('extracts paths from raw envelope { input: string }', () => {
    const paths = getPatchMutationPaths({
      input: `*** Begin Patch
*** Update File: src/a.ts
@@
-old
+new
*** Add File: src/b.ts
+content
*** Delete File: src/c.ts
*** End Patch
`,
    })
    expect(paths).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts'])
  })

  test('extracts both path and moveTo from move operations', () => {
    const paths = getPatchMutationPaths({
      input: `*** Begin Patch
*** Update File: old-path.ts
*** Move to: new-path.ts
@@
-old
+new
*** End Patch
`,
    })
    expect(paths).toEqual(['old-path.ts', 'new-path.ts'])
  })

  test('extracts paths from structured { ops: FilePatchOperation[] }', () => {
    const paths = getPatchMutationPaths({
      ops: [
        { type: 'update', path: 'foo.ts', moveTo: 'bar.ts', hunks: [] },
        { type: 'add', path: 'baz.ts', lines: [], noNewlineAtEndOfFile: false },
      ],
    })
    expect(paths).toEqual(['foo.ts', 'bar.ts', 'baz.ts'])
  })

  test('handles raw string envelope directly', () => {
    const paths = getPatchMutationPaths(`*** Begin Patch
*** Add File: notes.md
+text
*** End Patch
`)
    expect(paths).toEqual(['notes.md'])
  })

  test('returns empty array on invalid, missing, or malformed inputs without throwing', () => {
    expect(getPatchMutationPaths(null)).toEqual([])
    expect(getPatchMutationPaths(undefined)).toEqual([])
    expect(getPatchMutationPaths({})).toEqual([])
    expect(getPatchMutationPaths({ input: 'not a valid patch' })).toEqual([])
    expect(getPatchMutationPaths({ ops: 'not an array' })).toEqual([])
  })

  test('deduplicates targets when a path appears multiple times', () => {
    const paths = getPatchMutationPaths({
      ops: [
        { type: 'update', path: 'foo.ts', moveTo: 'bar.ts', hunks: [] },
        { type: 'add', path: 'bar.ts', lines: [], noNewlineAtEndOfFile: false },
      ],
    })
    expect(paths).toEqual(['foo.ts', 'bar.ts'])
  })
})
