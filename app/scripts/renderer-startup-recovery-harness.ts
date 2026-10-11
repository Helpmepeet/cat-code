/** External --require observer for the actual main.ts first-document boundary. */
import { app, dialog, ipcMain, session } from 'electron'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CH_RENDERER_READY } from '../shared/ipcChannels.js'

const root = process.env.CATCODE_RECOVERY_FIXTURE_ROOT!
const mode = process.env.CATCODE_RECOVERY_MODE!
const scenario = process.env.CATCODE_RECOVERY_SCENARIO!
if (!root || !['dev', 'packaged'].includes(mode) || !['first', 'repeat', 'quit', 'superseded'].includes(scenario)) {
  throw new Error('invalid startup recovery fixture configuration')
}
const rendererDir = join(root, 'renderer', 'dist')
mkdirSync(join(root, 'userData'), { recursive: true })
app.setPath('userData', join(root, 'userData'))
Object.defineProperty(app, 'isPackaged', { configurable: true, get: () => mode === 'packaged' })

// Block before production main imports its subprocess bindings. This fixture
// opens no sessions and cannot read an account vault or spend provider quota
// through the normal background/account workers, regardless of readiness timing.
let blockedWorkers = 0
for (const key of ['spawn', 'spawnSync', 'exec', 'execFile', 'execSync', 'execFileSync', 'fork'] as const) {
  Object.defineProperty(childProcess, key, { configurable: true, value: () => {
    blockedWorkers++
    throw new Error('startup recovery fixture blocks worker processes')
  } })
}
syncBuiltinESMExports()

type Observation = { kind: string; attempt?: number; code?: string | number; errno?: number; mainFrame?: boolean; reason?: string }
const observations: Observation[] = []
let attempts = 0, failures = 0, loaded = 0, ready = 0, dialogs = 0, shown = 0
let stopping = false
let stopTimer: ReturnType<typeof setTimeout> | null = null
const stop = () => {
  if (stopping) return
  stopping = true
  if (stopTimer) clearTimeout(stopTimer)
  app.quit()
}
dialog.showErrorBox = () => {
  dialogs++
  observations.push({ kind: 'fatal-dialog' })
  stopTimer = setTimeout(stop, 250)
}
app.on('will-quit', () => {
  writeFileSync(join(root, 'fixture-result.json'), JSON.stringify({
    mode, scenario, attempts, failures, loaded, ready, dialogs, shown, blockedWorkers, observations,
  }, null, 2))
})

app.whenReady().then(() => {
  app.dock?.hide()
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false
    try {
      const target = new URL(details.url)
      if (mode === 'dev') allowed = target.origin === new URL(process.env.CATCODE_RENDERER_URL!).origin
      else if (target.protocol === 'file:') {
        const path = relative(rendererDir, fileURLToPath(target))
        allowed = !path.startsWith('..') && !isAbsolute(path)
      }
    } catch { /* no external requests */ }
    if (details.resourceType === 'mainFrame') {
      const shouldFail = scenario === 'repeat' || failures === 0
      if (shouldFail) {
        failures++
        observations.push({ kind: 'document-request-blocked', attempt: failures })
        // Real Chromium ERR_BLOCKED_BY_CLIENT, rather than ERR_ABORTED (-3).
        callback({ cancel: true })
        return
      }
    }
    callback({ cancel: !allowed })
  })
  stopTimer = setTimeout(stop, 6_000)
})

app.on('browser-window-created', (_event, window) => {
  window.on('show', () => { shown++ })
  // Observe the native promise as well as the event. Delaying only the first
  // genuine rejection in the superseded control makes its later delivery
  // deterministic without manufacturing the error or any successful receipt.
  for (const method of ['loadURL', 'loadFile'] as const) {
    const load = window[method].bind(window) as (target: string, options?: unknown) => Promise<void>
    Object.defineProperty(window, method, { configurable: true, value: (...args: Parameters<typeof load>) => {
      const attempt = ++attempts
      observations.push({ kind: method, attempt })
      const promise = load(...args)
      void promise.then(() => {
        loaded++
        observations.push({ kind: 'promise-resolved', attempt })
      }, (error: { code?: string; errno?: number }) => {
        observations.push({ kind: 'promise-rejected', attempt, code: error.code, errno: error.errno })
      })
      return scenario === 'superseded' && attempt === 1
        ? promise.catch(error => new Promise<void>((_resolve, reject) => setTimeout(() => reject(error), 250)))
        : promise
    } })
  }
  window.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
    observations.push({ kind: 'did-fail-load', code, mainFrame })
    if (!mainFrame || code === -3) return
    if (scenario === 'quit') stop()
    if (scenario === 'superseded' && attempts === 1) window.webContents.forcefullyCrashRenderer()
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    observations.push({ kind: 'render-process-gone', reason: details.reason, code: details.exitCode })
  })
  ipcMain.on(CH_RENDERER_READY, event => {
    if (event.sender !== window.webContents) return
    ready++
    observations.push({ kind: 'renderer-ready' })
    // Let main accept its real ready handshake and complete replay first.
    if (!stopping && scenario !== 'repeat' && scenario !== 'quit') {
      if (stopTimer) clearTimeout(stopTimer)
      stopTimer = setTimeout(stop, scenario === 'superseded' ? 400 : 50)
    }
  })
})
