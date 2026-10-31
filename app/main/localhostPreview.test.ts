import { expect, test } from 'bun:test'
import { createLocalhostPreviewService, type LocalhostFrozenPayload } from './localhostPreview.js'
import { sessionDescriptorFixture } from '../shared/sessionDescriptor.fixture.js'
import type { FilePreviewEvent } from '../shared/filePreview.js'

function fixture(options: { devOrigin?: string; live?: boolean; snapshots?: Map<string, LocalhostFrozenPayload> } = {}) {
  const events: FilePreviewEvent[] = []
  const requests: Array<{ method: string; path: string }> = []
  let server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname
    requests.push({ method: request.method, path })
    if (path === '/start' && request.method !== 'HEAD') return Response.redirect(new URL('/actual', request.url), 302)
    if (path === '/redirect') return Response.redirect(new URL('/', request.url), 302)
    if (path === '/outside') return Response.redirect('http://example.invalid/never-fetch', 302)
    if (path === '/head-only-unsupported' && request.method === 'HEAD') return new Response(null, { status: 405 })
    if (path.startsWith('/router/')) return new Response('Client-only route', { status: 404 })
    return new Response('<h1>Real local server</h1>', { headers: { 'Content-Type': 'text/html' } })
  } })
  const origin = `http://127.0.0.1:${server.port}`
  let sessions = [sessionDescriptorFixture({ appSessionId: 'local-session', cwd: '/private/tmp' })]
  const service = createLocalhostPreviewService({ sessions: () => sessions, devOrigin: options.devOrigin, publish: event => events.push(event), isLive: () => options.live ?? false, findSnapshot: (_sessionId, url) => options.snapshots?.get(url) ?? null, getSnapshot: id => [...(options.snapshots?.values() ?? [])].find(snapshot => snapshot.id === id) ?? null })
  return { origin, requests, events, service,
    revoke() { sessions = [] },
    stop() { server.stop(true) },
    restart() { const port = Number(new URL(origin).port); server = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('<h1>Returned</h1>') }) },
    dispose() { service.dispose(); server.stop(true) },
  }
}

test('a connected server that answers slowly is running, not stopped', async () => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async () => { await Bun.sleep(1500); return new Response('<h1>Compiled</h1>') } })
  const events: FilePreviewEvent[] = []
  const service = createLocalhostPreviewService({ sessions: () => [sessionDescriptorFixture({ appSessionId: 'slow', cwd: '/private/tmp' })], publish: event => events.push(event), isLive: () => true })
  try {
    expect((await service.prepare({ appSessionId: 'slow', url: `http://127.0.0.1:${server.port}/` })).ok).toBe(true)
    await Bun.sleep(1200)
    expect(events.some(event => event.kind === 'server-stopped')).toBe(false)
  } finally { service.dispose(); server.stop(true) }
})

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

test('adopts a real GET redirect when HEAD stayed at the original route, without replaying it as SPA history', async () => {
  const f = fixture()
  try {
    const opened = await f.service.prepare({ appSessionId: 'local-session', url: f.origin + '/start' })
    if (!opened.ok) throw new Error('Expected initial server')
    expect(opened.descriptor.path).toBe(f.origin + '/start')
    const response = await fetch(opened.descriptor.url)
    expect(response.url).toBe(f.origin + '/actual')
    const settled = f.service.settleNavigation(opened.descriptor.id, opened.descriptor.revision, response.url)
    expect(settled?.replay).toBe(false)
    expect(settled?.descriptor.path).toBe(f.origin + '/actual')
    expect(settled?.descriptor.baseUrl).toBe(f.origin + '/actual')
    expect(settled?.descriptor.url).toBe(opened.descriptor.url)
    expect(f.service.commit(opened.descriptor.id, opened.descriptor.revision)).toBe(true)
    expect(f.service.current(opened.descriptor.id)?.path).toBe(f.origin + '/actual')
    expect(f.events.some(event => event.kind === 'route' && event.url === f.origin + '/actual' && event.replace)).toBe(true)
  } finally { f.dispose() }
})

test('serves only snapshot-owner-retained bytes for an offline return, and recovers through the real server', async () => {
  const snapshots = new Map<string, LocalhostFrozenPayload>()
  const f = fixture({ snapshots })
  try {
    const asset = 'a'.repeat(64)
    snapshots.set(f.origin + '/', { id: 'f'.repeat(48), html: '<h1>Frozen last version</h1>', resources: new Map([[asset, { mimeType: 'image/png', body: Buffer.from('recorded image bytes') }]]) })
    f.stop()
    const opened = await f.service.prepare({ appSessionId: 'local-session', url: f.origin })
    if (!opened.ok) throw new Error('Expected recorded offline fallback')
    const descriptor = opened.descriptor
    expect(descriptor.serverStopped).toBe(true)
    expect(descriptor.url).toMatch(/^cat-preview:/)
    expect(await f.service.respond(descriptor.id, descriptor.revision, '/index.html')?.text()).toBe('<h1>Frozen last version</h1>')
    expect(await f.service.respond(descriptor.id, descriptor.revision, '/asset/' + asset)?.text()).toBe('recorded image bytes')
    const policy = f.service.respond(descriptor.id, descriptor.revision, '/index.html')?.headers.get('Content-Security-Policy')
    expect(policy).toContain("script-src 'none'")
    expect(policy).toContain('sandbox allow-same-origin allow-scripts')
    expect(policy).toContain("frame-src 'none'; object-src 'none'; form-action 'none'")
    f.service.release(descriptor.id)
    const returned = await f.service.prepare({ appSessionId: 'local-session', url: f.origin })
    if (!returned.ok) throw new Error('Expected retained frozen route after live handle release')
    expect(returned.descriptor.id).not.toBe(descriptor.id)
    const superseded = await f.service.refresh(returned.descriptor.id)
    const latest = await f.service.refresh(returned.descriptor.id)
    expect(f.service.respond(returned.descriptor.id, superseded!.revision, '/index.html')).toBeNull()
    expect(f.service.respond(returned.descriptor.id, latest!.revision, '/index.html')?.status).toBe(200)
    f.restart()
    const recovered = await f.service.refresh(returned.descriptor.id)
    expect(recovered?.url).toBe(f.origin + '/')
    expect(recovered?.serverStopped).toBeUndefined()
    // A candidate must not invalidate the still-painted frozen document.
    expect(f.service.respond(returned.descriptor.id, returned.descriptor.revision, '/index.html')?.status).toBe(200)
    snapshots.clear()
    // The service keeps IDs, so snapshot-owner eviction immediately revokes bytes.
    expect(f.service.respond(returned.descriptor.id, returned.descriptor.revision, '/index.html')).toBeNull()
  } finally { f.dispose() }
})
