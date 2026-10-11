import type { ToolDiffProjection, ToolResultProjection } from './transcriptProjector.js'

/** Saved single-file rows and current multi-file patches share the same readers. */
export function selectToolDiffs(
  result: ToolResultProjection | null | undefined,
): readonly ToolDiffProjection[] {
  if (result?.fileDiffs?.length) return result.fileDiffs
  return result?.diff ? [result.diff] : []
}
