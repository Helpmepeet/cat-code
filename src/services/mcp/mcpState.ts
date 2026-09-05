import uniqBy from 'lodash-es/uniqBy.js'
import type { Command } from '../../commands.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { Tool } from '../../Tool.js'
import { LIST_MCP_RESOURCES_TOOL_NAME } from '../../tools/ListMcpResourcesTool/prompt.js'
import { READ_MCP_RESOURCE_TOOL_NAME } from '../../tools/ReadMcpResourceTool/prompt.js'
import { getMcpPrefix } from './mcpStringUtils.js'
import type {
  MCPServerConnection,
  ScopedMcpServerConfig,
  ServerResource,
} from './types.js'
import {
  excludeCommandsByServer,
  excludeResourcesByServer,
} from './utils.js'

export type McpState = AppState['mcp']

export type McpServerStateUpdate = {
  client: MCPServerConnection
  tools?: Tool[]
  commands?: Command[]
  resources?: ServerResource[]
}

export function selectAvailableMcpServerNames(
  mcp: Pick<McpState, 'clients' | 'tools'>,
): string[] {
  const serversWithRealTools = new Set(
    mcp.tools.flatMap(tool => {
      const info = tool.mcpInfo
      return info && info.toolName !== 'authenticate' ? [info.serverName] : []
    }),
  )

  return mcp.clients
    .filter(
      client =>
        client.type === 'connected' && serversWithRealTools.has(client.name),
    )
    .map(client => client.name)
    .filter((name, index, names) => names.indexOf(name) === index)
    .sort((left, right) => left.localeCompare(right))
}

export function seedMcpServerStates(
  mcp: McpState,
  configs: Record<string, ScopedMcpServerConfig>,
  isDisabled: (name: string) => boolean,
): McpState {
  const existingNames = new Set(mcp.clients.map(client => client.name))
  const newClients = Object.entries(configs)
    .filter(([name]) => !existingNames.has(name))
    .map(([name, config]): MCPServerConnection => ({
      name,
      type: isDisabled(name) ? 'disabled' : 'pending',
      config,
    }))

  if (newClients.length === 0) return mcp
  return { ...mcp, clients: [...mcp.clients, ...newClients] }
}

export function applyMcpServerStateUpdate(
  mcp: McpState,
  update: McpServerStateUpdate,
): McpState {
  const {
    client,
    tools: rawTools,
    commands: rawCommands,
    resources: rawResources,
  } = update
  const replacesExecutableState =
    client.type === 'disabled' ||
    client.type === 'failed' ||
    client.type === 'needs-auth'
  const tools = replacesExecutableState ? (rawTools ?? []) : rawTools
  const commands = replacesExecutableState
    ? (rawCommands ?? [])
    : rawCommands
  const resources = replacesExecutableState
    ? (rawResources ?? [])
    : rawResources

  const clients = mcp.clients.some(current => current.name === client.name)
    ? mcp.clients.map(current =>
        current.name === client.name ? client : current,
      )
    : [...mcp.clients, client]

  let nextTools = mcp.tools
  if (tools !== undefined) {
    const prefix = getMcpPrefix(client.name)
    nextTools = uniqBy(
      [
        ...mcp.tools.filter(
          tool =>
            tool.mcpInfo?.serverName !== client.name &&
            !tool.name.startsWith(prefix),
        ),
        ...tools,
      ],
      'name',
    )
  }

  const nextCommands =
    commands === undefined
      ? mcp.commands
      : uniqBy(
          [...excludeCommandsByServer(mcp.commands, client.name), ...commands],
          'name',
        )

  const nextResources =
    resources === undefined
      ? mcp.resources
      : resources.length > 0
        ? { ...mcp.resources, [client.name]: resources }
        : excludeResourcesByServer(mcp.resources, client.name)

  if (
    tools !== undefined &&
    !clients.some(
      current =>
        current.type === 'connected' && !!current.capabilities.resources,
    )
  ) {
    const sharedResourceToolNames = new Set([
      LIST_MCP_RESOURCES_TOOL_NAME,
      READ_MCP_RESOURCE_TOOL_NAME,
    ])
    nextTools = nextTools.filter(tool => !sharedResourceToolNames.has(tool.name))
  }

  return {
    ...mcp,
    clients,
    tools: nextTools,
    commands: nextCommands,
    resources: nextResources,
  }
}
