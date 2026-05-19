import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ValidationResult } from '../../Tool.js'
import { getSessionId } from '../../bootstrap/state.js'
import { readSessionState } from '../../agent-mode/sessionState.js'
import { completeThreadGoalAction } from '../../utils/threadGoalActions.js'
import {
  buildThreadGoalToolResponse,
  type ThreadGoalToolResponse,
} from '../../utils/threadGoal.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { lazySchema } from '../../utils/lazySchema.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    status: z.literal('complete'),
  }),
)

type InputSchema = ReturnType<typeof inputSchema>

type Output = ThreadGoalToolResponse

function validateGoalUpdate(input: {
  status: 'complete'
}): ValidationResult {
  void input.status
  return { result: true }
}

function describeUnresolvedWorkers(
  workers: Array<{
    agentId: string
    handle?: string
    status: string
    synthesisStatus?: string
  }>,
): string {
  return workers
    .map(worker => {
      const label =
        worker.handle && worker.handle !== worker.agentId
          ? worker.handle
          : worker.agentId
      const reason =
        worker.status === 'running'
          ? 'still running'
          : worker.synthesisStatus === 'pending'
            ? 'pending synthesis'
            : worker.status
      return `@${label} (${reason})`
    })
    .join(', ')
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
    return [
      'Update the existing goal.',
      'Use this tool only to mark the goal achieved.',
      'Set status to `complete` only when the objective has actually been achieved and no required work remains.',
      'Do not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work.',
      'You cannot use this tool to pause, resume, or budget-limit a goal; those status changes are controlled by the user or system.',
      'When marking a budgeted goal achieved with status `complete`, report the final token usage from the tool result to the user.',
    ].join('\n')
  },
  async prompt() {
    return [
      'Use this tool only to mark the current thread goal complete.',
      '',
      'Before using this tool, verify that:',
      '- every explicit requirement in the goal objective is satisfied',
      '- relevant files, command output, tests, logs, PR state, or other real evidence support completion',
      '- tests or green status actually cover the objective requirements',
      '- no required work remains',
      '',
      'Do not use this tool because the work seems mostly done.',
      'Do not use this tool because tests passed unless those tests cover the objective.',
      'Do not use this tool because the token budget is nearly exhausted.',
      'Do not use this tool because you are stopping work.',
      '',
      'The only valid status is "complete".',
      'You cannot use this tool to pause, resume, clear, or budget-limit a goal; those status changes are controlled by the user or runtime.',
      'When marking a budgeted goal complete, report the final token usage and elapsed time from the tool result to the user.',
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

    const sessionState = await readSessionState(getSessionId())
    const unresolvedWorkers =
      sessionState?.knownWorkers.filter(
        worker =>
          worker.status === 'running' || worker.synthesisStatus === 'pending',
      ) ?? []

    if (unresolvedWorkers.length > 0) {
      return {
        result: false,
        message:
          'Cannot mark the goal complete while Agent Mode still has unresolved workers. ' +
          `Resolve or synthesize them first: ${describeUnresolvedWorkers(unresolvedWorkers)}.`,
        errorCode: 6,
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

    const nextGoal = await completeThreadGoalAction({
      context,
      goal: currentGoal,
    })

    return {
      data: buildThreadGoalToolResponse(nextGoal, {
        includeCompletionBudgetReport: true,
      }),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
