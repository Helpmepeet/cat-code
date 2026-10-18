import { isSubagentDockTerminal, type SubagentDockRow } from './subagentDockState.js'
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

/**
 * Every Agent and ResumeAgent run publishes its steps under its own tool use,
 * foreground or background (`runAgent` `publishDisplaySteps`), so a live run
 * opens before its first step arrives.
 */
export function canOpenSubagentPanel(row: SubagentDockRow, rows: readonly NestedTranscriptRow[]): boolean {
  if (row.toolUseId === null) return false
  // A synthetic resume key has no run-owned transcript correlation. Its reveal
  // target can still point at the previous run.
  if (row.runKey.startsWith('resume:') && row.runKey !== row.toolUseId) return false
  const branch = selectSubagentPanelBranch(rows, row.toolUseId)
  // A finished run recorded before steps were published has only its launch
  // acknowledgement, and keeps the reveal fallback.
  return !isSubagentDockTerminal(row.state) || branch.steps.length > 0 || branch.incomplete
}
