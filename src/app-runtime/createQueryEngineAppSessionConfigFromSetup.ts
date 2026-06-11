import type { Command } from '../commands.js'
import type { MCPServerConnection, ServerResource } from '../services/mcp/types.js'
import type { AppState } from '../state/AppStateStore.js'
import type { Tool } from '../Tool.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import type { FileStateCache } from '../utils/fileStateCache.js'
import type { ThinkingConfig } from '../utils/thinking.js'
import type { QueryEngineAppSessionConfig } from './createQueryEngineAppSession.js'

export type QueryEngineAppSessionSetup = {
  cwd: string
  tools: readonly Tool[]
  commands: readonly Command[]
  mcpTools: readonly Tool[]
  mcpCommands: readonly Command[]
  mcpClients: readonly MCPServerConnection[]
  mcpResources: Record<string, ServerResource[]>
  agents: readonly AgentDefinition[]
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  readFileCache: FileStateCache
  customSystemPrompt?: string
  appendSystemPrompt?: string
  userSpecifiedModel?: string
  fallbackModel?: string
  thinkingConfig?: ThinkingConfig
  maxTurns?: number
  maxBudgetUsd?: number
  taskBudget?: { total: number }
  jsonSchema?: Record<string, unknown>
  verbose?: boolean
  replayUserMessages?: boolean
  setSDKStatus?: QueryEngineAppSessionConfig['setSDKStatus']
}

const cloneMcpResource = (resource: ServerResource): ServerResource =>
  structuredClone(resource)

export function createQueryEngineAppSessionConfigFromSetup({
  cwd,
  tools,
  commands,
  mcpTools,
  mcpCommands,
  mcpClients,
  mcpResources,
  agents,
  getAppState,
  setAppState,
  readFileCache,
  customSystemPrompt,
  appendSystemPrompt,
  userSpecifiedModel,
  fallbackModel,
  thinkingConfig,
  maxTurns,
  maxBudgetUsd,
  taskBudget,
  jsonSchema,
  verbose,
  replayUserMessages,
  setSDKStatus,
}: QueryEngineAppSessionSetup): QueryEngineAppSessionConfig {
  const setupTools = [...tools]
  const setupCommands = [...commands]
  const setupMcpTools = [...mcpTools]
  const setupMcpCommands = [...mcpCommands]
  const setupMcpClients = [...mcpClients]
  const setupMcpResources: Record<string, ServerResource[]> = Object.fromEntries(
    Object.entries(mcpResources).map(([server, resources]) => [
      server,
      resources.map(cloneMcpResource),
    ]),
  )
  const setupAgents = [...agents]
  const copyMcpResources = () =>
    Object.fromEntries(
      Object.entries(setupMcpResources).map(([server, resources]) => [
        server,
        resources.map(cloneMcpResource),
      ]),
    ) as Record<string, ServerResource[]>

  return {
    cwd,
    tools: [...setupTools, ...setupMcpTools],
    commands: [...setupCommands, ...setupMcpCommands],
    mcpClients: setupMcpClients,
    agents: setupAgents,
    getAppState: () => {
      const state = getAppState()
      return {
        ...state,
        mcp: {
          ...state.mcp,
          clients: [...setupMcpClients],
          tools: [...setupMcpTools],
          commands: [...setupMcpCommands],
          resources: copyMcpResources(),
        },
      }
    },
    setAppState,
    readFileCache,
    customSystemPrompt,
    appendSystemPrompt,
    userSpecifiedModel,
    fallbackModel,
    thinkingConfig,
    maxTurns,
    maxBudgetUsd,
    taskBudget,
    jsonSchema,
    verbose,
    replayUserMessages,
    includePartialMessages: true,
    setSDKStatus,
  }
}
