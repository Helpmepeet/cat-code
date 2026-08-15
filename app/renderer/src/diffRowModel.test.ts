/**
 * The diff row model's own proofs (CC-62): the flattening that lets one
 * virtualizer bound every hunk of a file at once, and the two ceilings that
 * stop the word-level highlight from being the unbounded axis instead.
 */

import { describe, expect, test } from 'bun:test'
import {
  MAX_WORD_DIFF_CHARS,
  MAX_WORD_DIFF_SEGMENTS,
  selectDiffRows,
  selectRawDiffLines,
  selectRowWordSegments,
  selectWordDiffPair,
} from './diffRowModel.js'
import type { ToolDiffProjection } from './transcriptProjector.js'

function diff(hunks: ToolDiffProjection['hunks']): ToolDiffProjection {
  return { filePath: '/repo/a.ts', hunks }
}

function hunk(
  lines: string[],
  over: Partial<ToolDiffProjection['hunks'][number]> = {},
): ToolDiffProjection['hunks'][number] {
  return {
    oldStart: 1,
    oldLines: lines.length,
    newStart: 1,
    newLines: lines.length,
    lines,
    ...over,
  }
}

describe('every hunk of a file is one ordered row list', () => {
  test('rows keep their order and their per-hunk gutter numbers', () => {
    const rows = selectDiffRows(
      diff([
        hunk([' one', '-two', '+TWO']),
        hunk([' nine', '+ten'], { oldStart: 9, newStart: 9 }),
      ]),
    )

    // A context line keeps its leading space: it is the file's own column.
    expect(rows.map(row => row.body)).toEqual([' one', 'two', 'TWO', ' nine', 'ten'])
    expect(rows.map(row => row.kind)).toEqual(['ctx', 'del', 'add', 'ctx', 'add'])
    // A removed line has no line in the current file, so its gutter is blank.
    expect(rows.map(row => row.currentLabel)).toEqual(['1', '', '2', '9', '10'])
    expect(rows.map(row => row.hunkIndex)).toEqual([0, 0, 0, 1, 1])
  })

  test('a whole-file patch flattens to one row per file line', () => {
    const lines = Array.from({ length: 20_000 }, (_unused, index) => `+line ${index}`)
    const rows = selectDiffRows(diff([hunk(lines)]))

    // Retained data stays complete: bounding is mounted DOM, never the model.
    expect(rows).toHaveLength(20_000)
    expect(rows[19_999].body).toBe('line 19999')
    expect(selectRawDiffLines(diff([hunk(lines)]))).toHaveLength(20_000)
  })
})

describe('replaced runs pair inside their own hunk', () => {
  test('consecutive removes pair with the adds that follow them', () => {
    const rows = selectDiffRows(diff([hunk(['-a', '-b', '+A', '+B', ' c'])]))

    expect(rows[0].pairedWith).toBe(2)
    expect(rows[1].pairedWith).toBe(3)
    expect(rows[2].pairedWith).toBe(0)
    expect(rows[3].pairedWith).toBe(1)
    expect(rows[4].pairedWith).toBeNull()
  })

  test('a remove at the end of one hunk never pairs with an add in the next', () => {
    const rows = selectDiffRows(
      diff([hunk(['-gone']), hunk(['+arrived'], { oldStart: 40, newStart: 40 })]),
    )

    expect(rows[0].pairedWith).toBeNull()
    expect(rows[1].pairedWith).toBeNull()
  })

  test('an unpaired remove has no segments to compute', () => {
    const rows = selectDiffRows(diff([hunk(['-gone', ' kept'])]))
    expect(selectRowWordSegments(rows, 0)).toBeNull()
  })

  test('both sides of a pair get their own side of the word diff', () => {
    const rows = selectDiffRows(diff([hunk(['-const a = 1', '+const a = 2'])]))

    const del = selectRowWordSegments(rows, 0)
    const add = selectRowWordSegments(rows, 1)
    expect(del?.map(part => part.value).join('')).toBe('const a = 1')
    expect(add?.map(part => part.value).join('')).toBe('const a = 2')
    expect(del?.some(part => part.changed && part.value.includes('1'))).toBe(true)
    expect(add?.some(part => part.changed && part.value.includes('2'))).toBe(true)
  })

  test('the segments are computed once per row and cached against the list', () => {
    const rows = selectDiffRows(diff([hunk(['-const a = 1', '+const a = 2'])]))
    expect(selectRowWordSegments(rows, 0)).toBe(
      selectRowWordSegments(rows, 0) as ReturnType<typeof selectRowWordSegments>,
    )
  })
})

describe('the word-level highlight has its own ceilings', () => {
  test('a near-total rewrite keeps the line-level wash (the prototype guard)', () => {
    expect(selectWordDiffPair('aaaa', 'bbbb')).toBeNull()
  })

  test('a minified line is never run through the word differ', () => {
    // One word changed out of a very long line, so the 90% guard cannot be
    // what refuses it: only the character ceiling can.
    const pad = (width: number) => `${'x'.repeat(width)} tail`
    expect(selectWordDiffPair(pad(1_000), pad(1_000).replace('tail', 'TAIL'))).not.toBeNull()
    const long = pad(MAX_WORD_DIFF_CHARS)
    expect(long.length).toBeGreaterThan(MAX_WORD_DIFF_CHARS)
    expect(selectWordDiffPair(long, long.replace('tail', 'TAIL'))).toBeNull()
  })

  test('a pair that alternates every word past the run ceiling falls back', () => {
    const left = Array.from({ length: MAX_WORD_DIFF_SEGMENTS }, (_u, i) => `a${i}`).join(' ')
    const right = Array.from({ length: MAX_WORD_DIFF_SEGMENTS }, (_u, i) => `b${i}`).join(' ')
    expect(selectWordDiffPair(left, right)).toBeNull()
  })

  test('a run count that stays under the ceiling still paints its runs', () => {
    const pair = selectWordDiffPair('one two three', 'one TWO three')
    expect(pair).not.toBeNull()
    expect(pair?.del).toHaveLength(3)
    expect(pair?.add).toHaveLength(3)
  })
})
