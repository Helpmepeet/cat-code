/**
 * Pure string utility functions for MCP tool/server name parsing.
 * This file has no heavy dependencies to keep it lightweight for
 * consumers that only need string parsing (e.g., permissionValidation).
 */

import { normalizeNameForMCP } from './normalization.js'

/**
 * Best-effort parser for legacy/model-facing MCP tool names. The delimiter
 * format is ambiguous, so this must not be used as an authorization identity.
 * @param toolString The string to parse. Expected format: "mcp__serverName__toolName"
 * @returns An object containing server name and optional tool name, or null if not a valid MCP rule
 */
export function mcpInfoFromString(toolString: string): {
  serverName: string
  toolName: string | undefined
} | null {
  const parts = toolString.split('__')
  const [mcpPart, serverName, ...toolNameParts] = parts
  if (mcpPart !== 'mcp' || !serverName) {
    return null
  }
  // Join all parts after server name to preserve double underscores in tool names
  const toolName =
    toolNameParts.length > 0 ? toolNameParts.join('__') : undefined
  return { serverName, toolName }
}

/**
 * Generates the MCP tool/command name prefix for a given server
 * @param serverName Name of the MCP server
 * @returns The prefix string
 */
export function getMcpPrefix(serverName: string): string {
  return `mcp__${normalizeNameForMCP(serverName)}__`
}

/**
 * Builds the historical model-facing MCP tool name. This delimiter format is
 * lossy for some server/tool names; use structured mcpInfo for authorization.
 * @param serverName Name of the MCP server (unnormalized)
 * @param toolName Name of the tool (unnormalized)
 * @returns The fully qualified name, e.g., "mcp__server__tool"
 */
export function buildMcpToolName(serverName: string, toolName: string): string {
  return `${getMcpPrefix(serverName)}${normalizeNameForMCP(toolName)}`
}

const MCP_PERMISSION_ID_PREFIX = 'mcpid:v1:'

export type McpPermissionIdentity =
  | { scope: 'tool'; serverName: string; toolName: string }
  | { scope: 'server' | 'wildcard'; serverName: string }

function encodeMcpPermissionPart(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, char =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

export function buildMcpPermissionRuleName(
  serverName: string,
  toolName: string,
): string {
  return `${MCP_PERMISSION_ID_PREFIX}tool:${encodeMcpPermissionPart(serverName)}:${encodeMcpPermissionPart(toolName)}`
}

export function buildMcpServerPermissionRuleName(
  serverName: string,
  scope: 'server' | 'wildcard' = 'server',
): string {
  return `${MCP_PERMISSION_ID_PREFIX}${scope}:${encodeMcpPermissionPart(serverName)}`
}

export function mcpPermissionIdentityFromRuleName(
  ruleName: string,
): McpPermissionIdentity | null {
  if (!ruleName.startsWith(MCP_PERMISSION_ID_PREFIX)) return null
  const parts = ruleName.split(':')
  if (parts[0] !== 'mcpid' || parts[1] !== 'v1') return null
  try {
    if (
      (parts[2] === 'server' || parts[2] === 'wildcard') &&
      parts.length === 4
    ) {
      const serverName = decodeURIComponent(parts[3]!)
      if (encodeMcpPermissionPart(serverName) !== parts[3]) return null
      return { scope: parts[2], serverName }
    }
    if (parts[2] !== 'tool' || parts.length !== 5) return null
    const serverName = decodeURIComponent(parts[3]!)
    const toolName = decodeURIComponent(parts[4]!)
    if (
      encodeMcpPermissionPart(serverName) !== parts[3] ||
      encodeMcpPermissionPart(toolName) !== parts[4]
    ) {
      return null
    }
    return {
      scope: 'tool',
      serverName,
      toolName,
    }
  } catch {
    return null
  }
}

export function isUnambiguousLegacyMcpIdentity(
  serverName: string,
  toolName?: string,
): boolean {
  return (
    !serverName.includes('_') &&
    normalizeNameForMCP(serverName) === serverName &&
    (toolName === undefined ||
      toolName === '*' ||
      (!toolName.includes('_') &&
        normalizeNameForMCP(toolName) === toolName))
  )
}

/**
 * Returns the name to use for permission rule matching.
 * MCP permission identity is reversible and does not share a namespace with
 * built-in tool names or the lossy model-facing MCP name.
 */
export function getToolNameForPermissionCheck(tool: {
  name: string
  mcpInfo?: { serverName: string; toolName: string }
}): string {
  return tool.mcpInfo
    ? buildMcpPermissionRuleName(
        tool.mcpInfo.serverName,
        tool.mcpInfo.toolName,
      )
    : tool.name
}

/*
 * Extracts the display name from an MCP tool/command name
 * @param fullName The full MCP tool/command name (e.g., "mcp__server_name__tool_name")
 * @param serverName The server name to remove from the prefix
 * @returns The display name without the MCP prefix
 */
export function getMcpDisplayName(
  fullName: string,
  serverName: string,
): string {
  const prefix = `mcp__${normalizeNameForMCP(serverName)}__`
  return fullName.replace(prefix, '')
}

/**
 * Extracts just the tool/command display name from a userFacingName
 * @param userFacingName The full user-facing name (e.g., "github - Add comment to issue (MCP)")
 * @returns The display name without server prefix and (MCP) suffix
 */
export function extractMcpToolDisplayName(userFacingName: string): string {
  // This is really ugly but our current Tool type doesn't make it easy to have different display names for different purposes.

  // First, remove the (MCP) suffix if present
  let withoutSuffix = userFacingName.replace(/\s*\(MCP\)\s*$/, '')

  // Trim the result
  withoutSuffix = withoutSuffix.trim()

  // Then, remove the server prefix (everything before " - ")
  const dashIndex = withoutSuffix.indexOf(' - ')
  if (dashIndex !== -1) {
    const displayName = withoutSuffix.substring(dashIndex + 3).trim()
    return displayName
  }

  // If no dash found, return the string without (MCP)
  return withoutSuffix
}
