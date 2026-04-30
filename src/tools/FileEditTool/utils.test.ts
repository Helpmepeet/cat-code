import { describe, expect, it } from 'bun:test'
import { findActualString } from './utils.js'

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
