/**
 * What a search result REPORTS, read back off the flattened text.
 *
 * A grouped search card needs a per-pattern digest ("42 matches"), and the wire
 * carries only the tool result's text — the engine's structured `numFiles` /
 * `numLines` / `numMatches` fields never leave the tool (`GrepTool.ts:146-151`;
 * `mapToolResultToToolResultBlockParam` at `:254` flattens them into prose before
 * the block is built). So the digest is parsed back out of the exact strings that
 * function writes, and returns null rather than a guess for anything else.
 *
 * THREE MODES, THREE UNITS (`GrepTool.ts:52-56`), and they are not
 * interchangeable — `files_with_matches` is the DEFAULT and counts FILES, not
 * matches, so labelling everything "matches" would misreport the common case:
 *
 *  - `files_with_matches` → `Found N files\n<path>\n<path>…` (`:303`), or the
 *    exact string `No files found` when empty (`:298`).
 *  - `count` → the raw counts plus a trailing
 *    `\n\nFound M total occurrences across N files.` (`:285`).
 *  - `content` → raw ripgrep text (`:271`). Matches carry a `path:LINE:` locator
 *    and context lines carry `path-LINE-` (rg's own convention), so only the
 *    colon form is counted — counting both would inflate the number by the `-A`
 *    / `-B` / `-C` window.
 */

/** A match line: `path:LINE:body`. The path is matched non-greedily so a path
 * containing a colon cannot swallow the line number (same guard as
 * `splitGrepLine`, `transcriptViewModel.ts:122`). */
const MATCH_LINE = /^(.*?):\d+:/

const FOUND_FILES = /^Found (\d+) files?\b/
const FOUND_OCCURRENCES = /\n\nFound (\d+) total occurrences? across \d+ files?\./

export type GrepDigest =
  /** The count and what it counts. `none` is a real, stated empty result. */
  | { unit: 'files' | 'matches'; count: number }
  | { unit: 'none'; count: 0 }

/**
 * The digest for one search result, or null when the payload is not a shape this
 * knows — an error string, a future mode. A null digest renders no count at all,
 * exactly as a read with no parseable body renders no line count.
 */
export function grepDigest(content: string): GrepDigest | null {
  if (content.length === 0) return null

  // Empty results are exact strings the tool writes, not prose to interpret.
  if (content === 'No files found' || content === 'No matches found') {
    return { unit: 'none', count: 0 }
  }

  const files = FOUND_FILES.exec(content)
  if (files !== null) return { unit: 'files', count: Number(files[1]) }

  const occurrences = FOUND_OCCURRENCES.exec(content)
  if (occurrences !== null) {
    return { unit: 'matches', count: Number(occurrences[1]) }
  }

  let matches = 0
  for (const line of content.split('\n')) {
    if (MATCH_LINE.test(line)) matches += 1
  }
  return matches > 0 ? { unit: 'matches', count: matches } : null
}

/** The digest as the member row says it: `42 matches`, `3 files`, `no matches`. */
export function formatGrepDigest(digest: GrepDigest): string {
  if (digest.unit === 'none') return 'no matches'
  if (digest.unit === 'files') {
    return `${digest.count} ${digest.count === 1 ? 'file' : 'files'}`
  }
  return `${digest.count} ${digest.count === 1 ? 'match' : 'matches'}`
}

/**
 * The run's total, for the card's sub line. The prototype states
 * `${total} matches · ${n} patterns` (`Messages.jsx:679`), which assumes every
 * member counts the same thing. Real members can mix units (one pattern run in
 * `content` mode, the next in the default file mode), and summing across units
 * would print a number that means nothing — so a mixed run returns null and the
 * card falls back to the pattern count alone.
 */
export function totalGrepDigest(
  digests: readonly (GrepDigest | null)[],
): GrepDigest | null {
  const counted = digests.filter(
    (digest): digest is Exclude<GrepDigest, { unit: 'none' }> =>
      digest !== null && digest.unit !== 'none',
  )
  if (counted.length === 0) {
    // Every member that reported at all reported an EMPTY result. That is a real,
    // stated zero and must not read like the mixed-unit refusal below, which is
    // "these do not add up". Only a run where nothing measured anything at all
    // falls through to null.
    return digests.some(digest => digest?.unit === 'none')
      ? { unit: 'none', count: 0 }
      : null
  }
  const unit = counted[0].unit
  if (counted.some(digest => digest.unit !== unit)) return null
  return { unit, count: counted.reduce((sum, d) => sum + d.count, 0) }
}
