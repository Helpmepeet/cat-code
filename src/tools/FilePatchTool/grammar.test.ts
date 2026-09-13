import { describe, expect, test } from 'bun:test'
import { FILE_PATCH_LARK_GRAMMAR } from './grammar.js'
import { parseFilePatch } from './parser.js'

describe('canonical apply_patch generation grammar', () => {
  test('is a bounded patch language rather than a catch-all payload', () => {
    expect(FILE_PATCH_LARK_GRAMMAR).toContain(
      'start: BEGIN _NL operation+ END _NL?',
    )
    expect(FILE_PATCH_LARK_GRAMMAR).toContain('?operation: update | add | delete')
    expect(FILE_PATCH_LARK_GRAMMAR).toContain('hunk_header: HUNK_HEADER _NL')
    expect(FILE_PATCH_LARK_GRAMMAR).toContain('EOF_MARKER _NL')
    expect(FILE_PATCH_LARK_GRAMMAR).not.toContain('EOF_MARKER _NL?')
    expect(FILE_PATCH_LARK_GRAMMAR).toContain('NO_NEWLINE: "\\\\ No newline at end of file"')
    expect(FILE_PATCH_LARK_GRAMMAR).not.toContain('/[\\s\\S]*/')
    expect(FILE_PATCH_LARK_GRAMMAR).not.toContain('legacy')
    expect(FILE_PATCH_LARK_GRAMMAR).not.toContain('EOF heredoc')
  })

  test.each([
    `*** Begin Patch
*** Update File: src/a.ts
@@ function a() {
 function a() {
-  return 1
+  return 2
 }
*** End Patch
`,
    `*** Begin Patch
*** Update File: src/a.ts
*** Move to: src/b.ts
@@
 line
*** End of File
*** End Patch
`,
    `*** Begin Patch
*** Add File: src/a.txt
+one
+two
\\ No newline at end of file
*** Delete File: src/old.txt
*** End Patch
`,
  ])('uses canonical fixtures accepted by the runtime parser', fixture => {
    expect(parseFilePatch(fixture).ops.length).toBeGreaterThan(0)
  })

  test('keeps wrappers and narrative out of canonical parser fixtures', () => {
    expect(() =>
      parseFilePatch(`narrative
*** Begin Patch
*** Delete File: src/old.txt
*** End Patch`),
    ).toThrow('must start')
    expect(() =>
      parseFilePatch(`*** Begin Patch
*** Delete File: src/old.txt
*** End Patch
narrative`),
    ).toThrow('must end')
  })
})
