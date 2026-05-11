import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ValidationResult } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { createThreadGoalAction } from '../../utils/threadGoalActions.js'
import {
  buildThreadGoalToolResponse,
  MAX_GOAL_OBJECTIVE_CHARS,
  type ThreadGoalToolResponse,
} from '../../utils/threadGoal.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    objective: z.string().trim().min(1).max(MAX_GOAL_OBJECTIVE_CHARS),
    token_budget: z.number().int().positive().optional(),
  }),
)

type InputSchema = ReturnType<typeof inputSchema>

type Output = ThreadGoalToolResponse

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
    return [
      'Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks.',
      'Set token_budget only when an explicit token budget is requested. Fails if a goal exists; use update_goal only for status.',
    ].join('\n')
  },
  async prompt() {
    return [
      'Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks.',
      'Set token_budget only when an explicit token budget is requested. Fails if a goal exists; use update_goal only for status.',
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
      tokenBudget: input.token_budget,
      resetWorkers: true,
    })

    return {
      data: buildThreadGoalToolResponse(nextGoal),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
