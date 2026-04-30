import { describe, expect, test } from 'bun:test'
import { parseFilePatch } from './parser.js'

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
          scopeHints: ['export function greet() {'],
          lines: [
            { kind: 'context', text: 'export function greet() {' },
            { kind: 'delete', text: "  return 'hello'" },
            { kind: 'add', text: "  return 'hi'" },
            { kind: 'context', text: '}' },
          ],
          isEndOfFile: false,
          noNewlineAtEndOfFile: false,
        },
        {
          scopeHints: ['console.log(greet())'],
          lines: [
            { kind: 'context', text: 'console.log(greet())' },
            { kind: 'add', text: "console.log('done')" },
          ],
          isEndOfFile: false,
          noNewlineAtEndOfFile: false,
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
          scopeHints: ['const value = 1'],
          lines: [
            { kind: 'context', text: 'const value = 1' },
            { kind: 'delete', text: 'const value = 1' },
            { kind: 'add', text: 'const value = 2' },
          ],
          isEndOfFile: false,
          noNewlineAtEndOfFile: true,
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
          scopeHints: [''],
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
          scopeHints: ['class BaseClass', '  def method():'],
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

  test('rejects unknown operation headers', () => {
    expect(() =>
      parseFilePatch(`*** Begin Patch
*** Move File: src/old.ts
*** End Patch
`),
    ).toThrow('Unsupported patch header')
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
})
