import { z } from 'zod/v4'
import { getSessionId } from '../../bootstrap/state.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { isAgentMode } from '../../agent-mode/agentMode.js'
import {
  markWorkerResultSynthesized,
  readSessionState,
  resolveWorkerAgentId,
} from '../../agent-mode/sessionState.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getTaskOutput } from '../../utils/task/diskOutput.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { GET_WORKER_RESULT_TOOL_NAME } from './constants.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    worker: z.string().describe('Worker handle or agent ID'),
    markSynthesized: z
      .boolean()
      .default(false)
      .describe('Mark this result as synthesized after reading'),
  }),
)

type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

export const GetWorkerResultTool = buildTool({
  name: GET_WORKER_RESULT_TOOL_NAME,
  searchHint: 'read an Agent Mode worker result',
  maxResultSizeChars: 100_000,
  userFacingName: () => '',
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  isEnabled() {
    return isAgentMode()
  },
  isReadOnly(input) {
    return !input.markSynthesized
  },
  async description() {
    return 'Read a worker output by handle or agentId and optionally mark it synthesized'
  },
  async prompt() {
    return 'Read a completed Agent Mode worker result before synthesizing it into the main objective.'
  },
  async call(input: Input) {
    const sessionId = getSessionId()
    const agentId = await resolveWorkerAgentId(sessionId, input.worker)
    if (!agentId) {
      throw new Error(`No Agent Mode worker found for: ${input.worker}`)
    }

    const output = await getTaskOutput(agentId)
    const hasOutput = output.length > 0
    const state = await readSessionState(sessionId)
    const worker = state?.knownWorkers.find(item => item.agentId === agentId)
    const canMark =
      input.markSynthesized &&
      (hasOutput ||
        (worker?.status === 'completed' && worker.lastResultSummary !== undefined))
    const synthesized = canMark
      ? await markWorkerResultSynthesized({ sessionId, agentId })
      : false

    return {
      data: {
        worker: input.worker,
        agentId,
        output,
        hasOutput,
        synthesized,
        reason:
          !input.markSynthesized
            ? undefined
            : !canMark
              ? 'No output available for this worker'
              : !synthesized
                ? 'Worker result was not ready to be marked synthesized'
                : undefined,
      },
    }
  },
  mapToolResultToToolResultBlockParam(data, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(data),
    }
  },
} satisfies ToolDef<InputSchema, unknown>)
