import { afterAll, describe, expect, test } from 'bun:test'
import { PNG } from 'pngjs'
import { createCuaDriverRun } from '../../utils/cuaDriver/run.js'
import type { CallToolResult, Tool as McpTool } from '@modelcontextprotocol/sdk/types.js'
import type { ConnectedMCPServer } from './types.js'

const macroState = globalThis as typeof globalThis & {
  MACRO?: { VERSION: string; FEEDBACK_CHANNEL: string }
}
const originalMacro = macroState.MACRO
macroState.MACRO = { VERSION: 'test', FEEDBACK_CHANNEL: 'test' }
const { fetchToolsForClient } = await import('./client.js')
afterAll(() => { macroState.MACRO = originalMacro })

function image(width: number, height: number, wrong = false): CallToolResult {
  const png = new PNG({ width, height })
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      png.data.set([wrong ? 255 : x, wrong ? 0 : y, wrong ? 0 : 200, 255], i)
    }
  }
  return { content: [{ type: 'image', mimeType: 'image/png',
    data: PNG.sync.write(png).toString('base64') }] }
}

const zoom: McpTool = {
  name: 'zoom', description: 'PID-only native zoom',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: Object.fromEntries(['pid', 'x1', 'y1', 'x2', 'y2']
      .map(key => [key, { type: 'number' }])),
    required: ['pid', 'x1', 'y1', 'x2', 'y2'],
  },
}
const click: McpTool = {
  name: 'click', inputSchema: { type: 'object', properties: {
    pid: { type: 'integer' }, window_id: { type: 'integer' },
    x: { type: 'number' }, y: { type: 'number' },
    from_zoom: { type: 'boolean' },
  } },
}

async function fixture(options: {
  compatibility?: boolean
  otherServer?: boolean
  replaceTransport?: boolean
  snapshot?: CallToolResult
  native?: CallToolResult
  windowPid?: number
} = {}) {
  let compatibility = options.compatibility ?? false
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = []
  const connection = {
    type: 'connected', name: `window-crop-${crypto.randomUUID()}`,
    capabilities: { tools: {} }, cleanup: async () => {},
    config: { type: 'sdk', name: 'in-process-window-fixture', scope: 'local' },
    serverInfo: { name: options.otherServer ? 'another-driver' : 'cua-driver', version: '0.1.9' },
    client: {
      request: async () => ({ tools: [zoom, click, {
        name: 'get_window_state', inputSchema: { type: 'object',
          properties: { pid: { type: 'integer' }, window_id: { type: 'integer' } },
          required: ['pid', 'window_id'] },
      }, {
        name: 'screenshot', inputSchema: { type: 'object', additionalProperties: false,
          properties: { window_id: { type: 'integer' },
            ...(compatibility ? { pid: { type: 'integer' } } : { format: { type: 'string' } }) },
          required: compatibility ? ['pid', 'window_id'] : ['window_id'] },
      }] }),
      callTool: async (request: { name: string; arguments: Record<string, unknown> }) => {
        calls.push({ name: request.name, arguments: request.arguments })
        if (request.name === 'get_window_state') return options.snapshot ?? image(100, 80)
        if (request.name === 'screenshot') return options.native ?? image(200, 160)
        if (request.name === 'list_windows') return {
          content: [], structuredContent: { windows: [{
            pid: options.windowPid ?? 41, window_id: 72, on_current_space: true,
          }] },
        }
        // The confirmed bug: PID-only zoom can capture an unrelated window.
        if (request.name === 'zoom') return image(20, 20, true)
        return { content: [{ type: 'text', text: 'clicked' }] }
      },
    },
  } as unknown as ConnectedMCPServer
  const tools = await fetchToolsForClient(connection)
  if (options.replaceTransport) {
    // Reconnection replaces the SDK instance and may negotiate a different
    // screenshot contract while the model retains its generated zoom tool.
    compatibility = !compatibility
    connection.client = { ...connection.client } as typeof connection.client
  }
  const defaultRun = createCuaDriverRun()
  const abortController = new AbortController()
  async function invoke(name: string, args: Record<string, unknown>, run = defaultRun) {
    const tool = tools.find(tool => tool.mcpInfo?.toolName === name)!
    return tool.call(args, {
      abortController, cuaDriverRun: run, setAppState: () => {},
    } as never, (() => {}) as never, { message: { content: [] } } as never)
  }
  return { tools, calls, invoke }
}

