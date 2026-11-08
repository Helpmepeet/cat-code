import { expect, test } from 'bun:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserPanePresentation } from './browserPanePresentation.js'
import { BrowserPaneHost } from './browserPaneHost.js'
import type { BrowserPaneEvent, BrowserPaneLayout } from '../shared/browserPanePresentation.js'

function fixture(folders: readonly string[] = []) {
  let now = 0
  const events: BrowserPaneEvent[] = []
  const native: string[] = []
  const opened: string[] = []
  const errors: unknown[] = []
  let timer!: () => void
  let capture: () => Promise<string> = async () => 'data:image/png;base64,cGlj'
  const host = new BrowserPaneHost({ folders: () => folders, devOrigin: null, adapter: {
    startup: async () => {}, create: async id => ({
      navigate: async () => {}, back: async options => { native.push(`back:${id}:${options?.ignoreBeforeUnload}`) },
      forward: async () => {}, reload: async () => {}, destroy: () => {}, clearData: async () => {},
      history: () => ({ canGoBack: true, canGoForward: false }),
    }),
  } })
  const presentation = new BrowserPanePresentation({ host, sessions: () => [{ appSessionId: 'a' }, { appSessionId: 'b' }],
    window: () => 'window', publish: event => { events.push(event) }, openExternal: async url => { opened.push(url) },
    now: () => now, schedule: callback => { timer = callback; return () => {} }, onError: error => { errors.push(error) },
    native: { attach: (_window, view) => { native.push(`attach:${view === host.get('a')?.view ? 'a' : 'b'}`) },
      detach: () => { native.push('detach') }, visible: (view, visible) => { native.push(`visible:${view === host.get('a')?.view ? 'a' : 'b'}:${visible}`) },
      bounds: (_view, rect) => { native.push(`bounds:${rect.x},${rect.y},${rect.width},${rect.height}`) },
      capture: () => capture(),
    },
  })
  const open = async (id: string, target = 'http://localhost:3000/') => { await host.navigate(id, { action: 'navigate', target }); await presentation.onHostChange(host.get(id), id) }
  const layout = (id = 'a', overlay = false): BrowserPaneLayout => ({ appSessionId: id, rect: { x: 10, y: 20, width: 200, height: 100 }, overlay, accent: { r: 100, g: 120, b: 140 } })
  return { host, presentation, open, layout, native, events, opened, errors, advance: (ms: number) => { now += ms; timer() }, expire: () => { now += 1500; timer() }, capture: (value: () => Promise<string>) => { capture = value } }
}

test('handback validates closed input and session ownership before returning control', async () => {
  const f = fixture()
  await f.open('a')
  f.host.takeOver('a')
  expect((await f.presentation.command({ appSessionId: 'unknown', command: 'handback' })).ok).toBe(false)
  expect((await f.presentation.command({ appSessionId: 'a', command: 'handback', extra: true } as never)).ok).toBe(false)
  expect((await f.presentation.command({ appSessionId: 'b', command: 'handback' })).ok).toBe(false)
  expect(f.host.get('a')!.controller).toBe('user')
  expect(await f.presentation.command({ appSessionId: 'a', command: 'handback' })).toEqual({ ok: true })
  expect(f.host.get('a')!.controller).toBe('agent')
  expect(f.presentation.snapshots()[0]!.controller).toBe('agent')
  f.presentation.dispose()
  await f.host.dispose()
})

test('identical layout heartbeats renew freshness but still fail closed after reports stop and can recover', async () => {
  const f = fixture(); await f.open('a')
  await f.presentation.layout(f.layout())
  f.advance(1000)
  await f.presentation.layout(f.layout())
  f.advance(1000)
  expect(f.host.get('a')!.visible).toBe(true)
  f.advance(500)
  expect(f.host.get('a')!.visible).toBe(false)
  await f.presentation.layout(f.layout())
  expect(f.host.get('a')!.visible).toBe(true)
  f.presentation.rendererLost()
  expect(f.host.get('a')!.visible).toBe(false)
  await f.presentation.layout(f.layout())
  expect(f.host.get('a')!.visible).toBe(true)
  f.presentation.dispose(); await f.host.dispose()
})

test('publishes opening state before layout; only selected view is attached and inset; stale/lost renderer hides all', async () => {
  const f = fixture(); await f.open('a'); await f.open('b')
  expect(f.presentation.snapshots()).toHaveLength(2)
  expect(f.events[0]!.state?.url).toBe('http://localhost:3000/')
  await f.presentation.layout(f.layout())
  expect(f.native).toContain('bounds:12,22,196,96')
  expect(f.host.get('a')!.visible).toBe(true)
  expect(f.host.get('b')!.visible).toBe(false)
  await f.presentation.layout(f.layout('b'))
  expect(f.native).toContain('visible:a:false')
  expect(f.host.get('b')!.visible).toBe(true)
  f.expire()
  expect([...f.host.records.values()].every(record => !record.visible)).toBe(true)
  await f.presentation.layout(f.layout())
  f.presentation.rendererLost()
  expect(f.host.get('a')!.visible).toBe(false)
  f.presentation.dispose(); await f.host.dispose()
})

