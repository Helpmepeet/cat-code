import type { ToolDiffProjection, ToolResultProjection } from './transcriptProjector.js'

/** Saved single-file rows and current multi-file patches share the same readers. */
export function selectToolDiffs(
  result: ToolResultProjection | null | undefined,
): readonly ToolDiffProjection[] {
  if (result?.fileDiffs?.length) return result.fileDiffs
  return result?.diff ? [result.diff] : []
}

/** A terminal newline ends the last line instead of starting another one. */
export function countWrittenLines(content: string): number {
  if (!content.length) return 0
  let lines = 1
  for (let index = 0; index < content.length - 1; index++) {
    if (content[index] === '\n') lines++
  }
  return lines
}

const diffCounts = new WeakMap<ToolDiffProjection, { adds: number; dels: number }>()

/** +adds / −dels across every hunk (from the `+`/`-` line prefixes). */
export function countDiff(diff: ToolDiffProjection): { adds: number; dels: number } {
  const cached = diffCounts.get(diff)
  if (cached) return cached
  let adds = 0
  let dels = 0
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) adds++
      else if (line.startsWith('-')) dels++
    }
  }
  const counts = { adds, dels }
  diffCounts.set(diff, counts)
  return counts
}
