import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, mock, test } from 'bun:test'
import * as realMcpValidation from '../../utils/mcpValidation.js'
import * as realToolResultStorage from '../../utils/toolResultStorage.js'
import type { ConnectedMCPServer } from './types.js'

const persistedIds: string[] = []

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

const { connectToServer, fetchToolsForClient, processMCPResult } = await import(
  './client.js'
)

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

afterEach(() => {
  restoreConnectionCache?.()
  restoreConnectionCache = undefined
  persistedIds.length = 0
})

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
