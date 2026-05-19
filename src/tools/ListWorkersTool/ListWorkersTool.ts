import { z } from 'zod/v4'
import { getSessionId } from '../../bootstrap/state.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { isAgentMode } from '../../agent-mode/agentMode.js'
import { readSessionStateWithContinuity } from '../../agent-mode/sessionState.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { LIST_WORKERS_TOOL_NAME } from './constants.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    activeOnly: z.boolean().optional().describe('Only return running workers'),
    resumableOnly: z
      .boolean()
      .optional()
      .describe('Only return resumable workers'),
  }),
)

type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

export const ListWorkersTool = buildTool({
  name: LIST_WORKERS_TOOL_NAME,
  searchHint: 'list Agent Mode worker sessions',
  maxResultSizeChars: 100_000,
  userFacingName: () => '',
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  isEnabled() {
    return isAgentMode()
  },
  isReadOnly() {
    return true
  },
  async description() {
    return 'List known Agent Mode worker sessions and their status'
  },
  async prompt() {
    return 'List known Agent Mode workers, including handle, agentId, role, status, resumability, and synthesis status.'
  },
  async call(input: Input) {
    const state = await readSessionStateWithContinuity(getSessionId())
    const workers = state?.knownWorkers ?? []
    const filtered = workers.filter(worker => {
      if (input.activeOnly && worker.status !== 'running') return false
      if (input.resumableOnly && !worker.resumable) return false
      return true
    })

    return {
      data: {
        objective: state?.objective ?? '',
        currentPhase: state?.currentPhase ?? 'planning',
        nextAction: state?.nextAction ?? '',
        workers: filtered,
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
