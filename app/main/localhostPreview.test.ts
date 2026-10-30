import { expect, test } from 'bun:test'
import { createLocalhostPreviewService } from './localhostPreview.js'
import { sessionDescriptorFixture } from '../shared/sessionDescriptor.fixture.js'
import type { FilePreviewEvent } from '../shared/filePreview.js'

function fixture(options: { devOrigin?: string; live?: boolean } = {}) {
  const events: FilePreviewEvent[] = []
  const requests: Array<{ method: string; path: string }> = []
  let server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname
    requests.push({ method: request.method, path })
    if (path === '/redirect') return Response.redirect(new URL('/', request.url), 302)
    if (path === '/outside') return Response.redirect('http://example.invalid/never-fetch', 302)
    if (path === '/head-only-unsupported' && request.method === 'HEAD') return new Response(null, { status: 405 })
    if (path.startsWith('/router/')) return new Response('Client-only route', { status: 404 })
    return new Response('<h1>Real local server</h1>', { headers: { 'Content-Type': 'text/html' } })
  } })
  const origin = `http://127.0.0.1:${server.port}`
  let sessions = [sessionDescriptorFixture({ appSessionId: 'local-session', cwd: '/private/tmp' })]
  const service = createLocalhostPreviewService({ sessions: () => sessions, devOrigin: options.devOrigin, publish: event => events.push(event), isLive: () => options.live ?? false })
  return { origin, requests, events, service,
    revoke() { sessions = [] },
    stop() { server.stop(true) },
    restart() { const port = Number(new URL(origin).port); server = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('<h1>Returned</h1>') }) },
    dispose() { service.dispose(); server.stop(true) },
  }
}

test('prepares only a real permitted session server and keeps same-URL preparation reload-free', async () => {
  const f = fixture()
  try {
    const result = await f.service.prepare({ appSessionId: 'local-session', url: f.origin })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('Expected available server')
    expect(result.descriptor.path).toBe(f.origin + '/')
    expect(result.descriptor.frameName).toContain(result.descriptor.id)
    const count = f.requests.length
    const repeated = await f.service.prepare({ appSessionId: 'local-session', url: f.origin + '/' })
    expect(repeated).toEqual(result)
    expect(f.requests).toHaveLength(count)
    expect(await f.service.prepare({ appSessionId: 'missing', url: f.origin })).toEqual({ ok: false, reason: 'refused' })
    expect(await f.service.prepare({ appSessionId: 'local-session', url: f.origin, extra: true })).toEqual({ ok: false, reason: 'refused' })
    f.revoke()
    expect(await f.service.refresh(result.descriptor.id)).toBeNull()
  } finally { f.dispose() }
})

test('accepts HEAD405 as online and refuses redirects before any off-host request', async () => {
  const f = fixture()
  try {
    expect((await f.service.prepare({ appSessionId: 'local-session', url: f.origin + '/head-only-unsupported' })).ok).toBe(true)
    const redirected = await f.service.prepare({ appSessionId: 'local-session', url: f.origin + '/redirect' })
    expect(redirected.ok).toBe(true)
    if (redirected.ok) expect(redirected.descriptor.path).toBe(f.origin + '/')
    expect(await f.service.prepare({ appSessionId: 'local-session', url: f.origin + '/outside' })).toEqual({ ok: false, reason: 'refused' })
    expect(f.requests.every(request => request.method === 'HEAD')).toBe(true)
  } finally { f.dispose() }
})

test('refuses the application origin before probing and distinguishes an unavailable server', async () => {
  const f = fixture()
  const own = createLocalhostPreviewService({ sessions: () => [sessionDescriptorFixture({ appSessionId: 's', cwd: '/private/tmp' })], devOrigin: f.origin + '/', publish: () => {} })
  try {
    expect(await own.prepare({ appSessionId: 's', url: f.origin + '/other' })).toEqual({ ok: false, reason: 'refused' })
    expect(f.requests).toEqual([])
    f.stop()
    expect(await f.service.prepare({ appSessionId: 'local-session', url: f.origin })).toEqual({ ok: false, reason: 'unavailable', hostPort: new URL(f.origin).host })
  } finally { own.dispose(); f.dispose() }
})

test('retains a stopped pane, reuses it without a request, and stages automatic recovery', async () => {
  const f = fixture({ live: true })
  try {
    const opened = await f.service.prepare({ appSessionId: 'local-session', url: f.origin })
    if (!opened.ok) throw new Error('Expected initial server')
    f.stop()
    const deadline = Date.now() + 3000
    while (!f.events.some(event => event.kind === 'server-stopped') && Date.now() < deadline) await Bun.sleep(20)
    expect(f.events.some(event => event.kind === 'server-stopped')).toBe(true)
    expect(f.service.current(opened.descriptor.id)?.serverStopped).toBe(true)
    const count = f.requests.length
    const reused = await f.service.prepare({ appSessionId: 'local-session', url: f.origin })
    expect(reused.ok && reused.descriptor.id).toBe(opened.descriptor.id)
    expect(f.requests).toHaveLength(count)
    f.restart()
    const recoveryDeadline = Date.now() + 3000
    while (!f.events.some(event => event.kind === 'updated') && Date.now() < recoveryDeadline) await Bun.sleep(20)
    const recovery = f.events.find(event => event.kind === 'updated')
    expect(recovery?.kind).toBe('updated')
    if (recovery?.kind === 'updated') {
      expect(recovery.descriptor.revision).toBeGreaterThan(opened.descriptor.revision)
      expect(recovery.descriptor.serverStopped).toBeUndefined()
    }
  } finally { f.dispose() }
})

test('keeps unique route receipts and reloads client-only routes through their real boot page', async () => {
  const f = fixture()
  try {
    const opened = await f.service.prepare({ appSessionId: 'local-session', url: f.origin })
    if (!opened.ok) throw new Error('Expected server')
    const id = opened.descriptor.id
    const one = f.service.route(id, f.origin + '/router/client-only', { x: 0, y: 180 }, { index: 1 })!
    const two = f.service.route(id, f.origin + '/router/client-only', { x: 0, y: 300 }, { index: 2 })!
    expect(one.routeKey).not.toBe(two.routeKey)
    expect(f.service.routeFor(id, one.routeKey!)?.state).toEqual({ index: 1 })
    const refreshed = await f.service.refresh(id)
    expect(refreshed?.path).toBe(f.origin + '/router/client-only')
    expect(refreshed?.url).toBe(f.origin + '/')
    expect(f.requests.at(-1)?.path).toBe('/')
    f.service.release(id)
    const reopened = await f.service.prepare({ appSessionId: 'local-session', url: f.origin + '/router/client-only' })
    expect(reopened.ok).toBe(true)
    if (reopened.ok) expect(reopened.descriptor.url).toBe(f.origin + '/')
  } finally { f.dispose() }
})

test('committing one ready stage does not discard a newer queued revision', async () => {
  const f = fixture()
  try {
    const opened = await f.service.prepare({ appSessionId: 'local-session', url: f.origin })
    if (!opened.ok) throw new Error('Expected server')
    const first = opened.descriptor
    const second = await f.service.refresh(opened.descriptor.id)
    expect(f.service.commit(first!.id, first!.revision)).toBe(true)
    expect(f.service.descriptor(second!.id, second!.revision)).toEqual(second)
  } finally { f.dispose() }
})
