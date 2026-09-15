import { describe, expect, test } from 'bun:test'
import type { Command } from '../commands.js'
import type {
  discoverMcpConnection,
  McpConnectionAcquisitionEvent,
} from '../services/mcp/client.js'
import type { McpServerStateUpdate } from '../services/mcp/mcpState.js'
import type {
  ConnectedMCPServer,
  MCPServerConnection,
  ScopedMcpServerConfig,
  ServerResource,
} from '../services/mcp/types.js'
import type { AppState } from '../state/AppStateStore.js'
import { createStore } from '../state/store.js'
import type { Tool } from '../Tool.js'
import { createAppRuntimeMcpLifecycle } from './createAppRuntimeMcpLifecycle.js'

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
const alphaTool = {
  name: 'mcp__alpha__ping',
  mcpInfo: { serverName: 'alpha', toolName: 'ping' },
} as Tool
const replacementTool = {
  name: 'mcp__alpha__replacement',
  mcpInfo: { serverName: 'alpha', toolName: 'replacement' },
} as Tool
const alphaCommand = { name: 'mcp__alpha__prompt' } as Command
const alphaResource = {
  server: 'alpha',
  uri: 'fixture://alpha',
  name: 'alpha',
} as ServerResource

type McpConnectionDiscovery = Awaited<ReturnType<typeof discoverMcpConnection>>

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createTestStore() {
  return createStore({
    mcp: {
      clients: [],
      tools: [],
      commands: [],
      resources: {},
      pluginReconnectKey: 0,
    },
  } as AppState)
}

function connected(
  name = 'alpha',
  config = alphaConfig,
): ConnectedMCPServer {
  return {
    name,
    type: 'connected',
    config,
    capabilities: {},
    cleanup: async () => {},
    client: { onclose: undefined } as ConnectedMCPServer['client'],
  }
}

function createHarness(options?: {
  configs?: Record<string, ScopedMcpServerConfig>
  disabled?: Set<string>
  connectRun?: Promise<void>
  discover?: typeof discoverMcpConnection
}) {
  const store = createTestStore()
  const calls = {
    config: [] as unknown[][],
    connect: 0,
    discover: 0,
    dispose: [] as string[],
    subscribe: 0,
    unsubscribe: 0,
  }
  let connectionCallback:
    | ((result: McpServerStateUpdate) => void)
    | undefined
  let acquisitionListener:
    | ((event: McpConnectionAcquisitionEvent) => void | Promise<void>)
    | undefined

  const lifecycle = createAppRuntimeMcpLifecycle(store, {
    getClaudeCodeMcpConfigs: async (...args: unknown[]) => {
      calls.config.push(args)
      return { servers: options?.configs ?? { alpha: alphaConfig }, errors: [] }
    },
    getMcpToolsCommandsAndResources: async callback => {
      calls.connect++
      connectionCallback = callback
      await (options?.connectRun ?? Promise.resolve())
    },
    discoverMcpConnection: async connection => {
      calls.discover++
      return options?.discover
        ? options.discover(connection)
        : { client: connection, tools: [], commands: [], resources: [] }
    },
    disposeServerConnection: async name => {
      calls.dispose.push(name)
    },
    getServerCacheKey: name => `${name}-key`,
    subscribeToMcpConnectionAcquisitions: listener => {
      calls.subscribe++
      acquisitionListener = listener
      return () => {
        calls.unsubscribe++
      }
    },
    isMcpServerDisabled: name => options?.disabled?.has(name) ?? false,
  })

  return {
    store,
    calls,
    lifecycle,
    getConnectionCallback: () => connectionCallback,
    getAcquisitionListener: () => acquisitionListener,
  }
}

