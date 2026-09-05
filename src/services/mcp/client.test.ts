import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import * as realExecFileNoThrow from '../../utils/execFileNoThrow.js'
import * as realMcpValidation from '../../utils/mcpValidation.js'
import * as realToolResultStorage from '../../utils/toolResultStorage.js'
import type {
  ConnectedMCPServer,
  ScopedMcpServerConfig,
} from './types.js'

const persistedIds: string[] = []
let headerHelperAbortSignal: AbortSignal | undefined

mock.module('../../utils/toolResultStorage.js', () => ({
  ...realToolResultStorage,
  persistToolResult: async (content: string, id: string) => {
    persistedIds.push(id)
    return {
      filepath: `/tmp/${id}.txt`,
      originalSize: content.length,
      isJson: false,
      preview: content.slice(0, 10),
      hasMore: true,
    }
  },
}))

mock.module('../../utils/mcpValidation.js', () => ({
  ...realMcpValidation,
  mcpContentNeedsTruncation: async () => true,
}))

mock.module('../../utils/execFileNoThrow.js', () => ({
  ...realExecFileNoThrow,
  execFileNoThrowWithCwd: (
    ...args: Parameters<typeof realExecFileNoThrow.execFileNoThrowWithCwd>
  ) => {
    if (args[0] !== 'test-hanging-helper') {
      return realExecFileNoThrow.execFileNoThrowWithCwd(...args)
    }
    headerHelperAbortSignal = args[2]?.abortSignal
    return new Promise(resolve => {
      headerHelperAbortSignal?.addEventListener(
        'abort',
        () => resolve({ stdout: '', stderr: '', code: 1 }),
        { once: true },
      )
    })
  },
}))

const macroState = globalThis as typeof globalThis & {
  MACRO?: { VERSION: string; FEEDBACK_CHANNEL: string }
}
const originalMacro = macroState.MACRO
macroState.MACRO = {
  VERSION: 'test',
  FEEDBACK_CHANNEL: 'test',
}

const {
  _mcpConnectionAcquisitionForTest,
  clearServerCache,
  connectToServer,
  disposeServerConnection,
  ensureConnectedClient,
  fetchCommandsForClient,
  fetchResourcesForClient,
  fetchToolsForClient,
  processMCPResult,
  resetMcpConnectionAcquisitionStateForTest,
  subscribeToMcpConnectionAcquisitions,
} = await import('./client.js')

type ListToolsPage = { tools: unknown[]; nextCursor?: string }

function makeListedTool(
  name: string,
  annotations?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: {} },
    ...(annotations && { annotations }),
  }
}

function makeConnection(options: {
  name: string
  listTools?: (cursor: string | undefined) => ListToolsPage
  callTool?: () => Promise<never>
}): ConnectedMCPServer {
  return {
    type: 'connected',
    name: options.name,
    capabilities: { tools: {} },
    config: { type: 'http', url: 'https://example.invalid/mcp', scope: 'local' },
    cleanup: async () => {},
    client: {
      request: async (request: { params?: { cursor?: string } }) =>
        options.listTools
          ? options.listTools(request.params?.cursor)
          : { tools: [] },
      callTool: async () => {
        if (!options.callTool) throw new Error('callTool not stubbed')
        return await options.callTool()
      },
    },
  } as unknown as ConnectedMCPServer
}

/**
 * Pin every connectToServer lookup to one connection and make the cache
 * deletion performed by clearServerCache inert, so the retry path can be
 * exercised without a real transport.
 */
let restoreConnectionCache: (() => void) | undefined
const temporaryDirectories: string[] = []

function pinConnection(connection: ConnectedMCPServer): void {
  const memoized = connectToServer as unknown as { cache: unknown }
  const original = memoized.cache
  restoreConnectionCache = () => {
    memoized.cache = original
  }
  const sticky = {
    has: () => true,
    get: () => Promise.resolve(connection),
    set: () => sticky,
    delete: () => true,
    clear: () => {},
  }
  memoized.cache = sticky
}

afterEach(async () => {
  restoreConnectionCache?.()
  restoreConnectionCache = undefined
  persistedIds.length = 0
  headerHelperAbortSignal = undefined
  await resetMcpConnectionAcquisitionStateForTest()
  await Promise.all(
    temporaryDirectories.splice(0).map(path =>
      rm(path, { recursive: true, force: true }),
    ),
  )
})

afterAll(() => {
  macroState.MACRO = originalMacro
})

async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'cat-code-mcp-lifecycle-'))
  temporaryDirectories.push(path)
  return path
}

