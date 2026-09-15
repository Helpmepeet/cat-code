import { describe, expect, test } from 'bun:test'
import type { Command } from '../commands.js'
import type { MCPServerConnection, ServerResource } from '../services/mcp/types.js'
import { getDefaultAppState, type AppState } from '../state/AppStateStore.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import type { Tool } from '../Tool.js'
import { createFileStateCacheWithSizeLimit } from '../utils/fileStateCache.js'
import { createQueryEngineAppSessionConfigFromSetup } from './createQueryEngineAppSessionConfigFromSetup.js'

const command = { name: 'demo-command' } as Command
const mcpCommand = { name: 'mcp-command' } as Command
const tool = { name: 'Read' } as Tool
const mcpTool = { name: 'mcp__server__tool' } as Tool
const mcpClient = { name: 'server', type: 'connected' } as MCPServerConnection
const mcpResource = { uri: 'file://demo', name: 'demo-resource' } as ServerResource
const agent = { agentType: 'builder' } as AgentDefinition

type NestedServerResource = ServerResource & {
  annotations: { audience: string[] }
  icons: { src: string }[]
  _meta: { nested: { label: string } }
}

const createNestedMcpResource = (): NestedServerResource =>
  ({
    ...mcpResource,
    server: 'server',
    annotations: { audience: ['user'] },
    icons: [{ src: 'file://icon' }],
    _meta: { nested: { label: 'original' } },
  } as NestedServerResource)

