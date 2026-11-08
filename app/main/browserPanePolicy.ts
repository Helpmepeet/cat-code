import { realpath, stat, readFile } from 'node:fs/promises'
import { dirname, relative, isAbsolute, resolve, extname, sep } from 'node:path'
import { createHash } from 'node:crypto'

export const BROWSER_LOCAL_SCHEME = 'cat-browser-local'
export type BrowserPanePolicyDependencies = { folders: (id: string) => readonly string[] | null; devOrigin: string | null }
function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(hostname)
}
function contains(root: string, file: string): boolean {
  const rel = relative(root, file)
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}
export class BrowserPanePolicy {
  private directories = new Map<string, Map<string, string>>()
  constructor(private readonly deps: BrowserPanePolicyDependencies) {}
  loopback(value: string): boolean {
    try {
      const url = new URL(value)
      const dev = this.deps.devOrigin ? new URL(this.deps.devOrigin) : null
      // Host aliases can reach the same dev listener, so its port is reserved across loopback.
      const isDev = dev && url.protocol === dev.protocol && url.port === dev.port &&
        (url.hostname === dev.hostname || isLoopbackHost(dev.hostname))
      return url.protocol === 'http:' && !url.username && !url.password &&
        isLoopbackHost(url.hostname) && !isDev
    } catch { return false }
  }
  private async authorized(id: string, path: string): Promise<boolean> {
    const folders = this.deps.folders(id)
    if (!folders) return false
    for (const folder of folders) {
      try { if (contains(await realpath(folder), path)) return true } catch { /* A removed folder grants nothing. */ }
    }
    return false
  }
  async navigate(id: string, target: string): Promise<string> {
    if (this.loopback(target)) return new URL(target).href
    if (target.startsWith(`${BROWSER_LOCAL_SCHEME}://`)) {
      if ((await this.resolveLocal(id, target)) === null) throw new Error('Local document is not allowed')
      return new URL(target).href
    }
    if (!isAbsolute(target)) throw new Error('Only loopback HTTP or local paths are allowed')
    const path = await realpath(target)
    if (!await this.authorized(id, path) || !(await stat(path)).isFile()) throw new Error('Local document is outside the session folders')
    const dir = dirname(path)
    const host = createHash('sha256').update(dir).digest('hex')
    let origins = this.directories.get(id)
    if (!origins) this.directories.set(id, origins = new Map())
    origins.set(host, dir)
    return `${BROWSER_LOCAL_SCHEME}://${host}/${encodeURIComponent(relative(dir, path))}`
  }
  private async resolveLocal(id: string, value: string): Promise<string | null> {
    try {
      const url = new URL(value)
      if (url.protocol !== `${BROWSER_LOCAL_SCHEME}:` || url.username || url.password || url.port) return null
      const dir = this.directories.get(id)?.get(url.hostname)
      if (!dir) return null
      const path = await realpath(resolve(dir, `.${decodeURIComponent(url.pathname)}`))
      return contains(dir, path) && await this.authorized(id, path) && (await stat(path)).isFile() ? path : null
    } catch { return null }
  }
  /** Revalidates canonical containment before exposing a local document externally. */
  localPath(id: string, url: string): Promise<string | null> { return this.resolveLocal(id, url) }
  async displayUrl(id: string, url: string): Promise<string> { return await this.localPath(id, url) ?? url }
  allowRequest(id: string, target: string, source: string, navigationTarget?: string): boolean {
    try {
      // Main supplies this only for an explicitly requested top-level navigation.
      if (navigationTarget && (target === navigationTarget || this.loopback(navigationTarget) && this.loopback(target))) source = ''
      const url = new URL(target)
      const local = url.protocol === `${BROWSER_LOCAL_SCHEME}:` && !!this.directories.get(id)?.has(url.hostname)
      if (source.startsWith(`${BROWSER_LOCAL_SCHEME}:`)) return local && new URL(source).host === url.host
      return local || this.loopback(target)
    } catch { return false }
  }
  async respond(id: string, url: string): Promise<Response> {
    const path = await this.resolveLocal(id, url)
    if (!path) return new Response(null, { status: 403 })
    const mime: Record<string, string> = { '.html': 'text/html', '.htm': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' }
    try { return new Response(await readFile(path), { headers: { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream', 'Content-Security-Policy': "connect-src 'self'; form-action 'self'; frame-src 'self'", 'X-Content-Type-Options': 'nosniff' } }) }
    catch { return new Response(null, { status: 404 }) }
  }
  forget(id: string): void { this.directories.delete(id) }
}
