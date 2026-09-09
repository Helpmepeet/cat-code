import type { AppStateStore } from '../state/AppStateStore.js'
import type { McpRuntimeSnapshot } from '../Tool.js'
import {
  discoverMcpConnection,
  disposeServerConnection,
  getMcpToolsCommandsAndResources,
  getServerCacheKey,
  subscribeToMcpConnectionAcquisitions,
  type McpConnectionAcquisitionEvent,
} from '../services/mcp/client.js'
import {
  getClaudeCodeMcpConfigs,
  isMcpServerDisabled,
} from '../services/mcp/config.js'
import {
  applyMcpServerStateUpdate,
  seedMcpServerStates,
  type McpServerStateUpdate,
  type McpState,
} from '../services/mcp/mcpState.js'
import type {
  ConnectedMCPServer,
  ScopedMcpServerConfig,
  ServerResource,
} from '../services/mcp/types.js'
import { errorMessage } from '../utils/errors.js'
import { logMCPError } from '../utils/log.js'

export type AppRuntimeMcpLifecycle = {
  prepare(): Promise<void>
  start(): void
  getSnapshot(): McpRuntimeSnapshot
  getPreparedConfiguration(): Readonly<Record<string, ScopedMcpServerConfig>>
  dispose(): Promise<void>
}

type AppRuntimeMcpLifecycleDependencies = {
  getClaudeCodeMcpConfigs: typeof getClaudeCodeMcpConfigs
  getMcpToolsCommandsAndResources: typeof getMcpToolsCommandsAndResources
  discoverMcpConnection: typeof discoverMcpConnection
  disposeServerConnection: typeof disposeServerConnection
  getServerCacheKey: typeof getServerCacheKey
  subscribeToMcpConnectionAcquisitions:
    typeof subscribeToMcpConnectionAcquisitions
  isMcpServerDisabled: typeof isMcpServerDisabled
}

const defaultDependencies: AppRuntimeMcpLifecycleDependencies = {
  getClaudeCodeMcpConfigs,
  getMcpToolsCommandsAndResources,
  discoverMcpConnection,
  disposeServerConnection,
  getServerCacheKey,
  subscribeToMcpConnectionAcquisitions,
  isMcpServerDisabled,
}

function createSnapshot(mcp: McpState): McpRuntimeSnapshot {
  const resources = Object.fromEntries(
    Object.entries<readonly ServerResource[]>(mcp.resources).map(
      ([name, entries]) => [
        name,
        Object.freeze([...entries]),
      ],
    ),
  )

  return Object.freeze({
    clients: Object.freeze([...mcp.clients]),
    tools: Object.freeze([...mcp.tools]),
    commands: Object.freeze([...mcp.commands]),
    resources: Object.freeze(resources),
  })
}

function abortError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

