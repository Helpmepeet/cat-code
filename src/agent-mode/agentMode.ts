import { feature } from 'bun:bundle'
import { ASYNC_AGENT_ALLOWED_TOOLS } from '../constants/tools.js'
import { checkStatsigFeatureGate_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { AGENT_TOOL_NAME } from '../tools/AgentTool/constants.js'
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../tools/FileReadTool/prompt.js'
import { SEND_MESSAGE_TOOL_NAME } from '../tools/SendMessageTool/constants.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../tools/SyntheticOutputTool/SyntheticOutputTool.js'
import { TEAM_CREATE_TOOL_NAME } from '../tools/TeamCreateTool/constants.js'
import { TEAM_DELETE_TOOL_NAME } from '../tools/TeamDeleteTool/constants.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { getOrchestratorSystemPrompt } from './orchestratorPrompt.js'

function isScratchpadGateEnabled(): boolean {
  return checkStatsigFeatureGate_CACHED_MAY_BE_STALE('tengu_scratch')
}

const INTERNAL_WORKER_TOOLS = new Set([
  TEAM_CREATE_TOOL_NAME,
  TEAM_DELETE_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  SYNTHETIC_OUTPUT_TOOL_NAME,
])

export function isAgentMode(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_AGENT_MODE)
}

export function getAgentModeUserContext(
  mcpClients: ReadonlyArray<{ name: string }>,
  scratchpadDir?: string,
): { [k: string]: string } {
  if (!isAgentMode()) {
    return {}
  }

  const workerTools = isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)
    ? [BASH_TOOL_NAME, FILE_READ_TOOL_NAME, FILE_EDIT_TOOL_NAME]
        .sort()
        .join(', ')
    : Array.from(ASYNC_AGENT_ALLOWED_TOOLS)
        .filter(name => !INTERNAL_WORKER_TOOLS.has(name))
        .sort()
        .join(', ')

  let content = `Delegated workers launched via the ${AGENT_TOOL_NAME} tool have access to these tools: ${workerTools}`

  if (mcpClients.length > 0) {
    const serverNames = mcpClients.map(c => c.name).join(', ')
    content += `\n\nDelegated workers also have access to MCP tools from connected MCP servers: ${serverNames}`
  }

  if (scratchpadDir && isScratchpadGateEnabled()) {
    content += `\n\nScratchpad directory: ${scratchpadDir}\nWorkers can read and write here without permission prompts. Use this for durable cross-worker knowledge when it helps the run.`
  }

  return { workerToolsContext: content }
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
