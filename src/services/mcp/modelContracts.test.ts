import {
  CallToolResultSchema,
  ListToolsResultSchema,
  type CallToolResult,
  type Tool as ListedTool,
} from '@modelcontextprotocol/sdk/types.js'
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import sharp from 'sharp'
import type { Tool } from '../../Tool.js'
import type { APIProvider } from '../../utils/model/providers.js'
import type { ConnectedMCPServer } from './types.js'

const configDirectory = mkdtempSync(join(tmpdir(), 'cat-code-mcp-contracts-'))
const originalEnvironment = {
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
  CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING:
    process.env.CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING,
}
process.env.CLAUDE_CONFIG_DIR = configDirectory
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
const macroState = globalThis as typeof globalThis & {
  MACRO?: { VERSION: string; FEEDBACK_CHANNEL: string }
}
const originalMacro = macroState.MACRO
macroState.MACRO = { VERSION: 'test', FEEDBACK_CHANNEL: 'test' }
const originalFetch = globalThis.fetch
globalThis.fetch = (() => {
  throw new Error('MCP contract tests forbid network requests')
}) as unknown as typeof fetch

const { getEmptyToolPermissionContext } = await import('../../Tool.js')
const { setSessionProvider, getSessionProvider } = await import(
  '../../bootstrap/state.js'
)
const { normalizeContentFromAPI } = await import('../../utils/messages.js')
const { toolToAPISchema } = await import('../../utils/api.js')
const { clearToolSchemaCache } = await import(
  '../../utils/toolSchemaCache.js'
)
const { GrepTool } = await import('../../tools/GrepTool/GrepTool.js')
const { ToolSearchTool, clearToolSearchDescriptionCache } = await import(
  '../../tools/ToolSearchTool/ToolSearchTool.js'
)
const { fetchToolsForClient } = await import('./client.js')
const originalProvider = getSessionProvider()

afterEach(() => {
  fetchToolsForClient.cache.clear()
  clearToolSchemaCache()
  clearToolSearchDescriptionCache()
  setSessionProvider(originalProvider)
})

afterAll(() => {
  globalThis.fetch = originalFetch
  macroState.MACRO = originalMacro
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(configDirectory, { recursive: true, force: true })
})

function connectionFor(
  name: string,
  listTools: () => ListedTool[],
  callTool: (args: Record<string, unknown>) => CallToolResult = () => ({
    content: [{ type: 'text', text: 'ok' }],
  }),
): ConnectedMCPServer {
  return {
    type: 'connected',
    name,
    config: { type: 'sdk', name, scope: 'local' },
    capabilities: { tools: { listChanged: true } },
    cleanup: async () => {},
    client: {
      request: async () => ListToolsResultSchema.parse({ tools: listTools() }),
      callTool: async (request: { arguments: Record<string, unknown> }) =>
        CallToolResultSchema.parse(callTool(request.arguments)),
    },
  } as unknown as ConnectedMCPServer
}

function schemaOptions(tool: Tool, provider: APIProvider = 'openai') {
  return {
    tools: [tool],
    agents: [],
    model: provider === 'openai' ? 'gpt-6.1-sol' : 'claude-opus-5',
    provider,
    getToolPermissionContext: async () => getEmptyToolPermissionContext(),
  }
}

async function renderSchema(tool: Tool, provider: APIProvider = 'openai') {
  const schema = await toolToAPISchema(tool, schemaOptions(tool, provider))
  if (!('input_schema' in schema)) throw new Error('Expected a function tool schema')
  return schema
}

async function execute(tool: Tool, input: Record<string, unknown> = {}) {
  return tool.call(
    input,
    { abortController: new AbortController(), setAppState: () => {} } as never,
    undefined as never,
    { message: { content: [] } } as never,
    undefined,
  )
}

function decode(tool: Tool, input: Record<string, unknown>, provider?: APIProvider) {
  const [block] = normalizeContentFromAPI(
    [{ type: 'tool_use', id: 'call-contract', name: tool.name, input }],
    [tool],
    undefined,
    provider,
  )
  if (block?.type !== 'tool_use') throw new Error('Expected decoded tool call')
  return block.input as Record<string, unknown>
}