export function createAppRuntimeMcpLifecycle(
  store: AppStateStore,
  dependencyOverrides: Partial<AppRuntimeMcpLifecycleDependencies> = {},
): AppRuntimeMcpLifecycle {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides }
  let snapshotMcp = store.getState().mcp
  let snapshot = createSnapshot(snapshotMcp)
  let configs: Record<string, ScopedMcpServerConfig> = {}
  let preparePromise: Promise<void> | undefined
  let disposePromise: Promise<void> | undefined
  let started = false
  let disposed = false
  let generation = 0
  const serverRevisions = new Map<string, number>()
  const adoptedClients = new WeakSet<object>()

  const updateMcpState = (updater: (mcp: McpState) => McpState): void => {
    store.setState(previous => {
      const mcp = updater(previous.mcp)
      if (mcp === previous.mcp) return previous
      snapshotMcp = mcp
      snapshot = createSnapshot(mcp)
      return { ...previous, mcp }
    })
  }

  const disposeLateConnection = (connection: ConnectedMCPServer): void => {
    connection.client.onclose = undefined
    void dependencies
      .disposeServerConnection(connection.name, connection.config)
      .catch(error => {
        logMCPError(
          connection.name,
          `Failed to dispose late MCP connection: ${errorMessage(error)}`,
        )
      })
  }

  const isCurrent = (
    cacheKey: string,
    lifecycleGeneration: number,
    serverRevision: number,
  ): boolean =>
    !disposed &&
    generation === lifecycleGeneration &&
    serverRevisions.get(cacheKey) === serverRevision

  const publishUpdate = (update: McpServerStateUpdate): void => {
    updateMcpState(mcp => applyMcpServerStateUpdate(mcp, update))
  }

  const installCloseHandler = (
    connection: ConnectedMCPServer,
    cacheKey: string,
    lifecycleGeneration: number,
    serverRevision: number,
  ): void => {
    const originalOnclose = connection.client.onclose
    connection.client.onclose = () => {
      try {
        originalOnclose?.()
      } finally {
        if (!isCurrent(cacheKey, lifecycleGeneration, serverRevision)) return
        serverRevisions.set(cacheKey, serverRevision + 1)
        publishUpdate({
          client: {
            name: connection.name,
            type: 'failed',
            config: connection.config,
          },
        })
      }
    }
  }

  const ownsEvent = (
    event: McpConnectionAcquisitionEvent,
  ): ScopedMcpServerConfig | undefined => {
    const config = configs[event.connection.name]
    if (
      config &&
      dependencies.getServerCacheKey(event.connection.name, config) ===
        event.cacheKey
    ) {
      return config
    }
    return undefined
  }

  const adoptAcquiredConnection = async (
    event: McpConnectionAcquisitionEvent,
  ): Promise<void> => {
    if (!ownsEvent(event)) return
    if (disposed) {
      disposeLateConnection(event.connection)
      throw abortError('App-runtime MCP lifecycle was disposed')
    }

    const lifecycleGeneration = generation
    const serverRevision = (serverRevisions.get(event.cacheKey) ?? 0) + 1
    serverRevisions.set(event.cacheKey, serverRevision)
    installCloseHandler(
      event.connection,
      event.cacheKey,
      lifecycleGeneration,
      serverRevision,
    )

    let result: McpServerStateUpdate
    try {
      result = await dependencies.discoverMcpConnection(event.connection)
    } catch (error) {
      if (isCurrent(event.cacheKey, lifecycleGeneration, serverRevision)) {
        publishUpdate({
          client: {
            name: event.connection.name,
            type: 'failed',
            config: event.connection.config,
            error: errorMessage(error),
          },
        })
      }
      throw error
    }

    if (!isCurrent(event.cacheKey, lifecycleGeneration, serverRevision)) {
      disposeLateConnection(event.connection)
      throw abortError('MCP connection belongs to an inactive lifecycle')
    }

    adoptedClients.add(event.connection.client)
    publishUpdate(result)
  }

  const handleConnectionResult = (result: McpServerStateUpdate): void => {
    const config = configs[result.client.name]
    if (!config) return
    const cacheKey = dependencies.getServerCacheKey(result.client.name, config)

    if (disposed) {
      if (result.client.type === 'connected') {
        disposeLateConnection(result.client)
      }
      return
    }

    if (
      result.client.type === 'connected' &&
      adoptedClients.has(result.client.client)
    ) {
      return
    }

    const serverRevision = (serverRevisions.get(cacheKey) ?? 0) + 1
    serverRevisions.set(cacheKey, serverRevision)
    if (result.client.type === 'connected') {
      installCloseHandler(
        result.client,
        cacheKey,
        generation,
        serverRevision,
      )
      adoptedClients.add(result.client.client)
    }
    publishUpdate(result)
  }

  const prepare = (): Promise<void> => {
    if (preparePromise) return preparePromise
    if (disposed) return Promise.resolve()

    preparePromise = (async () => {
      const { servers } = await dependencies.getClaudeCodeMcpConfigs(
        {},
        Promise.resolve({}),
        { projectMcpApproval: 'explicit-only' },
      )
      if (disposed) return

      configs = servers
      updateMcpState(mcp =>
        seedMcpServerStates(
          mcp,
          configs,
          dependencies.isMcpServerDisabled,
        ),
      )
    })()
    return preparePromise
  }

  const start = (): void => {
    if (started || disposed) return
    started = true
    const lifecycleGeneration = ++generation

    void prepare()
      .then(async () => {
        if (
          disposed ||
          generation !== lifecycleGeneration ||
          Object.keys(configs).length === 0
        ) {
          return
        }

        // Keep the disposed listener as a tombstone until this session process
        // exits. A stale wrapper can acquire a replacement after dispose(), and
        // without this guard that new transport would have no owner to close it.
        dependencies.subscribeToMcpConnectionAcquisitions(
          adoptAcquiredConnection,
        )
        await dependencies.getMcpToolsCommandsAndResources(
          handleConnectionResult,
          configs,
        )
      })
      .catch(error => {
        if (!disposed) {
          logMCPError(
            'app-runtime',
            `Failed to start MCP lifecycle: ${errorMessage(error)}`,
          )
        }
      })
  }

  const dispose = (): Promise<void> => {
    if (disposePromise) return disposePromise
    disposed = true
    generation++

    const ownedEntries = Object.entries(configs)
    const ownedNames = new Set(Object.keys(configs))
    for (const connection of store.getState().mcp.clients) {
      if (ownedNames.has(connection.name) && connection.type === 'connected') {
        connection.client.onclose = undefined
      }
    }

    if (ownedEntries.length > 0) {
      updateMcpState(mcp =>
        ownedEntries.reduce(
          (next, [name, config]) =>
            applyMcpServerStateUpdate(next, {
              client: { name, type: 'failed', config },
            }),
          mcp,
        ),
      )
    }

    disposePromise = Promise.allSettled(
      ownedEntries.map(([name, config]) =>
        dependencies.disposeServerConnection(name, config),
      ),
    ).then(results => {
      const rejected = results.filter(result => result.status === 'rejected')
      if (rejected.length > 0) {
        logMCPError(
          'app-runtime',
          `Failed to dispose ${rejected.length} MCP server connection(s)`,
        )
      }
    })
    return disposePromise
  }

  return {
    prepare,
    start,
    getSnapshot: () => {
      const mcp = store.getState().mcp
      if (mcp !== snapshotMcp) {
        snapshotMcp = mcp
        snapshot = createSnapshot(mcp)
      }
      return snapshot
    },
    getPreparedConfiguration: () => configs,
    dispose,
  }
}
