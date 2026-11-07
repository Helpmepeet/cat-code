import { expect, test } from 'bun:test'
import { BrowserPaneCdp, isUserBrowserInput } from './browserPaneCdp.js'

function fixture() {
  const calls: { method: string; params: any }[] = []
  let password = false
  let crossOrigin = false
  const cdp = new BrowserPaneCdp({
    command: async (method, params: any) => {
      calls.push({ method, params })
      if (method === 'Accessibility.getFullAXTree') return { nodes: [{ nodeId: '1', backendDOMNodeId: 10, role: { value: 'textbox' }, name: { value: 'Display name' } }] }
      if (method === 'DOM.resolveNode') return { object: { objectId: 'element' } }
      if (method === 'Runtime.evaluate' && params.expression.includes('innerText')) return { result: { value: 'page text' } }
      if (method === 'Runtime.evaluate') return { result: { objectId: 'element' } }
      if (method === 'Runtime.callFunctionOn' && params.returnByValue) return { result: { value: { password, crossOrigin, x: 20, y: 30, role: 'textbox', name: 'Display name', tag: 'INPUT' } } }
      if (method === 'Runtime.callFunctionOn') return { result: { objectId: 'element' } }
      return {}
    },
    url: () => 'http://localhost:3000/',
    capture: async () => ({ data: 'png', width: 800, height: 600 }),
  })
  return { cdp, calls, password: () => { password = true }, crossOrigin: () => { crossOrigin = true } }
}

test('read creates short generation refs and navigation invalidates them', async () => {
  const { cdp, calls } = fixture()
  const result = await cdp.read(() => {})
  expect(result.text).toBe('page text')
  expect(result.snapshot).toContain('g1r1 textbox "Display name"')
  cdp.navigated()
  await expect(cdp.act({ action: 'click', ref: 'g1r1' }, () => {})).rejects.toThrow('stale')
  expect(calls.some(c => c.method === 'Input.dispatchMouseEvent')).toBe(false)
})

test('password typing is refused for ref, point and focused targets', async () => {
  for (const target of [{ ref: 'g1r1' }, { x: 3, y: 4 }, {}]) {
    const { cdp, calls, password } = fixture()
    await cdp.read(() => {}); password()
    await expect(cdp.act({ action: 'type', text: 'secret', ...target }, () => {})).rejects.toThrow('password')
    expect(calls.some(c => c.method === 'Input.insertText')).toBe(false)
  }
})

test('cross-origin targets and modifier keys are refused; description uses real target', async () => {
  const { cdp, calls, crossOrigin } = fixture()
  await cdp.read(() => {})
  expect((await cdp.describe({ operation: 'act', act: { action: 'click', ref: 'g1r1' } }, () => {})).description).toContain('Display name')
  expect(calls.some(c => c.method.startsWith('Input.'))).toBe(false)
  await expect(cdp.act({ action: 'key', key: 'Control+L' }, () => {})).rejects.toThrow('key')
  crossOrigin()
  await expect(cdp.act({ action: 'click', x: 3, y: 4 }, () => {})).rejects.toThrow('Cross-origin')
})

test('screenshots use injected capturePage, not CDP screenshot; gate before each dispatch', async () => {
  const { cdp, calls } = fixture()
  expect(await cdp.screenshot(() => {})).toEqual({ data: 'png', mimeType: 'image/png', width: 800, height: 600 })
  expect(calls.some(c => c.method === 'Page.captureScreenshot')).toBe(false)
  let count = 0
  await expect(cdp.act({ action: 'click', x: 1, y: 2 }, () => { if (++count >= 7) throw new Error('user control') })).rejects.toThrow('user control')
  expect(calls.some(c => c.params?.type === 'mousePressed')).toBe(true)
  expect(calls.some(c => c.params?.type === 'mouseReleased')).toBe(false)
})

test('only genuine user activation input takes control', () => {
  for (const type of ['mouseDown', 'rawKeyDown', 'keyDown', 'touchStart']) {
    expect(isUserBrowserInput({ type, _modifiers: 0 })).toBe(true)
    expect(isUserBrowserInput({ type, _modifiers: 1 << 23 })).toBe(false)
  }
  for (const type of ['mouseMove', 'mouseWheel', 'touchMove']) expect(isUserBrowserInput({ type })).toBe(false)
})

test('dialog shim is installed in main world and attached iframe before it resumes; native dialogs are never answered', async () => {
  const events: any[] = []
  const instrumented = new BrowserPaneCdp({
    command: async (method, params, sessionId) => { events.push({ method, params, sessionId }); return {} },
    url: () => 'http://localhost:3000/', capture: async () => ({ data: '', width: 1, height: 1 }),
    onNativeDialog: open => events.push({ native: open }),
  })
  await instrumented.initialize(() => {})
  await instrumented.event('Target.attachedToTarget', { sessionId: 'child', targetInfo: { type: 'iframe' } }, () => {})
  const scripts = events.filter(e => e.method === 'Page.addScriptToEvaluateOnNewDocument')
  expect(scripts).toHaveLength(2)
  expect(scripts[0].params.worldName).toBeUndefined()
  expect(scripts[1].sessionId).toBe('child')
  expect(events.filter(e => e.method === 'Page.setInterceptFileChooserDialog' && e.params.enabled === true).map(e => e.sessionId)).toEqual([undefined, 'child'])
  expect([...events].reverse().find(e => e.method)?.method).toBe('Runtime.runIfWaitingForDebugger')
  await instrumented.event('Page.javascriptDialogOpening', {}, () => {})
  expect(events.at(-1)).toEqual({ native: true })
  expect(events.some(e => e.method === 'Page.handleJavaScriptDialog')).toBe(false)
})

test('read bounds text and nodes with a truncation marker; oversized captures are refused', async () => {
  const cdp = new BrowserPaneCdp({
    command: async method => method === 'Accessibility.getFullAXTree'
      ? { nodes: Array.from({ length: 1000 }, (_, i) => ({ backendDOMNodeId: i + 1, role: { value: 'button' }, name: { value: 'a'.repeat(500) } })) }
      : { result: { value: 'x'.repeat(40_000) } },
    url: () => 'http://localhost:3000/', capture: async () => ({ data: '', width: 4096, height: 4096 }),
  })
  const read = await cdp.read(() => {})
  expect(read.text.length).toBeLessThanOrEqual(32_000)
  expect(read.snapshot.length).toBeLessThan(33_000)
  expect(read.truncated).toBe(true)
  expect(read.snapshot).toContain('[truncated]')
  await expect(cdp.screenshot(() => {})).rejects.toThrow('pixel limit')
})

test('dialog reports reach the next read without opening or answering native dialogs', async () => {
  const { cdp } = fixture()
  await cdp.event('Runtime.bindingCalled', { name: '__catBrowserDialogReport', payload: JSON.stringify({ type: 'alert', message: 'Saved', accepted: false }) }, () => {})
  expect((await cdp.read(() => {})).snapshot).toContain('[dialog] alert: Saved')
  expect((await cdp.read(() => {})).snapshot).not.toContain('[dialog]')
})
