import { describe, expect, test } from 'bun:test'
import type { Command } from './commands.js'
import { resolveMcpRuntimeInputs } from './QueryEngine.js'
import type { MCPServerConnection, ServerResource } from './services/mcp/types.js'
import type { AppState } from './state/AppStateStore.js'
import {
  getEmptyToolPermissionContext,
  type McpRuntimeSnapshot,
  type Tool,
} from './Tool.js'

// The sidecar injects a tool set the default built-ins do not contain. If the
// dynamic path regenerated built-ins instead of layering onto what the caller
// passed, this tool would disappear from the model's view.
const injectedTool = { name: 'InjectedOnlyTool' } as Tool
const mcpTool = { name: 'mcp__cua-driver__click' } as Tool
const deniedMcpTool = { name: 'mcp__cua-driver__type' } as Tool
const baseCommand = { name: 'base-command' } as Command
const mcpCommand = { name: 'mcp-command' } as Command
const staticClient = { name: 'stale', type: 'pending' } as MCPServerConnection
const liveClient = { name: 'cua-driver', type: 'connected' } as MCPServerConnection
const resource = { uri: 'file://demo', name: 'demo' } as ServerResource

function appStateWith(
  permissionContext = getEmptyToolPermissionContext(),
): AppState {
  return { toolPermissionContext: permissionContext } as unknown as AppState
}

function snapshot(
  overrides: Partial<McpRuntimeSnapshot> = {},
): McpRuntimeSnapshot {
  return {
    clients: [liveClient],
    tools: [mcpTool],
    commands: [mcpCommand],
    resources: { 'cua-driver': [resource] },
    ...overrides,
  }
}

describe('resolveMcpRuntimeInputs', () => {
  test('a caller without a runtime source keeps its static values', () => {
    const tools = [injectedTool]
    const commands = [baseCommand]
    const mcpClients = [staticClient]
    const mcpResources = { stale: [resource] }

    const resolved = resolveMcpRuntimeInputs({
      tools,
      commands,
      mcpClients,
      mcpResources,
      getAppState: () => appStateWith(),
    })

    // Same references, not merely equal contents: nothing was assembled,
    // filtered, or re-sorted behind a static caller's back.
    expect(resolved.tools).toBe(tools)
    expect(resolved.commands).toBe(commands)
    expect(resolved.mcpClients).toBe(mcpClients)
    expect(resolved.mcpResources).toBe(mcpResources)
  })

  test('a live caller gets one snapshot read, and all four values from it', () => {
    let reads = 0
    const resolved = resolveMcpRuntimeInputs({
      tools: [injectedTool],
      commands: [baseCommand],
      mcpClients: [staticClient],
      getMcpRuntimeSnapshot: () => {
        reads++
        return snapshot()
      },
      getAppState: () => appStateWith(),
    })

    // One read per use is the whole point: two reads could straddle a
    // generation boundary and hand the model a tool whose client is gone.
    expect(reads).toBe(1)
    expect(resolved.tools.map(t => t.name)).toEqual([
      'InjectedOnlyTool',
      'mcp__cua-driver__click',
    ])
    expect(resolved.commands).toEqual([baseCommand, mcpCommand])
    expect(resolved.mcpClients).toEqual([liveClient])
    expect(resolved.mcpResources).toEqual({ 'cua-driver': [resource] })
  })

  test('MCP deny rules still filter the dynamic half', () => {
    const permissionContext = {
      ...getEmptyToolPermissionContext(),
      alwaysDenyRules: {
        localSettings: ['mcp__cua-driver__type'],
      },
    }

    const resolved = resolveMcpRuntimeInputs({
      tools: [injectedTool],
      commands: [],
      mcpClients: [],
      getMcpRuntimeSnapshot: () => snapshot({ tools: [mcpTool, deniedMcpTool] }),
      getAppState: () => appStateWith(permissionContext),
    })

    expect(resolved.tools.map(t => t.name)).toEqual([
      'InjectedOnlyTool',
      'mcp__cua-driver__click',
    ])
  })

  test('resources are copied out of the snapshot, not aliased into it', () => {
    const live = snapshot()
    const resolved = resolveMcpRuntimeInputs({
      tools: [],
      commands: [],
      mcpClients: [],
      getMcpRuntimeSnapshot: () => live,
      getAppState: () => appStateWith(),
    })

    resolved.mcpResources['cua-driver'].push({
      uri: 'file://injected',
      name: 'injected',
    } as ServerResource)

    expect(live.resources['cua-driver']).toHaveLength(1)
  })
})
