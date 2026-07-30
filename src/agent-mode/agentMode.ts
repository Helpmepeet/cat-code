import { feature } from 'bun:bundle'
import { getSessionId } from '../bootstrap/state.js'
import { checkStatsigFeatureGate_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { AGENT_TOOL_NAME } from '../tools/AgentTool/constants.js'
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'
import { FILE_READ_TOOL_NAME } from '../tools/FileReadTool/prompt.js'
import { RESUME_AGENT_TOOL_NAME } from '../tools/ResumeAgentTool/constants.js'
import { SEND_MESSAGE_TOOL_NAME } from '../tools/SendMessageTool/constants.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../tools/SyntheticOutputTool/SyntheticOutputTool.js'
import { TEAM_CREATE_TOOL_NAME } from '../tools/TeamCreateTool/constants.js'
import { TEAM_DELETE_TOOL_NAME } from '../tools/TeamDeleteTool/constants.js'
import {
  getAsyncAgentDisplayTools,
  getAsyncAgentFileEditTool,
} from '../constants/tools.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { getOrchestratorSystemPrompt } from './orchestratorPrompt.js'
import {
  formatAgentModeSessionState,
  readSessionStateWithContinuity,
} from './sessionState.js'

function isScratchpadGateEnabled(): boolean {
  return checkStatsigFeatureGate_CACHED_MAY_BE_STALE('tengu_scratch')
}

const INTERNAL_WORKER_TOOLS = new Set([
  TEAM_CREATE_TOOL_NAME,
  TEAM_DELETE_TOOL_NAME,
  RESUME_AGENT_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  SYNTHETIC_OUTPUT_TOOL_NAME,
])

export function isAgentMode(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_AGENT_MODE)
}

export async function getAgentModeUserContext(
  mcpClients: ReadonlyArray<{ name: string }>,
  scratchpadDir?: string,
  sessionId?: string,
): Promise<{ [k: string]: string }> {
  if (!isAgentMode()) {
    return {}
  }

  const workerTools = isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)
    ? [BASH_TOOL_NAME, FILE_READ_TOOL_NAME, getAsyncAgentFileEditTool()]
        .sort()
        .join(', ')
    : getAsyncAgentDisplayTools()
        .filter(name => !INTERNAL_WORKER_TOOLS.has(name))
        .sort()
        .join(', ')

  // Candidate set, not a guarantee: the worker's own role definition narrows
  // it at spawn time (resolveAgentTools), so do not promise per-worker access.
  let content = `Delegated workers launched via the ${AGENT_TOOL_NAME} tool can receive these tools: ${workerTools}. That is the candidate set for this provider, not a per-worker guarantee: the role you select may allow fewer, and a read-only role gets no file-edit or write tools.`

  if (mcpClients.length > 0) {
    const serverNames = mcpClients.map(c => c.name).join(', ')
    content += `\n\nDelegated workers can also receive MCP tools from connected MCP servers: ${serverNames}`
  }

  if (scratchpadDir && isScratchpadGateEnabled()) {
    content += `\n\nScratchpad directory: ${scratchpadDir}\nWorkers can read and write here without permission prompts. Use this for durable cross-worker knowledge when it helps the run.`
  }

  const effectiveSessionId = sessionId ?? getSessionId()
  const sessionState = await readSessionStateWithContinuity(effectiveSessionId)

  return {
    workerToolsContext: content,
    ...(sessionState
      ? {
          agentModeSessionState:
            `${formatAgentModeSessionState(sessionState)}\n\n` +
            `Use this state to choose whether to resume an existing worker or spawn a fresh worker. Use ${RESUME_AGENT_TOOL_NAME} on a resumable worker handle when the follow-up overlaps that worker's loaded context. Use ${SEND_MESSAGE_TOOL_NAME} only to queue messages into a worker that is currently running.`,
        }
      : {}),
  }
}

export function getAgentModeSystemPrompt(): string {
  // Live Agent Mode prompt.
  return getOrchestratorSystemPrompt()
}

export type SessionMode = 'agent' | 'coordinator' | 'normal'

export function getCurrentSessionMode(): SessionMode {
  if (isAgentMode()) {
    return 'agent'
  }
  if (feature('COORDINATOR_MODE') && isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)) {
    return 'coordinator'
  }
  return 'normal'
}

export function matchSessionMode(
  sessionMode: SessionMode | undefined,
): string | undefined {
  if (!sessionMode) {
    return undefined
  }

  const currentMode = getCurrentSessionMode()
  if (currentMode === sessionMode) {
    return undefined
  }

  if (sessionMode === 'agent') {
    process.env.CLAUDE_CODE_AGENT_MODE = '1'
    delete process.env.CLAUDE_CODE_COORDINATOR_MODE
  } else if (sessionMode === 'coordinator') {
    process.env.CLAUDE_CODE_COORDINATOR_MODE = '1'
    delete process.env.CLAUDE_CODE_AGENT_MODE
  } else {
    delete process.env.CLAUDE_CODE_AGENT_MODE
    delete process.env.CLAUDE_CODE_COORDINATOR_MODE
  }

  logEvent('tengu_agent_mode_switched', {
    to: sessionMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  if (sessionMode === 'agent') {
    return 'Entered Agent mode to match resumed session.'
  }
  if (sessionMode === 'coordinator') {
    return 'Entered coordinator mode to match resumed session.'
  }
  if (currentMode === 'agent') {
    return 'Exited Agent mode to match resumed session.'
  }
  if (currentMode === 'coordinator') {
    return 'Exited coordinator mode to match resumed session.'
  }
  return undefined
}
