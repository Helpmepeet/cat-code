import type {
  MemoryInstructionFile,
  MemorySnapshot,
  ServerFrame,
  SessionId,
  ThreadGoalSnapshot,
} from '../../shared/protocol.js'
import type { MergedSessionRow } from './sessionsCatalogState.js'

export type GoalMemoryState = {
  goals: Record<SessionId, ThreadGoalSnapshot | null>
}

export type GoalMemoryAction = { type: 'frame'; frame: ServerFrame }

export type ThreadGoalRow = {
  displayLabel: string
  cwd: string
  appSessionId: SessionId
  goal: ThreadGoalSnapshot
}

export function createGoalMemoryState(): GoalMemoryState {
  return { goals: {} }
}

export function reduceGoalMemoryState(
  state: GoalMemoryState,
  action: GoalMemoryAction,
): GoalMemoryState {
  const { frame } = action

  if (frame.kind === 'thread-goal.snapshot') {
    return {
      ...state,
      goals: { ...state.goals, [frame.sessionId]: frame.goal },
    }
  }

  return state
}

export function selectThreadGoalRows(
  state: GoalMemoryState,
  roster: readonly Pick<MergedSessionRow, 'sessionId' | 'appSessionId' | 'cwd' | 'displayLabel'>[],
): ThreadGoalRow[] {
  const rows: ThreadGoalRow[] = []
  for (const row of roster) {
    if (row.appSessionId === null) continue
    const goal = state.goals[row.appSessionId]
    if (goal === undefined || goal === null) continue
    rows.push({
      displayLabel: row.displayLabel,
      cwd: row.cwd,
      appSessionId: row.appSessionId,
      goal,
    })
  }
  return rows
}

export function selectThreadGoalSnapshot(
  state: GoalMemoryState,
  sessionId: SessionId | null,
): ThreadGoalSnapshot | null {
  const snapshot = sessionId ? state.goals[sessionId] : undefined
  return snapshot ?? null
}

export function selectMemoryInstructionCounts(snapshot: MemorySnapshot | null): {
  total: number
  managed: number
  user: number
  project: number
  local: number
  autoMem: number
  teamMem: number
} {
  const counts = {
    total: 0,
    managed: 0,
    user: 0,
    project: 0,
    local: 0,
    autoMem: 0,
    teamMem: 0,
  }
  if (!snapshot) return counts
  for (const file of snapshot.instructionFiles) {
    counts.total += 1
    switch (file.type) {
      case 'Managed':
        counts.managed += 1
        break
      case 'User':
        counts.user += 1
        break
      case 'Project':
        counts.project += 1
        break
      case 'Local':
        counts.local += 1
        break
      case 'AutoMem':
        counts.autoMem += 1
        break
      case 'TeamMem':
        counts.teamMem += 1
        break
    }
  }
  return counts
}

export function selectInstructionFilesByType(
  snapshot: MemorySnapshot | null,
): Array<{ type: MemoryInstructionFile['type']; files: MemoryInstructionFile[] }> {
  if (!snapshot) return []
  const groups = new Map<MemoryInstructionFile['type'], MemoryInstructionFile[]>()
  for (const file of snapshot.instructionFiles) {
    const group = groups.get(file.type)
    if (group) group.push(file)
    else groups.set(file.type, [file])
  }
  return [...groups.entries()].map(([type, files]) => ({ type, files }))
}
