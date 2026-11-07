import { expect, test } from 'bun:test'
import type { ToolUseContext } from '../../src/Tool.js'
import type { PeerHostRequester } from './peerHostRequester.js'
import { createBrowserTools } from './browserTools.js'

const samples = [{ action: 'navigate', target: 'http://localhost:3000' }, {}, {}, { action: 'click', ref: 'g1-e1' }]
function fixture() {
  const calls: Array<{ verb: string; args: unknown; timeout?: number }> = []
  const request = (async (verb, args, options) => {
    calls.push({ verb, args, timeout: options?.timeoutMs })
    return verb === 'browser.describe'
      ? { ok: true, value: { description: 'click button "Save changes" on localhost:3000', url: 'http://localhost:3000/' } }
      : { ok: true, value: verb === 'browser.screenshot'
        ? { data: 'aGVsbG8=', mimeType: 'image/png', width: 10, height: 10 }
        : { url: 'http://localhost:3000/' } }
  }) as PeerHostRequester
  return { tools: createBrowserTools(request), calls }
}

test('every browser tool passes through permissions in every mode and projects its resolved target per use', async () => {
  const { tools, calls } = fixture()
  expect(tools.map(tool => tool.name)).toEqual(['BrowserNavigate', 'BrowserRead', 'BrowserScreenshot', 'BrowserAct'])
  for (const [i, tool] of tools.entries()) {
    const input = samples[i]!
    for (const mode of ['default', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions']) {
      const context = { toolUseId: `${tool.name}-${mode}`, getAppState: () => ({ toolPermissionContext: { mode } }) } as unknown as ToolUseContext
      expect((await tool.checkPermissions(input, context)).behavior).toBe('passthrough')
      expect(tool.toAutoClassifierInputForUse?.(input, context.toolUseId!)).toBe('click button "Save changes" on localhost:3000')
    }
    expect(tool.isConcurrencySafe(input)).toBe(false)
  }
  expect(calls.every(call => call.verb === 'browser.describe' && call.timeout === 30_000)).toBe(true)
})

test('browser screenshot maps to an image result and workers cannot dispatch browser tools', async () => {
  const { tools, calls } = fixture()
  const screenshot = tools[2]!
  const unusedPermission = async () => { throw new Error('Permission callback is not used by a tool dispatch') }
  const result = await screenshot.call({}, {} as ToolUseContext, unusedPermission, { message: { content: [] } } as never)
  const block = screenshot.mapToolResultToToolResultBlockParam(result.data, 'capture')
  expect(block.content).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }])
  const before = calls.length
  for (const [i, tool] of tools.entries()) {
    const result = await tool.call(samples[i]!, { agentId: 'worker' } as unknown as ToolUseContext, unusedPermission, { message: { content: [] } } as never)
    expect(tool.mapToolResultToToolResultBlockParam(result.data, 'worker').is_error).toBe(true)
  }
  expect(calls).toHaveLength(before)
})
