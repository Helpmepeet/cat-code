import type { SubagentDockRow } from './subagentDockState.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'

const EMPTY_STEPS: NestedTranscriptRow[] = []

export function selectSubagentPanelBranch(rows: readonly NestedTranscriptRow[], toolUseId: string | null) {
  const branch = toolUseId === null ? undefined : rows.find(row =>
    row.kind === 'tool-use' && row.toolFamily === 'agent' && row.toolUseId === toolUseId ||
    row.kind === 'orphaned-agent' && row.missingToolUseId === toolUseId)
  return {
    agent: branch?.kind === 'tool-use' ? branch : null,
    steps: branch?.children ?? EMPTY_STEPS,
    incomplete: branch === undefined || branch.kind === 'orphaned-agent' ||
      branch.kind === 'tool-use' && branch.stepsNotLoaded === true,
  }
}

/** Async launches and resumed background runs do not forward live step frames. */
export function canOpenSubagentPanel(row: SubagentDockRow, rows: readonly NestedTranscriptRow[]): boolean {
  if (row.toolUseId === null || row.state === 'background' || row.state === 'resumed') return false
  const branch = selectSubagentPanelBranch(rows, row.toolUseId)
  // A blocked async worker can be "waiting" without ever forwarding steps.
  return row.state !== 'waiting' || branch.steps.length > 0 || branch.incomplete
}
