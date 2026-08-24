import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ValidationResult } from '../../Tool.js'
import { getSessionId } from '../../bootstrap/state.js'
import { readSessionState } from '../../agent-mode/sessionState.js'
import { applyThreadGoalTransition } from '../../utils/threadGoalActions.js'
import {
  buildThreadGoalToolResponse,
  type ThreadGoalToolResponse,
} from '../../utils/threadGoal.js'
import { checkThreadGoalTransition } from '../../utils/threadGoalState.js'
import {
  evaluateThreadGoalCompletion,
  hashThreadGoalContract,
} from '../../utils/threadGoalEvidence.js'
import { getThreadGoalWorkspaceFingerprint } from '../../utils/threadGoalWorkspace.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { lazySchema } from '../../utils/lazySchema.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    // The only two statuses the working model may request. Pause, resume,
    // clear, budget, usage-limit, stall, and failure transitions belong to the
    // user or the runtime, and threadGoalState.ts enforces that separately so
    // widening this schema alone cannot widen model authority.
    status: z.enum(['complete', 'blocked']),
  }),
)

type InputSchema = ReturnType<typeof inputSchema>

type Output = ThreadGoalToolResponse

function validateGoalUpdate(input: {
  status: 'complete' | 'blocked'
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
      'Set status to `complete` only when the objective has actually been achieved and no required work remains.',
      'Set status to `blocked` only when the same blocker has stopped progress on at least three consecutive goal turns and it needs the user or an external change to clear.',
      'Do not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work.',
      'You cannot use this tool to pause, resume, or budget-limit a goal; those status changes are controlled by the user or system.',
      'When marking a budgeted goal achieved with status `complete`, report the final token usage from the tool result to the user.',
    ].join('\n')
  },
  async prompt() {
    return [
      'Use this tool to mark the current thread goal complete, or to report that it is blocked.',
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
      'Use status "blocked" only when the SAME blocker has stopped progress on at least three consecutive goal turns and clearing it needs the user or an external change. A blocker you have not tried to work around is not a blocked goal.',
      '',
      'The only valid statuses are "complete" and "blocked".',
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
    if (currentGoal.status === 'complete') {
      return {
        result: false,
        message: 'The current thread goal is already complete.',
        errorCode: 4,
      }
    }

    // The transition table is the authority. Asking it here means the tool
    // rejects an illegal request BEFORE any durable write, and the reason it
    // gives the model always matches what the control plane would enforce.
    const check = checkThreadGoalTransition({
      from: currentGoal.status,
      to: input.status,
      actor: 'agent',
    })
    if (!check.allowed) {
      return {
        result: false,
        message:
          check.code === 'unauthorized'
            ? `Setting status ${input.status} is not something this tool controls.`
            : `A goal with status ${currentGoal.status} cannot be set to ${input.status}.`,
        errorCode: 5,
      }
    }

    // Only completion is gated on worker resolution. A blocked report is the
    // model telling the user it cannot proceed, and unresolved workers are
    // frequently the very thing blocking it.
    if (input.status !== 'complete') {
      return { result: true }
    }

    // Deterministic gate BEFORE any semantic judgment. The model proposes
    // completion; this decides it, from evidence the runtime recorded. A goal
    // with no required criteria is not gated, so plain-objective goals behave
    // exactly as before.
    const completion = evaluateThreadGoalCompletion({
      contract: currentGoal.contract,
      evidence: currentGoal.evidence,
      contractDigest: hashThreadGoalContract(
        currentGoal.objective,
        currentGoal.contract,
      ),
      workspaceFingerprint: await getThreadGoalWorkspaceFingerprint(),
    })
    if (!completion.allowed) {
      const named = completion.criterionIds.join(', ')
      return {
        result: false,
        message:
          completion.reason === 'required_gate_failed'
            ? `A required check for this goal is failing: ${named}. Fix it and re-run the check before marking the goal complete.`
            : `These required criteria have no passing evidence yet: ${named}. Run the checks that cover them before marking the goal complete.`,
        errorCode: 7,
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
  async call(input, context) {
    const currentGoal = context.getAppState().threadGoal
    if (!currentGoal) {
      throw new Error('No current thread goal exists.')
    }

    const isCompletion = input.status === 'complete'
    // The revision the model validated against is the compare-and-swap
    // precondition. If the user paused, edited, replaced, or cleared the goal
    // between validation and here, the write is refused rather than applied to
    // whatever goal now occupies the session.
    const result = await applyThreadGoalTransition({
      context,
      goalId: currentGoal.goalId,
      to: input.status,
      reason: isCompletion
        ? 'agent_reported_complete'
        : 'agent_reported_blocked',
      actor: 'agent',
      expectedRevision: currentGoal.revision,
      ...(isCompletion ? { objective: '', resetWorkers: true } : {}),
    })

    if (!result.ok) {
      throw new Error(
        result.code === 'stale'
          ? 'The goal changed while this update was in flight. Re-read the goal with get_goal before updating it.'
          : result.code === 'missing'
            ? 'The thread goal was cleared or replaced and no longer exists.'
            : `This goal cannot be set to ${input.status} from its current status.`,
      )
    }

    return {
      data: buildThreadGoalToolResponse(result.goal, {
        includeCompletionBudgetReport: isCompletion,
      }),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
