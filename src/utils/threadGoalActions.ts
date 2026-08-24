import type { UUID } from 'crypto'
import { getSessionId } from '../bootstrap/state.js'
import { updateSessionObjective } from '../agent-mode/sessionState.js'
import { clearThreadGoal, saveThreadGoal } from './sessionStorage.js'
import {
  createThreadGoal,
  type ThreadGoal,
  type ThreadGoalStatus,
  type ThreadGoalStatusReason,
  updateThreadGoalStatus,
} from './threadGoal.js'
import {
  checkThreadGoalTransition,
  type ThreadGoalActor,
} from './threadGoalState.js'

export type ThreadGoalState = {
  threadGoal: ThreadGoal | null
}

export type ThreadGoalActionContext<
  TState extends ThreadGoalState = ThreadGoalState,
> = {
  getAppState(): TState
  setAppState(updater: (prev: TState) => TState): void
}

/**
 * Outcome of an attempted durable transition.
 *
 * Every rejection names WHY, because the callers differ: a tool reports
 * `unauthorized` back to the model, the scheduler treats `stale` as "someone
 * changed the goal under me, abandon this attempt", and `missing` means the
 * goal was cleared mid-flight.
 */
export type ThreadGoalTransitionCode =
  | 'ok'
  | 'missing'
  | 'stale'
  | 'terminal'
  | 'forbidden'
  | 'unauthorized'

/**
 * `code` is present on BOTH outcomes so callers can read it without narrowing.
 * See threadGoalState.ts for why a boolean discriminant is not enough here.
 */
export type ThreadGoalTransitionResult = {
  ok: boolean
  code: ThreadGoalTransitionCode
  goal: ThreadGoal | null
}

/**
 * Read the current goal for compare-and-swap.
 *
 * This reads live session state rather than re-parsing the transcript. Two
 * reasons: every mutation path updates session state synchronously before it
 * returns, so it is the freshest value in the process; and getCurrentThreadGoal
 * parses the ENTIRE session JSONL, which reaches multiple GB, so putting it on
 * every goal mutation would be a serious regression.
 *
 * The scope this therefore fences is in-process staleness: a caller that
 * decided against an older revision cannot commit against a newer one. It does
 * NOT fence two engine processes mutating one session concurrently; that needs
 * the durable lock machinery and is not claimed here.
 */
function readCurrentGoal<TState extends ThreadGoalState>(
  context: ThreadGoalActionContext<TState>,
  goalId: string,
): ThreadGoal | null {
  const current = context.getAppState().threadGoal
  return current && current.goalId === goalId ? current : null
}

/**
 * Apply a status transition under a compare-and-swap precondition.
 *
 * The three checks are ordered so the most specific failure wins:
 *
 * 1. the goal still exists and is the one the caller meant (`missing`);
 * 2. its revision still matches what the caller decided against (`stale`);
 * 3. the transition is legal for this actor (`terminal`/`forbidden`/
 *    `unauthorized`).
 *
 * Together these are what stop a continuation decided before a pause, edit, or
 * clear from committing work against the goal that replaced it.
 */
export async function applyThreadGoalTransition<
  TState extends ThreadGoalState = ThreadGoalState,
>({
  context,
  goalId,
  to,
  reason,
  actor,
  expectedRevision,
  objective,
  resetWorkers = false,
  nowMs,
}: {
  context: ThreadGoalActionContext<TState>
  goalId: string
  to: ThreadGoalStatus
  reason: ThreadGoalStatusReason
  actor: ThreadGoalActor
  /** Omit only for a control action the user just issued against live state. */
  expectedRevision?: number
  objective?: string
  resetWorkers?: boolean
  nowMs?: number
}): Promise<ThreadGoalTransitionResult> {
  const current = readCurrentGoal(context, goalId)
  if (!current) {
    return { ok: false, code: 'missing', goal: null }
  }

  if (expectedRevision !== undefined && current.revision !== expectedRevision) {
    return { ok: false, code: 'stale', goal: current }
  }

  const check = checkThreadGoalTransition({
    from: current.status,
    to,
    actor,
  })
  if (!check.allowed) {
    return { ok: false, code: check.code, goal: current }
  }

  const nextGoal = updateThreadGoalStatus(current, to, reason, nowMs)
  saveThreadGoal(nextGoal)
  await updateSessionObjective({
    sessionId: nextGoal.threadId,
    objective: objective ?? nextGoal.objective,
    resetWorkers,
  })
  context.setAppState(prev => ({ ...prev, threadGoal: nextGoal }))

  return { ok: true, code: 'ok', goal: nextGoal }
}

