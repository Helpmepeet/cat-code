import type {
  MemoryInstructionFile,
  MemorySnapshot,
  ServerFrame,
  SessionId,
  ThreadGoalSnapshot,
} from '../../shared/protocol.js'

export type GoalMemoryState = {
  goals: Record<SessionId, ThreadGoalSnapshot | null>
  memory: Record<SessionId, MemorySnapshot | null>
}

export type GoalMemoryAction = { type: 'frame'; frame: ServerFrame }

export function createGoalMemoryState(): GoalMemoryState {
  return { goals: {}, memory: {} }
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

  if (frame.kind === 'memory.snapshot') {
    return {
      ...state,
      memory: { ...state.memory, [frame.sessionId]: frame.memory },
    }
  }

  if (frame.kind === 'lifecycle') {
    if (!(frame.sessionId in state.goals) && !(frame.sessionId in state.memory)) {
      return state
    }
    const nextGoals = { ...state.goals, [frame.sessionId]: null }
    const nextMemory = { ...state.memory, [frame.sessionId]: null }
    return { goals: nextGoals, memory: nextMemory }
  }

  return state
}

export function selectThreadGoalSnapshot(
  state: GoalMemoryState,
  sessionId: SessionId | null,
): ThreadGoalSnapshot | null {
  const snapshot = sessionId ? state.goals[sessionId] : undefined
  return snapshot ?? null
}

export function selectMemorySnapshot(
  state: GoalMemoryState,
  sessionId: SessionId | null,
): MemorySnapshot | null {
  const snapshot = sessionId ? state.memory[sessionId] : undefined
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
