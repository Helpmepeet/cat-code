/**
 * The per-line highlighter's own proofs (CC-62).
 *
 * The DOM proofs live in `boundedToolBodies.test.tsx`; what is provable here is
 * the part that decides how much DOM there is at all: one piece per line, a
 * token that spans lines kept on every line it covers, and the two ceilings.
 *
 * None of the ceiling assertions compares a measurement against the constant it
 * is testing. They compare against literals, and against the SAME measurement
 * taken over a ten-times bigger source: raising a budget makes the second
 * number move, which is what fails the test.
 */

import { describe, expect, test } from 'bun:test'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  MAX_HIGHLIGHTED_SOURCE_CHARS,
  MAX_HIGHLIGHTED_SOURCE_LINES,
  selectHighlightedSourceRows,
} from './sourceHighlight.js'

function markup(row: ReactNode): string {
  return renderToStaticMarkup(createElement('i', null, row))
}

function textOf(row: ReactNode): string {
  return markup(row)
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function elementCount(row: ReactNode): number {
  return (markup(row).match(/<[a-zA-Z]/g) ?? []).length
}

describe('one piece per line', () => {
  test('a slice comes back with exactly one row per source line', () => {
    const lines = ['const a = 1', '', 'const b = 2']
    const rows = selectHighlightedSourceRows(lines, 'typescript')

    expect(rows).not.toBeNull()
    expect(rows).toHaveLength(3)
    expect(textOf(rows?.[0])).toBe('const a = 1')
    expect(textOf(rows?.[1])).toBe('')
    expect(textOf(rows?.[2])).toBe('const b = 2')
  })

  test('a token spanning lines keeps its colour on every line it covers', () => {
    const rows = selectHighlightedSourceRows(
      ['const banner = `alpha', 'middle', 'beta`'],
      'typescript',
    )

    expect(rows).toHaveLength(3)
    // The template literal opens on the first line and closes on the third, so
    // all three carry the string class and none of them reprints the whole
    // token — the defect `diffHighlight.ts` records, at hast level.
    expect(markup(rows?.[0])).toContain('hljs-string')
    expect(markup(rows?.[1])).toContain('hljs-string')
    expect(markup(rows?.[2])).toContain('hljs-string')
    expect(textOf(rows?.[1])).toBe('middle')
    expect(textOf(rows?.[0])).not.toContain('beta')
  })

  test('the head and the tail of a window are ONE parse, not two', () => {
    // The two-parse shape this replaced fed the head and the tail to separate
    // fences, so a token opened in the head was closed against nothing.
    const rows = selectHighlightedSourceRows(
      ['/* open', 'tail */ const after = 1'],
      'typescript',
    )

    expect(markup(rows?.[0])).toContain('hljs-comment')
    expect(markup(rows?.[1])).toContain('hljs-comment')
  })
})

describe('one row cannot mount an unbounded amount', () => {
  test('a giant single logical line mounts 4,001 characters of a 60,000 line', () => {
    const line = `const value = "${'x'.repeat(60_000)}"`
    const rows = selectHighlightedSourceRows([line], 'typescript')

    expect(rows).toHaveLength(1)
    const painted = textOf(rows?.[0])
    // 4,000 characters plus the one-character cut mark, whatever the line held.
    expect(painted).toHaveLength(4_001)
    expect(painted.endsWith('…')).toBe(true)
    expect(line.length).toBe(60_016)
  })

  test('the painted length of one row does not grow with the line', () => {
    const shorter = selectHighlightedSourceRows(
      [`const value = "${'x'.repeat(60_000)}"`],
      'typescript',
    )
    const longer = selectHighlightedSourceRows(
      [`const value = "${'x'.repeat(120_000)}"`],
      'typescript',
    )

    expect(textOf(longer?.[0])).toHaveLength(textOf(shorter?.[0]).length)
  })

  test('a row the tokenizer explodes into spans mounts a bounded node count', () => {
    const small = selectHighlightedSourceRows(
      [`const x = ${Array.from({ length: 400 }, () => '"a"').join(' + ')}`],
      'javascript',
    )
    const big = selectHighlightedSourceRows(
      [`const x = ${Array.from({ length: 4_000 }, () => '"a"').join(' + ')}`],
      'javascript',
    )

    const smallCount = elementCount(small?.[0])
    // Well past a plain row, and still nowhere near the 400 literals.
    expect(smallCount).toBeGreaterThan(20)
    expect(smallCount).toBeLessThan(301)
    // Ten times the tokens, the same mounted nodes: the ceiling is doing the
    // work, not the input.
    expect(elementCount(big?.[0])).toBe(smallCount)
  })
})

describe('the slice is left uncoloured rather than parsed', () => {
  test('a language we cannot name', () => {
    expect(selectHighlightedSourceRows(['some notes'], null)).toBeNull()
  })

  test('an empty slice', () => {
    expect(selectHighlightedSourceRows([], 'typescript')).toBeNull()
  })

  test('a slice past the line ceiling', () => {
    const under = Array.from({ length: MAX_HIGHLIGHTED_SOURCE_LINES }, () => 'const a = 1')
    expect(selectHighlightedSourceRows(under, 'typescript')).not.toBeNull()
    expect(selectHighlightedSourceRows([...under, 'const a = 1'], 'typescript')).toBeNull()
  })

  test('a slice past the character ceiling', () => {
    // One line, so the line ceiling cannot be what refuses it.
    const line = 'x'.repeat(MAX_HIGHLIGHTED_SOURCE_CHARS)
    expect(selectHighlightedSourceRows([line], 'typescript')).toBeNull()
  })

  test('a 50,000 line write is refused before it parses anything', () => {
    const lines = Array.from({ length: 50_000 }, (_unused, index) => `const v${index} = ${index}`)
    const started = Date.now()

    expect(selectHighlightedSourceRows(lines, 'typescript')).toBeNull()
    // The refusal is a length check, not a parse: this is the ceiling being a
    // ceiling on WORK rather than only on mounted nodes.
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})
