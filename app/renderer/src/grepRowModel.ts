/**
 * The pure model behind the search body's rows (CC-62).
 *
 * `GrepBody` used to paint each run of same-file results as ONE syntax-coloured
 * block inside a single `grid-cols-[max-content_1fr]`, which is what kept every
 * run's source starting at the same x. One block per run cannot be virtualized,
 * and the shared grid column cannot survive virtualization either: `max-content`
 * over a mounted window resizes as the window moves.
 *
 * So the alignment moves into the model. Locators are padded to the widest one
 * in the WHOLE body, which is a fixed column at any scroll position, needs no
 * measurement and no interpolated class. The gutter is `select-none`, so the
 * padding never reaches a copy.
 */

import type { ReactNode } from 'react'
import { groupGrepLines } from './transcriptViewModel.js'
import { readSourceLanguage } from './readSource.js'
import {
  MAX_HIGHLIGHTED_SOURCE_CHARS,
  MAX_HIGHLIGHTED_SOURCE_LINES,
  selectHighlightedSourceRows,
} from './sourceHighlight.js'

export type GrepRow = {
  /**
   * The `path:line:` prefix, padded to the body's widest, or null for a line
   * that carries none (a `--` separator, a bare `-l` filename, a summary).
   */
  locator: string | null
  /** The matched source, or the whole line when there is no locator. */
  body: string
  /** The file the run belongs to, or null. Only used to name a language. */
  path: string | null
}

/** One row per output line, in order, with the locator column already sized. */
export function selectGrepRows(lines: readonly string[]): GrepRow[] {
  const rows: GrepRow[] = []
  for (const segment of groupGrepLines([...lines])) {
    if (segment.kind === 'plain') {
      for (const line of segment.lines) {
        rows.push({ locator: null, body: line, path: null })
      }
      continue
    }
    segment.locators.forEach((locator, index) => {
      rows.push({
        locator,
        body: segment.bodies[index] ?? '',
        path: segment.path,
      })
    })
  }
  let widest = 0
  for (const row of rows) {
    if (row.locator !== null) widest = Math.max(widest, row.locator.length)
  }
  return rows.map(row =>
    row.locator === null ? row : { ...row, locator: row.locator.padEnd(widest) },
  )
}

/**
 * One coloured row per entry of `rows`, or null in that slot. Each consecutive
 * run of same-file rows is one parse in its own language, because a search
 * result spans files and there is no single language for the whole body.
 *
 * The ceilings apply to the body as a WHOLE rather than per run: a result made
 * of ten thousand one-line runs would otherwise pass every per-run check and
 * still run ten thousand parses.
 */
export function selectGrepHighlightedRows(
  rows: readonly GrepRow[],
): readonly (ReactNode | null)[] {
  const painted: (ReactNode | null)[] = rows.map(() => null)
  let characters = 0
  for (const row of rows) characters += row.body.length + 1
  if (rows.length > MAX_HIGHLIGHTED_SOURCE_LINES) return painted
  if (characters > MAX_HIGHLIGHTED_SOURCE_CHARS) return painted
  let index = 0
  while (index < rows.length) {
    const path = rows[index].path
    if (path === null) {
      index++
      continue
    }
    let end = index
    while (end < rows.length && rows[end].path === path) end++
    const coloured = selectHighlightedSourceRows(
      rows.slice(index, end).map(row => row.body),
      readSourceLanguage(path),
    )
    if (coloured !== null) {
      for (let at = index; at < end; at++) painted[at] = coloured[at - index]
    }
    index = end
  }
  return painted
}
