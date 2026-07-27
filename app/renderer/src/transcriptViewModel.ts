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
