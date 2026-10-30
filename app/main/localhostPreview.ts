import { request as httpRequest } from 'node:http'
import { randomBytes } from 'node:crypto'
import { MAX_REGISTRY_SESSIONS } from '../host/registry.js'
import {
  normalizeLocalhostPreviewUrl, localhostPreviewHostPort,
  type FilePreviewDescriptor, type FilePreviewEvent, type FilePreviewScroll, type LocalhostPreviewResult,
} from '../shared/filePreview.js'
import type { SessionDescriptor } from '../shared/hostApi.js'

export type LocalhostRoute = {
  key: string
  appSessionId: string
  url: string
  baseUrl: string
  state: unknown
}
export type LocalhostFrozenPayload = {
  id: string
  html: string
  resources: ReadonlyMap<string, { mimeType: string; body: Buffer }>
}
type Preview = {
  id: string
  appSessionId: string
  authorityCwd: string
  path: string
  baseUrl: string
  revision: number
  committed: number
  descriptors: Map<number, FilePreviewDescriptor>
  stopped: boolean
  polling: boolean
  blockedUrl: string | null
  timer: ReturnType<typeof setInterval>
  frozenIds: Map<number, string>
  routeKey: string
}
type Probe = { status: 'online'; url: string } | { status: 'unavailable' } | { status: 'refused'; destination?: string }
const MAX_RECORDS = MAX_REGISTRY_SESSIONS * 3
const MAX_ROUTES = MAX_REGISTRY_SESSIONS * 64
const MAX_ROUTE_STATE_BYTES = 64 * 1024
const MAX_ROUTE_STATE_TOTAL_BYTES = 8 * 1024 * 1024

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

/** Only a status line is needed. Do not consume an unbounded response body. */
async function head(url: string): Promise<{ status: number; location?: string } | null> {
  const parsed = new URL(url)
  const addresses = parsed.hostname === 'localhost' ? ['127.0.0.1', '::1'] : [parsed.hostname.replace(/^\[|\]$/g, '')]
  for (const address of addresses) {
    const response = await new Promise<{ status: number; location?: string } | null>(resolve => {
      let done = false
      const finish = (result: { status: number; location?: string } | null) => { if (!done) { done = true; clearTimeout(timer); resolve(result) } }
      const request = httpRequest({ hostname: address, port: parsed.port || 80, method: 'HEAD', path: `${parsed.pathname}${parsed.search}`, headers: { Host: parsed.host }, agent: false }, response => {
        finish({ status: response.statusCode ?? 0, ...(response.headers.location ? { location: response.headers.location } : {}) })
        response.destroy()
      })
      const timer = setTimeout(() => { finish(null); request.destroy() }, 700)
      request.once('error', () => finish(null))
      request.end()
    })
    if (response) return response
  }
  return null
}

