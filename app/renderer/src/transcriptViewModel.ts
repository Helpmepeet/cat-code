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
 * `text-[#9b9ba3]` if the operator rules the other way; nothing else depends on it.
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
export function splitGrepLine(line: string): { locator: string; body: string } | null {
  const match = /^(.*?[:-]\d+[:-])(.*)$/.exec(line)
  if (match === null || match[1].length === 0) return null
  return { locator: match[1], body: match[2] }
}

export function logLineClass(line: string): string {
  if (/(^\s*FAIL\b|\bERROR\b|\berror\b|npm ERR!|✕|✘|UnhandledPromise|failed)/.test(line)) {
    return 'text-[#fca5a5]'
  }
  if (/(^\s*WARNING\b|\bwarn(ing)?\b|exceed|collision|not wrapped)/i.test(line)) {
    return 'text-[#fcd34d]'
  }
  if (/(^\s*PASS\b|✓|compiled|succeeded|\bpassed\b)/.test(line)) {
    return 'text-[#86efac]'
  }
  if (/^\s*(>|@ |at )/.test(line)) return 'text-text-faint'
  return 'text-text-muted'
}
