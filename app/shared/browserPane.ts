export type BrowserNavigateInput = { action: 'navigate' | 'back' | 'forward' | 'reload'; target?: string }
export type BrowserTarget = { ref?: string; x?: number; y?: number }
export type BrowserActInput = BrowserTarget & { action: 'click' | 'type' | 'key' | 'scroll' | 'select' | 'acceptConfirm'; text?: string; key?: string; deltaX?: number; deltaY?: number; value?: string }
export type BrowserDescribeInput = { operation: 'navigate' | 'read' | 'screenshot' | 'act'; navigate?: BrowserNavigateInput; act?: BrowserActInput }
export type BrowserRequestArgs = {
  'browser.navigate': BrowserNavigateInput
  'browser.read': Record<string, never>
  'browser.screenshot': Record<string, never>
  'browser.act': BrowserActInput
  'browser.describe': BrowserDescribeInput
}
export type BrowserRequestValues = {
  'browser.navigate': { url: string }
  'browser.read': { url: string; text: string; snapshot: string; truncated: boolean; generation: number }
  'browser.screenshot': { data: string; mimeType: 'image/png'; width: number; height: number }
  'browser.act': { url: string; description: string }
  'browser.describe': { description: string; url: string }
}
export type BrowserResult<T = BrowserRequestValues[keyof BrowserRequestValues]> = { ok: true; value: T } | { ok: false; error: { code: 'unavailable' | 'bad_request' | 'internal_error'; message: string } }
const verbs = ['browser.navigate', 'browser.read', 'browser.screenshot', 'browser.act', 'browser.describe'] as const
export function isBrowserVerb(value: string): value is keyof BrowserRequestArgs { return (verbs as readonly string[]).includes(value) }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw new Error('Invalid browser arguments')
  return value as Record<string, unknown>
}
function navigate(value: unknown): BrowserNavigateInput {
  const v = object(value, ['action', 'target'])
  if (!['navigate', 'back', 'forward', 'reload'].includes(v.action as string)) throw new Error('Invalid navigation action')
  if (v.action === 'navigate' ? typeof v.target !== 'string' || !v.target.trim() : v.target !== undefined) throw new Error('Invalid navigation target')
  return v as BrowserNavigateInput
}
function act(value: unknown): BrowserActInput {
  const v = object(value, ['action', 'ref', 'x', 'y', 'text', 'key', 'deltaX', 'deltaY', 'value'])
  if (!['click', 'type', 'key', 'scroll', 'select', 'acceptConfirm'].includes(v.action as string)) throw new Error('Invalid browser action')
  for (const k of ['ref', 'text', 'key', 'value']) if (v[k] !== undefined && typeof v[k] !== 'string') throw new Error('Invalid action string')
  for (const k of ['x', 'y', 'deltaX', 'deltaY']) if (v[k] !== undefined && (typeof v[k] !== 'number' || !Number.isFinite(v[k]))) throw new Error('Invalid action number')
  if ((v.x === undefined) !== (v.y === undefined) || (v.ref !== undefined && v.x !== undefined)) throw new Error('Invalid action target')
  if (v.action === 'type' && typeof v.text !== 'string' || v.action === 'key' && typeof v.key !== 'string' || v.action === 'select' && typeof v.value !== 'string') throw new Error('Missing action value')
  return v as BrowserActInput
}
export function parseBrowserArgs<K extends keyof BrowserRequestArgs>(verb: K, value: unknown): BrowserRequestArgs[K] {
  let result: unknown
  switch (verb) {
    case 'browser.navigate': result = navigate(value); break
    case 'browser.act': result = act(value); break
    case 'browser.read': case 'browser.screenshot': result = object(value, []); break
    case 'browser.describe': {
      const v = object(value, ['operation', 'navigate', 'act'])
      if (!['navigate', 'read', 'screenshot', 'act'].includes(v.operation as string)) throw new Error('Invalid describe operation')
      if (v.operation === 'navigate') navigate(v.navigate)
      else if (v.navigate !== undefined) throw new Error('Unexpected navigation')
      if (v.operation === 'act') act(v.act)
      else if (v.act !== undefined) throw new Error('Unexpected action')
      result = v; break
    }
    default: throw new Error('Unknown browser verb')
  }
  return result as BrowserRequestArgs[K]
}