describe('createQueryEngineAppSessionConfigFromSetup', () => {
  test('preserves normal startup owners for runtime-backed web sessions', () => {
    let state: AppState = {
      ...getDefaultAppState(),
      toolPermissionContext: {
        mode: 'plan',
        additionalWorkingDirectories: [],
        alwaysAllowRules: [],
        alwaysDenyRules: [],
        alwaysAskRules: [],
        isBypassPermissionsModeAvailable: false,
      },
    }
    const readFileCache = createFileStateCacheWithSizeLimit(20)
    const jsonSchema = { type: 'object' }
    const setupMcpTools = [mcpTool]
    const setupMcpCommands = [mcpCommand]
    const setupMcpClients = [mcpClient]
    const setupMcpResource = createNestedMcpResource()
    const expectedMcpResource = createNestedMcpResource()
    const setupMcpResources: Record<string, ServerResource[]> = {
      server: [setupMcpResource],
    }

    const config = createQueryEngineAppSessionConfigFromSetup({
      cwd: '/repo',
      tools: [tool],
      commands: [command],
      mcpTools: setupMcpTools,
      mcpCommands: setupMcpCommands,
      mcpClients: setupMcpClients,
      mcpResources: setupMcpResources,
      agents: [agent],
      getAppState: () => state,
      setAppState: update => {
        state = update(state)
      },
      readFileCache,
      customSystemPrompt: 'system prompt',
      appendSystemPrompt: 'append prompt',
      userSpecifiedModel: 'gpt-5.6-terra',
      fallbackModel: 'claude-sonnet-4-5-20250929',
      thinkingConfig: { type: 'enabled', budgetTokens: 1024 },
      verbose: true,
      maxTurns: 7,
      maxBudgetUsd: 3,
      taskBudget: { total: 2 },
      jsonSchema,
      replayUserMessages: true,
      setSDKStatus: () => {},
    })

    expect(config.cwd).toBe('/repo')
    expect(config.tools).toEqual([tool, mcpTool])
    expect(config.commands).toEqual([command, mcpCommand])
    expect(config.mcpClients).toEqual([mcpClient])
    expect(config.mcpResources).toEqual({
      server: [expectedMcpResource],
    })
    expect(config.getAppState().mcp).toMatchObject({
      clients: [mcpClient],
      tools: [mcpTool],
      commands: [mcpCommand],
      resources: { server: [expectedMcpResource] },
    })
    setupMcpTools.push({ name: 'mcp__server__mutated_tool' } as Tool)
    setupMcpCommands.push({ name: 'mutated-mcp-command' } as Command)
    setupMcpClients.push({
      name: 'mutated-server',
      type: 'connected',
    } as MCPServerConnection)
    setupMcpResources.server.push({
      uri: 'file://mutated',
      name: 'mutated-resource',
    } as ServerResource)
    setupMcpResources.mutated = [
      { uri: 'file://mutated-server', name: 'mutated-server-resource' } as ServerResource,
    ]
    expect(config.getAppState().mcp.tools).toEqual([mcpTool])
    expect(config.getAppState().mcp.commands).toEqual([mcpCommand])
    expect(config.getAppState().mcp.clients).toEqual([mcpClient])
    expect(config.getAppState().mcp.resources).toEqual({
      server: [expectedMcpResource],
    })
    setupMcpResource.name = 'setup-mutated-resource'
    setupMcpResource.annotations.audience.push('setup-mutated-audience')
    setupMcpResource.icons[0].src = 'file://setup-mutated-icon'
    setupMcpResource._meta.nested.label = 'setup-mutated-label'
    const firstState = config.getAppState()
    firstState.mcp.tools.push({ name: 'mcp__server__state_mutated_tool' } as Tool)
    firstState.mcp.commands.push({ name: 'state-mutated-mcp-command' } as Command)
    firstState.mcp.clients.push({
      name: 'state-mutated-server',
      type: 'connected',
    } as MCPServerConnection)
    firstState.mcp.resources.server.push({
      uri: 'file://state-mutated',
      name: 'state-mutated-resource',
    } as ServerResource)
    ;(firstState.mcp.resources.server[0] as { name: string }).name =
      'state-mutated-resource-name'
    ;(firstState.mcp.resources.server[0] as NestedServerResource).annotations.audience.push(
      'state-mutated-audience',
    )
    ;(firstState.mcp.resources.server[0] as NestedServerResource).icons[0].src =
      'file://state-mutated-icon'
    ;(firstState.mcp.resources.server[0] as NestedServerResource)._meta.nested.label =
      'state-mutated-label'
    const secondState = config.getAppState()
    const secondResource = secondState.mcp.resources.server[0] as NestedServerResource
    expect(secondState.mcp.tools).toEqual([mcpTool])
    expect(secondState.mcp.commands).toEqual([mcpCommand])
    expect(secondState.mcp.clients).toEqual([mcpClient])
    expect(secondState.mcp.resources).toEqual({
      server: [expectedMcpResource],
    })
    expect(secondResource.name).toBe('demo-resource')
    expect(secondResource.annotations.audience).toEqual(['user'])
    expect(secondResource.icons[0].src).toBe('file://icon')
    expect(secondResource._meta.nested.label).toBe('original')
    expect(config.agents).toEqual([agent])
    expect(config.canUseTool).toBeUndefined()
    expect(config.getAppState().toolPermissionContext.mode).toBe('plan')
    config.setAppState(prev => ({ ...prev, verbose: true }))
    expect(state.verbose).toBe(true)
    expect(config.readFileCache).toBe(readFileCache)
    expect(config.customSystemPrompt).toBe('system prompt')
    expect(config.appendSystemPrompt).toBe('append prompt')
    expect(config.userSpecifiedModel).toBe('gpt-5.6-terra')
    expect(config.fallbackModel).toBe('claude-sonnet-4-5-20250929')
    expect(config.thinkingConfig).toEqual({ type: 'enabled', budgetTokens: 1024 })
    expect(config.verbose).toBe(true)
    expect(config.maxTurns).toBe(7)
    expect(config.maxBudgetUsd).toBe(3)
    expect(config.taskBudget).toEqual({ total: 2 })
    expect(config.jsonSchema).toEqual(jsonSchema)
    expect(config.replayUserMessages).toBe(true)
    expect(config.includePartialMessages).toBe(true)
    expect(config.setSDKStatus).toBeTypeOf('function')
  })
  test('a live caller reads the store instead of the frozen setup overlay', () => {
    // The lifecycle publishes into the real store. With the overlay in place,
    // ToolSearch's pending-server check and AgentTool's required-server wait
    // both read the empty setup arrays forever, so a server that connects
    // mid-session stays invisible to them no matter what options.tools says.
    const liveClient = {
      name: 'cua-driver',
      type: 'connected',
    } as MCPServerConnection
    const liveTool = { name: 'mcp__cua-driver__click' } as Tool
    let state: AppState = {
      ...getDefaultAppState(),
      mcp: {
        clients: [liveClient],
        tools: [liveTool],
        commands: [mcpCommand],
        resources: { 'cua-driver': [mcpResource] },
      },
    } as AppState

    const config = createQueryEngineAppSessionConfigFromSetup({
      cwd: '/repo',
      tools: [tool],
      commands: [command],
      mcpTools: [],
      mcpCommands: [],
      mcpClients: [],
      mcpResources: {},
      getMcpRuntimeSnapshot: () => ({
        clients: [liveClient],
        tools: [liveTool],
        commands: [mcpCommand],
        resources: { 'cua-driver': [mcpResource] },
      }),
      agents: [agent],
      getAppState: () => state,
      setAppState: update => {
        state = update(state)
      },
      readFileCache: createFileStateCacheWithSizeLimit(20),
    })

    expect(config.getAppState().mcp.clients).toEqual([liveClient])
    expect(config.getAppState().mcp.tools).toEqual([liveTool])
    expect(config.getMcpRuntimeSnapshot).toBeTypeOf('function')
    // The engine layers each turn's snapshot onto these, so they must stay the
    // base pool and catalog rather than a pre-merged one.
    expect(config.tools).toEqual([tool])
    expect(config.commands).toEqual([command])
  })
})
