import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import type { ThreadGoal } from '../../utils/threadGoal.js'

const inputSchema = lazySchema(() => z.strictObject({}))

type InputSchema = ReturnType<typeof inputSchema>

type Output = {
  goal: ThreadGoal | null
  remainingTokens?: number
}

export const GetGoalTool = buildTool({
  name: 'GetGoal',
  aliases: ['get_goal'],
  maxResultSizeChars: 100_000,

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  isReadOnly() {
    return true
  },

  async description() {
    return 'Get the current thread goal, including status, context-token budget, context-token usage, elapsed time, and remaining context-token budget.'
  },

  async prompt() {
    return 'Use this to inspect the current thread goal. This tool is read-only and cannot create, pause, resume, clear, or complete a goal.'
  },

  async validateInput() {
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
    const goal = context.getAppState().threadGoal
    const remainingTokens =
      goal?.tokenBudget === undefined
        ? undefined
        : Math.max(0, goal.tokenBudget - goal.tokensUsed)

    return {
      data: {
        goal,
        ...(remainingTokens !== undefined ? { remainingTokens } : {}),
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
