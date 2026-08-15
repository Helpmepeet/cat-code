/**
 * The pure model behind the diff bodies (CC-62).
 *
 * `DiffView` used to walk `diff.hunks` and mount every line of every hunk, and
 * `extractDiffProjection` caps neither, so a Write of a whole file arrives here
 * as one structured patch and mounted one DOM row per file line. Flattening the
 * hunks into ONE ordered row list is what lets the same virtualizer that bounds
 * the log bodies bound this one: the rows keep their per-hunk gutter numbers,
 * and the list decides which of them are near the viewport.
 *
 * The word-level intra-line highlight is the other unbounded axis. Pairing runs
 * of removes with the following runs of adds is cheap and happens here for the
 * whole diff; running `diffWordsWithSpace` over a pair is NOT, so that is left
 * to the caller to do for the rows it actually mounts, under the two ceilings
 * below.
 */

import { diffWordsWithSpace } from 'diff'
import type { ToolDiffProjection } from './transcriptProjector.js'

/**
 * Longest pair `diffWordsWithSpace` is run over. The algorithm is quadratic in
 * the worst case, and a minified bundle arrives as one 2 MB line: past this the
 * row keeps the line-level wash, which is what the prototype falls back to for
 * a near-total rewrite anyway.
 */
export const MAX_WORD_DIFF_CHARS = 2_000

/**
 * Word runs one row may paint. Each run becomes at least one mounted span, and
 * a pair of lines that alternate every character produces one run per
 * character. Past this the row takes the line-level wash instead.
 */
export const MAX_WORD_DIFF_SEGMENTS = 120

export type DiffLineKind = 'add' | 'del' | 'ctx'

export type WordDiffSide = { value: string; changed: boolean }[]

export type DiffRow = {
  kind: DiffLineKind
  /** The line without its diff sign. What is coloured, searched and copied. */
  body: string
  /** Current-file line number, blank on a removed line (the prototype gutter). */
  currentLabel: string
  hunkIndex: number
  /**
   * The row this one is paired with for the word-level highlight, or null.
   * Both sides of a pair carry it, so a mounted row can compute its own
   * segments without its partner being mounted.
   */
  pairedWith: number | null
}

/** Every hunk's lines, in order, as one flat row list. */
export function selectDiffRows(diff: ToolDiffProjection): DiffRow[] {
  const rows: DiffRow[] = []
  diff.hunks.forEach((hunk, hunkIndex) => {
    let oldNo = hunk.oldStart
    let newNo = hunk.newStart
    for (const line of hunk.lines) {
      const kind: DiffLineKind = line.startsWith('+')
        ? 'add'
        : line.startsWith('-')
          ? 'del'
          : 'ctx'
      const currentLabel = kind === 'del' ? '' : String(newNo)
      if (kind !== 'add') oldNo++
      if (kind !== 'del') newNo++
      rows.push({
        kind,
        body: kind === 'ctx' ? line : line.slice(1),
        currentLabel,
        hunkIndex,
        pairedWith: null,
      })
    }
  })
  pairReplacedRuns(rows)
  return rows
}

/**
 * Pair each consecutive run of removes with the run of adds that follows it
 * (prototype pairing, `Messages.jsx:134-150`). Pairing never crosses a hunk,
 * because two hunks are two separate regions of the file.
 */
function pairReplacedRuns(rows: DiffRow[]): void {
  let index = 0
  while (index < rows.length) {
    if (rows[index].kind !== 'del') {
      index++
      continue
    }
    const hunkIndex = rows[index].hunkIndex
    const dels: number[] = []
    while (
      index < rows.length &&
      rows[index].kind === 'del' &&
      rows[index].hunkIndex === hunkIndex
    ) {
      dels.push(index++)
    }
    const adds: number[] = []
    while (
      index < rows.length &&
      rows[index].kind === 'add' &&
      rows[index].hunkIndex === hunkIndex
    ) {
      adds.push(index++)
    }
    const pairs = Math.min(dels.length, adds.length)
    for (let pair = 0; pair < pairs; pair++) {
      rows[dels[pair]].pairedWith = adds[pair]
      rows[adds[pair]].pairedWith = dels[pair]
    }
  }
}

/**
 * Word-level intra-line highlight for a replaced pair (prototype `DiffView`,
 * `Messages.jsx:132-151`). The prototype only word-highlights when under 90% of
 * the line changed, because a near-total rewrite reads better line-level.
 *
 * Returns null on that guard, on either ceiling, on an empty diff, or on ANY
 * throw: the diff body is not under the prose error boundary, so this has to
 * degrade in place rather than bubble.
 */
export function selectWordDiffPair(
  oldLine: string,
  newLine: string,
): { del: WordDiffSide; add: WordDiffSide } | null {
  if (oldLine.length > MAX_WORD_DIFF_CHARS || newLine.length > MAX_WORD_DIFF_CHARS) {
    return null
  }
  try {
    const parts = diffWordsWithSpace(oldLine, newLine)
    if (parts.length > MAX_WORD_DIFF_SEGMENTS) return null
    let changed = 0
    let total = 0
    for (const part of parts) {
      total += part.value.length
      if (part.added || part.removed) changed += part.value.length
    }
    if (total === 0 || changed / total >= 0.9) return null
    const del: WordDiffSide = []
    const add: WordDiffSide = []
    for (const part of parts) {
      if (!part.added) del.push({ value: part.value, changed: part.removed === true })
      if (!part.removed) add.push({ value: part.value, changed: part.added === true })
    }
    return { del, add }
  } catch {
    return null
  }
}

/**
 * The word segments for ONE row, computed on demand and cached against the row
 * list that produced it. A mounted row asks for its own segments; scrolling
 * back over it must not re-run the diff, and the cache dies with the row list.
 */
export function selectRowWordSegments(
  rows: readonly DiffRow[],
  index: number,
): WordDiffSide | null {
  let cache = wordSegmentsByRows.get(rows)
  if (cache === undefined) {
    cache = new Map()
    wordSegmentsByRows.set(rows, cache)
  }
  const cached = cache.get(index)
  if (cached !== undefined) return cached
  const row = rows[index]
  const partner = row?.pairedWith
  if (row === undefined || partner === null || partner === undefined) {
    cache.set(index, null)
    return null
  }
  const del = row.kind === 'del' ? row : rows[partner]
  const add = row.kind === 'del' ? rows[partner] : row
  const pair = selectWordDiffPair(del.body, add.body)
  const own = pair === null ? null : row.kind === 'del' ? pair.del : pair.add
  cache.set(index, own)
  return own
}

const wordSegmentsByRows = new WeakMap<
  readonly DiffRow[],
  Map<number, WordDiffSide | null>
>()

/** Every hunk's lines as the raw `+`/`-`/` ` strings, in order. */
export function selectRawDiffLines(diff: ToolDiffProjection): string[] {
  const lines: string[] = []
  for (const hunk of diff.hunks) lines.push(...hunk.lines)
  return lines
}
