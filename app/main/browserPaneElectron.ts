import { app, protocol, session, WebContentsView } from 'electron'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { BROWSER_LOCAL_SCHEME } from './browserPanePolicy.js'
import type { BrowserPaneAdapter } from './browserPaneHost.js'

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
      view.setVisible(false)
      const wc = view.webContents
      let requested: string | undefined
      ses.webRequest.onBeforeRequest((details, callback) => {
        const explicit = details.resourceType === 'mainFrame' && details.url === requested
        const source = details.frame?.url || wc.getURL()
        callback({ cancel: !policy.allowRequest(id, details.url, explicit ? '' : source) })
      })
      wc.setWindowOpenHandler(() => ({ action: 'deny' }))
      wc.on('select-bluetooth-device', (event, _devices, callback) => { event.preventDefault(); callback('') })
      wc.on('login', (event, _details, _auth, callback) => { event.preventDefault(); callback() })
      wc.on('certificate-error', (event, _url, _error, _cert, callback) => { event.preventDefault(); callback(false) })
      wc.on('will-navigate', (event, url) => { if (!policy.allowRequest(id, url, wc.getURL())) event.preventDefault() })
      wc.on('will-redirect', (event, url) => { if (!policy.allowRequest(id, url, wc.getURL())) event.preventDefault() })
      try {
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
        const prevented = () => { cleanup(); reject(new Error('The page prevented navigation')) }
        const timer = setTimeout(() => { cleanup(); reject(new Error('Browser navigation timed out')) }, 30_000)
        wc.once('did-finish-load', finished)
        wc.once('did-navigate-in-page', finished)
        wc.on('did-fail-load', failed)
        wc.once('will-prevent-unload', prevented)
        try { action() } catch (error) { cleanup(); reject(error) }
      })
      return {
        nativeView: view,
        debugger: wc.debugger,
        getURL: () => wc.getURL(),
        navigate: async url => { requested = url; try { await wc.loadURL(url) } finally { requested = undefined } },
        back: async () => { if (wc.navigationHistory.canGoBack()) await historyNavigation(() => wc.navigationHistory.goBack()) },
        forward: async () => { if (wc.navigationHistory.canGoForward()) await historyNavigation(() => wc.navigationHistory.goForward()) },
        reload: () => historyNavigation(() => wc.reload()),
        destroy: () => { if (!wc.isDestroyed()) wc.close({ waitForBeforeUnload: false }) },
        clearData: () => ses.clearData(),
      }
    },
  }
}
