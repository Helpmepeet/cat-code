import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ValidationResult } from '../../Tool.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { saveThreadGoal } from '../../utils/sessionStorage.js'
import { updateThreadGoalStatus } from '../../utils/threadGoal.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    status: z.literal('complete'),
    goalId: z.string().optional(),
  }),
)

type InputSchema = ReturnType<typeof inputSchema>

type Output = {
  message: string
  goalId: string
  status: 'complete'
  objective: string
  tokensUsed: number
  timeUsedSeconds: number
  tokenBudget?: number
  remainingTokens?: number
  completionBudgetReport?: string
}

function validateGoalUpdate(input: {
  status: 'complete'
  goalId?: string
}): ValidationResult {
  void input.status
  return { result: true }
}

function buildCompletionBudgetReport(goal: {
  tokenBudget?: number
  tokensUsed: number
  timeUsedSeconds: number
}): string | undefined {
  const parts: string[] = []

  if (goal.tokenBudget !== undefined) {
    parts.push(`tokens used: ${goal.tokensUsed} of ${goal.tokenBudget}`)
  }

  if (goal.timeUsedSeconds > 0) {
    parts.push(`time used: ${goal.timeUsedSeconds} seconds`)
  }

  return parts.length
    ? `Goal achieved. Report final budget usage to the user: ${parts.join('; ')}.`
    : undefined
}

export const UpdateGoalTool = buildTool({
  name: 'UpdateGoal',
  aliases: ['update_goal'],
  maxResultSizeChars: 100_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  isReadOnly() {
    return false
  },
  async description() {
    return 'Mark the current thread goal complete after verifying it is achieved'
  },
  async prompt() {
    return [
      'Update the existing thread goal.',
      'Use this tool only to mark the goal achieved.',
      'The only valid status is "complete".',
      'Set status to "complete" only when the objective has actually been achieved and no required work remains.',
      'Do not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work.',
      'You cannot use this tool to pause, resume, clear, or budget-limit a goal; those status changes are controlled by the user or runtime.',
      'When marking a budgeted goal complete, report the final token usage and elapsed time from the tool result to the user.',
    ].join('\n')
  },
  async validateInput(input, context) {
    const schemaCheck = validateGoalUpdate(input)
    if (!schemaCheck.result) {
      return schemaCheck
    }

    const currentGoal = context.getAppState().threadGoal
    if (!currentGoal) {
      return {
        result: false,
        message: 'No current thread goal exists.',
        errorCode: 1,
      }
    }
    if (input.goalId && input.goalId !== currentGoal.goalId) {
      return {
        result: false,
        message: `Goal ID ${input.goalId} is stale. Current goal ID is ${currentGoal.goalId}.`,
        errorCode: 2,
      }
    }
    if (currentGoal.status === 'paused') {
      return {
        result: false,
        message: 'Paused goals cannot be marked complete.',
        errorCode: 3,
      }
    }
    if (currentGoal.status === 'complete') {
      return {
        result: false,
        message: 'The current thread goal is already complete.',
        errorCode: 4,
      }
    }
    if (
      currentGoal.status !== 'active' &&
      currentGoal.status !== 'budget_limited'
    ) {
      return {
        result: false,
        message: `Goals with status ${currentGoal.status} cannot be marked complete.`,
        errorCode: 5,
      }
    }

    return { result: true }
  },
  renderToolUseMessage() {
    return null
  },
  renderToolResultMessage() {
    return null
  },
  renderToolUseErrorMessage() {
    return null
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(output),
    }
  },
  async call(_input, context) {
    const currentGoal = context.getAppState().threadGoal
    if (!currentGoal) {
      throw new Error('No current thread goal exists.')
    }

    const nextGoal = updateThreadGoalStatus(currentGoal, 'complete')
    const remainingTokens =
      nextGoal.tokenBudget === undefined
        ? undefined
        : Math.max(0, nextGoal.tokenBudget - nextGoal.tokensUsed)
    const completionBudgetReport = buildCompletionBudgetReport(nextGoal)

    saveThreadGoal(nextGoal)
    context.setAppState(prev => ({ ...prev, threadGoal: nextGoal }))

    return {
      data: {
        message: 'Thread goal marked complete.',
        goalId: nextGoal.goalId,
        status: 'complete',
        objective: nextGoal.objective,
        tokensUsed: nextGoal.tokensUsed,
        timeUsedSeconds: nextGoal.timeUsedSeconds,
        ...(nextGoal.tokenBudget !== undefined
          ? { tokenBudget: nextGoal.tokenBudget }
          : {}),
        ...(remainingTokens !== undefined ? { remainingTokens } : {}),
        ...(completionBudgetReport ? { completionBudgetReport } : {}),
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
