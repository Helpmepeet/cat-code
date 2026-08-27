import type { NestedTranscriptRow } from './transcriptProjector.js'

type ToolUseNestedRow = Extract<NestedTranscriptRow, { kind: 'tool-use' }>

export function findNestedToolUseRow(
  rows: NestedTranscriptRow[],
  id: string,
): ToolUseNestedRow | null {
  for (const row of rows) {
    if (row.kind === 'tool-use' && row.id === id) return row
    const nested = findNestedToolUseRow(row.children, id)
    if (nested) return nested
  }
  return null
}

export function resolveToolCardExpanded(
  userExpanded: boolean | null,
  defaultExpanded: boolean,
): boolean {
  return userExpanded ?? defaultExpanded
}

/**
 * Semantic output-line tint — a port of the prototype's `logLineColor`
 * (`Messages.jsx:212-218`), carrying BASH OUTPUT ONLY. That is the prototype's
 * own split: `logLineColor` reaches the screen through `OutputLines`, which
 * `BashOutputCard` (`Messages.jsx:381-556`) and the output drawer use, while the
 * Grep/Web/Mcp/Skill bodies take flat `FE_T.t2` plus `hl()` syntax coloring
 * (`:695,715,734,788`). `BashBody` is the single call site, and
 * `PlainLinesBody` deliberately does NOT use this — a guard test in
 * `TranscriptView.test.tsx` pins that, because applying these heuristics to a
 * grep or MCP body would tint any line that merely contains `WARNING` or `✓`.
 *
 * 🔁 ONE DEVIATION, deliberate and unapproved: the unclassified fallback. The
 * prototype returns a bespoke `#9b9ba3` (`:217`); this returns `text-text-muted`
 * `#a1a1aa`. That is the prototype's OWN `FE_T.t2` (`:11`), the colour it gives
 * ordinary lines in every other tool body, so the token keeps a plain bash line
 * the same weight as a plain grep line and keeps the theme in one place. The
 * `#9b9ba3` one-off looks like prototype-local drift rather than intent. Swap to
 * `text-[light-dark(#5b5b63,#9b9ba3)]` if the operator rules the other way; nothing else depends on it.
 *
 * The hues are the prototype's own, and they are deliberately the 300-level
 * pastels — NOT the `--tone-*` tokens this once returned. The prototype runs a
 * two-level palette (`Messages.jsx:11` `add:'#86efac', del:'#fca5a5'`): pastels
 * carry BODY TEXT, the saturated 400s (`#4ade80`/`#f87171`) carry signs, dots and
 * chips, exactly as `DIFF_ROW_CLASS` vs `DIFF_SIGN_CLASS` already split them. The
 * earlier tone-token mapping put 400s on body text, which reads muddy against
 * `#09090b` and is a large part of why output looked colorless.
 *
 * Literal arbitrary-value classes for the same reason `DIFF_ROW_CLASS` uses them:
 * Tailwind v4's oklch palette drifts the named utilities off the prototype hexes,
 * and an interpolated `text-[${hex}]` would never be scanned at all.
 *
 * Lives here rather than in `TranscriptView.tsx` because it is a plain helper,
 * which that module may not export under the Fast Refresh boundary rule, and the
 * branch table is worth asserting directly rather than only through whichever
 * lines a rendered fixture happens to contain.
 */
/** The peek's normal size, and the most it will ever grow to. */
const PEEK_LINES = 3
const PEEK_MAX_LINES = 5

/**
 * The three OUTCOME tints. `text-text-faint` (stack/trace continuation) is
 * deliberately excluded: a trace line is context, not a result, and letting it
 * extend the peek would grow the card for the least informative lines there are.
 */
const OUTCOME_CLASSES: ReadonlySet<string> = new Set([
  'text-[light-dark(#dc2626,#fca5a5)]',
  'text-[light-dark(#a35f00,#fcd34d)]',
  'text-[light-dark(#15803d,#86efac)]',
])

/**
 * Which lines a COLLAPSED bash card previews.
 *
 * Last-three is the obvious rule and it drops the one line that matters. Real
 * `bun test` ends:
 *
 *     18 pass  ←  the outcome, and the only line that carries a colour
 *     0 fail
 *     28 expect() calls
 *     Ran 18 tests across 1 file. [355.00ms]
 *
 * so a three-line window shows the three least informative lines and cuts the
 * result. Observed directly in the running app (2026-08-04).
 *
 * The window therefore EXTENDS BACKWARDS to reach the most recent outcome line,
 * capped. It never picks lines out of order or skips over one to reach a
 * colourful one further back — a peek with a hole in it misrepresents the output
 * it is previewing. Contiguous tail, just sometimes a slightly longer one.
 */
export function selectPeekLines(lines: string[]): string[] {
  const nonEmpty = lines.filter(line => line.length > 0)
  if (nonEmpty.length === 0) return []
  const window = nonEmpty.slice(-PEEK_MAX_LINES)
  let lastOutcome = -1
  window.forEach((line, index) => {
    if (OUTCOME_CLASSES.has(logLineClass(line))) lastOutcome = index
  })
  const reach = lastOutcome === -1 ? PEEK_LINES : window.length - lastOutcome
  return nonEmpty.slice(-Math.min(Math.max(reach, PEEK_LINES), PEEK_MAX_LINES))
}