export function createLocalhostPreviewService(deps: {
  sessions: () => readonly SessionDescriptor[]
  devOrigin?: string | null
  publish: (event: FilePreviewEvent) => void
  isLive?: (id: string) => boolean
  findSnapshot?: (appSessionId: string, url: string) => LocalhostFrozenPayload | null
  getSnapshot?: (id: string) => LocalhostFrozenPayload | null
}) {
  const records = new Map<string, Preview>()
  const routes = new Map<string, LocalhostRoute>()
  let activeProbes = 0
  let routeStateBytes = 0
  const waiting: Array<() => void> = []
  const ownOrigin = deps.devOrigin ? new URL(deps.devOrigin).origin : null
  function allowed(value: unknown): string | null {
    const url = normalizeLocalhostPreviewUrl(value)
    return url && new URL(url).origin !== ownOrigin ? url : null
  }
  function authorized(record: Preview): boolean {
    return deps.sessions().some(session => session.appSessionId === record.appSessionId && session.cwd === record.authorityCwd && !session.moving)
  }
  async function probe(value: string): Promise<Probe> {
    if (activeProbes >= 4) {
      if (waiting.length >= 16) return { status: 'unavailable' }
      await new Promise<void>(resolve => waiting.push(resolve))
    } else activeProbes++
    try {
      let url = value
      for (let count = 0; count < 6; count++) {
        const current = allowed(url)
        if (!current) return { status: 'refused', destination: url }
        const response = await head(current)
        if (!response) return { status: 'unavailable' }
        if (response.status >= 300 && response.status < 400 && response.location) {
          try { url = new URL(response.location, current).href } catch { return { status: 'refused' } }
          continue
        }
        // HEAD 405 still proves an HTTP server is running; the iframe uses GET.
        return { status: 'online', url: current }
      }
      return { status: 'refused' }
    } finally {
      const next = waiting.shift()
      if (next) next()
      else activeProbes--
    }
  }
  function route(record: Preview, url: string, state: unknown = null): LocalhostRoute {
    let retained: unknown = null
    let retainedBytes = 0
    try {
      const serialized = JSON.stringify(state)
      if (serialized && Buffer.byteLength(serialized) <= MAX_ROUTE_STATE_BYTES) { retained = JSON.parse(serialized); retainedBytes = Buffer.byteLength(serialized) }
    } catch { /* Route and scroll survive even when page state is not serializable. */ }
    for (const previous of routes.values()) {
      if (routeStateBytes + retainedBytes <= MAX_ROUTE_STATE_TOTAL_BYTES) break
      routeStateBytes -= Buffer.byteLength(JSON.stringify(previous.state))
      previous.state = null
      routeStateBytes += 4
    }
    const next: LocalhostRoute = { key: randomBytes(24).toString('hex'), appSessionId: record.appSessionId, url, baseUrl: record.baseUrl, state: retained }
    routes.set(next.key, next)
    routeStateBytes += retainedBytes || 4
    if (routes.size > MAX_ROUTES) {
      const oldest = routes.values().next().value!
      routeStateBytes -= Buffer.byteLength(JSON.stringify(oldest.state))
      routes.delete(oldest.key)
    }
    return next
  }
  function describe(record: Preview, url: string, revision: number, routeKey?: string): FilePreviewDescriptor {
    const currentRoute = routes.get(routeKey ?? record.routeKey) ?? route(record, record.path)
    record.routeKey = currentRoute.key
    return {
      id: record.id, appSessionId: record.appSessionId, path: record.path,
      displayPath: record.path.replace(/^http:\/\//i, ''), kind: 'localhost', url, revision,
      frameName: `cat-localhost-preview-${record.id}-${revision}`, baseUrl: record.baseUrl,
      routeKey: currentRoute?.key, ...(record.stopped ? { serverStopped: true } : {}),
      ...(record.blockedUrl ? { blockedHost: new URL(record.blockedUrl).host } : {}),
    }
  }
  function stopped(record: Preview): void {
    if (!record.stopped) { record.stopped = true; deps.publish({ id: record.id, kind: 'server-stopped' }) }
  }
  function leave(id: string, value: string): boolean {
    const record = records.get(id)
    if (!record || !authorized(record)) return false
    try {
      const url = new URL(value)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
      record.blockedUrl = url.href
      deps.publish({ id, kind: 'leave', host: url.host })
      return true
    } catch { return false }
  }
  async function refresh(id: string): Promise<FilePreviewDescriptor | null> {
    const record = records.get(id)
    if (!record || !authorized(record)) return null
    const result = await probe(record.baseUrl)
    if (!records.has(id) || !authorized(record)) return null
    if (result.status === 'refused') { if (result.destination) leave(id, result.destination); return null }
    if (result.status === 'unavailable') {
      stopped(record)
      const frozen = deps.findSnapshot?.(record.appSessionId, record.path)
      if (!frozen) return null
      const revision = ++record.revision
      record.frozenIds.set(revision, frozen.id)
      const descriptor = describe(record, `cat-preview://${id}/r${revision}/index.html`, revision)
      record.descriptors.set(revision, descriptor)
      for (const candidate of record.descriptors.keys()) if (candidate !== record.committed && candidate !== revision) { record.descriptors.delete(candidate); record.frozenIds.delete(candidate) }
      deps.publish({ id, kind: 'updated', descriptor })
      return descriptor
    }
    record.stopped = false
    record.blockedUrl = null
    const descriptor = describe(record, result.url, ++record.revision)
    record.descriptors.set(record.revision, descriptor)
    for (const revision of record.descriptors.keys()) if (revision !== record.committed && revision !== record.revision) { record.descriptors.delete(revision); record.frozenIds.delete(revision) }
    deps.publish({ id, kind: 'updated', descriptor })
    return descriptor
  }
  function release(id: string) {
    const record = records.get(id)
    if (record) { clearInterval(record.timer); records.delete(id) }
  }
  return {
    allowed,
    probe,
    async prepare(input: unknown): Promise<LocalhostPreviewResult> {
      if (!exactObject(input, ['appSessionId', 'url']) || typeof input.appSessionId !== 'string') return { ok: false, reason: 'refused' }
      const url = allowed(input.url)
      const session = deps.sessions().find(session => session.appSessionId === input.appSessionId && !session.moving)
      if (!url || !session) return { ok: false, reason: 'refused' }
      for (const [id, record] of records) if (!authorized(record)) release(id)
      const existing = [...records.values()].find(record => record.appSessionId === input.appSessionId && record.path === url)
      if (existing) return { ok: true, descriptor: { ...existing.descriptors.get(existing.committed)!, ...(existing.stopped ? { serverStopped: true } : {}), ...(existing.blockedUrl ? { blockedHost: new URL(existing.blockedUrl).host } : {}) } }
      const priorRoute = [...routes.values()].reverse().find(route => route.appSessionId === input.appSessionId && route.url === url)
      const authorityCwd = session.cwd
      const result = await probe(priorRoute?.baseUrl ?? url)
      if (!deps.sessions().some(session => session.appSessionId === input.appSessionId && session.cwd === authorityCwd && !session.moving)) return { ok: false, reason: 'refused' }
      const frozen = result.status === 'unavailable' ? deps.findSnapshot?.(input.appSessionId, url) : null
      if (result.status === 'unavailable' && !frozen) return { ok: false, reason: 'unavailable', hostPort: localhostPreviewHostPort(url)! }
      if (result.status === 'refused') {
        const current = [...records.values()].find(record => record.appSessionId === input.appSessionId && deps.isLive?.(record.id))
        if (current && result.destination && leave(current.id, result.destination)) return { ok: true, descriptor: current.descriptors.get(current.committed)! }
        return { ok: false, reason: 'refused' }
      }
      if (records.size >= MAX_RECORDS || [...records.values()].filter(record => record.appSessionId === input.appSessionId).length >= 3) return { ok: false, reason: 'refused' }
      const record: Preview = {
        id: randomBytes(24).toString('hex'), appSessionId: input.appSessionId, authorityCwd, path: priorRoute || result.status !== 'online' ? url : result.url,
        baseUrl: priorRoute?.baseUrl ?? (result.status === 'online' ? result.url : url), revision: 1, committed: 1, descriptors: new Map(), stopped: result.status === 'unavailable',
        polling: false, blockedUrl: null, frozenIds: new Map(), routeKey: priorRoute?.key ?? '',
        timer: setInterval(() => {
          if (record.polling || !records.has(record.id) || !deps.isLive?.(record.id)) return
          record.polling = true
          void probe(record.baseUrl).then(result => {
            if (!records.has(record.id) || !authorized(record)) return
            if (result.status === 'unavailable') stopped(record)
            else if (result.status === 'online' && record.stopped) void refresh(record.id)
          }).finally(() => { record.polling = false })
        }, 1000),
      }
      record.timer.unref?.()
      if (frozen) record.frozenIds.set(1, frozen.id)
      const descriptor = describe(record, frozen ? `cat-preview://${record.id}/r1/index.html` : result.status === 'online' ? result.url : url, 1, priorRoute?.key)
      record.descriptors.set(1, descriptor)
      records.set(record.id, record)
      return { ok: true, descriptor }
    },
    refresh,
    settleNavigation(id: string, revision: number, actualUrl: string): { descriptor: FilePreviewDescriptor; replay: boolean } | null {
      const record = records.get(id), normalized = allowed(actualUrl)
      const descriptor = record?.descriptors.get(revision)
      if (!record || !descriptor || !normalized || !authorized(record)) return null
      const replay = descriptor.path !== descriptor.url && new URL(normalized).origin === new URL(descriptor.url).origin
      if (replay || normalized === descriptor.path) return { descriptor, replay }
      // HEAD can differ from GET. The real frame's allowed final URL owns its route.
      record.path = normalized
      record.baseUrl = normalized
      const visited = route(record, normalized)
      record.routeKey = visited.key
      const settled = { ...descriptor, path: normalized, displayPath: normalized.replace(/^http:\/\//i, ''), baseUrl: normalized, routeKey: visited.key }
      record.descriptors.set(revision, settled)
      deps.publish({ id, kind: 'route', url: normalized, scroll: { x: 0, y: 0 }, routeKey: visited.key, replace: true })
      return { descriptor: settled, replay: false }
    },
    commit(id: string, revision: number): boolean {
      const record = records.get(id)
      if (!record || !authorized(record) || !record.descriptors.has(revision)) return false
      record.committed = revision
      record.path = record.descriptors.get(revision)!.path
      for (const key of record.descriptors.keys()) if (key < revision) { record.descriptors.delete(key); record.frozenIds.delete(key) }
      return true
    },
    current(id: string) {
      const record = records.get(id)
      if (!record) return null
      const current = record.descriptors.get(record.committed)
      return current ? { ...current, ...(record.stopped ? { serverStopped: true } : {}), ...(record.blockedUrl ? { blockedHost: new URL(record.blockedUrl).host } : {}) } : null
    },
    rememberRoute(id: string, url: string, state: unknown) {
      const record = records.get(id)
      if (!record || !allowed(url) || !authorized(record)) return null
      const known = routes.get(record.routeKey)
      if (known && known.url === url) {
        let serialized: string
        try { serialized = JSON.stringify(state) } catch { return known }
        if (Buffer.byteLength(serialized) <= MAX_ROUTE_STATE_BYTES) {
          const before = Buffer.byteLength(JSON.stringify(known.state))
          if (routeStateBytes - before + Buffer.byteLength(serialized) <= MAX_ROUTE_STATE_TOTAL_BYTES) { known.state = JSON.parse(serialized); routeStateBytes += Buffer.byteLength(serialized) - before }
        }
        return known
      }
      return route(record, url, state)
    },
    descriptor(id: string, revision: number) { return records.get(id)?.descriptors.get(revision) ?? null },
    has(id: string) { return records.has(id) },
    release,
    leave,
    blockedUrl(id: string) { return records.get(id)?.blockedUrl ?? null },
    clearBlocked(id: string) { const record = records.get(id); if (record) record.blockedUrl = null },
    route(id: string, url: string, scroll: FilePreviewScroll, state: unknown, replace = false): FilePreviewDescriptor | null {
      const record = records.get(id), normalized = allowed(url)
      if (!record || !normalized || !authorized(record) || new URL(normalized).origin !== new URL(record.baseUrl).origin) return null
      const visited = route(record, normalized, state)
      record.path = normalized
      record.routeKey = visited.key
      const current = record.descriptors.get(record.committed)!
      const descriptor = { ...current, path: normalized, displayPath: normalized.replace(/^http:\/\//i, ''), routeKey: visited.key }
      record.descriptors.set(record.committed, descriptor)
      deps.publish({ id, kind: 'route', url: normalized, scroll, routeKey: visited.key, ...(replace ? { replace: true } : {}) })
      return descriptor
    },
    routeFor(id: string, key: string): LocalhostRoute | null {
      const record = records.get(id), known = routes.get(key)
      return record && known && authorized(record) && record.appSessionId === known.appSessionId && new URL(record.baseUrl).origin === new URL(known.url).origin ? known : null
    },
    restoreRoute(id: string, key: string): FilePreviewDescriptor | null {
      const record = records.get(id), known = routes.get(key)
      if (!record || !known || !authorized(record) || record.appSessionId !== known.appSessionId) return null
      record.path = known.url
      record.routeKey = key
      const descriptor = { ...record.descriptors.get(record.committed)!, path: known.url, displayPath: known.url.replace(/^http:\/\//i, ''), routeKey: key }
      record.descriptors.set(record.committed, descriptor)
      return descriptor
    },
    bindings() { return [...records.values()].flatMap(record => [...record.descriptors.values()].filter(descriptor => descriptor.url.startsWith('http:')).map(descriptor => ({ id: record.id, appSessionId: record.appSessionId, frameName: descriptor.frameName!, url: descriptor.path }))) },
    respond(id: string, revision: number, path: string): Response | null {
      const record = records.get(id)
      const frozenId = record?.frozenIds.get(revision)
      const frozen = frozenId ? deps.getSnapshot?.(frozenId) : null
      if (!record || !frozen || !record.descriptors.has(revision) || !authorized(record)) return null
      const resource = path === '/index.html' ? { mimeType: 'text/html; charset=utf-8', body: Buffer.from(frozen.html) } : /^\/asset\/([a-f0-9]{64})$/.test(path) ? frozen.resources.get(path.slice('/asset/'.length)) : null
      // Allow host frame evaluation for readiness/scroll; script-src none still forbids document scripts.
      return resource ? new Response(new Uint8Array(resource.body), { headers: { 'Content-Type': resource.mimeType, 'Content-Security-Policy': "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; frame-src 'none'; object-src 'none'; form-action 'none'; sandbox allow-same-origin allow-scripts", 'Cache-Control': 'no-store' } }) : new Response(null, { status: 404 })
    },
    dispose() { for (const id of records.keys()) release(id); routes.clear() },
  }
}
