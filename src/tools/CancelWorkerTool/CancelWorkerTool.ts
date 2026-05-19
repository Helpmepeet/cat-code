import { z } from 'zod/v4'
import { getSessionId } from '../../bootstrap/state.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { isAgentMode } from '../../agent-mode/agentMode.js'
import { resolveWorkerAgentId } from '../../agent-mode/sessionState.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { StopTaskError, stopTask } from '../../tasks/stopTask.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { CANCEL_WORKER_TOOL_NAME } from './constants.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    worker: z.string().describe('Worker handle or agent ID'),
    reason: z.string().optional().describe('Short reason for cancellation'),
  }),
)

type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

export const CancelWorkerTool = buildTool({
  name: CANCEL_WORKER_TOOL_NAME,
  searchHint: 'cancel a running Agent Mode worker',
  maxResultSizeChars: 100_000,
  userFacingName: () => '',
  shouldDefer: true,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  isEnabled() {
    return isAgentMode()
  },
  isReadOnly() {
    return false
  },
  async description() {
    return 'Stop a running Agent Mode worker by handle or ID'
  },
  async prompt() {
    return 'Stop a running Agent Mode worker before it continues consuming resources.'
  },
  mapToolResultToToolResultBlockParam(data, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(data),
    }
  },
  async call(input: Input, context) {
    const sessionId = getSessionId()
    const agentId = await resolveWorkerAgentId(sessionId, input.worker)
    if (!agentId) {
      throw new Error(`No Agent Mode worker found for: ${input.worker}`)
    }

    const result = await stopTask(agentId, {
      getAppState: context.getAppState,
      setAppState: context.setAppState,
    }).catch(error => {
      if (error instanceof StopTaskError &&
          (error.code === 'not_running' || error.code === 'not_found')) {
        return {
          stopped: false as const,
          error: error.message,
          code: error.code,
        }
      }
      throw error
    })

    if ('stopped' in result) {
      return {
        data: {
          worker: input.worker,
          agentId,
          reason: input.reason,
          stopped: false,
          code: result.code,
          message: result.error,
        },
      }
    }

    return {
      data: {
        worker: input.worker,
        agentId,
        reason: input.reason,
        stopped: {
          taskId: result.taskId,
          taskType: result.taskType,
          command: result.command,
        },
      },
    }
  },
} satisfies ToolDef<InputSchema, unknown>)
