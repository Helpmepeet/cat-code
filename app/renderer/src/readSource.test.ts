import { expect, test } from 'bun:test'
import {
  parseReadSource,
  readLineNumbers,
  readSourceLanguage,
  sourceFence,
} from './readSource.js'

/* ---------------------------------------------------------------------------
 * The payload shapes are the engine's, not invented: `addLineNumbers`
 * (`src/utils/file.ts:290-318`) emits `N\t<line>` by default and a
 * right-aligned `N→<line>` when the compact killswitch is on.
 * ------------------------------------------------------------------------- */

test('the compact `N\\t` payload splits into source and its real line numbers', () => {
  const source = parseReadSource('1\timport os\n2\t\n3\tdef f():')

  expect(source.lines).toEqual(['import os', '', 'def f():'])
  expect(source.numbers).toEqual([1, 2, 3])
})

test('the padded `N→` payload splits the same way', () => {
  const source = parseReadSource('     1→import os\n     2→def f():')

  expect(source.lines).toEqual(['import os', 'def f():'])
  expect(source.numbers).toEqual([1, 2])
})

test('an offset read keeps the file line numbers, not 1..N', () => {
  const source = parseReadSource('812\tconst x = 1\n813\tconst y = 2')

  expect(source.numbers).toEqual([812, 813])
  // The gutter of the whole slice, and of a tail starting one line in.
  expect(readLineNumbers(source, 0, 2)).toEqual([812, 813])
  expect(readLineNumbers(source, 1, 1)).toEqual([813])
})

test('an unnumbered payload is left exactly as it arrived', () => {
  const source = parseReadSource('EISDIR: illegal operation\non a directory')

  expect(source.numbers).toBeNull()
  expect(source.lines).toEqual(['EISDIR: illegal operation', 'on a directory'])
  // Without numbers the gutter counts positions, which is what the card
  // rendered before this module existed.
  expect(readLineNumbers(source, 0, 2)).toEqual([1, 2])
  expect(readLineNumbers(source, 894, 2)).toEqual([895, 896])
})

test('output that merely opens with digits and a tab is not read as numbered', () => {
  // Consecutiveness is the guard: these are plausible tab-separated columns.
  const source = parseReadSource('1\talpha\n7\tbravo\n9\tcharlie')

  expect(source.numbers).toBeNull()
  expect(source.lines).toEqual(['1\talpha', '7\tbravo', '9\tcharlie'])
})

test('one unnumbered line disqualifies the whole payload', () => {
  const source = parseReadSource('1\timport os\nsomething appended\n2\tdef f():')

  expect(source.numbers).toBeNull()
})

test('the language comes from the extension, and only from ones we can color', () => {
  expect(readSourceLanguage('/w/app/src/main.tsx')).toBe('typescript')
  expect(readSourceLanguage('/w/a.py')).toBe('python')
  expect(readSourceLanguage('C:\\w\\a.RS')).toBe('rust')
  expect(readSourceLanguage('/w/pyproject.toml')).toBe('ini')

  expect(readSourceLanguage('/w/notes.wat')).toBeNull() // unmapped extension
  expect(readSourceLanguage('/w/Makefile')).toBeNull() // no extension
  expect(readSourceLanguage('/w/.gitignore')).toBeNull() // dotfile, not an extension
  expect(readSourceLanguage(undefined)).toBeNull() // absent tool input
  expect(readSourceLanguage(42)).toBeNull()
})

test('the fence outgrows any backtick run in the file it wraps', () => {
  expect(sourceFence('x = 1', 'python')).toBe('```python\nx = 1\n```')

  // A markdown file carrying its own fence must not close ours early.
  const doc = 'text\n```bash\nls\n```\ntail'
  const fenced = sourceFence(doc, 'markdown')
  expect(fenced.startsWith('````markdown\n')).toBe(true)
  expect(fenced.endsWith('\n````')).toBe(true)
  expect(fenced).toContain(doc)
})
