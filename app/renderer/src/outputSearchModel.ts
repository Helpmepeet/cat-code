/**
 * P4-37 — the pure half of the tool inspector's output search
 * (prototype `OutputInspector`, `Messages.jsx:271-284,325-335`).
 *
 * Search is pure interaction and the renderer suite renders to STATIC MARKUP:
 * no test in this package can type into a field, press a stepper, or run a
 * scroll effect. So every decision the search makes — which lines match, which
 * match is active, what `k/N` reads, where a step lands when it runs off the
 * end — lives here as a plain function with unit coverage, and `ToolInspector`
 * keeps only the thin DOM layer over it.
 *
 * Matching is literal and case-insensitive: the query is a user's search string,
 * never a pattern. `String.includes`/`indexOf` means a query of `.*` or `[` finds
 * those characters instead of throwing or matching everything.
 */

import {
  MAX_MOUNTED_CHUNK_CHARS,
  selectVisualChunk,
} from './lineWindow.js'

/**
 * Budget 3 of 3 (`lineWindow.ts` owns the other two): highlight descendants
 * mounted for one chunk. A one-character query over a repetitive line produces
 * one segment per two characters, so a 4,000-character chunk of `aaaa…`
 * searched for `a` would build 8,000 React children for a single row. Past this
 * ceiling the rest of the chunk paints as one plain run: the matches are all
 * still counted, stepped through and centred, they just stop being tinted
 * somewhere no reader was going to look.
 *
 * 300 is well past any readable density. An inspector row shows around 60
 * characters, so 300 segments covers several full visual lines of back-to-back
 * matches.
 */
export const MAX_RENDERED_HIGHLIGHT_SEGMENTS = 300

/** One run of a line, split so the DOM layer can paint the matched parts. */
export type OutputSegment = {
  text: string
  match: boolean
}

/**
 * What one row actually mounts: a bounded slice of the logical line, already
 * split into runs, plus whether characters were cut off either end so the row
 * can say so.
 */
export type OutputLineChunk = {
  segments: OutputSegment[]
  truncatedStart: boolean
  truncatedEnd: boolean
}

/**
 * The model retains all output lines. The render boundary windows them before
 * creating DOM nodes, so search can navigate to any line without an arbitrary
 * source-data cut.
 */
export type OutputSearchModel = {
  /** The complete output split on newlines. Line N is `lines[N - 1]`. */
  lines: string[]
  /** Lines in the whole output. */
  totalLines: number
  /** Kept for the display contract. Windowing paints every source line logically. */
  hiddenLines: number
  /** 1-based numbers of the lines containing the query, ascending. */
  matches: number[]
  /** The 1-based line the steppers are parked on, or null when nothing matches. */
  activeLine: number | null
  /** Index of `activeLine` within `matches`, or -1 when nothing matches. */
  activeIndex: number
  /** The counter beside the field: `k/N`, or `0` when a query finds nothing. */
  label: string
  /** False while the field is empty, so the DOM layer can hide the counter. */
  searching: boolean
}

export function describeOutputSearch(
  text: string,
  query: string,
  matchIndex: number,
): OutputSearchModel {
  const allLines = text.split('\n')
  const lines = allLines
  const counts = {
    totalLines: allLines.length,
    hiddenLines: 0,
  }
  const needle = query.toLowerCase()
  if (needle.length === 0) {
    return {
      lines,
      ...counts,
      matches: [],
      activeLine: null,
      activeIndex: -1,
      label: '',
      searching: false,
    }
  }
  const matches: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(needle)) matches.push(i + 1)
  }
  if (matches.length === 0) {
    return {
      lines,
      ...counts,
      matches,
      activeLine: null,
      activeIndex: -1,
      label: '0',
      searching: true,
    }
  }
  // Wrap rather than clamp: the stored index survives a query edit that shrank
  // the match list, so a stale index lands on a real match instead of nothing.
  const activeIndex = wrapIndex(matchIndex, matches.length)
  return {
    lines,
    ...counts,
    matches,
    activeLine: matches[activeIndex],
    activeIndex,
    label: `${activeIndex + 1}/${matches.length}`,
    searching: true,
  }
}

/**
 * Step the active match by `delta`, wrapping in both directions: stepping past
 * the last match returns to the first, and back from the first goes to the last
 * (prototype `stepMatch`, `Messages.jsx:284`).
 */
export function stepMatchIndex(
  index: number,
  delta: number,
  total: number,
): number {
  if (total <= 0) return 0
  return wrapIndex(index + delta, total)
}

/**
 * Split one line into matched / unmatched runs so the matched text can be
 * painted. Always returns at least one segment, never more than `maxSegments`,
 * and every segment is rendered as a text node — this never produces markup.
 */
export function splitLineByQuery(
  line: string,
  query: string,
  maxSegments: number = MAX_RENDERED_HIGHLIGHT_SEGMENTS,
): OutputSegment[] {
  const needle = query.toLowerCase()
  if (needle.length === 0 || line.length === 0) {
    return [{ text: line, match: false }]
  }
  const limit = Math.max(1, Math.floor(maxSegments))
  const haystack = line.toLowerCase()
  const segments: OutputSegment[] = []
  let from = 0
  let at = haystack.indexOf(needle, from)
  while (at !== -1) {
    // One match can add two runs, and the remainder always needs a slot of its
    // own, so stop while there is room for all three.
    if (segments.length + 2 >= limit) break
    if (at > from) segments.push({ text: line.slice(from, at), match: false })
    segments.push({ text: line.slice(at, at + needle.length), match: true })
    from = at + needle.length
    at = haystack.indexOf(needle, from)
  }
  if (segments.length === 0) return [{ text: line, match: false }]
  if (from < line.length) segments.push({ text: line.slice(from), match: false })
  return segments
}

/**
 * The bounded, painted form of one logical line.
 *
 * `anchorToMatch` is what keeps a match on a pathological line reachable: on
 * the active row the slice is centred on the first occurrence instead of taken
 * from the start, so stepping onto a match five megabytes into one line still
 * shows it. Every other row slices from the start, which is where a reader
 * looks first.
 */
export function selectOutputLineChunk(
  line: string,
  query: string,
  options: { anchorToMatch?: boolean; maxChars?: number } = {},
): OutputLineChunk {
  const needle = query.toLowerCase()
  const anchor =
    options.anchorToMatch === true && needle.length > 0
      ? line.toLowerCase().indexOf(needle)
      : -1
  const chunk = selectVisualChunk(
    line,
    anchor < 0 ? 0 : anchor,
    options.maxChars ?? MAX_MOUNTED_CHUNK_CHARS,
  )
  return {
    segments: splitLineByQuery(chunk.text, query),
    truncatedStart: chunk.truncatedStart,
    truncatedEnd: chunk.truncatedEnd,
  }
}

function wrapIndex(index: number, total: number): number {
  if (!Number.isFinite(index)) return 0
  const whole = Math.trunc(index)
  return ((whole % total) + total) % total
}
