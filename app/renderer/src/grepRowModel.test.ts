/**
 * The search body's row model (CC-62): one row per output line, a locator
 * column that is fixed at any scroll position, and per-file colouring that
 * cannot fan out into one parse per line.
 */

import { describe, expect, test } from 'bun:test'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { selectGrepHighlightedRows, selectGrepRows } from './grepRowModel.js'
import { MAX_HIGHLIGHTED_SOURCE_LINES } from './sourceHighlight.js'

function markup(row: ReactNode): string {
  return renderToStaticMarkup(createElement('i', null, row))
}

describe('one row per output line', () => {
  test('locators, bodies and order survive the grouping', () => {
    const rows = selectGrepRows([
      'src/a.ts:1:const a = 1',
      'src/a.ts-2- const b = 2',
      '--',
      'src/really/long/path/b.ts:9:const c = 3',
    ])

    expect(rows).toHaveLength(4)
    expect(rows.map(row => row.body)).toEqual([
      'const a = 1',
      ' const b = 2',
      '--',
      'const c = 3',
    ])
    expect(rows[2].locator).toBeNull()
    expect(rows[2].path).toBeNull()
    expect(rows[0].path).toBe('src/a.ts')
  })

  test('every locator is padded to the widest in the WHOLE body', () => {
    const rows = selectGrepRows([
      'a.ts:1:one',
      'src/deeply/nested/b.ts:222:two',
    ])

    const widths = rows.map(row => row.locator?.length ?? 0)
    expect(widths[0]).toBe(widths[1])
    expect(widths[0]).toBe('src/deeply/nested/b.ts:222:'.length)
    // Padding only, never truncation: the locator still reads in full.
    expect(rows[0].locator?.trimEnd()).toBe('a.ts:1:')
  })

  test('the padding is the same whichever rows a window mounts', () => {
    const lines = [
      'a.ts:1:one',
      'src/deeply/nested/b.ts:222:two',
      'c.ts:3:three',
    ]
    const rows = selectGrepRows(lines)
    // The row a viewport shows last is padded by the same rule as the first,
    // which is what a `max-content` grid over a mounted window cannot do.
    expect(rows[2].locator?.length).toBe(rows[0].locator?.length)
  })

  test('a row count of one hundred thousand still comes back complete', () => {
    const lines = Array.from(
      { length: 100_000 },
      (_unused, index) => `src/a.ts:${index + 1}:const v = ${index}`,
    )
    expect(selectGrepRows(lines)).toHaveLength(100_000)
  })
})

describe('colouring runs per file, under one ceiling for the whole body', () => {
  test('each consecutive run is coloured in its own language', () => {
    const rows = selectGrepRows([
      'src/a.ts:1:const a = 1',
      'src/b.py:2:def f():',
    ])
    const painted = selectGrepHighlightedRows(rows)

    expect(markup(painted[0])).toContain('hljs-keyword')
    expect(markup(painted[1])).toContain('hljs-keyword')
  })

  test('a line carrying no locator is never coloured', () => {
    const rows = selectGrepRows(['--', 'src/a.ts:1:const a = 1'])
    expect(selectGrepHighlightedRows(rows)[0]).toBeNull()
  })

  test('a file we cannot name a language for stays uncoloured', () => {
    const rows = selectGrepRows(['notes.wat:1:some notes'])
    expect(selectGrepHighlightedRows(rows)[0]).toBeNull()
  })

  test('a result of ten thousand one-line runs colours nothing', () => {
    // Every line its own file, so a per-run check would pass ten thousand
    // times and run ten thousand parses. The ceiling is on the body.
    const lines = Array.from(
      { length: MAX_HIGHLIGHTED_SOURCE_LINES + 1 },
      (_unused, index) => `src/f${index}.ts:1:const v = ${index}`,
    )
    const started = Date.now()
    const painted = selectGrepHighlightedRows(selectGrepRows(lines))

    expect(painted.every(row => row === null)).toBe(true)
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})