/**
 * Persist an accounting result produced by accountThreadGoalTurn.
 *
 * Accounting is not a transition request: it is the runtime recording what a
 * finished turn actually cost, and the stop it derives is already authorized
 * by the budget the user set. It still guards on revision so a turn belonging
 * to a replaced goal cannot charge the new one.
 */
export function persistAccountedThreadGoal<
  TState extends ThreadGoalState = ThreadGoalState,
>({
  context,
  accounted,
  expectedRevision,
}: {
  context: ThreadGoalActionContext<TState>
  accounted: ThreadGoal
  expectedRevision: number
}): ThreadGoalTransitionResult {
  const current = readCurrentGoal(context, accounted.goalId)
  if (!current) {
    return { ok: false, code: 'missing', goal: null }
  }
  if (current.revision !== expectedRevision) {
    return { ok: false, code: 'stale', goal: current }
  }

  saveThreadGoal(accounted)
  context.setAppState(prev => ({ ...prev, threadGoal: accounted }))
  return { ok: true, code: 'ok', goal: accounted }
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

/**
 * Direct status write used by user control actions on live state.
 *
 * Kept for `/goal pause|resume`, where the user is acting on exactly the goal
 * the UI is showing and there is no delayed decision to fence. Everything with
 * a gap between decision and write must use applyThreadGoalTransition.
 */
export async function updateThreadGoalStatusAction<
  TState extends ThreadGoalState = ThreadGoalState,
>({
  context,
  goal,
  status,
  reason,
  actor,
  objective,
  resetWorkers = false,
}: {
  context: ThreadGoalActionContext<TState>
  goal: ThreadGoal
  status: ThreadGoalStatus
  reason: ThreadGoalStatusReason
  actor: ThreadGoalActor
  objective: string
  resetWorkers?: boolean
}): Promise<ThreadGoalTransitionResult> {
  const check = checkThreadGoalTransition({
    from: goal.status,
    to: status,
    actor,
  })
  if (!check.allowed) {
    return { ok: false, code: check.code, goal }
  }

  const nextGoal = updateThreadGoalStatus(goal, status, reason)

  saveThreadGoal(nextGoal)
  await updateSessionObjective({
    sessionId: nextGoal.threadId,
    objective,
    resetWorkers,
  })
  context.setAppState(prev => ({ ...prev, threadGoal: nextGoal }))

  return { ok: true, code: 'ok', goal: nextGoal }
}

/**
 * Replace the goal's contract.
 *
 * Editing the contract changes what "done" means, so it bumps the revision and
 * therefore the contract digest: evidence recorded against the previous
 * contract stops counting, which is the correct outcome rather than a
 * green result silently carrying over to a different requirement.
 */
export async function setThreadGoalContractAction<
  TState extends ThreadGoalState = ThreadGoalState,
>({
  context,
  goal,
  contract,
}: {
  context: ThreadGoalActionContext<TState>
  goal: ThreadGoal
  contract: ThreadGoal['contract']
}): Promise<ThreadGoal> {
  const nextGoal: ThreadGoal = {
    ...goal,
    contract,
    revision: goal.revision + 1,
    updatedAtMs: Date.now(),
  }

  saveThreadGoal(nextGoal)
  context.setAppState(prev => ({ ...prev, threadGoal: nextGoal }))
  return nextGoal
}

export async function completeThreadGoalAction<
  TState extends ThreadGoalState = ThreadGoalState,
>({
  context,
  goal,
  expectedRevision,
}: {
  context: ThreadGoalActionContext<TState>
  goal: ThreadGoal
  expectedRevision?: number
}): Promise<ThreadGoalTransitionResult> {
  return applyThreadGoalTransition({
    context,
    goalId: goal.goalId,
    to: 'complete',
    reason: 'agent_reported_complete',
    actor: 'agent',
    expectedRevision: expectedRevision ?? goal.revision,
    objective: '',
    resetWorkers: true,
  })
}
