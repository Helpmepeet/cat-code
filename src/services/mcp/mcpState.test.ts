import { describe, expect, test } from 'bun:test'
import type { Command } from '../../commands.js'
import type { Tool } from '../../Tool.js'
import {
  applyMcpServerStateUpdate,
  selectAvailableMcpServerNames,
  seedMcpServerStates,
  type McpState,
} from './mcpState.js'
import type {
  ConnectedMCPServer,
  ScopedMcpServerConfig,
  ServerResource,
} from './types.js'

const alphaConfig = {
  type: 'stdio',
  command: 'alpha-fixture',
  args: [],
  scope: 'user',
} as ScopedMcpServerConfig
const betaConfig = {
  type: 'stdio',
  command: 'beta-fixture',
  args: [],
  scope: 'user',
} as ScopedMcpServerConfig

function emptyMcpState(): McpState {
  return {
    clients: [],
    tools: [],
    commands: [],
    resources: {},
    pluginReconnectKey: 0,
  }
}

function connected(
  name: string,
  config: ScopedMcpServerConfig,
): ConnectedMCPServer {
  return {
    name,
    type: 'connected',
    config,
    capabilities: {},
    cleanup: async () => {},
    client: {} as ConnectedMCPServer['client'],
  }
}

const alphaOldTool = {
  name: 'mcp__alpha__old',
  mcpInfo: { serverName: 'alpha', toolName: 'old' },
} as Tool
const alphaNewTool = {
  name: 'mcp__alpha__new',
  mcpInfo: { serverName: 'alpha', toolName: 'new' },
} as Tool
const betaTool = {
  name: 'mcp__beta__keep',
  mcpInfo: { serverName: 'beta', toolName: 'keep' },
} as Tool
const alphaOldCommand = { name: 'mcp__alpha__old' } as Command
const alphaNewCommand = { name: 'mcp__alpha__new' } as Command
const betaCommand = { name: 'mcp__beta__keep' } as Command
const alphaResource = {
  server: 'alpha',
  uri: 'fixture://alpha',
  name: 'alpha',
} as ServerResource
const betaResource = {
  server: 'beta',
  uri: 'fixture://beta',
  name: 'beta',
} as ServerResource

describe('MCP state transitions', () => {
  test('selects only connected servers with matching real tools by MCP metadata', () => {
    const punctuationName = 'Cua Driver, Local'
    const punctuationConfig = {
      ...alphaConfig,
      command: 'punctuation-fixture',
    }
    const state: McpState = {
      ...emptyMcpState(),
      clients: [
        { name: 'pending', type: 'pending', config: alphaConfig },
        { name: 'failed', type: 'failed', config: alphaConfig },
        { name: 'auth-only', type: 'needs-auth', config: alphaConfig },
        connected('connected-with-auth-only', alphaConfig),
        connected(punctuationName, punctuationConfig),
        connected('metadata-mismatch', alphaConfig),
      ],
      tools: [
        {
          name: 'mcp__pending__real',
          mcpInfo: { serverName: 'pending', toolName: 'real' },
        } as Tool,
        {
          name: 'mcp__failed__real',
          mcpInfo: { serverName: 'failed', toolName: 'real' },
        } as Tool,
        {
          name: 'mcp__auth-only__authenticate',
          mcpInfo: { serverName: 'auth-only', toolName: 'authenticate' },
        } as Tool,
        {
          name: 'mcp__connected-with-auth-only__authenticate',
          mcpInfo: {
            serverName: 'connected-with-auth-only',
            toolName: 'authenticate',
          },
        } as Tool,
        {
          name: 'mcp__Cua_Driver__click',
          mcpInfo: { serverName: punctuationName, toolName: 'click' },
        } as Tool,
        {
          name: 'mcp__metadata-mismatch__real',
          mcpInfo: { serverName: 'different-server', toolName: 'real' },
        } as Tool,
      ],
    }

    expect(selectAvailableMcpServerNames(state)).toEqual([punctuationName])
  })

  test('seeds pending and disabled servers without replacing existing state', () => {
    const existing = connected('existing', alphaConfig)
    const initial = { ...emptyMcpState(), clients: [existing] }

    const seeded = seedMcpServerStates(
      initial,
      {
        existing: alphaConfig,
        alpha: alphaConfig,
        beta: betaConfig,
      },
      name => name === 'beta',
    )

    expect(seeded.clients).toEqual([
      existing,
      { name: 'alpha', type: 'pending', config: alphaConfig },
      { name: 'beta', type: 'disabled', config: betaConfig },
    ])
  })

  test('replaces one server generation without disturbing peer surfaces', () => {
    const initial: McpState = {
      ...emptyMcpState(),
      clients: [
        connected('alpha', alphaConfig),
        connected('beta', betaConfig),
      ],
      tools: [alphaOldTool, betaTool],
      commands: [alphaOldCommand, betaCommand],
      resources: { alpha: [alphaResource], beta: [betaResource] },
    }

    const next = applyMcpServerStateUpdate(initial, {
      client: connected('alpha', alphaConfig),
      tools: [alphaNewTool, alphaNewTool],
      commands: [alphaNewCommand, alphaNewCommand],
      resources: [],
    })

    expect(next.tools).toEqual([betaTool, alphaNewTool])
    expect(next.commands).toEqual([betaCommand, alphaNewCommand])
    expect(next.resources).toEqual({ beta: [betaResource] })
    expect(next.clients.find(client => client.name === 'beta')).toBe(
      initial.clients[1],
    )
  })

  test('failed and disabled states clear only that server executable state', () => {
    const initial: McpState = {
      ...emptyMcpState(),
      clients: [
        connected('alpha', alphaConfig),
        connected('beta', betaConfig),
      ],
      tools: [alphaOldTool, betaTool],
      commands: [alphaOldCommand, betaCommand],
      resources: { alpha: [alphaResource], beta: [betaResource] },
    }

    const needsAuthTool = {
      name: 'mcp__alpha__authenticate',
      mcpInfo: { serverName: 'alpha', toolName: 'authenticate' },
    } as Tool
    const needsAuth = applyMcpServerStateUpdate(initial, {
      client: { name: 'alpha', type: 'needs-auth', config: alphaConfig },
      tools: [needsAuthTool],
    })
    const failed = applyMcpServerStateUpdate(needsAuth, {
      client: { name: 'alpha', type: 'failed', config: alphaConfig },
    })
    const disabled = applyMcpServerStateUpdate(failed, {
      client: { name: 'beta', type: 'disabled', config: betaConfig },
    })

    expect(needsAuth.tools).toEqual([betaTool, needsAuthTool])
    expect(needsAuth.commands).toEqual([betaCommand])
    expect(needsAuth.resources).toEqual({ beta: [betaResource] })
    expect(failed.tools).toEqual([betaTool])
    expect(failed.commands).toEqual([betaCommand])
    expect(failed.resources).toEqual({ beta: [betaResource] })
    expect(disabled.tools).toEqual([])
    expect(disabled.commands).toEqual([])
    expect(disabled.resources).toEqual({})
  })
})
