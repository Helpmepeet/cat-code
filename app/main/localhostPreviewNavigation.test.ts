import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalhostPreviewService, localhostPreviewInnerFrameAllowed } from './localhostPreview.js'
import { createFilePreviewService, parseFilePreviewUrl } from './filePreview.js'
import { sessionDescriptorFixture } from '../shared/sessionDescriptor.fixture.js'

// Execute the registered handlers without importing main.ts and starting Electron.
const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
function between(start: string, end: string): string {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length)
  if (from < 0 || to < 0) throw new Error(`Missing main.ts handler boundary: ${start}`)
  return source.slice(from, to)
}
const handlerCode = new Bun.Transpiler({ loader: 'ts' }).transformSync([
  between('function livePreviewFrame(', 'function previewDescriptor('),
  between('async function localNavigationMethod(', 'function installLocalHistory('),
  between('function applySecurityBaseline(', '/** The layout-derived floor'),
  'applySecurityBaseline();',
  between("  window.webContents.on('will-frame-navigate'", "  window.webContents.on('frame-created'"),
].join('\n'))

type Frame = {
  frameTreeNodeId: number; parent: Frame | null; url: string; name: string; detached: boolean
  isDestroyed: () => boolean; executeJavaScript: (script: string) => Promise<unknown>
}
type Navigation = { frame: Frame; url: string; initiator: Frame; isMainFrame: boolean; preventDefault: () => void }
type Request = { frame: Frame; url: string; resourceType: string; webContentsId: number; responseHeaders?: Record<string, string[]> }
function fixture(filePreviews: Pick<ReturnType<typeof createFilePreviewService>, 'has' | 'pathForUrl'> = { has: () => false, pathForUrl: () => null }) {
  const callbacks = new Map<string, (event: Navigation, url?: string) => void>()
  let beforeRequest!: (details: Request, callback: (result: { cancel?: boolean }) => void) => void
  let headersReceived!: (details: Request, callback: (result: { responseHeaders: Record<string, string[]> }) => void) => void
  const sent: unknown[] = [], notes: unknown[] = [], leaves: unknown[] = [], refreshes: string[] = []
  let nextNode = 0
  const page = { __catcodeLocalHistory: { form: null as null | { url: string; method: string } } }
  const frame = (url: string, parent: Frame | null): Frame => ({
    frameTreeNodeId: ++nextNode, parent, url, name: '', detached: false, isDestroyed: () => false,
    executeJavaScript: script => Promise.resolve(new Function('window', `return ${script}`)(page)),
  })
  const main = frame('http://localhost:5173/', null)
  const outer = frame('http://localhost:6006/story', main)
  const inner = frame('http://localhost:6006/iframe.html', outer)
  const nested = frame('http://localhost:6006/nested', inner)
  const descriptor = { id: 'preview', revision: 1, path: outer.url }
  const bindings = new Map([[outer.frameTreeNodeId, { id: descriptor.id, revision: 1 }]])
  const admission = createLocalhostPreviewService({ sessions: () => [], devOrigin: main.url, publish: () => {} })
  const localhostPreviews = {
    allowed: admission.allowed, has: (id: string) => id === descriptor.id,
    descriptor: (id: string, revision: number) => id === descriptor.id && revision === 1 ? descriptor : null,
    current: () => descriptor,
    browserNote: (...args: unknown[]) => { notes.push(args) },
    leave: (...args: unknown[]) => { leaves.push(args) },
    refresh: (id: string) => { refreshes.push(id) },
  }
  const window = { isDestroyed: () => false, webContents: {
    id: 7, mainFrame: Object.assign(main, { send: (_channel: string, event: unknown) => sent.push(event) }),
    on: (name: string, callback: (event: Navigation, url?: string) => void) => callbacks.set(name, callback),
  } }
  const context = {
    window, mainWindow: window, localhostPreviews, localFrameBindings: bindings,
    localhostPreviewInnerFrameAllowed, parseFilePreviewUrl, filePreviews,
    FILE_PREVIEW_SCHEME: 'cat-preview', CH_FILE_PREVIEW_EVENT: 'preview-event', IS_DEV: true,
    VITE_REACT_PREAMBLE_CSP_HASH: 'hash',
    session: { defaultSession: { webRequest: {
      onBeforeRequest: (callback: typeof beforeRequest) => { beforeRequest = callback },
      onHeadersReceived: (callback: typeof headersReceived) => { headersReceived = callback },
    } } },
  }
  new Function('context', `const {${Object.keys(context).join(',')}} = context;\n${handlerCode}`)(context)
  function navigate(target: Frame, url: string, redirect = false, initiator = target) {
    let cancelled = false
    const event = { frame: target, url, initiator, isMainFrame: false, preventDefault: () => { cancelled = true } }
    callbacks.get(redirect ? 'will-redirect' : 'will-frame-navigate')!(event, url)
    return cancelled
  }
  function request(target: Frame, url: string, resourceType = 'subFrame') {
    let result: { cancel?: boolean } | undefined
    beforeRequest({ frame: target, url, resourceType, webContentsId: 7 }, value => { result = value })
    return result
  }
  function headers(target: Frame, url: string, resourceType = 'subFrame') {
    let result: Record<string, string[]> | undefined
    headersReceived({ frame: target, url, resourceType, webContentsId: 7, responseHeaders: {
      'X-Frame-Options': ['DENY'], 'Content-Security-Policy': ["default-src 'self'; frame-ancestors 'none'; script-src 'self'"],
      'Content-Type': ['text/html'],
    } }, value => { result = value.responseHeaders })
    return result!
  }
  return { outer, inner, nested, main, frame, page, sent, notes, leaves, refreshes, navigate, request, headers, bindings }
}

