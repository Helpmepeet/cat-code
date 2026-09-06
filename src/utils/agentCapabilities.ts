import { CLAUDE_CLI_TOOL_NAME } from '../tools/ClaudeCliTool/constants.js'
import { AGENT_TOOL_NAME } from '../tools/AgentTool/constants.js'
import { ASK_ORCHESTRATOR_TOOL_NAME } from '../tools/AskOrchestratorTool/prompt.js'
import { SEND_MESSAGE_TOOL_NAME } from '../tools/SendMessageTool/constants.js'

/**
 * "May this worker delegate, and how may it escalate" in one place, so a
 * permission check and a prompt line read the same fact instead of each
 * asserting their own copy of the tool policy.
 */
export type WorkerCapabilities = {
  /** Worker holds the nested external-CLI delegation tool. */
  mayDelegateExternally: boolean
  /** Worker holds the in-process Agent tool. */
  mayDelegateInternally: boolean
  /** Escalation channels present in the worker's resolved pool. */
  canAskOrchestrator: boolean
  canSendMessage: boolean
}

/**
 * Derives capability from the worker's own RESOLVED tool-name set — the
 * output of resolveAgentTools, never a second read of the allow/deny lists
 * that produced it. Callers pass whatever they already have on hand
 * (a Tool[] mapped to names, or the raw set from a tool schema).
 */
export function resolveWorkerCapabilities(
  toolNames: Iterable<string>,
): WorkerCapabilities {
  const names = new Set(toolNames)
  return {
    mayDelegateExternally: names.has(CLAUDE_CLI_TOOL_NAME),
    mayDelegateInternally: names.has(AGENT_TOOL_NAME),
    canAskOrchestrator: names.has(ASK_ORCHESTRATOR_TOOL_NAME),
    canSendMessage: names.has(SEND_MESSAGE_TOOL_NAME),
  }
}

/**
 * The one sentence every worker is told about delegating and escalating,
 * built from the same resolved pool the permission checks read. Role prompts
 * must not restate it: a hand-maintained copy is only true for the roles
 * someone remembered to update, and a general-purpose worker (which has no
 * role prompt at all) was told nothing, so it went looking for a delegation
 * tool the harness had already stripped
 * (docs/reports/2026-09-06-subagent-escalation-and-delegation-failures.md).
 *
 * SendMessage is named as what it is. It routes to running workers and
 * teammates and has no parent address at all, so a worker told only that it
 * "has a messaging tool" tries to reach its spawner with it and gets the
 * no-such-recipient fall-through instead of an answer.
 */
export function getWorkerCapabilityPromptLine(
  toolNames: Iterable<string>,
): string {
  const capabilities = resolveWorkerCapabilities(toolNames)

  const grants: string[] = []
  if (capabilities.mayDelegateInternally) {
    grants.push(`start a subagent with ${AGENT_TOOL_NAME}`)
  }
  if (capabilities.mayDelegateExternally) {
    grants.push(`run ${CLAUDE_CLI_TOOL_NAME} for a read-only advisory pass`)
  }

  const delegation =
    grants.length > 0
      ? `you may ${grants.join(' and ')}, and the assigned work stays yours to finish.`
      : `you have no tool that starts another agent, and you MUST NOT launch one through a shell, so do the work yourself.`

  const escalation = capabilities.canAskOrchestrator
    ? `If you are blocked, call ${ASK_ORCHESTRATOR_TOOL_NAME} once, then stop your turn and return a blocked result naming the exact question.`
    : `If you are blocked, stop your turn and return a blocked result naming the exact question.`

  const sideways = capabilities.canSendMessage
    ? ` ${SEND_MESSAGE_TOOL_NAME} reaches running workers and teammates, never whoever spawned you.`
    : ''

  return `Delegation and escalation for this run: ${delegation} ${escalation}${sideways}`
}