/**
 * Split a grep output line into its `path:line:` locator and the matched source.
 * Returns null for any line that is not in that shape (a `--` group separator, a
 * bare filename from `-l`, a summary), which then renders unchanged.
 *
 * Both separators are real and mean different things in the same payload: `:`
 * marks a MATCH line, `-` a context line from `-A`/`-B`/`-C`. Accepting only `:`
 * would leave every context line unsplit, which is most of the output of a
 * search run with context.
 *
 * The locator is matched non-greedily up to the FIRST `<sep><digits><sep>`, so a
 * path containing a dash or a colon does not swallow the line number.
 */
export function splitGrepLine(
  line: string,
): { locator: string; path: string; body: string } | null {
  const match = /^((.*?)[:-]\d+[:-])(.*)$/.exec(line)
  if (match === null || match[1].length === 0 || match[2].length === 0) return null
  return { locator: match[1], path: match[2], body: match[3] }
}

/**
 * One run of the search body: either source from a single file, or lines that
 * carry no locator at all (a `--` group separator, a bare `-l` filename).
 */
export type GrepSegment =
  | { kind: 'source'; path: string; locators: string[]; bodies: string[] }
  | { kind: 'plain'; lines: string[] }

/**
 * Group search output into runs that can each be syntax-colored as one block.
 *
 * WHY GROUP AT ALL. The highlighter takes a block and a language. A search
 * result spans many files, so there is no single language for the whole body —
 * which is why this was long recorded as blocked. But every line names its OWN
 * file in its locator, and real search output arrives in runs from the same
 * file, so consecutive same-path lines can share one block and one language.
 *
 * Grouping is by CONSECUTIVE path, never by path globally: reordering a search
 * result would misrepresent it. The worst case (every line a different file)
 * degrades to one block per line, which is still correct, just less efficient.
 */
export function groupGrepLines(lines: string[]): GrepSegment[] {
  const segments: GrepSegment[] = []
  for (const line of lines) {
    const split = splitGrepLine(line)
    const last = segments[segments.length - 1]
    if (split === null) {
      if (last?.kind === 'plain') last.lines.push(line)
      else segments.push({ kind: 'plain', lines: [line] })
      continue
    }
    if (last?.kind === 'source' && last.path === split.path) {
      last.locators.push(split.locator)
      last.bodies.push(split.body)
      continue
    }
    segments.push({
      kind: 'source',
      path: split.path,
      locators: [split.locator],
      bodies: [split.body],
    })
  }
  return segments
}

export type QuotePosition = { start: { offset?: number }; end: { offset?: number } }

/**
 * Recover the plain text a rendered blockquote wraps by stripping `>` from
 * the RAW markdown source at the node's position, rather than flattening the
 * already-parsed tree — paragraph and list line breaks survive intact this
 * way, where reconstructing them from `<p>`/`<li>` elements would run every
 * line together. Lives here rather than in `TranscriptView.tsx` because it is
 * a plain helper, which that module may not export under the Fast Refresh
 * boundary rule, and the line-splitting is worth asserting directly.
 */
export function dequote(
  rawSource: string,
  position: QuotePosition | undefined,
): string {
  const start = position?.start.offset
  const end = position?.end.offset
  if (typeof start !== 'number' || typeof end !== 'number') return ''
  return rawSource
    .slice(start, end)
    .split('\n')
    .map(line => line.replace(/^>\s?/, ''))
    .join('\n')
    .trim()
}

export function logLineClass(line: string): string {
  // COUNT LINES FIRST — and this branch is NOT from the prototype.
  //
  // Real runners report outcomes as counts, and the prototype's fixtures never
  // contained one. `bun test` ends with ` 18 pass` / ` 0 fail`: no `PASS`, no
  // `✓`, no `passed`, so every branch below misses and a whole test summary
  // renders grey — which is exactly what the operator kept reporting. The
  // prototype is a UX spec; its mock data is not the contract.
  //
  // A count also carries meaning no keyword match can see: ZERO IS GOOD NEWS.
  // `0 fail` must not read as a failure, and `failed` in the branch below would
  // paint `0 failed` red, so this has to run first.
  const count = /^\s*(\d+)\s+(pass(?:ed|ing)?|fail(?:ed|ures?|ing)?|errors?)\b/i.exec(line)
  if (count !== null) {
    const total = Number(count[1])
    if (total === 0) return 'text-text-muted'
    return /^pass/i.test(count[2]) ? 'text-[light-dark(#15803d,#86efac)]' : 'text-[light-dark(#dc2626,#fca5a5)]'
  }
  if (/(^\s*FAIL\b|\bERROR\b|\berror\b|npm ERR!|✕|✘|UnhandledPromise|failed)/.test(line)) {
    return 'text-[light-dark(#dc2626,#fca5a5)]'
  }
  if (/(^\s*WARNING\b|\bwarn(ing)?\b|exceed|collision|not wrapped)/i.test(line)) {
    return 'text-[light-dark(#a35f00,#fcd34d)]'
  }
  if (/(^\s*PASS\b|✓|compiled|succeeded|\bpassed\b)/.test(line)) {
    return 'text-[light-dark(#15803d,#86efac)]'
  }
  if (/^\s*(>|@ |at )/.test(line)) return 'text-text-faint'
  return 'text-text-muted'
}
