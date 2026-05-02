import type { LocalJSXCommandCall } from '../../types/command.js'
import {
  formatThreadGoalSummary,
  getThreadGoalUsageText,
  parseGoalCommand,
} from '../../utils/threadGoal.js'
import {
  buildGoalMetaMessage,
  clearThreadGoalAction,
  createThreadGoalAction,
  updateThreadGoalStatusAction,
} from '../../utils/threadGoalActions.js'

const GOAL_EXISTS_MESSAGE =
  'A goal already exists. Run /goal replace <objective> to replace it, or /goal clear first.'
const NO_GOAL_MESSAGE = 'No goal is currently set.'
const GOAL_QUERY_ACTIVE_MESSAGE =
  'Cannot set a new goal while a turn is running. Stop or wait first.'

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const parsed = parseGoalCommand(args)

  if (parsed.type === 'error') {
    onDone(parsed.message, { display: 'system' })
    return null
  }

  const currentGoal = context.getAppState().threadGoal

  if (parsed.type === 'show') {
    onDone(
      currentGoal
        ? formatThreadGoalSummary(currentGoal)
        : `${getThreadGoalUsageText()}\n\n${NO_GOAL_MESSAGE}`,
      { display: 'system' },
    )
    return null
  }

  if (parsed.type === 'clear') {
    if (!currentGoal) {
      onDone(NO_GOAL_MESSAGE, { display: 'system' })
      return null
    }

    await clearThreadGoalAction({ context, goal: currentGoal })
    onDone('Cleared current goal.', {
      display: 'system',
      metaMessages: [
        '<system-reminder>\nThe current thread goal was cleared. There is no active thread goal now.\n</system-reminder>',
      ],
    })
    return null
  }

  if (parsed.type === 'pause') {
    if (!currentGoal) {
      onDone(NO_GOAL_MESSAGE, { display: 'system' })
      return null
    }
    if (currentGoal.status !== 'active') {
      onDone('Only active goals can be paused.', { display: 'system' })
      return null
    }

    const nextGoal = await updateThreadGoalStatusAction({
      context,
      goal: currentGoal,
      status: 'paused',
      objective: currentGoal.objective,
    })
    onDone(formatThreadGoalSummary(nextGoal), {
      display: 'system',
      metaMessages: [buildGoalMetaMessage(nextGoal)],
    })
    return null
  }

  if (parsed.type === 'resume') {
    if (!currentGoal) {
      onDone(NO_GOAL_MESSAGE, { display: 'system' })
      return null
    }
    if (currentGoal.status !== 'paused') {
      onDone('Only paused goals can be resumed.', { display: 'system' })
      return null
    }

    const nextGoal = await updateThreadGoalStatusAction({
      context,
      goal: currentGoal,
      status: 'active',
      objective: currentGoal.objective,
    })
    onDone(formatThreadGoalSummary(nextGoal), {
      display: 'system',
      metaMessages: [buildGoalMetaMessage(nextGoal)],
    })
    return null
  }

  if (
    (parsed.type === 'set' || parsed.type === 'replace') &&
    context.isQueryActive
  ) {
    onDone(GOAL_QUERY_ACTIVE_MESSAGE, { display: 'system' })
    return null
  }

  if (parsed.type === 'replace') {
    const nextGoal = await createThreadGoalAction({
      context,
      objective: parsed.objective,
      tokenBudget: parsed.tokenBudget,
      resetWorkers: true,
    })
    onDone(formatThreadGoalSummary(nextGoal), {
      display: 'system',
      metaMessages: [buildGoalMetaMessage(nextGoal)],
    })
    return null
  }

  if (currentGoal && currentGoal.status !== 'complete') {
    onDone(GOAL_EXISTS_MESSAGE, { display: 'system' })
    return null
  }

  const nextGoal = await createThreadGoalAction({
    context,
    objective: parsed.objective,
    tokenBudget: parsed.tokenBudget,
    resetWorkers: true,
  })
  onDone(formatThreadGoalSummary(nextGoal), {
    display: 'system',
    metaMessages: [buildGoalMetaMessage(nextGoal)],
  })
  return null
}