async function waitForFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      return await readFile(path, 'utf8')
    } catch {
      await Bun.sleep(10)
    }
  }
  throw new Error(`Timed out waiting for ${path}`)
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      process.kill(pid, 0)
      await Bun.sleep(10)
    } catch {
      return
    }
  }
  throw new Error(`Process ${pid} did not exit`)
}

async function waitForHeaderHelperStart(): Promise<AbortSignal> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (headerHelperAbortSignal) return headerHelperAbortSignal
    await Bun.sleep(10)
  }
  throw new Error('Timed out waiting for headers helper')
}

async function callGeneratedTool(
  connection: ConnectedMCPServer,
  toolName: string,
): Promise<void> {
  const tools = await fetchToolsForClient(connection)
  const tool = tools.find(t => t.mcpInfo?.toolName === toolName)!
  await tool.call(
    { arg: 1 },
    {
      abortController: new AbortController(),
      setAppState: () => {},
    } as never,
    undefined as never,
    { message: { content: [] } } as never,
    undefined,
  )
}

describe('processMCPResult large-output persistence', () => {
  test('two same-millisecond results for one tool get distinct persist ids', async () => {
    const originalNow = Date.now
    Date.now = () => 1_700_000_000_000
    try {
      await processMCPResult(
        { content: [{ type: 'text', text: 'a'.repeat(200) }] },
        'search',
        'slack',
      )
      await processMCPResult(
        { content: [{ type: 'text', text: 'b'.repeat(200) }] },
        'search',
        'slack',
      )
    } finally {
      Date.now = originalNow
    }

    expect(persistedIds).toHaveLength(2)
    expect(persistedIds[0]).not.toBe(persistedIds[1])
  })
})

describe('fetchToolsForClient pagination', () => {
  test('follows nextCursor so tools past the first page are discovered', async () => {
    const cursors: Array<string | undefined> = []
    const connection = makeConnection({
      name: 'paged-server',
      listTools: cursor => {
        cursors.push(cursor)
        return cursor === undefined
          ? { tools: [makeListedTool('first')], nextCursor: 'page-2' }
          : { tools: [makeListedTool('second')] }
      },
    })

    const tools = await fetchToolsForClient(connection)

    expect(tools.map(t => t.mcpInfo?.toolName)).toEqual(['first', 'second'])
    expect(cursors).toEqual([undefined, 'page-2'])
  })

  test('stops after the page cap when a server always returns a cursor', async () => {
    let pages = 0
    const connection = makeConnection({
      name: 'endless-server',
      listTools: () => {
        pages++
        return { tools: [makeListedTool(`tool-${pages}`)], nextCursor: 'more' }
      },
    })

    const tools = await fetchToolsForClient(connection)

    expect(pages).toBe(20)
    expect(tools).toHaveLength(20)
  })
})

describe('fetchToolsForClient discovery failure', () => {
  test('a transient tools/list failure is not cached as an empty tool set', async () => {
    let attempts = 0
    const connection = makeConnection({
      name: 'flaky-server',
      listTools: () => {
        attempts++
        if (attempts === 1) throw new Error('transient discovery failure')
        return { tools: [makeListedTool('recovered')] }
      },
    })

    expect(await fetchToolsForClient(connection)).toEqual([])
    const retried = await fetchToolsForClient(connection)

    expect(attempts).toBe(2)
    expect(retried.map(t => t.mcpInfo?.toolName)).toEqual(['recovered'])
  })
})

describe('generated MCP tool session-retry gate', () => {
  test('an ambiguous connection close does not replay a write tool', async () => {
    let calls = 0
    const connection = makeConnection({
      name: 'closer-write-server',
      listTools: () => ({ tools: [makeListedTool('post_message')] }),
      callTool: async () => {
        calls++
        throw new McpError(ErrorCode.ConnectionClosed, 'Connection closed')
      },
    })
    pinConnection(connection)

    await expect(
      callGeneratedTool(connection, 'post_message'),
    ).rejects.toThrow()
    expect(calls).toBe(1)
  })

  test('an ambiguous connection close still replays a read-only tool', async () => {
    let calls = 0
    const connection = makeConnection({
      name: 'closer-read-server',
      listTools: () => ({
        tools: [makeListedTool('search', { readOnlyHint: true })],
      }),
      callTool: async () => {
        calls++
        throw new McpError(ErrorCode.ConnectionClosed, 'Connection closed')
      },
    })
    pinConnection(connection)

    await expect(callGeneratedTool(connection, 'search')).rejects.toThrow()
    expect(calls).toBe(2)
  })

  test('a confirmed session expiry still replays a write tool', async () => {
    let calls = 0
    const connection = makeConnection({
      name: 'expired-write-server',
      listTools: () => ({ tools: [makeListedTool('post_message')] }),
      callTool: async () => {
        calls++
        throw Object.assign(
          new Error('HTTP 404: {"error":{"code":-32001,"message":"Session"}}'),
          { code: 404 },
        )
      },
    })
    pinConnection(connection)

    await expect(
      callGeneratedTool(connection, 'post_message'),
    ).rejects.toThrow()
    expect(calls).toBe(2)
  })
})

