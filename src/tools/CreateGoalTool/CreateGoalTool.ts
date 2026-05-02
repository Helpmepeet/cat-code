import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ValidationResult } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { createThreadGoalAction } from '../../utils/threadGoalActions.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    objective: z.string().trim().min(1),
    tokenBudget: z.number().int().positive().optional(),
  }),
)

type InputSchema = ReturnType<typeof inputSchema>

type Output = {
  message: string
  goalId: string
  status: 'active'
  objective: string
  tokensUsed: number
  timeUsedSeconds: number
  tokenBudget?: number
  remainingTokens?: number
}

function validateCreateGoalInput(): ValidationResult {
  return { result: true }
}

export const CreateGoalTool = buildTool({
  name: 'CreateGoal',
  aliases: ['create_goal'],
  maxResultSizeChars: 100_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  isReadOnly() {
    return false
  },
  async description() {
    return 'Create a new active thread goal when explicitly requested'
  },
  async prompt() {
    return [
      'Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks.',
      'Set tokenBudget only when an explicit token budget is requested.',
      'This tool fails if a non-complete goal already exists; use UpdateGoal only to mark an existing goal complete.',
    ].join('\n')
  },
  async validateInput(input, context) {
    const schemaCheck = validateCreateGoalInput()
    if (!schemaCheck.result) {
      return schemaCheck
    }

    const currentGoal = context.getAppState().threadGoal
    if (currentGoal && currentGoal.status !== 'complete') {
      return {
        result: false,
        message:
          'A current thread goal already exists. Complete or clear it before creating a new goal.',
        errorCode: 1,
      }
    }

    void input
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
  async call(input, context) {
    const nextGoal = await createThreadGoalAction({
      context,
      objective: input.objective,
      tokenBudget: input.tokenBudget,
      resetWorkers: true,
    })
    const remainingTokens =
      nextGoal.tokenBudget === undefined
        ? undefined
        : Math.max(0, nextGoal.tokenBudget - nextGoal.tokensUsed)

    return {
      data: {
        message: 'Thread goal created.',
        goalId: nextGoal.goalId,
        status: nextGoal.status,
        objective: nextGoal.objective,
        tokensUsed: nextGoal.tokensUsed,
        timeUsedSeconds: nextGoal.timeUsedSeconds,
        ...(nextGoal.tokenBudget !== undefined
          ? { tokenBudget: nextGoal.tokenBudget }
          : {}),
        ...(remainingTokens !== undefined ? { remainingTokens } : {}),
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
