import type { NestedToolUseRow, NestedTranscriptRow } from './transcriptProjector.js'
import { codeModeForRow } from './codeMode.js'
import { codeModeChildView } from './codeModeChildView.js'

/** Output-pane resolution may reconstruct bounded-away Code Mode audit children.
 * Keep this projector dependency out of shared card expansion/view helpers. */
export function findToolOutputRow(rows: readonly NestedTranscriptRow[], id: string): NestedToolUseRow | null {
  for (const row of rows) {
    if (row.kind === 'tool-use') {
      const audit = codeModeForRow(row)
      if (audit) {
        const actual = row.children.find((child): child is NestedToolUseRow => child.kind === 'tool-use' && child.id === id)
        const call = audit.calls.find(candidate => `${row.id}:audit:${candidate.toolUseId}` === id || actual?.toolUseId === candidate.toolUseId)
        if (call) return codeModeChildView(row, call, actual ?? row.children.find((child): child is NestedToolUseRow => child.kind === 'tool-use' && child.toolUseId === call.toolUseId))
      }
    }
    if (row.kind === 'tool-use' && row.id === id) return row
    const nested = findToolOutputRow(row.children, id)
    if (nested) return nested
  }
  return null
}
