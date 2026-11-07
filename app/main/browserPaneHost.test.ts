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
