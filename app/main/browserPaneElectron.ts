import { app, nativeImage, protocol, session, WebContentsView } from 'electron'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { BROWSER_LOCAL_SCHEME } from './browserPanePolicy.js'
import type { BrowserPaneAdapter, BrowserPaneView, BrowserPaneViewHooks, BrowserNavigationOptions } from './browserPaneHost.js'
import type { BrowserPanePresentationNative } from './browserPanePresentation.js'
import { BROWSER_SCREENSHOT_MAX_PIXELS } from './browserPaneCdp.js'

/** Call before app.ready, alongside the application's other privileged schemes. */
export function registerBrowserPaneScheme(otherSchemes: Electron.CustomScheme[] = []): void {
  protocol.registerSchemesAsPrivileged([...otherSchemes, { scheme: BROWSER_LOCAL_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])
}

/** Construct once per main process; startup must finish before any browser partition is opened. */
export function createBrowserPaneElectronAdapter(): BrowserPaneAdapter {
  let startup: Promise<void> | undefined
  const configured = new WeakSet<Electron.Session>()
  const start = () => startup ??= (async () => {
    const partitions = join(app.getPath('sessionData'), 'Partitions')
    let entries
    try { entries = await readdir(partitions, { withFileTypes: true }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    for (const entry of entries) {
      if (entry.isDirectory() && /^cat-browser-[A-Za-z0-9_-]{1,128}$/.test(entry.name)) {
        await rm(join(partitions, entry.name), { recursive: true, force: true })
      }
    }
  })()
  return {
    startup: start,
    async create(id, policy) {
      await start()
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid browser session id')
      const partition = `persist:cat-browser-${id}`
      const ses = session.fromPartition(partition)
      ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      ses.setPermissionCheckHandler(() => false)
      ses.setDevicePermissionHandler(() => false)
      ses.setDisplayMediaRequestHandler((_request, callback) => callback({}))
      // A partition survives clearData; install these handlers once, not on each reopen.
      if (!configured.has(ses)) {
        await ses.protocol.handle('file', () => new Response(null, { status: 403 }))
        await ses.protocol.handle(BROWSER_LOCAL_SCHEME, request => policy.respond(id, request.url))
        ses.on('select-hid-device', (event, _details, callback) => { event.preventDefault(); callback() })
        ses.on('select-usb-device', (event, _details, callback) => { event.preventDefault(); callback() })
        ses.on('select-serial-port', (event, _ports, _contents, callback) => { event.preventDefault(); callback('') })
        ses.on('will-download', (event, item) => { event.preventDefault(); item.cancel() })
        configured.add(ses)
      }
      const view = new WebContentsView({ webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, webSecurity: true, navigateOnDragDrop: false } })
      view.setBounds({ x: 0, y: 0, width: 1024, height: 768 })
      view.setVisible(false)
      const wc = view.webContents
      let hooks: BrowserPaneViewHooks | undefined
      let ignoreBeforeUnload = false
      wc.on('input-event', (_event, input) => hooks?.input(input as typeof input & { _modifiers?: number }))
      wc.on('did-navigate', () => hooks?.navigated())
      wc.on('did-navigate-in-page', (_event, _url, isMainFrame) => { if (isMainFrame) hooks?.navigated() })
      wc.on('will-prevent-unload', event => {
        if (ignoreBeforeUnload) event.preventDefault()
        else hooks?.beforeUnload()
      })
      wc.debugger.on('message', (_event, method, params, sessionId) => hooks?.cdpEvent(method, params, sessionId))
      let requested: string | undefined
      ses.webRequest.onBeforeRequest((details, callback) => {
        const source = details.frame?.url || wc.getURL()
        callback({ cancel: !policy.allowRequest(id, details.url, source, details.resourceType === 'mainFrame' ? requested : undefined) })
      })
      wc.setWindowOpenHandler(() => ({ action: 'deny' }))
      wc.on('select-bluetooth-device', (event, _devices, callback) => { event.preventDefault(); callback('') })
      wc.on('login', (event, _details, _auth, callback) => { event.preventDefault(); callback() })
      wc.on('certificate-error', (event, _url, _error, _cert, callback) => { event.preventDefault(); callback(false) })
      wc.on('will-navigate', (event, url) => { if (!policy.allowRequest(id, url, wc.getURL(), requested)) event.preventDefault() })
      wc.on('will-redirect', (event, url) => { if (!policy.allowRequest(id, url, wc.getURL(), event.isMainFrame ? requested : undefined)) event.preventDefault() })
      try {
        // An unattached view has no page renderer until its first document is loaded.
        await wc.loadURL('about:blank')
        wc.debugger.attach('1.3')
        await wc.debugger.sendCommand('Page.enable')
        await wc.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true })
      } catch (error) { wc.close({ waitForBeforeUnload: false }); throw error }
      // An intercepted chooser is intentionally never fulfilled with file paths.
      const historyNavigation = (action: () => void) => new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer)
          wc.removeListener('did-finish-load', finished)
          wc.removeListener('did-navigate-in-page', finished)
          wc.removeListener('did-fail-load', failed)
          wc.removeListener('will-prevent-unload', prevented)
        }
        const finished = () => { cleanup(); resolve() }
        const failed = (_event: Electron.Event, code: number, description: string, _url: string, mainFrame: boolean) => {
          if (mainFrame) { cleanup(); reject(new Error(`Navigation failed (${code}): ${description}`)) }
        }
        const prevented = () => { if (!ignoreBeforeUnload) { cleanup(); reject(new Error('The page prevented navigation')) } }
        const timer = setTimeout(() => { cleanup(); reject(new Error('Browser navigation timed out')) }, 30_000)
        wc.once('did-finish-load', finished)
        wc.once('did-navigate-in-page', finished)
        wc.on('did-fail-load', failed)
        wc.once('will-prevent-unload', prevented)
        try { action() } catch (error) { cleanup(); reject(error) }
      })
      const navigation = async (action: () => Promise<void>, options?: BrowserNavigationOptions) => {
        ignoreBeforeUnload = options?.ignoreBeforeUnload === true
        try { await action() } finally { ignoreBeforeUnload = false }
      }
      return {
        nativeView: view,
        debugger: wc.debugger,
        setHooks: value => { hooks = value },
        getURL: () => wc.getURL(),
        history: () => ({ canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward() }),
        capturePage: async maxPixels => {
          // Normalize Retina representations so these limits describe encoded pixels, not DIPs.
          let image = nativeImage.createFromBuffer((await wc.capturePage()).toPNG(), { scaleFactor: 1 })
          let { width, height } = image.getSize()
          const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)), 4096 / width, 4096 / height)
          if (scale < 1) image = image.resize({ width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) })
          // PNG entropy varies; keep the base64 result below the transport's 4 MiB cap.
          let data = image.toPNG().toString('base64')
          while (data.length > 3_900_000) {
            const size = image.getSize()
            if (size.width <= 1 || size.height <= 1) throw new Error('Browser screenshot exceeds the result limit')
            image = image.resize({ width: Math.max(1, Math.floor(size.width * 0.75)), height: Math.max(1, Math.floor(size.height * 0.75)) })
            data = image.toPNG().toString('base64')
          }
          ;({ width, height } = image.getSize())
          return { data, width, height }
        },
        navigate: (url, options) => navigation(async () => { requested = url; try { await wc.loadURL(url) } finally { requested = undefined } }, options),
        back: options => navigation(async () => {
          if (!wc.navigationHistory.canGoBack()) return
          requested = wc.navigationHistory.getEntryAtIndex(wc.navigationHistory.getActiveIndex() - 1).url
          try { await historyNavigation(() => wc.navigationHistory.goBack()) } finally { requested = undefined }
        }, options),
        forward: options => navigation(async () => {
          if (!wc.navigationHistory.canGoForward()) return
          requested = wc.navigationHistory.getEntryAtIndex(wc.navigationHistory.getActiveIndex() + 1).url
          try { await historyNavigation(() => wc.navigationHistory.goForward()) } finally { requested = undefined }
        }, options),
        reload: options => navigation(() => historyNavigation(() => wc.reload()), options),
        destroy: () => { if (!wc.isDestroyed()) wc.close({ waitForBeforeUnload: false }) },
        clearData: () => ses.clearData(),
      }
    },
  }
}

