import { describe, expect, test } from 'bun:test'
import {
  describeOutputSearch,
  MAX_INSPECTOR_LINES,
  splitLineByQuery,
  stepMatchIndex,
} from './outputSearchModel.js'

const OUTPUT = ['alpha', 'BETA', 'gamma beta', 'delta', 'beta'].join('\n')

describe('describeOutputSearch', () => {
  test('an empty query matches nothing and shows no counter', () => {
    const model = describeOutputSearch(OUTPUT, '', 0)
    expect(model.searching).toBe(false)
    expect(model.matches).toEqual([])
    expect(model.activeLine).toBeNull()
    expect(model.activeIndex).toBe(-1)
    expect(model.label).toBe('')
    // The lines are still there: the body renders with or without a search.
    expect(model.lines).toHaveLength(5)
  })

  test('a query with zero matches reads 0 and parks on no line', () => {
    const model = describeOutputSearch(OUTPUT, 'epsilon', 0)
    expect(model.searching).toBe(true)
    expect(model.matches).toEqual([])
    expect(model.activeLine).toBeNull()
    expect(model.label).toBe('0')
  })

  test('one match reads 1/1 and is active', () => {
    const model = describeOutputSearch(OUTPUT, 'delta', 0)
    expect(model.matches).toEqual([4])
    expect(model.activeLine).toBe(4)
    expect(model.label).toBe('1/1')
  })

  test('many matches are 1-based line numbers, case-insensitive, in order', () => {
    const model = describeOutputSearch(OUTPUT, 'beta', 0)
    expect(model.matches).toEqual([2, 3, 5])
    expect(model.activeLine).toBe(2)
    expect(model.label).toBe('1/3')
  })

  test('mid-stepping: the counter and the active line follow the index', () => {
    const second = describeOutputSearch(OUTPUT, 'beta', 1)
    expect(second.activeLine).toBe(3)
    expect(second.label).toBe('2/3')
    const third = describeOutputSearch(OUTPUT, 'beta', 2)
    expect(third.activeLine).toBe(5)
    expect(third.label).toBe('3/3')
  })

  test('an index left over from a longer match list wraps onto a real match', () => {
    // Was on match 3 of 3 for "beta", then the query narrowed to one match.
    const model = describeOutputSearch(OUTPUT, 'delta', 2)
    expect(model.activeLine).toBe(4)
    expect(model.label).toBe('1/1')
  })

  test('the query is literal text, never a pattern', () => {
    const text = ['a.*b', 'axxb', 'plain'].join('\n')
    const model = describeOutputSearch(text, '.*', 0)
    expect(model.matches).toEqual([1])
    expect(model.label).toBe('1/1')
  })

  test('an empty output is one empty line, not zero lines', () => {
    const model = describeOutputSearch('', 'x', 0)
    expect(model.lines).toEqual([''])
    expect(model.matches).toEqual([])
  })

  test('a trailing newline keeps the final empty line numbered', () => {
    const model = describeOutputSearch('one\ntwo\n', 'two', 0)
    expect(model.lines).toHaveLength(3)
    expect(model.matches).toEqual([2])
  })

  test('a realistic long output is painted whole, with nothing hidden', () => {
    const long = Array.from({ length: 900 }, (_, i) => `line ${i + 1}`).join(
      '\n',
    )
    const model = describeOutputSearch(long, 'line 900', 0)
    expect(model.lines).toHaveLength(900)
    expect(model.hiddenLines).toBe(0)
    expect(model.activeLine).toBe(900)
  })

  test('past the render cut: the counter never promises an unpaintable match', () => {
    const text = ['hit', 'x', 'hit', 'x', 'hit'].join('\n')
    const model = describeOutputSearch(text, 'hit', 0, 3)
    expect(model.lines).toHaveLength(3)
    expect(model.totalLines).toBe(5)
    expect(model.hiddenLines).toBe(2)
    // Line 5 also says "hit", but it is not painted, so it is not counted.
    expect(model.matches).toEqual([1, 3])
    expect(model.label).toBe('1/2')
  })

  test('the default cut is generous and only bites a runaway output', () => {
    expect(MAX_INSPECTOR_LINES).toBeGreaterThan(4000)
    const huge = Array.from(
      { length: MAX_INSPECTOR_LINES + 25 },
      () => 'x',
    ).join('\n')
    const model = describeOutputSearch(huge, '', 0)
    expect(model.lines).toHaveLength(MAX_INSPECTOR_LINES)
    expect(model.hiddenLines).toBe(25)
  })
})

describe('stepMatchIndex', () => {
  test('steps forward and backward inside the list', () => {
    expect(stepMatchIndex(0, 1, 3)).toBe(1)
    expect(stepMatchIndex(2, -1, 3)).toBe(1)
  })

  test('stepping past the last match wraps to the first', () => {
    expect(stepMatchIndex(2, 1, 3)).toBe(0)
  })

  test('stepping back from the first match wraps to the last', () => {
    expect(stepMatchIndex(0, -1, 3)).toBe(2)
  })

  test('a single match stays put in both directions', () => {
    expect(stepMatchIndex(0, 1, 1)).toBe(0)
    expect(stepMatchIndex(0, -1, 1)).toBe(0)
  })

  test('no matches degrades to 0 rather than a negative or NaN index', () => {
    expect(stepMatchIndex(0, 1, 0)).toBe(0)
    expect(stepMatchIndex(3, -1, 0)).toBe(0)
  })
})

describe('splitLineByQuery', () => {
  test('an empty query is one unmatched run', () => {
    expect(splitLineByQuery('gamma beta', '')).toEqual([
      { text: 'gamma beta', match: false },
    ])
  })

  test('a non-matching query is one unmatched run', () => {
    expect(splitLineByQuery('gamma beta', 'zzz')).toEqual([
      { text: 'gamma beta', match: false },
    ])
  })

  test('splits every occurrence, preserving the original casing', () => {
    expect(splitLineByQuery('Beta and beta', 'beta')).toEqual([
      { text: 'Beta', match: true },
      { text: ' and ', match: false },
      { text: 'beta', match: true },
    ])
  })

  test('a match at the head and the tail leaves no empty runs', () => {
    expect(splitLineByQuery('abcab', 'ab')).toEqual([
      { text: 'ab', match: true },
      { text: 'c', match: false },
      { text: 'ab', match: true },
    ])
  })

  test('rejoining the segments reproduces the line exactly', () => {
    const line = '  Warning: BETA build (beta) '
    const joined = splitLineByQuery(line, 'beta')
      .map(segment => segment.text)
      .join('')
    expect(joined).toBe(line)
  })
})
