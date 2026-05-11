import type { UUID } from 'crypto'
import { getSessionId } from '../bootstrap/state.js'
import { updateSessionObjective } from '../agent-mode/sessionState.js'
import { clearThreadGoal, saveThreadGoal } from './sessionStorage.js'
import {
  createThreadGoal,
  type ThreadGoal,
  type ThreadGoalStatus,
  updateThreadGoalStatus,
} from './threadGoal.js'

export type ThreadGoalState = {
  threadGoal: ThreadGoal | null
}

export type ThreadGoalActionContext<
  TState extends ThreadGoalState = ThreadGoalState,
> = {
  getAppState(): TState
  setAppState(updater: (prev: TState) => TState): void
}

export async function createThreadGoalAction<
  TState extends ThreadGoalState = ThreadGoalState,
>({
  context,
  objective,
  tokenBudget,
  resetWorkers = true,
  nowMs,
}: {
  context: ThreadGoalActionContext<TState>
  objective: string
  tokenBudget?: number
  resetWorkers?: boolean
  nowMs?: number
}): Promise<ThreadGoal> {
  const nextGoal = createThreadGoal(
    getSessionId() as UUID,
    objective,
    tokenBudget,
    nowMs,
  )

  saveThreadGoal(nextGoal)
  await updateSessionObjective({
    sessionId: nextGoal.threadId,
    objective: nextGoal.objective,
    resetWorkers,
  })
  context.setAppState(prev => ({ ...prev, threadGoal: nextGoal }))

  return nextGoal
}

export async function clearThreadGoalAction<
  TState extends ThreadGoalState = ThreadGoalState,
>({
  context,
  goal,
}: {
  context: ThreadGoalActionContext<TState>
  goal: ThreadGoal
}): Promise<void> {
  clearThreadGoal(goal.goalId)
  await updateSessionObjective({
    sessionId: getSessionId(),
    objective: '',
    resetWorkers: true,
  })
  context.setAppState(prev => ({ ...prev, threadGoal: null }))
}

export async function updateThreadGoalStatusAction<
  TState extends ThreadGoalState = ThreadGoalState,
>({
  context,
  goal,
  status,
  objective,
  resetWorkers = false,
}: {
  context: ThreadGoalActionContext<TState>
  goal: ThreadGoal
  status: ThreadGoalStatus
  objective: string
  resetWorkers?: boolean
}): Promise<ThreadGoal> {
  const nextGoal = updateThreadGoalStatus(goal, status)

  saveThreadGoal(nextGoal)
  await updateSessionObjective({
    sessionId: nextGoal.threadId,
    objective,
    resetWorkers,
  })
  context.setAppState(prev => ({ ...prev, threadGoal: nextGoal }))

  return nextGoal
}

export async function completeThreadGoalAction<
  TState extends ThreadGoalState = ThreadGoalState,
>({
  context,
  goal,
}: {
  context: ThreadGoalActionContext<TState>
  goal: ThreadGoal
}): Promise<ThreadGoal> {
  return updateThreadGoalStatusAction({
    context,
    goal,
    status: 'complete',
    objective: '',
    resetWorkers: true,
  })
}
