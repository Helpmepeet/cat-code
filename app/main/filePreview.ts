import { constants, watch, type FSWatcher } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, extname, sep } from 'node:path'
import { resolveWorkspaceFile, type WorkspaceFileOptions } from './openWorkspaceFile.js'
import { FILE_PREVIEW_SCHEME, filePreviewKind, type FilePreviewDescriptor, type FilePreviewEvent } from '../shared/filePreview.js'
import type { SessionDescriptor } from '../shared/hostApi.js'

const MAX_FILE_BYTES = 16 * 1024 * 1024
const MAX_CACHE_BYTES = 128 * 1024 * 1024
const MAX_PREVIEWS = 32
const MAX_ASSETS = 128
const QUIET_MS = 180
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.markdown': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
}
const PAGE_CSP = "default-src * data: blob: cat-preview:; script-src * 'unsafe-inline' 'unsafe-eval' data: blob: cat-preview:; style-src * 'unsafe-inline' data: blob: cat-preview:; img-src * data: blob: cat-preview:; connect-src * data: blob: cat-preview:; frame-src 'none'; object-src 'none'; form-action 'none'; sandbox allow-scripts allow-same-origin"

type Snapshot = { revision: number; files: Map<string, Buffer>; failed: boolean }
type Preview = {
  id: string; appSessionId: string; authorityCwd: string; path: string; kind: NonNullable<ReturnType<typeof filePreviewKind>>
  snapshots: Map<number, Snapshot>; committed: number; nextRevision: number
  watched: Map<string, string | null>; watchers: Map<string, FSWatcher>
  timer?: ReturnType<typeof setTimeout>; poll: ReturnType<typeof setInterval>
  busy: boolean; dirty: boolean; removed: boolean; watchFailed: boolean; released: boolean
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const stamp = (info: Awaited<ReturnType<typeof stat>>) => `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
async function signature(path: string): Promise<string | null> {
  try { return stamp(await stat(path)) } catch { return null }
}

/** Readers never publish a torn read. Writer intent still requires atomic saves. */
async function stableRead(path: string): Promise<Buffer> {
  async function boundedRead() {
    const expected = await stat(path)
    if (await realpath(path) !== path) throw new Error('File moved')
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await handle.stat()
      if (info.ino !== expected.ino || info.dev !== expected.dev || await realpath(path) !== path) throw new Error('File moved')
      if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('File unavailable')
      const bytes = Buffer.alloc(info.size + 1)
      const result = await handle.read(bytes, 0, bytes.length, 0)
      const current = await stat(path)
      if (current.ino !== info.ino || current.dev !== info.dev || await realpath(path) !== path) throw new Error('File moved')
      if (result.bytesRead !== info.size) throw new Error('File changed')
      return bytes.subarray(0, result.bytesRead)
    } finally { await handle.close() }
  }
  const before = await stat(path)
  if (!before.isFile() || before.size > MAX_FILE_BYTES) throw new Error('File unavailable')
  const first = await boundedRead()
  await pause(35)
  const after = await stat(path)
  if (stamp(before) !== stamp(after) || first.length !== after.size) throw new Error('File changed')
  const second = await boundedRead()
  if (!first.equals(second) || stamp(after) !== stamp(await stat(path))) throw new Error('File changed')
  return first
}

export function parseFilePreviewUrl(value: string): { id: string; revision: number; path: string } | null {
  try {
    const url = new URL(value)
    if (url.protocol !== `${FILE_PREVIEW_SCHEME}:` || url.username || url.password || url.port || !/^[a-f0-9]{48}$/.test(url.hostname)) return null
    const match = /^\/r([1-9]\d*)\/(.+)$/.exec(url.pathname)
    if (!match || !Number.isSafeInteger(Number(match[1]))) return null
    const path = decodeURIComponent(`/${match[2]}`)
    if (path.includes('\0') || path.length > 4096) return null
    return { id: url.hostname, revision: Number(match[1]), path }
  } catch { return null }
}

export function createFilePreviewService(deps: {
  sessions: () => readonly SessionDescriptor[]
  options?: WorkspaceFileOptions
  publish: (event: FilePreviewEvent) => void
  home?: string
}) {
  const previews = new Map<string, Preview>()
  let cachedBytes = 0
  let pendingPrepares = 0
  let activeReads = 0
  const waitingReads: Array<() => void> = []
  const assetReads = new Map<string, Promise<Buffer | null>>()
  async function read(path: string): Promise<Buffer> {
    if (activeReads >= 2) {
      if (waitingReads.length >= 32) throw new Error('Preview busy')
      await new Promise<void>(resolve => waitingReads.push(resolve))
    } else activeReads++
    try { return await stableRead(path) }
    finally {
      const next = waitingReads.shift()
      if (next) next()
      else activeReads--
    }
  }
  function authorized(preview: Preview): boolean {
    return deps.sessions().some(session => session.appSessionId === preview.appSessionId && session.cwd === preview.authorityCwd && !session.moving)
  }
  const home = deps.home ?? homedir()
  function descriptor(preview: Preview, snapshot: Snapshot): FilePreviewDescriptor {
    const encoded = preview.path.split(sep).map(encodeURIComponent).join('/')
    return {
      id: preview.id, appSessionId: preview.appSessionId, path: preview.path,
      displayPath: preview.path === home || preview.path.startsWith(`${home}${sep}`) ? `~${preview.path.slice(home.length)}` : preview.path,
      kind: preview.kind, revision: snapshot.revision,
      ...(preview.watchFailed ? { watchError: true } : {}),
      url: `${FILE_PREVIEW_SCHEME}://${preview.id}/r${snapshot.revision}${encoded}`,
      ...(preview.kind === 'markdown' ? { markdown: snapshot.files.get(preview.path)!.toString('utf8') } : {}),
    }
  }
  function dropSnapshot(preview: Preview, revision: number) {
    const snapshot = preview.snapshots.get(revision)
    if (!snapshot) return
    for (const bytes of snapshot.files.values()) cachedBytes -= bytes.length
    preview.snapshots.delete(revision)
  }
  function announceWatchFailure(preview: Preview) {
    if (!preview.watchFailed && !preview.released) {
      preview.watchFailed = true
      deps.publish({ id: preview.id, kind: 'watch-error' })
    }
  }
  function track(preview: Preview, path: string) {
    if (preview.watched.has(path)) return
    if (preview.watched.size >= MAX_ASSETS) { announceWatchFailure(preview); return }
    preview.watched.set(path, null)
    void signature(path).then(value => { if (!preview.released) preview.watched.set(path, value) })
    const directory = dirname(path)
    if (preview.watchers.has(directory)) return
    try {
      const watcher = watch(directory, (_event, filename) => {
        if (filename === null || [...preview.watched.keys()].some(file => dirname(file) === directory && basename(file) === filename.toString())) schedule(preview)
      })
      watcher.on('error', () => announceWatchFailure(preview))
      watcher.unref()
      preview.watchers.set(directory, watcher)
    } catch { announceWatchFailure(preview) }
  }
  function schedule(preview: Preview) {
    if (preview.released) return
    preview.dirty = true
    if (preview.timer) clearTimeout(preview.timer)
    preview.timer = setTimeout(() => { preview.timer = undefined; void refresh(preview.id) }, QUIET_MS)
    preview.timer.unref?.()
  }
  async function resolve(preview: Pick<Preview, 'appSessionId'>, path: string) {
    return resolveWorkspaceFile({ appSessionId: preview.appSessionId, path }, deps.sessions(), deps.options)
  }
  async function refresh(id: string): Promise<FilePreviewDescriptor | null> {
    const preview = previews.get(id)
    if (!preview || preview.released) return null
    if (!authorized(preview)) { release(id); return null }
    if (preview.busy) { preview.dirty = true; return null }
    preview.busy = true
    preview.dirty = false
    try {
      const resolved = await resolve(preview, preview.path)
      if (!resolved) {
        if (!preview.removed) deps.publish({ id, kind: 'removed' })
        preview.removed = true
        return null
      }
      const bytes = await read(resolved.path)
      const total = bytes.length
      if (cachedBytes + total > MAX_CACHE_BYTES) {
        deps.publish({ id, kind: 'update-error' }); return null
      }
      const files = new Map([[preview.path, bytes]])
      if (preview.released || !authorized(preview)) return null
      preview.removed = false
      for (const revision of preview.snapshots.keys()) if (revision !== preview.committed) dropSnapshot(preview, revision)
      const snapshot: Snapshot = { revision: ++preview.nextRevision, files, failed: false }
      preview.snapshots.set(snapshot.revision, snapshot)
      cachedBytes += total
      for (const path of preview.watched.keys()) preview.watched.set(path, await signature(path))
      const result = descriptor(preview, snapshot)
      deps.publish({ id, kind: 'updated', descriptor: result })
      return result
    } catch {
      // The prior page remains visible while a writer or read is unavailable.
      if (!preview.released) deps.publish({ id, kind: 'update-error' })
      return null
    } finally {
      preview.busy = false
      if (preview.dirty) { preview.dirty = false; schedule(preview) }
    }
  }
  function release(id: string) {
    const preview = previews.get(id)
    if (!preview) return
    preview.released = true
    if (preview.timer) clearTimeout(preview.timer)
    clearInterval(preview.poll)
    for (const watcher of preview.watchers.values()) watcher.close()
    for (const revision of preview.snapshots.keys()) dropSnapshot(preview, revision)
    previews.delete(id)
  }
  return {
    async prepare(input: unknown): Promise<FilePreviewDescriptor | null> {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2 || !Object.hasOwn(input, 'appSessionId') || !Object.hasOwn(input, 'path')) return null
      if (previews.size + pendingPrepares >= MAX_PREVIEWS || pendingPrepares >= 4) return null
      pendingPrepares++
      try {
        const appSessionId = (input as { appSessionId: string }).appSessionId
        const authority = deps.sessions().find(session => session.appSessionId === appSessionId)
        if (!authority || authority.moving) return null
        const authorityCwd = authority.cwd
        const resolved = await resolveWorkspaceFile(input, deps.sessions(), deps.options)
        if (!resolved) return null
        const kind = filePreviewKind(resolved.path)
        if (!kind) return null
        const bytes = await read(resolved.path)
        if (cachedBytes + bytes.length > MAX_CACHE_BYTES) return null
        if (!deps.sessions().some(session => session.appSessionId === appSessionId && session.cwd === authorityCwd && !session.moving)) return null
        const preview: Preview = {
          id: randomBytes(24).toString('hex'), appSessionId, authorityCwd, path: resolved.path, kind,
          snapshots: new Map(), committed: 1, nextRevision: 1,
          watched: new Map(), watchers: new Map(), busy: false, dirty: false, removed: false, watchFailed: false, released: false,
          poll: setInterval(() => {
            void Promise.all([...preview.watched].map(async ([path, old]) => {
              const current = await signature(path)
              if (current !== old) { preview.watched.set(path, current); schedule(preview) }
            }))
          }, 1500),
        }
        preview.poll.unref?.()
        const snapshot = { revision: 1, files: new Map([[preview.path, bytes]]), failed: false }
        preview.snapshots.set(1, snapshot)
        cachedBytes += bytes.length
        previews.set(preview.id, preview)
        track(preview, preview.path)
        return descriptor(preview, snapshot)
      } catch { return null }
      finally { pendingPrepares-- }
    },
    refresh,
    commit(id: string, revision: number): boolean {
      const preview = previews.get(id)
      if (!preview?.snapshots.has(revision) || !authorized(preview)) return false
      if (preview.snapshots.get(revision)!.failed) { deps.publish({ id, kind: 'update-error' }); return false }
      preview.committed = revision
      for (const key of preview.snapshots.keys()) if (key !== revision) dropSnapshot(preview, key)
      const used = preview.snapshots.get(revision)!.files
      for (const path of preview.watched.keys()) if (!used.has(path)) preview.watched.delete(path)
      for (const [directory, watcher] of preview.watchers) {
        if (![...preview.watched.keys()].some(path => dirname(path) === directory)) { watcher.close(); preview.watchers.delete(directory) }
      }
      return true
    },
    release,
    has(id: string): boolean { return previews.has(id) },
    sessionId(id: string): string | null { return previews.get(id)?.appSessionId ?? null },
    descriptor(id: string, revision: number): FilePreviewDescriptor | null {
      const preview = previews.get(id), snapshot = preview?.snapshots.get(revision)
      return preview && snapshot ? descriptor(preview, snapshot) : null
    },
    async respond(request: Request): Promise<Response> {
      const parsed = parseFilePreviewUrl(request.url)
      const preview = parsed && previews.get(parsed.id)
      const snapshot = parsed && preview?.snapshots.get(parsed.revision)
      if (!parsed || !preview || !snapshot || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 404 })
      if (!authorized(preview)) { release(preview.id); return new Response(null, { status: 403 }) }
      // The snapshot survives deletion, but new assets still require current policy.
      let bytes = snapshot.files.get(parsed.path)
      if (!bytes) {
        if (snapshot.files.size >= MAX_ASSETS) { snapshot.failed = true; return new Response(null, { status: 413 }) }
        const resolved = await resolve(preview, parsed.path)
        if (!resolved || resolved.path !== parsed.path) { snapshot.failed = true; return new Response(null, { status: 403 }) }
        const key = `${preview.id}:${snapshot.revision}:${parsed.path}`
        let pending = assetReads.get(key)
        if (!pending) {
          if (assetReads.size >= 32) return new Response(null, { status: 429 })
          pending = (async () => {
            try {
              const data = await read(resolved.path)
              if (preview.released || !authorized(preview) || preview.snapshots.get(snapshot.revision) !== snapshot || cachedBytes + data.length > MAX_CACHE_BYTES) return null
              const existing = snapshot.files.get(parsed.path)
              if (existing) return existing
              snapshot.files.set(parsed.path, data)
              cachedBytes += data.length
              track(preview, parsed.path)
              return data
            } catch { return null }
            finally { assetReads.delete(key) }
          })()
          assetReads.set(key, pending)
        }
        bytes = await pending ?? undefined
        if (!bytes) { snapshot.failed = true; return new Response(null, { status: 404 }) }
      }
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes), {
        headers: {
          'Content-Type': MIME[extname(parsed.path).toLowerCase()] ?? 'application/octet-stream',
          'Content-Security-Policy': PAGE_CSP,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    },
    dispose() { for (const id of previews.keys()) release(id) },
  }
}
