import { afterEach, describe, expect, mock, test } from 'bun:test'
import { createElement } from 'react'
import { PassThrough } from 'stream'

import { render } from '../../ink.js'
import {
  AppStateProvider,
  getDefaultAppState,
  useAppStateStore,
} from '../../state/AppState.js'
import type { AppStateStore } from '../../state/AppState.js'
import type { MCPServerConnection, ScopedMcpServerConfig } from './types.js'

const SERVER = 'race-server'
const CONFIG = {
  type: 'sse',
  url: 'https://example.invalid/sse',
  scope: 'local',
} as unknown as ScopedMcpServerConfig

type ReconnectResult = {
  client: MCPServerConnection
  tools: unknown[]
  commands: unknown[]
}

// Shared state the mocked modules read. Reset per test.
const disabledOnDisk = new Set<string>()
const clearServerCacheCalls: string[] = []
let reconnectImpl: (name: string) => Promise<ReconnectResult> = async () => {
  throw new Error('reconnectImpl not set')
}

const realSetTimeout = globalThis.setTimeout

/**
 * The reconnect loop sleeps 1s/2s/4s/8s between attempts. Shrink only those
 * long sleeps so a five-attempt run finishes in milliseconds; the 16ms
 * updateServer batching window is left alone.
 */
function shrinkBackoffTimers(): void {
  globalThis.setTimeout = ((
    fn: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) =>
    realSetTimeout(
      fn,
      ms !== undefined && ms >= 1000 ? 1 : ms,
      ...args,
    )) as unknown as typeof globalThis.setTimeout
}

function connectedResult(): ReconnectResult {
  return {
    client: {
      name: SERVER,
      type: 'connected',
      config: CONFIG,
      capabilities: {},
      cleanup: async () => { },
      client: {
        setNotificationHandler: () => { },
        removeNotificationHandler: () => { },
        setRequestHandler: () => { },
        onclose: undefined,
      },
    } as unknown as MCPServerConnection,
    tools: [],
    commands: [],
  }
}