for (const method of ['POST', 'UNKNOWN', 'timeout', 'rejection'] as const) test(`${method} navigation is cancelled, notes the displayed page, and never replays`, async () => {
  const f = fixture()
  if (method === 'POST') f.page.__catcodeLocalHistory.form = { url: 'http://localhost:6006/form-target', method: 'POST' }
  if (method === 'UNKNOWN') f.outer.executeJavaScript = () => Promise.resolve('UNKNOWN')
  if (method === 'timeout') f.outer.executeJavaScript = () => new Promise(() => {})
  if (method === 'rejection') f.outer.executeJavaScript = () => Promise.reject(new Error('frame unavailable'))
  expect(f.navigate(f.outer, 'http://localhost:6006/form-target')).toBe(true)
  await Bun.sleep(method === 'timeout' ? 180 : 0)
  expect(f.notes).toEqual([['preview', 1, 'browser-required']])
  expect(f.sent).toEqual([])
  expect(f.refreshes).toEqual([])
  expect(f.leaves).toEqual([])
})

test('GET navigation and cross-origin departure keep their existing behavior', async () => {
  const f = fixture()
  expect(f.navigate(f.outer, 'http://localhost:6006/next')).toBe(true)
  await Bun.sleep(0)
  expect(f.sent).toEqual([{ id: 'preview', kind: 'navigate', path: 'http://localhost:6006/next' }])
  expect(f.navigate(f.outer, f.outer.url)).toBe(true)
  await Bun.sleep(0)
  expect(f.refreshes).toEqual(['preview'])
  expect(f.navigate(f.outer, 'https://example.invalid/leave')).toBe(true)
  expect(f.leaves).toEqual([['preview', 'https://example.invalid/leave']])
  expect(f.notes).toEqual([])
})

test('a delayed method result cannot note or replay a page after its frame changes', async () => {
  const f = fixture()
  let resolve!: (method: string) => void
  f.outer.executeJavaScript = () => new Promise(done => { resolve = done })
  f.navigate(f.outer, 'http://localhost:6006/form-target')
  f.outer.url = 'http://localhost:6006/other-page'
  resolve('POST')
  await Bun.sleep(0)
  expect(f.notes).toEqual([])
  expect(f.sent).toEqual([])
})

test('same-origin inner frames and deeper descendants pass navigation, request, and redirect guards without replay', () => {
  const f = fixture()
  for (const frame of [f.inner, f.nested]) {
    expect(f.navigate(frame, 'http://localhost:6006/canvas')).toBe(false)
    expect(f.request(frame, 'http://localhost:6006/canvas')).toEqual({})
    expect(f.navigate(frame, 'http://localhost:6006/canvas-redirect', true)).toBe(false)
  }
  expect(f.sent).toEqual([])
  expect(f.notes).toEqual([])
})

