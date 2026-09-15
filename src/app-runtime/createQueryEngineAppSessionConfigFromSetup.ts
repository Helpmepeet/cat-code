import type { Command } from '../commands.js'
import type { MCPServerConnection, ServerResource } from '../services/mcp/types.js'
import type { AppState } from '../state/AppStateStore.js'
import type { McpRuntimeSnapshot, Tool, ToolUseContext } from '../Tool.js'
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
  /**
   * Optional live MCP source owned by the session's MCP lifecycle. When
   * supplied, the four static mcp* values above are unused: the engine reads
   * one snapshot per turn and refreshes between iterations, and getAppState()
   * passes the store's real MCP state straight through so ToolSearch pending
   * checks and Agent required-server checks see the same generation the tool
   * pool came from. Without it the frozen setup overlay below is kept, because
   * a static caller's store has no MCP state to observe.
   */
  getMcpRuntimeSnapshot?: () => McpRuntimeSnapshot
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
  handleElicitation?: ToolUseContext['handleElicitation']
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
  getMcpRuntimeSnapshot,
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
  handleElicitation,
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

  const isLive = getMcpRuntimeSnapshot !== undefined

  return {
    cwd,
    // Live callers hand the engine the base pool and catalog; it layers each
    // turn's MCP generation on top itself. Static callers keep the merged
    // arrays, which are the only MCP values they will ever have.
    tools: isLive ? setupTools : [...setupTools, ...setupMcpTools],
    commands: isLive ? setupCommands : [...setupCommands, ...setupMcpCommands],
    mcpClients: setupMcpClients,
    mcpResources: copyMcpResources(),
    getMcpRuntimeSnapshot,
    agents: setupAgents,
    getAppState: isLive
      ? getAppState
      : () => {
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
    handleElicitation,
    includePartialMessages: true,
    setSDKStatus,
  }
}
