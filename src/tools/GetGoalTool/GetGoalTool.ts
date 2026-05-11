import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  buildThreadGoalToolResponse,
  type ThreadGoalToolResponse,
} from '../../utils/threadGoal.js'

const inputSchema = lazySchema(() => z.strictObject({}))

type InputSchema = ReturnType<typeof inputSchema>

type Output = ThreadGoalToolResponse

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
    return 'Get the current goal for this thread, including status, budgets, token and elapsed-time usage, and remaining token budget.'
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
    return {
      data: buildThreadGoalToolResponse(context.getAppState().threadGoal),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
