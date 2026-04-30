import type {
  ConfigScope,
  MCPServerConnection,
  McpClaudeAIProxyServerConfig,
  McpHTTPServerConfig,
  McpSSEServerConfig,
  McpStdioServerConfig,
} from '../../services/mcp/types.js'

export type StdioServerInfo = {
  name: string
  client: MCPServerConnection
  scope: ConfigScope
  transport: 'stdio'
  config: McpStdioServerConfig
}

export type SSEServerInfo = {
  name: string
  client: MCPServerConnection
  scope: ConfigScope
  transport: 'sse'
  isAuthenticated?: boolean
  config: McpSSEServerConfig
}

export type HTTPServerInfo = {
  name: string
  client: MCPServerConnection
  scope: ConfigScope
  transport: 'http'
  isAuthenticated?: boolean
  config: McpHTTPServerConfig
}

export type ClaudeAIServerInfo = {
  name: string
  client: MCPServerConnection
  scope: ConfigScope
  transport: 'claudeai-proxy'
  isAuthenticated?: boolean
  config: McpClaudeAIProxyServerConfig
}

export type ServerInfo =
  | StdioServerInfo
  | SSEServerInfo
  | HTTPServerInfo
  | ClaudeAIServerInfo

export type AgentMcpServerInfo = {
  name: string
  transport: 'stdio' | 'sse' | 'http'
  sourceAgents: string[]
  command?: string
  args?: string[]
  url?: string
  needsAuth?: boolean
  isAuthenticated?: boolean
}

export type MCPViewState =
  | { type: 'list'; defaultTab?: string }
  | { type: 'server-menu'; server: ServerInfo }
  | { type: 'agent-server-menu'; agentServer: AgentMcpServerInfo }
  | { type: 'server-tools'; server: ServerInfo }
