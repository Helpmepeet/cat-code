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

/** One run of a line, split so the DOM layer can paint the matched parts. */
export type OutputSegment = {
  text: string
  match: boolean
}

/**
 * How many lines the drawer paints. Each line becomes its own row so the active
 * match can be highlighted and scrolled to, and the whole body re-renders on
 * every keystroke in the search field — so an unbounded output would freeze the
 * renderer on a keypress. Far above any real tool result (the inline card cuts
 * over at 400 lines), and the copy button always writes the COMPLETE output, so
 * nothing becomes unreachable.
 */
export const MAX_INSPECTOR_LINES = 5000

export type OutputSearchModel = {
  /** The output split on newlines, cut to `MAX_INSPECTOR_LINES`. Line N is `lines[N - 1]`. */
  lines: string[]
  /** Lines in the whole output, including any past the render cut. */
  totalLines: number
  /** How many lines the cut left out. 0 for every realistic output. */
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
  maxLines: number = MAX_INSPECTOR_LINES,
): OutputSearchModel {
  const allLines = text.split('\n')
  const lines =
    allLines.length > maxLines ? allLines.slice(0, maxLines) : allLines
  const counts = {
    totalLines: allLines.length,
    hiddenLines: allLines.length - lines.length,
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
  // Only the painted lines can be matched: a counter promising a match the body
  // cannot scroll to would be a lie.
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
 * painted. Always returns at least one segment, and every segment is rendered
 * as a text node — this never produces markup.
 */
export function splitLineByQuery(line: string, query: string): OutputSegment[] {
  const needle = query.toLowerCase()
  if (needle.length === 0 || line.length === 0) {
    return [{ text: line, match: false }]
  }
  const haystack = line.toLowerCase()
  const segments: OutputSegment[] = []
  let from = 0
  let at = haystack.indexOf(needle, from)
  while (at !== -1) {
    if (at > from) segments.push({ text: line.slice(from, at), match: false })
    segments.push({ text: line.slice(at, at + needle.length), match: true })
    from = at + needle.length
    at = haystack.indexOf(needle, from)
  }
  if (segments.length === 0) return [{ text: line, match: false }]
  if (from < line.length) segments.push({ text: line.slice(from), match: false })
  return segments
}

function wrapIndex(index: number, total: number): number {
  if (!Number.isFinite(index)) return 0
  const whole = Math.trunc(index)
  return ((whole % total) + total) % total
}
