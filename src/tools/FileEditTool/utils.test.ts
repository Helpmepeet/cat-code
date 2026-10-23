import { describe, expect, it } from 'bun:test'
import { findActualString, getSnippet, getSnippetAtLine, resolveEditStrings } from './utils.js'

describe('resolveEditStrings indentation safety', () => {
  it('transforms replacement indentation together with a whitespace match', () => {
    expect(resolveEditStrings('        first()\n        second()\n', 'first()\nsecond()', 'first()\nchanged()'))
      .toEqual({
        actualOldString: '        first()\n        second()',
        actualNewString: '        first()\n        changed()',
        indentationAdjustment: { from: '', to: '        ' },
      })
  })

  it('rejects inconsistent prefixes and outdented additions', () => {
    expect(resolveEditStrings('  first()\n    second()\n', 'first()\nsecond()', 'first()\nchanged()')).toBeNull()
    expect(resolveEditStrings('  first()\n  second()\n', '    first()\n    second()', 'new()\n    changed()')).toBeNull()
  })

  it.each([['\t\t', '\t'], ['        ', '      ']])(
    'uses the same old-side prefix rule for %j to %j',
    (from, to) => {
      const resolved = resolveEditStrings(
        `${to}first()\n${to}second()\n`,
        `${from}first()\n${from}second()`,
        `${from}first()\n${from}changed()`,
      )
      expect(resolved?.indentationAdjustment).toEqual({ from, to })
      expect(resolved?.actualNewString).toBe(`${to}first()\n${to}changed()`)
    },
  )

  it('rejects ambiguous whitespace matches', () => {
    expect(resolveEditStrings('  first()\n  second()\n    first()\n    second()\n', 'first()\nsecond()', 'changed()')).toBeNull()
  })

  it('does not combine indentation repair with trailing or punctuation normalization', () => {
    expect(resolveEditStrings('  first() \n  second()\n', 'first()\nsecond()', 'changed()')).toBeNull()
    expect(resolveEditStrings('  first—call\n  second()\n', 'first-call\nsecond()', 'changed()')).toBeNull()
  })

  it('preserves exact, quote-only, and non-indentation trailing-whitespace behavior', () => {
    expect(resolveEditStrings('    first()\n', 'first()', 'changed()'))
      .toEqual({ actualOldString: 'first()', actualNewString: 'changed()' })
    expect(resolveEditStrings('const x = “old”\n', 'const x = "old"', 'const x = "new"'))
      .toEqual({ actualOldString: 'const x = “old”', actualNewString: 'const x = “new”' })
    expect(resolveEditStrings('one  \ntwo  \n', 'one\ntwo', 'new'))
      .toEqual({ actualOldString: 'one  \ntwo  ', actualNewString: 'new' })
  })

  it('preserves CRLF and blank replacement bytes', () => {
    expect(resolveEditStrings('  first()\r\n \t\r\n  second()\r\n', 'first()\r\n\r\nsecond()', 'new()\r\n \t\r\nlast()'))
      .toEqual({
        actualOldString: '  first()\r\n \t\r\n  second()',
        actualNewString: '  new()\r\n \t\r\n  last()',
        indentationAdjustment: { from: '', to: '  ' },
      })
  })
})

describe('edit snippets', () => {
  it('keeps single-edit snippets unchanged while sharing coordinate-based extraction', () => {
    expect(getSnippet('before\nold\nafter\n', 'old', 'new\nextra', 1)).toEqual({
      snippet: 'before\nnew\nextra\nafter', startLine: 1,
    })
  })

  it('uses final coordinates to distinguish repeated text and account for earlier insertions', () => {
    expect(getSnippetAtLine(['first', 'same', 'inserted', 'second', 'changed', 'tail'], 4, 1, 1))
      .toEqual({ snippet: 'second\nchanged\ntail', startLine: 4 })
  })
})

describe('findActualString', () => {
  it('returns exact match unchanged', () => {
    const file = 'function foo() {\n  return 1\n}\n'
    expect(findActualString(file, 'return 1')).toBe('return 1')
  })

  it('returns null when not found at all', () => {
    expect(findActualString('hello world\n', 'goodbye')).toBeNull()
  })

  it('returns empty string for empty search (caller guards old_string === "" before calling)', () => {
    // FileEditTool.ts checks old_string==='' before calling findActualString,
    // so this is unreachable in practice. Document the behavior anyway.
    expect(findActualString('some content\n', '')).toBe('')
  })

  it('handles curly → straight quote normalization', () => {
    const file = "const x = \u2018hello\u2019\n"
    const search = "const x = 'hello'"
    const result = findActualString(file, search)
    expect(result).not.toBeNull()
    // returned bytes should be from the real file
    expect(result).toBe("const x = \u2018hello\u2019")
  })

  it('matches when trailing whitespace drifts (strategy 3)', () => {
    // File has trailing spaces; model sent clean lines (no trailing newline in search)
    const file = 'function foo() {  \n  return 1  \n}\n'
    const search = 'function foo() {\n  return 1\n}'
    const result = findActualString(file, search)
    expect(result).not.toBeNull()
    // Search has no trailing newline → result strips it; but preserves inner trailing spaces
    expect(result).toBe('function foo() {  \n  return 1  \n}')
  })

  it('matches when leading + trailing whitespace drifts (strategy 4)', () => {
    // File has extra indentation; model sent less-indented search (no trailing newline)
    const file = '    if (x) {\n        return true\n    }\n'
    const search = 'if (x) {\n    return true\n}'
    const result = findActualString(file, search)
    expect(result).not.toBeNull()
    expect(result).toBe('    if (x) {\n        return true\n    }')
  })

  it('matches with Unicode punctuation normalization (strategy 5)', () => {
    // File uses em-dash; model sent hyphen-minus (no trailing newline in search)
    const file = 'const x = foo\u2014bar\n'
    const search = 'const x = foo-bar'
    const result = findActualString(file, search)
    expect(result).not.toBeNull()
    expect(result).toBe('const x = foo\u2014bar')
  })

  it('returns the string for exact duplicates (caller handles ambiguity via split count)', () => {
    // Exact duplicates: findActualString returns the match; FileEditTool.ts
    // detects "Found 2 matches" via split and surfaces the right error message.
    const file = 'x = 1\nx = 1\n'
    expect(findActualString(file, 'x = 1')).toBe('x = 1')
  })

  it('returns null when fuzzy-matched candidates are ambiguous (strategy 3+)', () => {
    // Two structurally identical blocks that only match via whitespace normalization
    const file = 'function foo() {  \n  return 1  \n}\n\nfunction foo() {  \n  return 1  \n}\n'
    expect(findActualString(file, 'function foo() {\n  return 1\n}')).toBeNull()
  })

  it('single-line match with trailing whitespace drift', () => {
    const file = 'const x = 1   \n'
    expect(findActualString(file, 'const x = 1')).toBe('const x = 1')
  })

  it('multi-line match preserves real line endings', () => {
    const file = 'a  \r\nb  \r\nc\r\n'
    const search = 'a\nb\nc'
    const result = findActualString(file, search)
    expect(result).not.toBeNull()
    // Search has no trailing newline → trailing \r\n stripped from result
    expect(result).toBe('a  \r\nb  \r\nc')
  })
})
