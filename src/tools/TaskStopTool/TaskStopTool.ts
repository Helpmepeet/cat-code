import { z } from 'zod/v4'
import type { TaskStateBase } from '../../Task.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { stopTask } from '../../tasks/stopTask.js'
import { getSessionId } from '../../bootstrap/state.js'
import { assertCodeModeTaskAccess } from '../../tasks/CodeModeTask.js'
import { getInterruptedToolRun } from '../../services/tools/interruptedToolRun.js'
import { getAgentLifecycleCompletion } from '../AgentTool/agentLifecycleOwnership.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { DESCRIPTION, TASK_STOP_TOOL_NAME } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    task_id: z
      .string()
      .optional()
      .describe('The ID of the background task to stop'),
    // shell_id is accepted for backward compatibility with the deprecated KillShell tool
    shell_id: z.string().optional().describe('Deprecated: use task_id instead'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    message: z.string().describe('Status message about the operation'),
    task_id: z.string().describe('The ID of the task that was stopped'),
    task_type: z.string().describe('The type of the task that was stopped'),
    // Optional: tool outputs are persisted to transcripts and replayed on --resume
    // without re-validation, so sessions from before this field was added lack it.
    command: z
      .string()
      .optional()
      .describe('The command or description of the stopped task'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

async function waitForStoppedAgent(id: string, lifecycle: Promise<void>, signal: AbortSignal): Promise<void> {
  const receipts = getInterruptedToolRun(getSessionId(), id)
  let finalized = false
  let unsubscribe: (() => void) | undefined
  let check: () => void = () => {}
  try {
    await new Promise<void>(resolve => {
      check = () => {
        if (signal.aborted || receipts.waitingForRetry || (finalized && !receipts.ownPending)) resolve()
      }
      unsubscribe = receipts.subscribe(check)
      signal.addEventListener('abort', check, { once: true })
      void lifecycle.then(() => { finalized = true; check() })
      check()
    })
  } finally {
    unsubscribe?.()
    signal.removeEventListener('abort', check)
  }
}

export const TaskStopTool = buildTool({
  name: TASK_STOP_TOOL_NAME,
  searchHint: 'kill a running background task',
  // KillShell is the deprecated name - kept as alias for backward compatibility
  // with existing transcripts and SDK users
  aliases: ['KillShell'],
  maxResultSizeChars: 100_000,
  userFacingName: () => (process.env.USER_TYPE === 'ant' ? '' : 'Stop Task'),
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  shouldDefer: true,
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.task_id ?? input.shell_id ?? ''
  },
  async validateInput({ task_id, shell_id }, { getAppState }) {
    // Support both task_id and shell_id (deprecated KillShell compat)
    const id = task_id ?? shell_id
    if (!id) {
      return {
        result: false,
        message: 'Missing required parameter: task_id',
        errorCode: 1,
      }
    }

    const appState = getAppState()
    const task = appState.tasks?.[id] as TaskStateBase | undefined

    if (!task) {
      return {
        result: false,
        message: `No task found with ID: ${id}`,
        errorCode: 1,
      }
    }

    if (task.status !== 'running') {
      return {
        result: false,
        message: `Task ${id} is not running (status: ${task.status})`,
        errorCode: 3,
      }
    }

    return { result: true }
  },
  async description() {
    return `Stop a running background task by ID`
  },
  async prompt() {
    return DESCRIPTION
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(output),
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  async call(
    { task_id, shell_id },
    { getAppState, setAppState, abortController, agentId },
  ) {
    // Support both task_id and shell_id (deprecated KillShell compat)
    const id = task_id ?? shell_id
    if (!id) {
      throw new Error('Missing required parameter: task_id')
    }

    const task = getAppState().tasks[id]
    if (task) assertCodeModeTaskAccess(task, getSessionId(), agentId)
    const lifecycle = task?.type === 'local_agent' ? getAgentLifecycleCompletion(id) : undefined
    const result = await stopTask(id, {
      getAppState,
      setAppState,
    })
    // A worker writes to its own transcript. Let it publish the stopped
    // report and settle its receipts before the parent reaches model admission.
    if (lifecycle) await waitForStoppedAgent(id, lifecycle, abortController.signal)

    return {
      data: {
        message: result.taskType === 'code_mode'
          ? `Cancellation requested for task: ${result.taskId}. Await task output for settlement.`
          : `Successfully stopped task: ${result.taskId} (${result.command})`,
        task_id: result.taskId,
        task_type: result.taskType,
        command: result.command,
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