/** Native operations kept outside the Electron-free presentation coordinator. */
export function createBrowserPanePresentationNative(): BrowserPanePresentationNative {
  const owners = new WeakMap<BrowserPaneView, Electron.BrowserWindow>()
  const bounds = new WeakMap<BrowserPaneView, Electron.Rectangle>()
  const visibility = new WeakMap<BrowserPaneView, boolean>()
  const native = (view: import('./browserPaneHost.js').BrowserPaneView): Electron.WebContentsView => {
    if (!view.nativeView) throw new Error('Browser native view is unavailable')
    return view.nativeView as Electron.WebContentsView
  }
  return {
    attach: (window, view) => {
      const target = window as Electron.BrowserWindow
      if (target.isDestroyed()) throw new Error('Browser window is closed')
      target.contentView.addChildView(native(view))
      bounds.delete(view)
      visibility.delete(view)
      owners.set(view, target)
    },
    detach: (window, view) => {
      const target = window as Electron.BrowserWindow
      if (!target.isDestroyed()) target.contentView.removeChildView(native(view))
      owners.delete(view)
      bounds.delete(view)
      visibility.delete(view)
    },
    bounds: (view, rect) => {
      const owner = owners.get(view)
      if (!owner || owner.isDestroyed()) throw new Error('Browser window is closed')
      // Renderer rectangles are CSS pixels; child-view bounds are device-independent pixels.
      const zoom = owner.webContents.getZoomFactor()
      const x = Math.round(rect.x * zoom), y = Math.round(rect.y * zoom)
      const next = { x, y,
        width: Math.round((rect.x + rect.width) * zoom) - x,
        height: Math.round((rect.y + rect.height) * zoom) - y }
      const previous = bounds.get(view)
      // Compare only after zoom conversion so unchanged CSS heartbeats still track zoom.
      if (previous && previous.x === next.x && previous.y === next.y && previous.width === next.width && previous.height === next.height) return
      bounds.delete(view)
      native(view).setBounds(next)
      bounds.set(view, next)
    },
    visible: (view, visible) => {
      const target = native(view)
      if (target.webContents.isDestroyed()) { visibility.delete(view); return }
      if (visibility.get(view) === visible) return
      visibility.delete(view)
      target.setVisible(visible)
      visibility.set(view, visible)
    },
    capture: async view => {
      if (!view.capturePage) throw new Error('Browser capture is unavailable')
      const image = await view.capturePage(BROWSER_SCREENSHOT_MAX_PIXELS)
      return `data:image/png;base64,${image.data}`
    },
  }
}
