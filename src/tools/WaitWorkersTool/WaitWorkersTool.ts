import { z } from 'zod/v4'
import { getSessionId } from '../../bootstrap/state.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { isAgentMode } from '../../agent-mode/agentMode.js'
import {
  type AgentModeWorkerSessionStatus,
  readSessionState,
  resolveWorkerAgentId,
} from '../../agent-mode/sessionState.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { sleep } from '../../utils/sleep.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import type { TaskState } from '../../tasks/types.js'
import { WAIT_WORKERS_TOOL_NAME } from './constants.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    workers: z
      .array(z.string())
      .min(1)
      .describe('Worker handles or agent IDs to wait for'),
    timeout: z
      .number()
      .min(0)
      .max(600000)
      .default(30000)
      .describe('Max wait time in ms'),
  }),
)

type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

export const WaitWorkersTool = buildTool({
  name: WAIT_WORKERS_TOOL_NAME,
  searchHint: 'wait for Agent Mode workers to finish',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  userFacingName: () => '',
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  isReadOnly() {
    return true
  },
  isEnabled() {
    return isAgentMode()
  },
  async description() {
    return 'Wait for selected Agent Mode workers to reach a terminal status'
  },
  async prompt() {
    return 'Wait for one or more Agent Mode workers by handle or agentId before synthesizing their results.'
  },
  async call(input: Input, context) {
    const sessionId = getSessionId()
    const resolved = await Promise.all(
      input.workers.map(async target => ({
        target,
        agentId: await resolveWorkerAgentId(sessionId, target),
      })),
    )
    const missing = resolved
      .filter(item => !item.agentId)
      .map(item => item.target)
    const agentIds = resolved.flatMap(item => (item.agentId ? [item.agentId] : []))
    if (agentIds.length === 0) {
      return {
        data: {
          status: 'missing',
          missing,
          workers: [],
        },
      }
    }
    const start = Date.now()

    const isTerminal = (status: string): boolean => {
      return status === 'completed' || status === 'failed' || status === 'killed'
    }

    while (Date.now() - start < input.timeout) {
      const tasks = context.getAppState().tasks ?? {}
      const sessionState = await readSessionState(sessionId)
      const durableWorkerStatus = new Map(
        sessionState?.knownWorkers.map(worker => [
          worker.agentId,
          worker.status as AgentModeWorkerSessionStatus,
        ]),
      )
      const statuses = agentIds.map(agentId => {
        const task = tasks[agentId] as TaskState | undefined
        const status =
          task?.status ??
          durableWorkerStatus.get(agentId) ??
          ('not_in_memory' as const)
        return {
          agentId,
          status,
          description: task?.description ?? '',
        }
      })

      if (statuses.every(item => isTerminal(item.status))) {
        return {
          data: {
            status: 'complete',
            missing,
            workers: statuses,
          },
        }
      }

      await sleep(100)
    }

    const tasks = context.getAppState().tasks ?? {}
    const sessionState = await readSessionState(sessionId)
    const durableWorkerStatus = new Map(
      sessionState?.knownWorkers.map(worker => [
        worker.agentId,
        worker.status as AgentModeWorkerSessionStatus,
      ]),
    )

    return {
      data: {
        status: 'timeout',
        missing,
        workers: agentIds.map(agentId => {
          const task = tasks[agentId] as TaskState | undefined
          const status =
            task?.status ?? durableWorkerStatus.get(agentId) ?? ('not_in_memory' as const)
          return {
            agentId,
            status,
            description: task?.description ?? '',
          }
        }),
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
