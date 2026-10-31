import { execFile } from 'node:child_process'
import { mkdtemp, open, realpath, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { parseExternalAppIconTarget, type ExternalAppIconResult, type ExternalAppIconTarget } from '../shared/externalAppIcons.js'

const MAX_SOURCE_BYTES = 16 * 1024 * 1024
const MAX_PNG_BYTES = 512 * 1024
const CACHE_LIMIT = 32
const CACHE_TTL_MS = 5 * 60_000

export type IconCommandRunner = (file: string, args: readonly string[]) => Promise<string>
const runCommand: IconCommandRunner = (file, args) => new Promise((resolve, reject) => {
  execFile(file, [...args], { timeout: 2500, maxBuffer: 64 * 1024, encoding: 'utf8', killSignal: 'SIGKILL' },
    (error, stdout) => error ? reject(error) : resolve(stdout.trim()))
})

// Arguments are data, not interpolated JavaScript. NSWorkspace only resolves URLs;
// none of these calls launch an application or send it an Apple event.
const RESOLVE_APP_SCRIPT = `ObjC.import('AppKit');
function run(argv) {
  const ws = $.NSWorkspace.sharedWorkspace;
  const url = argv[0] === 'bundle'
    ? ws.URLForApplicationWithBundleIdentifier(argv[1])
    : ws.URLForApplicationToOpenURL(argv[0] === 'file'
      ? $.NSURL.fileURLWithPath(argv[1]) : $.NSURL.URLWithString('https://example.com'));
  return JSON.stringify(url && !url.isNil() ? ObjC.unwrap(url.path) : null);
}`

const APPS = {
  chrome: { id: 'com.google.Chrome', name: 'Google Chrome.app' },
  safari: { id: 'com.apple.Safari', name: 'Safari.app' },
  vscode: { id: 'com.microsoft.VSCode', name: 'Visual Studio Code.app' },
  zed: { id: 'dev.zed.Zed', name: 'Zed.app' },
  cursor: { id: 'com.todesktop.230313mzl4w4u92', name: 'Cursor.app' },
  finder: { id: 'com.apple.finder', name: 'Finder.app' },
} as const

export interface ExternalAppIconServiceOptions {
  platform?: string
  run?: IconCommandRunner
  applicationDirectories?: readonly string[]
  temporaryDirectory?: string
  now?: () => number
}

/** Main-process only. trustedPath must already have passed workspace validation. */
export function createExternalAppIconService(options: ExternalAppIconServiceOptions = {}) {
  const run = options.run ?? runCommand
  const platform = options.platform ?? process.platform
  const roots = options.applicationDirectories ?? ['/Applications', join(homedir(), 'Applications')]
  const now = options.now ?? Date.now
  const cache = new Map<string, { dataUrl: string; expires: number }>()
  const bundles = new Map<string, Promise<ExternalAppIconResult>>()
  const requests = new Map<string, Promise<ExternalAppIconResult>>()
  const installationRequests = new Map<string, Promise<boolean>>()
  let active = 0
  const waiters: Array<() => void> = []

  async function resolveBundle(target: ExternalAppIconTarget, trustedPath?: string): Promise<string | null> {
    const app = target in APPS ? APPS[target as keyof typeof APPS] : undefined
    let resolved: unknown = null
    try {
      resolved = JSON.parse(await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', RESOLVE_APP_SCRIPT, '--',
        app ? 'bundle' : target === 'default' ? 'file' : 'browser', app?.id ?? trustedPath ?? '']))
    } catch { /* Installation fallbacks remain available when Launch Services fails. */ }
    const candidates = typeof resolved === 'string' ? [resolved] : []
    if (app) {
      if (target === 'finder') candidates.push('/System/Library/CoreServices/Finder.app')
      if (target === 'safari') candidates.push('/System/Applications/Safari.app')
      candidates.push(...roots.map(root => join(root, app.name)))
    }
    for (const candidate of candidates) {
      if (!isAbsolute(candidate) || !candidate.endsWith('.app') || candidate.includes('\0')) continue
      try {
        const bundle = await realpath(candidate)
        if (!(await stat(bundle)).isDirectory()) continue
        if (app) {
          const identity = await run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(bundle, 'Contents/Info.plist')])
          if (identity.trim() !== app.id) continue
        }
        return bundle
      } catch { /* Try the next installed bundle. */ }
    }
    return null
  }

  async function extract(bundle: string): Promise<ExternalAppIconResult> {
    let temporary: string | undefined
    try {
      const iconName = (await run('/usr/bin/plutil', ['-extract', 'CFBundleIconFile', 'raw', '-o', '-', join(bundle, 'Contents/Info.plist')])).trim()
      if (!iconName || iconName.length > 255 || basename(iconName) !== iconName || iconName === '.' || iconName === '..' || iconName.includes('\0')) return { dataUrl: null }
      const resources = await realpath(join(bundle, 'Contents/Resources'))
      const icon = await realpath(join(resources, iconName.endsWith('.icns') ? iconName : `${iconName}.icns`))
      const rel = relative(resources, icon)
      if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) return { dataUrl: null }
      const source = await stat(icon)
      if (!source.isFile() || source.size === 0 || source.size > MAX_SOURCE_BYTES) return { dataUrl: null }
      temporary = await mkdtemp(join(options.temporaryDirectory ?? tmpdir(), 'cat-code-app-icon-'))
      const output = join(temporary, 'icon.png')
      await run('/usr/bin/sips', ['-s', 'format', 'png', '-z', '64', '64', icon, '--out', output])
      // Read at most the limit even if a converter produces unexpectedly large output.
      const handle = await open(output, 'r')
      let png: Buffer
      try {
        const info = await handle.stat()
        if (!info.isFile() || info.size < 33 || info.size > MAX_PNG_BYTES) return { dataUrl: null }
        png = Buffer.alloc(info.size)
        const { bytesRead } = await handle.read(png, 0, png.length, 0)
        if (bytesRead !== png.length) return { dataUrl: null }
      } finally { await handle.close() }
      if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        png.toString('ascii', 12, 16) !== 'IHDR' || png.readUInt32BE(16) !== 64 || png.readUInt32BE(20) !== 64) return { dataUrl: null }
      return { dataUrl: `data:image/png;base64,${png.toString('base64')}` }
    } catch {
      return { dataUrl: null }
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => {})
    }
  }

  async function load(target: ExternalAppIconTarget, trustedPath?: string): Promise<ExternalAppIconResult> {
    const bundle = await resolveBundle(target, trustedPath)
    if (!bundle) return { dataUrl: null }
    const cached = cache.get(bundle)
    if (cached && cached.expires > now()) {
      cache.delete(bundle)
      cache.set(bundle, cached)
      return { dataUrl: cached.dataUrl }
    }
    cache.delete(bundle)
    const pending = bundles.get(bundle)
    if (pending) return pending
    const promise = extract(bundle).then(result => {
      if (result.dataUrl) {
        cache.set(bundle, { dataUrl: result.dataUrl, expires: now() + CACHE_TTL_MS })
        if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
      }
      return result
    }).finally(() => bundles.delete(bundle))
    bundles.set(bundle, promise)
    return promise
  }

  return {
    installed(target: ExternalAppIconTarget, trustedPath?: string): Promise<boolean> {
      if (platform !== 'darwin' || !parseExternalAppIconTarget(target)) return Promise.resolve(false)
      const key = JSON.stringify([target, target === 'default' ? trustedPath : null])
      const existing = installationRequests.get(key)
      if (existing) return existing
      if (installationRequests.size >= 32) return Promise.resolve(false)
      const promise = (async () => {
        if (active >= 4) await new Promise<void>(resolve => waiters.push(resolve))
        else active++
        try { return await resolveBundle(target, trustedPath) !== null }
        catch { return false }
        finally {
          const next = waiters.shift()
          if (next) next()
          else active--
        }
      })().finally(() => installationRequests.delete(key))
      installationRequests.set(key, promise)
      return promise
    },
    read(target: ExternalAppIconTarget, trustedPath?: string): Promise<ExternalAppIconResult> {
      if (platform !== 'darwin' || !parseExternalAppIconTarget(target) ||
        (target === 'default' && (!trustedPath || !isAbsolute(trustedPath) || trustedPath.length > 4096 || trustedPath.includes('\0')))) return Promise.resolve({ dataUrl: null })
      const key = JSON.stringify([target, target === 'default' ? trustedPath : null])
      const existing = requests.get(key)
      if (existing) return existing
      if (requests.size >= 32) return Promise.resolve({ dataUrl: null })
      const promise = (async () => {
        if (active >= 4) await new Promise<void>(resolve => waiters.push(resolve))
        else active++
        try { return await load(target, trustedPath) }
        catch { return { dataUrl: null } }
        finally {
          const next = waiters.shift()
          if (next) next()
          else active--
        }
      })().finally(() => requests.delete(key))
      requests.set(key, promise)
      return promise
    },
  }
}