describe('window-scoped CuaDriver MCP zoom', () => {
  test.each([
    { compatibility: false, replaceTransport: false },
    { compatibility: true, replaceTransport: false },
    { compatibility: false, replaceTransport: true },
  ])('crops the selected window at native resolution ($compatibility, reconnect=$replaceTransport)', async options => {
    const { tools, calls, invoke } = await fixture(options)
    const compatibility = options.compatibility !== options.replaceTransport
    await invoke('get_window_state', { pid: 41, window_id: 72 })
    const result = await invoke('zoom', { pid: 41, window_id: 72,
      x1: 30, y1: 20, x2: 60, y2: 50 })
    const blocks = result.data as Array<{ type: string; source?: { data: string } }>
    const output = PNG.sync.read(Buffer.from(blocks.find(block => block.type === 'image')!.source!.data, 'base64'))
    expect([output.width, output.height]).toEqual([84, 84])
    expect([...output.data.subarray(0, 4)]).toEqual([48, 28, 200, 255])
    expect([...output.data.subarray(-4)]).toEqual([131, 111, 200, 255])
    expect(calls).toEqual([
      { name: 'get_window_state', arguments: { pid: 41, window_id: 72 } },
      { name: 'list_windows', arguments: { pid: 41 } },
      { name: 'screenshot', arguments: compatibility
        ? { pid: 41, window_id: 72 } : { window_id: 72, format: 'png' } },
    ])
    expect(tools.find(tool => tool.mcpInfo?.toolName === 'zoom')!.inputJSONSchema?.required)
      .toContain('window_id')
    expect(result.mcpMeta?.structuredContent).toMatchObject({ pid: 41, window_id: 72, from_zoom: false })
  })

  test('requires target identity before capturing and refuses native zoom coordinates before an action', async () => {
    const { calls, invoke } = await fixture()
    await expect(invoke('zoom', { pid: 41, x1: 0, y1: 0, x2: 20, y2: 20 }))
      .rejects.toThrow('window_id')
    await expect(invoke('click', { pid: 41, window_id: 72, x: 1, y: 2, from_zoom: true }))
      .rejects.toThrow('from_zoom=true')
    expect(calls).toEqual([])
    await invoke('click', { pid: 41, window_id: 72, x: 1, y: 2, from_zoom: false })
    expect(calls).toEqual([{ name: 'click', arguments: {
      pid: 41, window_id: 72, x: 1, y: 2, from_zoom: false,
    } }])
  })

  test('keeps image frames separate between query runs sharing one SDK connection', async () => {
    const options = { snapshot: image(100, 80) }
    const { invoke } = await fixture(options)
    const runA = createCuaDriverRun()
    const runB = createCuaDriverRun()
    const region = { pid: 41, window_id: 72, x1: 30, y1: 20, x2: 60, y2: 50 }
    await invoke('get_window_state', { pid: 41, window_id: 72 }, runA)
    await expect(invoke('zoom', region, runB)).rejects.toThrow('fresh')
    options.snapshot = image(200, 160)
    await invoke('get_window_state', { pid: 41, window_id: 72 }, runB)
    const zoomA = await invoke('zoom', region, runA)
    const zoomB = await invoke('zoom', region, runB)
    expect(zoomA.mcpMeta?.structuredContent).toMatchObject({
      snapshot: { width: 100, height: 80 }, crop: { width: 84, height: 84 },
    })
    expect(zoomB.mcpMeta?.structuredContent).toMatchObject({
      snapshot: { width: 200, height: 160 }, crop: { width: 42, height: 42 },
    })
  })

  test('uses the image dimensions delivered after normal MCP downsampling', async () => {
    const large = image(4000, 2000)
    const { invoke } = await fixture({ snapshot: large, native: large })
    const source = await invoke('get_window_state', { pid: 41, window_id: 72 })
    const blocks = source.data as Array<{ type: string; source?: { data: string } }>
    const delivered = PNG.sync.read(Buffer.from(blocks.find(block => block.type === 'image')!.source!.data, 'base64'))
    expect([delivered.width, delivered.height]).toEqual([2000, 1000])
    const result = await invoke('zoom', { pid: 41, window_id: 72,
      x1: 300, y1: 200, x2: 600, y2: 500 })
    expect(result.mcpMeta?.structuredContent).toMatchObject({
      snapshot: { width: 2000, height: 1000 },
      crop: { left: 480, top: 280, width: 840, height: 840 },
    })
  })

  test.each([
    { label: 'capture error', snapshot: { isError: true, content: [{ type: 'text', text: 'capture failed' }] } as CallToolResult },
    { label: 'malformed image', snapshot: { content: [{ type: 'image', mimeType: 'image/png', data: Buffer.from('not a png').toString('base64') }] } as CallToolResult },
    { label: 'no screenshot', snapshot: { content: [{ type: 'text', text: 'AX only' }] } as CallToolResult },
  ])('discards the previous frame after $label', async ({ snapshot }) => {
    const options = { snapshot: image(100, 80) }
    const { calls, invoke } = await fixture(options)
    await invoke('get_window_state', { pid: 41, window_id: 72 })
    options.snapshot = snapshot
    try { await invoke('get_window_state', { pid: 41, window_id: 72 }) } catch {}
    await expect(invoke('zoom', { pid: 41, window_id: 72, x1: 1, y1: 1, x2: 20, y2: 20 }))
      .rejects.toThrow('fresh')
    expect(calls.map(call => call.name)).toEqual(['get_window_state', 'get_window_state'])
  })

  test('validates current ownership before capturing native pixels', async () => {
    const { calls, invoke } = await fixture({ windowPid: 99 })
    await invoke('screenshot', { window_id: 72, format: 'png' })
    await expect(invoke('zoom', { pid: 41, window_id: 72, x1: 1, y1: 1, x2: 20, y2: 20 }))
      .rejects.toThrow('not owned')
    expect(calls.map(call => call.name)).toEqual(['screenshot', 'list_windows'])
  })

  test('keeps another MCP server’s same-named tools unchanged', async () => {
    const { tools, calls, invoke } = await fixture({ otherServer: true })
    await invoke('zoom', { pid: 41, x1: 0, y1: 0, x2: 20, y2: 20 })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.name).toBe('zoom')
    expect(tools.find(tool => tool.mcpInfo?.toolName === 'zoom')!.inputJSONSchema?.required)
      .not.toContain('window_id')
  })
})
