import type { ToolPermissionContext, Tools } from '../../Tool.js'
import { mcpInfoFromString } from '../../services/mcp/mcpStringUtils.js'
import { filterDeniedAgents } from '../../utils/permissions/permissions.js'
import { AGENT_TOOL_NAME } from './constants.js'
import { filterAgentsByMcpRequirements, type AgentDefinition } from './loadAgentsDir.js'

export function getVisibleAgentDefinitions(
  agents: AgentDefinition[],
  tools: Tools,
  permissionContext: ToolPermissionContext,
  allowedAgentTypes?: string[],
): AgentDefinition[] {
  const mcpServers = tools.flatMap(tool => mcpInfoFromString(tool.name)?.serverName ?? [])
  const visible = filterDeniedAgents(
    filterAgentsByMcpRequirements(agents, mcpServers),
    permissionContext,
    AGENT_TOOL_NAME,
  )
  return allowedAgentTypes
    ? visible.filter(agent => allowedAgentTypes.includes(agent.agentType))
    : visible
}