describe('MCP connection acquisition ownership', () => {
  test('disposes a pending stdio child without waiting for connection discovery', async () => {
    const directory = await createTemporaryDirectory()
    const pidPath = join(directory, 'stdio.pid')
    const config = {
      type: 'stdio',
      command: process.execPath,
      args: [
        '-e',
        `await Bun.write(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000)`,
      ],
      scope: 'local',
    } satisfies ScopedMcpServerConfig

    const connectionPromise = connectToServer('pending-stdio', config)
    const pid = Number(await waitForFile(pidPath))

    await disposeServerConnection('pending-stdio', config)
    const result = await connectionPromise
    await waitForProcessExit(pid)

    expect(result.type).toBe('failed')
  })

  test('keeps a replacement cached while an explicitly disposed connection closes', async () => {
    const config = {
      type: 'stdio',
      command: process.execPath,
      args: [
        '-e',
        "process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); import { Server } from '@modelcontextprotocol/sdk/server/index.js'; import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'; const server = new Server({name:'fixture',version:'1.0.0'},{capabilities:{}}); await server.connect(new StdioServerTransport())",
      ],
      scope: 'local',
    } satisfies ScopedMcpServerConfig

    const initial = await connectToServer('overlap-stdio', config)
    expect(initial.type).toBe('connected')

    let disposalFinished = false
    const disposal = disposeServerConnection('overlap-stdio', config).then(
      () => {
        disposalFinished = true
      },
    )
    const replacement = await connectToServer('overlap-stdio', config)

    expect(disposalFinished).toBe(false)
    expect(replacement.type).toBe('connected')
    expect(replacement).not.toBe(initial)

    await disposal

    expect(await connectToServer('overlap-stdio', config)).toBe(replacement)
  })

  test('aborts a hanging headers helper before network setup', async () => {
    const config = {
      type: 'ws',
      url: 'ws://127.0.0.1:1',
      headersHelper: 'test-hanging-helper',
      scope: 'user',
    } satisfies ScopedMcpServerConfig

    const connectionPromise = connectToServer('pending-headers', config)
    const abortSignal = await waitForHeaderHelperStart()

    await disposeServerConnection('pending-headers', config)
    const result = await connectionPromise

    expect(abortSignal.aborted).toBe(true)
    expect(result.type).toBe('failed')
  })

  test('cleans an in-process server when setup fails', async () => {
    const acquisition =
      _mcpConnectionAcquisitionForTest.begin('failed-in-process')
    let closes = 0
    const server = {
      connect: async () => {
        throw new Error('setup failed')
      },
      close: async () => {
        closes++
      },
    }

    await expect(
      _mcpConnectionAcquisitionForTest.connectInProcessServer(
        acquisition,
        server,
        {} as never,
      ),
    ).rejects.toThrow('setup failed')
    await acquisition.dispose()

    expect(closes).toBe(1)
  })

  test('cache disposal does not create an absent connection', async () => {
    const directory = await createTemporaryDirectory()
    const markerPath = join(directory, 'started')
    const config = {
      type: 'stdio',
      command: process.execPath,
      args: ['-e', `await Bun.write(${JSON.stringify(markerPath)}, 'started')`],
      scope: 'local',
    } satisfies ScopedMcpServerConfig

    await clearServerCache('absent-server', config)
    await Bun.sleep(50)

    await expect(readFile(markerPath, 'utf8')).rejects.toThrow()
  })

  test('observers see lazy replacements before they become live', async () => {
    const observed: ConnectedMCPServer[] = []
    subscribeToMcpConnectionAcquisitions(async event => {
      await Bun.sleep(1)
      observed.push(event.connection)
    })
    const config = {
      type: 'stdio',
      command: process.execPath,
      args: [
        '-e',
        "import { Server } from '@modelcontextprotocol/sdk/server/index.js'; import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'; const server = new Server({name:'fixture',version:'1.0.0'},{capabilities:{}}); await server.connect(new StdioServerTransport())",
      ],
      scope: 'local',
    } satisfies ScopedMcpServerConfig

    const initial = await connectToServer('replacement-server', config)
    expect(initial.type).toBe('connected')
    if (initial.type !== 'connected') return
    expect(observed).toEqual([initial])

    await clearServerCache('replacement-server', config)
    const replacement = await ensureConnectedClient(initial)

    expect(replacement).not.toBe(initial)
    expect(observed).toEqual([initial, replacement])
    await replacement.cleanup()
  })

  test('a failed observer does not reject a healthy connection acquisition', async () => {
    subscribeToMcpConnectionAcquisitions(async () => {
      throw new Error('transient discovery failure')
    })
    const acquisition =
      _mcpConnectionAcquisitionForTest.begin('observer-failure')

    await expect(
      _mcpConnectionAcquisitionForTest.publish(
        acquisition,
        makeConnection({ name: 'observer-failure' }),
      ),
    ).resolves.toBeUndefined()
    await acquisition.dispose()
  })

  test('reset evicts failed connections and discovery results', async () => {
    const directory = await createTemporaryDirectory()
    const attemptsPath = join(directory, 'attempts')
    const serverName = 'failed-reset-server'
    const config = {
      type: 'stdio',
      command: process.execPath,
      args: [
        '-e',
        `const path = ${JSON.stringify(attemptsPath)}; const attempts = await Bun.file(path).text().catch(() => ''); await Bun.write(path, attempts + 'x')`,
      ],
      scope: 'local',
    } satisfies ScopedMcpServerConfig

    const first = await connectToServer(serverName, config)
    const reused = await connectToServer(serverName, config)
    expect(first.type).toBe('failed')
    expect(reused).toBe(first)
    expect(await readFile(attemptsPath, 'utf8')).toBe('x')

    const discoveryClient = {
      ...makeConnection({ name: serverName }),
      capabilities: { tools: {}, resources: {}, prompts: {} },
      client: {
        request: async ({ method }: { method: string }) => {
          if (method === 'tools/list') return { tools: [] }
          if (method === 'resources/list') return { resources: [] }
          return { prompts: [] }
        },
      },
    } as unknown as ConnectedMCPServer
    await Promise.all([
      fetchToolsForClient(discoveryClient),
      fetchResourcesForClient(discoveryClient),
      fetchCommandsForClient(discoveryClient),
    ])
    expect(fetchToolsForClient.cache.has(serverName)).toBe(true)
    expect(fetchResourcesForClient.cache.has(serverName)).toBe(true)
    expect(fetchCommandsForClient.cache.has(serverName)).toBe(true)

    await resetMcpConnectionAcquisitionStateForTest()

    expect(fetchToolsForClient.cache.has(serverName)).toBe(false)
    expect(fetchResourcesForClient.cache.has(serverName)).toBe(false)
    expect(fetchCommandsForClient.cache.has(serverName)).toBe(false)
    const retried = await connectToServer(serverName, config)
    expect(retried.type).toBe('failed')
    expect(retried).not.toBe(first)
    expect(await readFile(attemptsPath, 'utf8')).toBe('xx')
  })

  test('disposal is idempotent and reset clears owned state and observers', async () => {
    let cleanups = 0
    let observations = 0
    subscribeToMcpConnectionAcquisitions(() => {
      observations++
    })
    const acquisition = _mcpConnectionAcquisitionForTest.begin('reset-server')
    acquisition.own(async () => {
      cleanups++
    })

    await Promise.all([acquisition.dispose(), acquisition.dispose()])
    expect(cleanups).toBe(1)

    const connected =
      _mcpConnectionAcquisitionForTest.begin('connected-server')
    const cleanup = connected.complete(async () => {
      cleanups++
    })
    await Promise.all([cleanup(), cleanup()])
    expect(cleanups).toBe(2)

    const second = _mcpConnectionAcquisitionForTest.begin('reset-server-2')
    second.own(async () => {
      cleanups++
    })
    await resetMcpConnectionAcquisitionStateForTest()
    const afterReset = _mcpConnectionAcquisitionForTest.begin('after-reset')
    await _mcpConnectionAcquisitionForTest.publish(
      afterReset,
      makeConnection({ name: 'after-reset' }),
    )

    expect(cleanups).toBe(3)
    expect(observations).toBe(0)
    await afterReset.dispose()
  })
})
