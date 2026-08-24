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
import { isResumableThreadGoalStatus } from '../../utils/threadGoalState.js'

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
    if (currentGoal.status !== 'active' && currentGoal.status !== 'waiting') {
      // Already stopped, so the summary alone answers what the user asked.
      onDone(formatThreadGoalSummary(currentGoal), { display: 'system' })
      return null
    }

    const paused = await updateThreadGoalStatusAction({
      context,
      goal: currentGoal,
      status: 'paused',
      reason: 'user_paused',
      actor: 'user',
      objective: currentGoal.objective,
    })
    if (!paused.ok) {
      onDone('Could not pause this goal.', { display: 'system' })
      return null
    }
    onDone(formatThreadGoalSummary(paused.goal), { display: 'system' })
    return null
  }

  if (parsed.type === 'resume') {
    if (!currentGoal) {
      onDone(NO_GOAL_MESSAGE, { display: 'system' })
      return null
    }
    // Every stopped status resumes, not just paused: a goal that stalled, hit
    // its budget, or failed is exactly the goal a user wants to restart, and
    // resume opens a fresh continuation window.
    if (!isResumableThreadGoalStatus(currentGoal.status)) {
      onDone(
        currentGoal.status === 'complete'
          ? 'This goal is already complete. Use /goal clear or /goal replace <objective>.'
          : 'This goal is already running.',
        { display: 'system' },
      )
      return null
    }

    const resumed = await updateThreadGoalStatusAction({
      context,
      goal: currentGoal,
      status: 'active',
      reason: 'user_resumed',
      actor: 'user',
      objective: currentGoal.objective,
    })
    if (!resumed.ok) {
      onDone('Could not resume this goal.', { display: 'system' })
      return null
    }
    onDone(formatThreadGoalSummary(resumed.goal), { display: 'system' })
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