test('latest presentation keeps agent-use intent when a status update supersedes its projection', async () => {
  const f = fixture(); await f.open('a')
  const record = f.host.get('a')!
  record.agentUseSequence = 42
  const first = f.presentation.onHostChange(record, 'a')
  record.controller = 'user'
  await f.presentation.onHostChange(record, 'a')
  await first
  expect(f.presentation.snapshots()[0]).toMatchObject({ agentUseSequence: 42, controller: 'user' })
  f.presentation.dispose(); await f.host.dispose()
})

test('overlay capture swaps to still; takeover happens before showing live view; stale capture cannot resurrect view', async () => {
  const f = fixture(); await f.open('a'); await f.presentation.layout(f.layout())
  await f.presentation.layout(f.layout('a', true))
  expect(f.presentation.snapshots()[0]!.still).toBe('data:image/png;base64,cGlj')
  expect(f.native.at(-1)).toBe('visible:a:false')
  expect(await f.presentation.command({ appSessionId: 'a', command: 'takeover' })).toEqual({ ok: true })
  expect(f.host.get('a')!.controller).toBe('user')
  await f.presentation.layout(f.layout())
  expect(f.presentation.snapshots()[0]!.still).toBeNull()
  expect(f.native.at(-1)).toBe('visible:a:true')
  let resolve!: (value: string) => void
  f.capture(() => new Promise<string>(done => { resolve = done }))
  const swap = f.presentation.layout(f.layout('a', true))
  f.presentation.rendererLost(); resolve('data:image/png;base64,bGF0ZQ=='); await swap
  expect(f.presentation.snapshots()[0]!.still).toBeNull()
  expect(f.host.get('a')!.visible).toBe(false)
  f.presentation.dispose(); await f.host.dispose()
})

test('commands validate known sessions and closed inputs; use main URL and header history', async () => {
  const f = fixture(); await f.open('a')
  expect(f.presentation.snapshots()[0]).toMatchObject({ canGoBack: true, canGoForward: false })
  expect(await f.presentation.command({ appSessionId: 'unknown', command: 'external' })).toMatchObject({ ok: false })
  expect(await f.presentation.command({ appSessionId: 'a', command: 'external', url: 'http://evil.test/' } as any)).toMatchObject({ ok: false })
  expect(await f.presentation.command({ appSessionId: 'a', command: 'external' })).toEqual({ ok: true })
  expect(f.opened).toEqual(['http://localhost:3000/'])
  f.host.takeOver('a')
  expect(await f.presentation.command({ appSessionId: 'a', command: 'back' })).toEqual({ ok: true })
  expect(f.native).toContain('back:a:true')
  expect(await f.presentation.command({ appSessionId: 'a', command: 'close' })).toEqual({ ok: true })
  expect(f.presentation.snapshots()).toEqual([])
  expect(f.events.at(-1)).toEqual({ appSessionId: 'a', state: null })
  f.presentation.dispose(); await f.host.dispose()
})

test('local snapshot shows canonical file and external command opens that file, never the internal origin', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-presentation-'))
  try {
    const file = join(dir, 'index.html'); await writeFile(file, 'local')
    const f = fixture([dir]); await f.open('a', file)
    const canonical = await f.host.policy.localPath('a', f.host.get('a')!.url)
    expect(f.presentation.snapshots()[0]!.displayUrl).toBe(canonical!)
    expect(await f.host.handleRequest('a', { verb: 'browser.describe', args: { operation: 'navigate', navigate: { action: 'navigate', target: file } } })).toMatchObject({ ok: true, value: { description: `navigate to ${canonical}` } })
    expect(await f.presentation.command({ appSessionId: 'a', command: 'external' })).toEqual({ ok: true })
    expect(f.opened).toEqual([pathToFileURL(canonical!).href])
    f.presentation.dispose(); await f.host.dispose()
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('invalid layouts and failed captures fail closed; capture failures can retry on a fresh report', async () => {
  const f = fixture(); await f.open('a'); await f.presentation.layout(f.layout())
  await f.presentation.layout({ ...f.layout(), rect: { x: NaN, y: 0, width: 100, height: 100 } })
  expect(f.host.get('a')!.visible).toBe(false)
  f.capture(async () => { throw new Error('capture failed') })
  await f.presentation.layout(f.layout('a', true))
  expect(f.native.at(-1)).toBe('visible:a:false')
  expect(f.presentation.snapshots()[0]!.still).toBeNull()
  expect(f.errors.map(String)).toContain('Error: capture failed')
  f.capture(async () => 'data:image/png;base64,cGlj')
  await f.presentation.layout(f.layout('a', true))
  expect(f.presentation.snapshots()[0]!.still).toBe('data:image/png;base64,cGlj')
  f.presentation.dispose(); await f.host.dispose()
})