test('other origins, own dev origin, and non-HTTP inner frames stay blocked and note their owner, including redirects', () => {
  const f = fixture()
  for (const url of ['http://localhost:6007/foreign', 'http://localhost:5173/app', 'https://example.invalid/', 'about:blank', 'cat-preview://unknown/r1/index.html']) {
    expect(f.navigate(f.inner, url)).toBe(true)
    expect(f.request(f.inner, url)).toEqual({ cancel: true })
    expect(f.navigate(f.inner, url, true)).toBe(true)
  }
  expect(f.notes).toHaveLength(15)
  expect(f.notes.every(note => JSON.stringify(note) === JSON.stringify(['preview', 1, 'frame-blocked']))).toBe(true)
  expect(f.sent).toEqual([])
  expect(f.leaves).toEqual([])
  // An unbound sibling cannot inherit another preview's admission.
  expect(f.request(f.frame('about:blank', f.main), 'http://localhost:6006/')).toEqual({ cancel: true })
  expect(f.request(f.outer, 'http://localhost:5173/redirected')).toEqual({ cancel: true })
})

test('file preview root-relative links pass request guards and navigate to workspace files', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cat-preview-navigation-')))
  const service = createFilePreviewService({ sessions: () => [sessionDescriptorFixture({ appSessionId: 's1', cwd: root })], publish: () => {} })
  try {
    await mkdir(join(root, 'pages'))
    await writeFile(join(root, 'pages/report.html'), '<a href="/next%20%23.html">Next</a>')
    await writeFile(join(root, 'next #.html'), '<h1>Next</h1>')
    const preview = await service.prepare({ appSessionId: 's1', path: 'pages/report.html' })
    expect(preview).not.toBeNull()
    const f = fixture(service)
    const file = f.frame(preview!.url, f.main)
    const target = new URL('/next%20%23.html', preview!.url).href
    expect(f.request(file, new URL('/assets/site.css', preview!.url).href, 'stylesheet')).toEqual({})
    expect(f.headers(file, preview!.url)['Content-Security-Policy']).toEqual(["default-src 'self'; frame-ancestors 'none'; script-src 'self'"])
    expect(f.navigate(file, target)).toBe(true)
    expect(f.sent).toEqual([{ id: preview!.id, kind: 'navigate', path: join(root, 'next #.html') }])
    const next = await service.prepare({ appSessionId: 's1', path: join(root, 'next #.html') })
    expect(next?.path).toBe(join(root, 'next #.html'))
    expect(f.navigate(file, new URL('/%2e%2e%2fsecret.html', preview!.url).href)).toBe(true)
    expect(f.sent).toHaveLength(1)
    expect(f.navigate(file, next!.url, false, f.main)).toBe(false)
    service.release(preview!.id)
    expect(f.request(file, target)).toEqual({ cancel: true })
    expect(f.navigate(file, target)).toBe(true)
    expect(f.sent).toHaveLength(1)
  } finally {
    service.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('inner frames get the outer preview header treatment, while the app keeps its own CSP', () => {
  const f = fixture()
  const expected = f.headers(f.outer, f.outer.url)
  expect(expected['X-Frame-Options']).toBeUndefined()
  expect(expected['Content-Security-Policy']).toEqual(["default-src 'self'; script-src 'self'"])
  expect(f.headers(f.inner, f.inner.url)).toEqual(expected)
  expect(f.headers(f.nested, f.nested.url)).toEqual(expected)
  expect(f.headers(f.inner, 'http://localhost:6006/script.js', 'script')['Content-Security-Policy']).toEqual(["default-src 'self'; frame-ancestors 'none'; script-src 'self'"])
  expect(f.headers(f.main, f.main.url, 'mainFrame')['Content-Security-Policy']?.[0]).toContain("default-src 'none'")
  f.bindings.clear()
  expect(f.request(f.inner, f.inner.url)).toEqual({ cancel: true })
})