describe('model-facing MCP contracts', () => {
  test('keeps natural MCP property names through OpenAI decoding and the generated call', async () => {
    const modelInput = {
      context_lines: 4,
      case_insensitive: true,
      lines_after: 2,
      lines_before: 1,
      show_line_numbers: false,
    }
    let receivedArguments: Record<string, unknown> | undefined
    const connection = connectionFor(
      'natural-properties',
      () => [{
        name: 'lookup',
        inputSchema: {
          type: 'object',
          properties: {
            context_lines: { type: 'integer' },
            case_insensitive: { type: 'boolean' },
            lines_after: { type: 'integer' },
            lines_before: { type: 'integer' },
            show_line_numbers: { type: 'boolean' },
          },
        },
      }],
      args => {
        receivedArguments = args
        return { content: [{ type: 'text', text: 'found' }] }
      },
    )
    const [tool] = await fetchToolsForClient(connection)
    const schema = await renderSchema(tool!)
    expect(Object.keys(schema.input_schema.properties!)).toEqual(
      Object.keys(modelInput),
    )
    setSessionProvider('openai')
    const input = decode(tool!, modelInput)
    await execute(tool!, input)
    expect(receivedArguments).toEqual(modelInput)

    // Provider identity belongs to this request, even when the parent differs.
    setSessionProvider('firstParty')
    expect(decode(GrepTool, { pattern: 'needle', context_lines: 3 }, 'openai'))
      .toMatchObject({ pattern: 'needle', '-C': 3 })
    setSessionProvider('openai')
    expect(decode(GrepTool, { pattern: 'needle', context_lines: 3 }, 'firstParty'))
      .toMatchObject({ pattern: 'needle', context_lines: 3 })

    const collisionConnection = connectionFor('colliding-properties', () => [{
      name: 'lookup',
      inputSchema: {
        type: 'object',
        properties: {
          '-C': { type: 'integer' },
          context_lines: { type: 'string' },
          context_lines_2: { type: 'boolean' },
        },
        required: ['-C', 'context_lines'],
      },
    }])
    const [collisionTool] = await fetchToolsForClient(collisionConnection)
    const collisionSchema = await renderSchema(collisionTool!)
    expect(collisionSchema.input_schema.properties).toEqual({
      context_lines: { type: 'string' },
      context_lines_2: { type: 'boolean' },
      context_lines_3: { type: 'integer' },
    })
    expect(collisionSchema.input_schema.required).toEqual([
      'context_lines_3', 'context_lines',
    ])
    expect(decode(collisionTool!, {
      context_lines: 'natural', context_lines_2: false, context_lines_3: 4,
    }, 'openai')).toEqual({
      context_lines: 'natural', context_lines_2: false, '-C': 4,
    })
  })

  test('preserves distinct mixed content and emits structured compatibility copies once', async () => {
    const png = await sharp({
      create: { width: 1, height: 1, channels: 3, background: '#123456' },
    }).png().toBuffer()
    const structuredContent = { status: 'ok', count: 2 }
    let payload: CallToolResult = {
      structuredContent,
      content: [
        { type: 'text', text: 'Distinct essential answer' },
        { type: 'text', text: '{\n "count": 2, "status": "ok"\n}' },
        { type: 'image', mimeType: 'image/png', data: png.toString('base64') },
        { type: 'resource', resource: {
          uri: 'https://example.invalid/details', text: 'Supporting detail',
        } },
      ],
    }
    const connection = connectionFor('mixed-result', () => [{
      name: 'lookup', inputSchema: { type: 'object' },
    }], () => payload)
    const [tool] = await fetchToolsForClient(connection)
    const result = await execute(tool!)
    const mapped = tool!.mapToolResultToToolResultBlockParam(
      result.data, 'call-contract',
    )
    expect(mapped.content).toEqual([
      { type: 'text', text: JSON.stringify(structuredContent) },
      { type: 'text', text: 'Distinct essential answer' },
      { type: 'image', source: expect.objectContaining({
        type: 'base64', media_type: 'image/png', data: expect.any(String),
      }) },
      { type: 'text', text:
        '[Resource from mixed-result at https://example.invalid/details] Supporting detail' },
    ])
    expect(result.mcpMeta?.structuredContent).toEqual(structuredContent)

    payload = { structuredContent, content: [{
      type: 'text', text: JSON.stringify(structuredContent, null, 2),
    }] }
    expect((await execute(tool!)).data).toBe(JSON.stringify(structuredContent))
    payload = { content: [{ type: 'text', text: 'Content-only control' }] }
    expect((await execute(tool!)).data).toEqual([
      { type: 'text', text: 'Content-only control' },
    ])
  })

  test('authoritative rediscovery refreshes schemas and search without changing stable schema flags', async () => {
    process.env.CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING = '1'
    let description = 'Find the record using a numeric identifier'
    const connection = connectionFor('description-refresh', () => [{
      name: 'lookup', description, inputSchema: { type: 'object' },
    }])
    const [initialTool] = await fetchToolsForClient(connection)
    const initialSchema = await renderSchema(initialTool!, 'firstParty')
    expect('eager_input_streaming' in initialSchema && initialSchema.eager_input_streaming)
      .toBe(true)
    const search = (tool: Tool, query: string) => ToolSearchTool.call(
      { query, max_results: 5 },
      { options: { tools: [tool] }, getAppState: () => ({ mcp: { clients: [] } }) } as never,
    )
    expect((await search(initialTool!, 'numeric')).data.matches)
      .toEqual([initialTool!.name])

    // Model schema flags remain stable; only external definition bytes change.
    process.env.CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING = '0'
    description = 'Find the record using an exact slug'
    fetchToolsForClient.cache.delete(connection.name)
    const [updatedTool] = await fetchToolsForClient(connection)
    const updatedSchema = await renderSchema(updatedTool!, 'firstParty')
    expect(updatedSchema.description).toBe(description)
    expect(updatedSchema.input_schema).toEqual(initialSchema.input_schema)
    expect('eager_input_streaming' in updatedSchema && updatedSchema.eager_input_streaming)
      .toBe(true)
    expect((await search(updatedTool!, 'slug')).data.matches)
      .toEqual([updatedTool!.name])
    expect((await search(updatedTool!, 'numeric')).data.matches).toEqual([])

    fetchToolsForClient.cache.delete(connection.name)
    const [unchangedTool] = await fetchToolsForClient(connection)
    expect(await renderSchema(unchangedTool!, 'firstParty'))
      .toEqual(updatedSchema)
  })
})
