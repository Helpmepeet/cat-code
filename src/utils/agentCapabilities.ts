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
