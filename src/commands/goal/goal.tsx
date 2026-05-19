import * as React from 'react'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Select } from '../../components/CustomSelect/select.js'
import type {
  LocalJSXCommandCall,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import {
  formatThreadGoalSummary,
  getThreadGoalUsageText,
  parseGoalCommand,
} from '../../utils/threadGoal.js'
import {
  clearThreadGoalAction,
  createThreadGoalAction,
  updateThreadGoalStatusAction,
} from '../../utils/threadGoalActions.js'

const NO_GOAL_MESSAGE = 'No goal is currently set.'

type GoalCommandContext = Parameters<LocalJSXCommandCall>[1]

type ReplaceGoalConfirmationProps = {
  onDone: LocalJSXCommandOnDone
  context: GoalCommandContext
  objective: string
  tokenBudget?: number
}

function ReplaceGoalConfirmation({
  onDone,
  context,
  objective,
  tokenBudget,
}: ReplaceGoalConfirmationProps): React.ReactNode {
  const cancel = () => {
    onDone(undefined, { display: 'skip' })
  }

  const choose = async (choice: 'replace' | 'cancel') => {
    if (choice === 'cancel') {
      cancel()
      return
    }

    const nextGoal = await createThreadGoalAction({
      context,
      objective,
      tokenBudget,
      resetWorkers: true,
    })
    onDone(formatThreadGoalSummary(nextGoal), { display: 'system' })
  }

  return (
    <Dialog
      title="Replace goal?"
      subtitle={`New objective: ${objective}`}
      onCancel={cancel}
    >
      <Select
        defaultFocusValue="replace"
        options={[
          {
            value: 'replace' as const,
            label: 'Replace current goal',
            description: 'Set the new objective and start it now',
          },
          {
            value: 'cancel' as const,
            label: 'Cancel',
            description: 'Keep the current goal',
          },
        ]}
        onChange={choose}
        onCancel={cancel}
      />
    </Dialog>
  )
}

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
    onDone('Cleared current goal.', { display: 'system' })
    return null
  }

  if (parsed.type === 'pause') {
    if (!currentGoal) {
      onDone(NO_GOAL_MESSAGE, { display: 'system' })
      return null
    }
    if (currentGoal.status === 'budget_limited') {
      onDone(formatThreadGoalSummary(currentGoal), { display: 'system' })
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
    onDone(formatThreadGoalSummary(nextGoal), { display: 'system' })
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
    onDone(formatThreadGoalSummary(nextGoal), { display: 'system' })
    return null
  }

  if (parsed.type === 'replace') {
    const nextGoal = await createThreadGoalAction({
      context,
      objective: parsed.objective,
      tokenBudget: parsed.tokenBudget,
      resetWorkers: true,
    })
    onDone(formatThreadGoalSummary(nextGoal), { display: 'system' })
    return null
  }

  if (currentGoal && currentGoal.status !== 'complete') {
    return (
      <ReplaceGoalConfirmation
        onDone={onDone}
        context={context}
        objective={parsed.objective}
        tokenBudget={parsed.tokenBudget}
      />
    )
  }

  const nextGoal = await createThreadGoalAction({
    context,
    objective: parsed.objective,
    tokenBudget: parsed.tokenBudget,
    resetWorkers: true,
  })
  onDone(formatThreadGoalSummary(nextGoal), { display: 'system' })
  return null
}