function failedResult(): ReconnectResult {
  return {
    client: { name: SERVER, type: 'failed', config: CONFIG },
    tools: [],
    commands: [],
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function settle(ms = 60): Promise<void> {
  await new Promise(resolve => realSetTimeout(resolve, ms))
}

type HookApi = {
  reconnectMcpServer: (name: string) => Promise<unknown>
  toggleMcpServer: (name: string) => Promise<void>
}

async function mountHook(): Promise<{
  api: HookApi
  store: AppStateStore
  unmount: () => void
}> {
  await mock.module('./config.js', () => ({
    isMcpServerDisabled: (name: string) => disabledOnDisk.has(name),
    setMcpServerEnabled: (name: string, enabled: boolean) => {
      if (enabled) disabledOnDisk.delete(name)
      else disabledOnDisk.add(name)
    },
    getClaudeCodeMcpConfigs: async () => ({ servers: {}, errors: [] }),
    doesEnterpriseMcpConfigExist: () => false,
    filterMcpServersByPolicy: (servers: unknown) => ({
      allowed: servers,
      blocked: {},
    }),
    dedupClaudeAiMcpServers: (servers: unknown) => ({ servers, removed: [] }),
  }))
  await mock.module('./client.js', () => ({
    clearServerCache: async (name: string) => {
      clearServerCacheCalls.push(name)
    },
    fetchToolsForClient: Object.assign(async () => [], { cache: new Map() }),
    fetchCommandsForClient: Object.assign(async () => [], { cache: new Map() }),
    fetchResourcesForClient: Object.assign(async () => [], {
      cache: new Map(),
    }),
    getMcpToolsCommandsAndResources: async () => { },
    reconnectMcpServerImpl: (name: string) => reconnectImpl(name),
  }))
  await mock.module('./elicitationHandler.js', () => ({
    registerElicitationHandler: () => { },
  }))
  await mock.module('../analytics/index.js', () => ({
    logEvent: () => { },
  }))

  const { useManageMCPConnections } = await import(
    './useManageMCPConnections.js'
  )

  let api: HookApi | undefined
  let store: AppStateStore | undefined

  function Harness() {
    store = useAppStateStore()
    api = useManageMCPConnections(undefined, true) as HookApi
    return null
  }

  const defaultState = getDefaultAppState()
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream & {
    columns: number
  }
  stdout.columns = 100
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream
  const stderr = new PassThrough() as unknown as NodeJS.WriteStream

  const instance = await render(
    createElement(
      AppStateProvider,
      {
        initialState: {
          ...defaultState,
          mcp: {
            ...defaultState.mcp,
            clients: [{ name: SERVER, type: 'pending', config: CONFIG }],
          },
        },
      },
      createElement(Harness),
    ),
    { stdout, stdin, stderr, exitOnCtrlC: false, patchConsole: false },
  )

  await settle()
  if (!api || !store) throw new Error('hook did not mount')
  return { api, store, unmount: () => instance.unmount() }
}

function serverState(store: AppStateStore): MCPServerConnection | undefined {
  return store.getState().mcp.clients.find(c => c.name === SERVER)
}

/**
 * Drive the hook to a connected server whose onclose handler is installed,
 * install the reconnect behaviour the test needs, then fire onclose so the
 * automatic reconnect loop starts.
 */
async function startReconnectLoop(
  api: HookApi,
  loopImpl: () => Promise<ReconnectResult>,
): Promise<void> {
  const connected = connectedResult()
  reconnectImpl = async () => connected
  await api.reconnectMcpServer(SERVER)
  await settle()
  const onclose = (
    connected.client as unknown as { client: { onclose?: () => void } }
  ).client.onclose
  expect(typeof onclose).toBe('function')
  reconnectImpl = loopImpl
  onclose!()
}

describe('useManageMCPConnections automatic reconnect vs disable', () => {
  afterEach(() => {
    globalThis.setTimeout = realSetTimeout
    disabledOnDisk.clear()
    clearServerCacheCalls.length = 0
    mock.restore()
  })

  test('a reconnect that succeeds after the server was disabled does not resurrect it', async () => {
    const { api, store, unmount } = await mountHook()
    const inFlight = deferred<ReconnectResult>()

    await startReconnectLoop(api, async () => inFlight.promise)
    await settle()

    await api.toggleMcpServer(SERVER)
    await settle()
    expect(serverState(store)?.type).toBe('disabled')

    // Only teardown of the late connection should show up from here on.
    clearServerCacheCalls.length = 0
    inFlight.resolve(connectedResult())
    await settle()

    expect(serverState(store)?.type).toBe('disabled')
    expect(store.getState().mcp.tools).toEqual([])
    // The connection that came back has to be torn down, not left dangling.
    expect(clearServerCacheCalls).toContain(SERVER)
    unmount()
  })

  test('a max-attempt reconnect failure after a disable does not overwrite the disabled state', async () => {
    shrinkBackoffTimers()
    const { api, store, unmount } = await mountHook()
    const lastAttempt = deferred<ReconnectResult>()

    let attempts = 0
    await startReconnectLoop(api, async () => {
      attempts++
      // Attempts 1-4 resolve as failures so the loop reaches its final
      // attempt; the disable has to land inside that last attempt's window,
      // because the pre-attempt check already covers every earlier one.
      return attempts < 5 ? failedResult() : lastAttempt.promise
    })
    await settle(200)
    expect(attempts).toBe(5)

    await api.toggleMcpServer(SERVER)
    await settle()
    expect(serverState(store)?.type).toBe('disabled')

    lastAttempt.resolve(failedResult())
    await settle()

    expect(serverState(store)?.type).toBe('disabled')
    unmount()
  })

  test('a max-attempt reconnect throw after a disable does not overwrite the disabled state', async () => {
    shrinkBackoffTimers()
    const { api, store, unmount } = await mountHook()
    const lastAttempt = deferred<ReconnectResult>()

    let attempts = 0
    await startReconnectLoop(api, async () => {
      attempts++
      if (attempts < 5) return failedResult()
      return lastAttempt.promise
    })
    await settle(200)
    expect(attempts).toBe(5)

    await api.toggleMcpServer(SERVER)
    await settle()
    expect(serverState(store)?.type).toBe('disabled')

    lastAttempt.reject(new Error('transport gone'))
    await settle()

    expect(serverState(store)?.type).toBe('disabled')
    unmount()
  })
})
