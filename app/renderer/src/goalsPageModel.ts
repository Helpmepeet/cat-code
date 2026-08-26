import type { ThreadGoalStatus } from '../../shared/protocol.js'
import type { ThreadGoalRow } from './goalMemoryState.js'

export const GOAL_STATUS_LABELS: Record<ThreadGoalStatus, string> = {
  active: 'active',
  waiting: 'waiting',
  paused: 'paused',
  blocked: 'blocked',
  stalled: 'stalled',
  budget_limited: 'budget limited',
  usage_limited: 'usage limited',
  failed: 'failed',
  complete: 'complete',
}

export const GOAL_STATUS_TONES: Record<ThreadGoalStatus, string> = {
  active: 'border-tone-good/30 bg-tone-good/10 text-tone-good',
  waiting: 'border-shell-seam bg-shell-hover text-text-subtle',
  paused: 'border-shell-seam bg-shell-hover text-text-subtle',
  blocked: 'border-tone-warn/30 bg-tone-warn/10 text-tone-warn',
  stalled: 'border-tone-warn/30 bg-tone-warn/10 text-tone-warn',
  budget_limited: 'border-tone-warn/30 bg-tone-warn/10 text-tone-warn',
  usage_limited: 'border-tone-warn/30 bg-tone-warn/10 text-tone-warn',
  failed: 'border-tone-danger/30 bg-tone-danger/10 text-tone-danger',
  complete: 'border-accent/30 bg-accent/10 text-accent',
}

export function goalStatusLabel(status: ThreadGoalStatus): string {
  return GOAL_STATUS_LABELS[status] ?? status
}

export function goalStatusTone(status: ThreadGoalStatus): string {
  return GOAL_STATUS_TONES[status] ?? 'border-shell-seam bg-shell-hover text-text-subtle'
}

export function isTerminalGoalStatus(status: ThreadGoalStatus): boolean {
  return status === 'complete'
}

export function groupGoalRowsByWorkspace(
  rows: readonly ThreadGoalRow[],
): Array<{ workspace: string; rows: ThreadGoalRow[] }> {
  const grouped = new Map<string, ThreadGoalRow[]>()
  for (const row of rows) {
    const group = grouped.get(row.cwd)
    if (group) group.push(row)
    else grouped.set(row.cwd, [row])
  }
  return [...grouped.entries()]
    .sort(([workspaceA], [workspaceB]) => workspaceA.localeCompare(workspaceB))
    .map(([workspace, workspaceRows]) => ({
      workspace,
      rows: workspaceRows,
    }))
}

export function formatGoalNumber(value: number): string {
  return value.toLocaleString('en-US')
}
