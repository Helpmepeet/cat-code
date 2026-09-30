export const MAX_FILE_PATCH_COMPLETE_WITNESSES = 2
export const MAX_FILE_PATCH_WITNESS_PLACEMENTS = 20

/** Internal coordinates are zero-based and end-exclusive; hunkIndex is zero-based. */
export type HunkCoordinate = { start: number; end: number; hunkIndex?: number }

/** Round-robin sampling keeps a long first hunk from hiding later hunks. */
export function sampleHunkCoordinates<T extends { hunkIndex?: number }>(
  coordinates: readonly T[],
  limit: number,
): T[] {
  if (coordinates.length <= limit) return [...coordinates]
  const groups = new Map<number | undefined, T[]>()
  for (const coordinate of coordinates) {
    const group = groups.get(coordinate.hunkIndex) ?? []
    group.push(coordinate)
    groups.set(coordinate.hunkIndex, group)
  }
  const retained: T[] = []
  for (let offset = 0; retained.length < limit; offset++) {
    let found = false
    for (const group of groups.values()) {
      if (group[offset] === undefined) continue
      retained.push(group[offset]!)
      found = true
      if (retained.length >= limit) break
    }
    if (!found) break
  }
  return retained
}

/** A broad legacy truncation flag cannot tell us how many candidates were lost. */
export function candidateOmissions(
  previous: number | undefined,
  previouslyTruncated: boolean,
  discarded: number,
): number | undefined {
  if (previous === undefined && previouslyTruncated) return undefined
  return (previous ?? 0) + discarded
}
