import { z } from '../../node_modules/zod/v4'
import { buildTool, type Tool, type ToolUseContext } from '../../src/Tool.js'
import { parseBrowserArgs, type BrowserRequestArgs, type BrowserRequestValues } from '../shared/browserPane.js'
import { requestPeerHost, type PeerHostRequester } from './peerHostRequester.js'

type BrowserToolVerb = Exclude<keyof BrowserRequestArgs, 'browser.describe'>
type Output = { ok: true; value: BrowserRequestValues[BrowserToolVerb] } | { ok: false; message: string }
const navigateSchema = z.strictObject({
  action: z.enum(['navigate', 'back', 'forward', 'reload']),
  target: z.string().min(1).max(8192).optional().describe('A loopback HTTP URL, local HTML path, or route on the current localhost page.'),
})
const actSchema = z.strictObject({
  action: z.enum(['click', 'type', 'key', 'scroll', 'select', 'acceptConfirm']),
  ref: z.string().min(1).max(128).optional().describe('A current BrowserRead ref.'),
  x: z.number().finite().optional(), y: z.number().finite().optional(),
  text: z.string().max(64 * 1024).optional(), key: z.string().max(64).optional(),
  deltaX: z.number().finite().optional(), deltaY: z.number().finite().optional(),
  value: z.string().max(8192).optional(),
})

export function createBrowserTools(requestHost: PeerHostRequester = requestPeerHost): Tool[] {
  function create(name: string, verb: BrowserToolVerb, schema: typeof navigateSchema | typeof actSchema | z.ZodObject<{}>, description: string): Tool {
    const descriptions = new Map<string, string>()
    const operation = verb.slice('browser.'.length) as 'navigate' | 'read' | 'screenshot' | 'act'
    function inputForDescribe(input: Record<string, unknown>): BrowserRequestArgs['browser.describe'] {
      if (verb === 'browser.navigate') return { operation, navigate: parseBrowserArgs(verb, input) }
      if (verb === 'browser.act') return { operation, act: parseBrowserArgs(verb, input) }
      return { operation }
    }
    return buildTool({
      name, maxResultSizeChars: 1024 * 1024,
      userFacingName: () => name,
      get inputSchema() { return schema },
      isReadOnly: () => verb === 'browser.read' || verb === 'browser.screenshot',
      isConcurrencySafe: () => false,
      async description() { return description },
      async prompt() { return description },
      async checkPermissions(input, context) {
        const deny = (message: string) => ({ behavior: 'deny' as const, message, decisionReason: { type: 'other' as const, reason: message } })
        if (context.agentId) return deny('Only the main conversational agent may use the browser.')
        let result
        try { result = await requestHost('browser.describe', inputForDescribe(input), { timeoutMs: 30_000 }) }
        catch (error) { return deny(String(error)) }
        if (!result.ok) return deny(result.error.message)
        if (context.toolUseId) {
          descriptions.set(context.toolUseId, result.value.description)
          if (descriptions.size > 128) descriptions.delete(descriptions.keys().next().value!)
        }
        return { behavior: 'passthrough' as const, message: result.value.description }
      },
      toAutoClassifierInput: input => JSON.stringify(input),
      toAutoClassifierInputForUse: (_input, toolUseId) => descriptions.get(toolUseId),
      async call(input, context: ToolUseContext): Promise<{ data: Output }> {
        if (context.toolUseId) descriptions.delete(context.toolUseId)
        if (context.agentId) return { data: { ok: false, message: 'Only the main conversational agent may use the browser.' } }
        try {
          const result = await requestHost(verb, parseBrowserArgs(verb, input), { timeoutMs: 30_000 })
          return { data: result.ok ? { ok: true, value: result.value } : { ok: false, message: result.error.message } }
        } catch (error) { return { data: { ok: false, message: String(error) } } }
      },
      mapToolResultToToolResultBlockParam(data: Output, toolUseID: string) {
        return { type: 'tool_result' as const, tool_use_id: toolUseID,
          content: data.ok && 'mimeType' in data.value
            ? [{ type: 'image' as const, source: { type: 'base64' as const, media_type: data.value.mimeType, data: data.value.data } }]
            : JSON.stringify(data.ok ? data.value : { error: data.message }),
          ...(data.ok ? {} : { is_error: true }) }
      },
      renderToolUseMessage() { return null },
    }) as Tool
  }
  return [
    create('BrowserNavigate', 'browser.navigate', navigateSchema, 'Open a localhost page or local HTML file in the session browser, or go back, forward, or reload.'),
    create('BrowserRead', 'browser.read', z.strictObject({}), 'Read the session browser page text and bounded accessibility snapshot. Use its current refs for browser actions.'),
    create('BrowserScreenshot', 'browser.screenshot', z.strictObject({}), 'Capture the session browser page as an image.'),
    create('BrowserAct', 'browser.act', actSchema, 'Click, type, press a key, scroll, or select in the session browser by current ref or point. Password typing is refused. acceptConfirm arms acceptance of the next confirm dialog.'),
  ]
}
