import { test, expect } from 'bun:test'
import { BrowserPaneHost, type BrowserPaneAdapter, type BrowserPaneView } from './browserPaneHost.js'

function fixture() {
  const events: string[] = []
  let release: (() => void) | undefined
  let clearing!: () => void
  const clearStarted = new Promise<void>(resolve => { clearing = resolve })
  const adapter: BrowserPaneAdapter = {
    startup: async () => { events.push('startup') },
    create: async id => {
      events.push(`create:${id}`)
      return { navigate: async url => { events.push(url) }, back: async () => {}, forward: async () => {}, reload: async () => {},
        destroy: () => { events.push(`destroy:${id}`) }, clearData: async () => { events.push(`clear:${id}`); if (release) await new Promise<void>(r => { release = r; clearing() }) },
      } satisfies BrowserPaneView
    },
  }
  return { host: new BrowserPaneHost({ adapter, folders: () => null, devOrigin: null }), events, clearStarted,
    delayClear: () => { release = () => {} }, releaseClear: () => { const resolve = release; release = undefined; resolve?.() } }
}
const request = { verb: 'browser.navigate' as const, args: { action: 'navigate' as const, target: 'http://localhost:3000' } }

test('startup precedes creation; LRU protects visible and user-controlled views', async () => {
  const { host, events } = fixture()
  for (const id of ['a', 'b', 'c', 'd']) expect((await host.handleRequest(id, request)).ok).toBe(true)
  host.get('a')!.visible = true; host.get('b')!.controller = 'user'
  expect((await host.handleRequest('e', request)).ok).toBe(true)
  expect(host.get('c')).toBeUndefined()
  expect(events[0]).toBe('startup')
  expect(events).toContain('destroy:c'); expect(events).toContain('clear:c')
  for (const record of host.records.values()) record.visible = true
  expect(await host.handleRequest('f', request)).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  expect(await host.handleRequest('b', request)).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  await host.dispose()
})

test('close clears data before same-session reopen and unsupported verbs do not succeed', async () => {
  const { host, events, delayClear, releaseClear, clearStarted } = fixture()
  await host.handleRequest('a', request)
  delayClear()
  const close = host.close('a')
  await clearStarted
  const reopen = host.handleRequest('a', request)
  await Promise.resolve(); await Promise.resolve()
  expect(events.filter(x => x === 'create:a')).toHaveLength(1)
  releaseClear(); await close; expect((await reopen).ok).toBe(true)
  expect(events.filter(x => x === 'create:a')).toHaveLength(2)
  expect(await host.handleRequest('a', { verb: 'browser.read', args: {} })).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  releaseClear(); await host.dispose()
})

test('takeover blocks agent calls; handback and header commands are explicit', async () => {
  const { host } = fixture()
  await host.handleRequest('a', request)
  host.takeOver('a')
  expect(await host.handleRequest('a', request)).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  expect((await host.headerNavigate('a', { action: 'reload' })).ok).toBe(true)
  expect(host.get('a')!.controller).toBe('user')
  host.handBack('a')
  expect((await host.handleRequest('a', request)).ok).toBe(true)
  await host.dispose()
})

test('expired queued operations never dispatch and native dialog settles without an answer', async () => {
  let now = 0
  let hooks: import('./browserPaneHost.js').BrowserPaneViewHooks | undefined
  let unblock!: () => void
  const blocked = new Promise<void>(resolve => { unblock = resolve })
  const calls: string[] = []
  const host = new BrowserPaneHost({ folders: () => null, devOrigin: null, now: () => now, adapter: {
    startup: async () => {},
    create: async () => ({
      setHooks: value => { hooks = value },
      navigate: async () => { calls.push('navigate'); await blocked },
      back: async () => {}, forward: async () => {}, reload: async () => {}, destroy: () => {}, clearData: async () => {},
    }),
  } })
  const first = host.handleRequest('a', request)
  // Header commands share the queue, but carry their own deadline from arrival.
  const second = host.handleRequest('a', request)
  await new Promise<void>(resolve => { setImmediate(resolve) })
  now = 31_000
  hooks!.nativeDialog(true)
  expect(await first).toMatchObject({ ok: false, error: { message: 'A dialog is waiting for you' } })
  expect(await second).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  expect(calls).toEqual(['navigate'])
  unblock()
  await host.dispose()
})

test('loopback routes resolve against current page without overriding existing absolute files', async () => {
  const { host, events } = fixture()
  await host.navigate('a', { action: 'navigate', target: 'http://localhost:3000/nested/page' })
  expect(await host.navigate('a', { action: 'navigate', target: '/browser-route-not-a-real-file' })).toMatchObject({ ok: true, value: { url: 'http://localhost:3000/browser-route-not-a-real-file' } })
  expect(events).toContain('http://localhost:3000/browser-route-not-a-real-file')
  expect(await host.navigate('a', { action: 'navigate', target: '/etc/hosts' })).toMatchObject({ ok: false, error: { code: 'bad_request' } })
  await host.dispose()
})

test('host routes read, describe and screenshot through CDP/capture and wires genuine input', async () => {
  let hooks!: import('./browserPaneHost.js').BrowserPaneViewHooks
  let captures = 0
  let url = ''
  const commands: string[] = []
  const host = new BrowserPaneHost({ folders: () => null, devOrigin: null, adapter: {
    startup: async () => {},
    create: async () => ({
      setHooks: value => { hooks = value },
      navigate: async value => { url = value; hooks.navigated() },
      getURL: () => url,
      back: async () => {}, forward: async () => {}, reload: async () => {}, destroy: () => {}, clearData: async () => {},
      capturePage: async maxPixels => { captures++; expect(maxPixels).toBe(2_000_000); return { data: 'png', width: 10, height: 10 } },
      debugger: { sendCommand: async (method, params: any) => {
        commands.push(method)
        if (method === 'Accessibility.getFullAXTree') return { nodes: [{ backendDOMNodeId: 1, role: { value: 'button' }, name: { value: 'Save' } }] }
        if (method === 'Runtime.evaluate' && params.expression.includes('innerText')) return { result: { value: 'Hello' } }
        return {}
      } },
    }),
  } })
  await host.handleRequest('a', request)
  expect(await host.handleRequest('a', { verb: 'browser.read', args: {} })).toMatchObject({ ok: true, value: { text: 'Hello' } })
  expect(await host.handleRequest('a', { verb: 'browser.describe', args: { operation: 'screenshot' } })).toMatchObject({ ok: true, value: { description: 'screenshot on http://localhost:3000/' } })
  expect(await host.handleRequest('a', { verb: 'browser.screenshot', args: {} })).toMatchObject({ ok: true, value: { data: 'png' } })
  expect(captures).toBe(1)
  expect(commands).not.toContain('Page.captureScreenshot')
  hooks.input({ type: 'mouseDown', _modifiers: 1 << 23 })
  hooks.input({ type: 'mouseMove' })
  expect(host.get('a')!.controller).toBe('agent')
  hooks.input({ type: 'keyDown' })
  expect(host.get('a')!.controller).toBe('user')
  expect(await host.handleRequest('a', { verb: 'browser.read', args: {} })).toMatchObject({ ok: false })
  host.handBack('a')
  expect(host.get('a')!.controller).toBe('agent')
  await host.dispose()
})
