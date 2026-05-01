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
}

function validateGoalUpdate(input: {
  status: 'complete'
  goalId?: string
}): ValidationResult {
  void input.status
  return { result: true }
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
      'Use this only after verifying that the active thread goal is actually achieved.',
      'The only valid status is "complete".',
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
    saveThreadGoal(nextGoal)
    context.setAppState(prev => ({ ...prev, threadGoal: nextGoal }))

    return {
      data: {
        message: 'Thread goal marked complete.',
        goalId: nextGoal.goalId,
        status: 'complete',
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
