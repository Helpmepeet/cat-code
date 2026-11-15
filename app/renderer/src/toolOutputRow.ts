import { projectCodeModeCall, type NestedToolUseRow, type NestedTranscriptRow } from './transcriptProjector.js'

/** Output-pane resolution may reconstruct bounded-away Code Mode audit children.
 * Keep this projector dependency out of shared card expansion/view helpers. */
export function findToolOutputRow(rows: readonly NestedTranscriptRow[], id: string): NestedToolUseRow | null {
  for (const row of rows) {
    if (row.kind === 'tool-use' && row.id === id) return row
    const nested = findToolOutputRow(row.children, id)
    if (nested) return nested
    if (row.kind === 'tool-use' && row.toolName === 'REPL' && id.startsWith(`${row.id}:audit:`)) {
      const call = row.result?.codeMode?.calls.find(candidate => `${row.id}:audit:${candidate.toolUseId}` === id)
      if (call) return row.children.find((child): child is NestedToolUseRow => child.kind === 'tool-use' && child.toolUseId === call.toolUseId) ?? projectCodeModeCall(row, call)
    }
  }
  return null
}