async function nextTask(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('createAppRuntimeMcpLifecycle', () => {
  test('prepare uses explicit-only approval and seeds state without starting MCP', async () => {
    const harness = createHarness({
      configs: { alpha: alphaConfig, beta: betaConfig },
      disabled: new Set(['beta']),
    })

    await harness.lifecycle.prepare()
    await harness.lifecycle.prepare()

    expect(harness.calls.config).toHaveLength(1)
    expect(harness.calls.config[0]?.[2]).toEqual({
      projectMcpApproval: 'explicit-only',
    })
    expect(await (harness.calls.config[0]?.[1] as Promise<unknown>)).toEqual({})
    expect(harness.calls.connect).toBe(0)
    expect(harness.calls.discover).toBe(0)
    expect(harness.calls.subscribe).toBe(0)
    expect(harness.lifecycle.getSnapshot().clients.map(client => client.type)).toEqual(
      ['pending', 'disabled'],
    )
    expect(harness.lifecycle.getPreparedConfiguration()).toEqual({
      alpha: alphaConfig,
      beta: betaConfig,
    })
    expect(harness.lifecycle.getPreparedConfiguration()).toBe(
      harness.lifecycle.getPreparedConfiguration(),
    )
    expect(harness.calls.config).toHaveLength(1)
  })

  test('start is non-blocking, idempotent, fail-soft, and atomically publishes each result', async () => {
    const connectRun = deferred<void>()
    const harness = createHarness({
      configs: { alpha: alphaConfig, beta: betaConfig },
      connectRun: connectRun.promise,
    })
    await harness.lifecycle.prepare()

    const observedGenerations: Array<{
      state: string[]
      snapshot: string[]
      stateTools: string[]
      tools: string[]
      stateCommands: string[]
      commands: string[]
      stateResources: string[]
      resources: string[]
    }> = []
    harness.store.subscribe(() => {
      const state = harness.store.getState().mcp
      const snapshot = harness.lifecycle.getSnapshot()
      observedGenerations.push({
        state: state.clients.map(client => `${client.name}:${client.type}`),
        snapshot: snapshot.clients.map(
          client => `${client.name}:${client.type}`,
        ),
        stateTools: state.tools.map(tool => tool.name),
        tools: snapshot.tools.map(tool => tool.name),
        stateCommands: state.commands.map(command => command.name),
        commands: snapshot.commands.map(command => command.name),
        stateResources: Object.keys(state.resources),
        resources: Object.keys(snapshot.resources),
      })
    })

    expect(harness.lifecycle.start()).toBeUndefined()
    harness.lifecycle.start()
    await nextTask()
    expect(harness.calls.connect).toBe(1)
    expect(harness.calls.subscribe).toBe(1)

    harness.getConnectionCallback()!({
      client: connected(),
      tools: [alphaTool],
      commands: [alphaCommand],
      resources: [alphaResource],
    })
    harness.getConnectionCallback()!({
      client: {
        name: 'beta',
        type: 'failed',
        config: betaConfig,
        error: 'fixture failure',
      },
      tools: [],
      commands: [],
    })

    const snapshot = harness.lifecycle.getSnapshot()
    expect(snapshot.clients.map(client => `${client.name}:${client.type}`)).toEqual(
      ['alpha:connected', 'beta:failed'],
    )
    expect(snapshot.tools).toEqual([alphaTool])
    expect(snapshot.commands).toEqual([alphaCommand])
    expect(snapshot.resources).toEqual({ alpha: [alphaResource] })
    expect(observedGenerations.every(value => value.state.join() === value.snapshot.join())).toBe(
      true,
    )
    expect(
      observedGenerations.every(
        value =>
          value.stateTools.join() === value.tools.join() &&
          value.stateCommands.join() === value.commands.join() &&
          value.stateResources.join() === value.resources.join(),
      ),
    ).toBe(true)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.tools)).toBe(true)

    connectRun.resolve()
    await nextTask()
  })

  test('reads a fresh snapshot after an external MCP state update', async () => {
    const harness = createHarness()
    await harness.lifecycle.prepare()

    harness.store.setState(previous => ({
      ...previous,
      mcp: {
        ...previous.mcp,
        clients: [connected()],
        tools: [alphaTool],
        commands: [alphaCommand],
        resources: { alpha: [alphaResource] },
      },
    }))

    const snapshot = harness.lifecycle.getSnapshot()
    expect(snapshot.clients.map(client => client.type)).toEqual(['connected'])
    expect(snapshot.tools).toEqual([alphaTool])
    expect(snapshot.commands).toEqual([alphaCommand])
    expect(snapshot.resources).toEqual({ alpha: [alphaResource] })
  })

  test('an acquired replacement is discovered before publication and closes fail-closed', async () => {
    const discovery = deferred<McpConnectionDiscovery>()
    const originalCloseCalls: string[] = []
    const harness = createHarness({
      discover: () => discovery.promise,
    })
    await harness.lifecycle.prepare()
    harness.lifecycle.start()
    await nextTask()

    const replacement = connected()
    replacement.client.onclose = () => {
      originalCloseCalls.push('closed')
    }
    const adoption = Promise.resolve(
      harness.getAcquisitionListener()!({
        cacheKey: 'alpha-key',
        connection: replacement,
      }),
    )

    expect(harness.lifecycle.getSnapshot().clients[0]?.type).toBe('pending')
    expect(harness.calls.discover).toBe(1)

    discovery.resolve({
      client: replacement,
      tools: [replacementTool],
      commands: [alphaCommand],
      resources: [alphaResource],
    })
    await adoption

    expect(harness.lifecycle.getSnapshot().tools).toEqual([replacementTool])
    expect(harness.lifecycle.getSnapshot().resources).toEqual({
      alpha: [alphaResource],
    })

    replacement.client.onclose?.()
    expect(originalCloseCalls).toEqual(['closed'])
    expect(harness.lifecycle.getSnapshot().clients[0]?.type).toBe('failed')
    expect(harness.lifecycle.getSnapshot().tools).toEqual([])
    expect(harness.lifecycle.getSnapshot().commands).toEqual([])
    expect(harness.lifecycle.getSnapshot().resources).toEqual({})
  })

  test('dispose suppresses late results and uses non-connecting cleanup once per call sequence', async () => {
    const harness = createHarness()
    await harness.lifecycle.prepare()
    const firstDispose = harness.lifecycle.dispose()
    const secondDispose = harness.lifecycle.dispose()

    expect(secondDispose).toBe(firstDispose)
    await firstDispose
    expect(harness.calls.connect).toBe(0)
    expect(harness.calls.dispose).toEqual(['alpha'])

    harness.lifecycle.start()
    expect(harness.calls.connect).toBe(0)

    harness.getConnectionCallback()?.({
      client: connected(),
      tools: [alphaTool],
      commands: [alphaCommand],
      resources: [alphaResource],
    })
    await nextTask()

    expect(harness.lifecycle.getSnapshot().tools).toEqual([])
    expect(harness.calls.dispose).toEqual(['alpha'])
  })

  test('a result arriving after started lifecycle disposal is closed and never published', async () => {
    const connectRun = deferred<void>()
    const harness = createHarness({ connectRun: connectRun.promise })
    await harness.lifecycle.prepare()
    harness.lifecycle.start()
    await nextTask()

    await harness.lifecycle.dispose()
    const lateConnection = connected()
    harness.getConnectionCallback()!({
      client: lateConnection,
      tools: [alphaTool],
      commands: [alphaCommand],
      resources: [alphaResource],
    })
    await nextTask()

    expect(harness.lifecycle.getSnapshot().tools).toEqual([])
    expect(harness.calls.dispose).toEqual(['alpha', 'alpha'])
    expect(harness.calls.unsubscribe).toBe(0)
    connectRun.resolve()
  })

  test('an in-flight replacement is disposed instead of publishing after lifecycle disposal', async () => {
    const discovery = deferred<McpConnectionDiscovery>()
    const harness = createHarness({
      discover: () => discovery.promise,
    })
    await harness.lifecycle.prepare()
    harness.lifecycle.start()
    await nextTask()

    const replacement = connected()
    const adoption = Promise.resolve(
      harness.getAcquisitionListener()!({
        cacheKey: 'alpha-key',
        connection: replacement,
      }),
    )
    await harness.lifecycle.dispose()

    discovery.resolve({
      client: replacement,
      tools: [replacementTool],
      commands: [alphaCommand],
      resources: [alphaResource],
    })

    await expect(adoption).rejects.toMatchObject({ name: 'AbortError' })
    await nextTask()
    expect(harness.lifecycle.getSnapshot().tools).toEqual([])
    expect(harness.calls.dispose).toEqual(['alpha', 'alpha'])
  })

  test('a replacement acquired after disposal is rejected by the lifecycle tombstone', async () => {
    const harness = createHarness()
    await harness.lifecycle.prepare()
    harness.lifecycle.start()
    await nextTask()
    const acquisitionListener = harness.getAcquisitionListener()!

    await harness.lifecycle.dispose()
    await expect(
      Promise.resolve(
        acquisitionListener({
          cacheKey: 'alpha-key',
          connection: connected(),
        }),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    await nextTask()

    expect(harness.lifecycle.getSnapshot().tools).toEqual([])
    expect(harness.calls.dispose).toEqual(['alpha', 'alpha'])
    expect(harness.calls.unsubscribe).toBe(0)
  })

  test('dispose is safe before prepare and prevents later lifecycle work', async () => {
    const harness = createHarness()

    await harness.lifecycle.dispose()
    await harness.lifecycle.prepare()
    harness.lifecycle.start()

    expect(harness.calls.config).toEqual([])
    expect(harness.calls.connect).toBe(0)
    expect(harness.calls.dispose).toEqual([])
  })
})
