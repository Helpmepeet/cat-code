/**
 * F2 — end-to-end renderer-attachment verification in a REAL Electron renderer.
 *
 * Reproduces the exact scenario the review found broken: the sidecar produces
 * its one-shot `ready` frame and the probe `tool_use` BEFORE the renderer has
 * mounted (and again after a reload). With the buffer+replay fix, a renderer
 * that attaches late must still receive both. This harness:
 *
 *   1. spins up the REAL supervisor + Bun sidecar (probe on attach);
 *   2. uses the SAME `AttachmentGate` production `main.ts` uses (not a copy), so a
 *      regression in the gate fails this test too;
 *   3. loads a renderer that subscribes then calls rendererReady, but only AFTER a
 *      delay — so every frame is produced pre-attach (the F2 failure condition) —
 *      and calls rendererReady TWICE to mimic React StrictMode's double mount;
 *   4. asserts the renderer received `ready` + the `tool_use` event via replay,
 *      with NO duplicates (the StrictMode double-signal regression);
 *   5. reloads the renderer and asserts it re-receives them, still without dupes.
 *
 * Run: bun run app/scripts/run-f2-attach-smoke.ts   (builds + launches)
 * Exits 0 iff the renderer caught up on both first attach and reload, dup-free.
 */

import { app, BrowserWindow, ipcMain } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SidecarSupervisor } from '../supervisor/supervisor.js'
import { AttachmentGate } from '../main/attachmentGate.js'
import type { ServerFrame } from '../shared/protocol.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CH_SERVER_FRAME = 'catcode:server-frame'
const CH_RENDERER_READY = 'catcode:renderer-ready'

// The SAME gate main.ts uses — this harness is a faithful adapter, not a copy.
const attachmentGate = new AttachmentGate()
let mainWindow: BrowserWindow | null = null

function deliver(frames: ServerFrame[]): void {
  const contents = mainWindow?.webContents
  if (!contents) return
  for (const frame of frames) contents.send(CH_SERVER_FRAME, frame satisfies ServerFrame)
}

// A minimal renderer that subscribes, then after a DELAY announces readiness
// TWICE (StrictMode double-invokes the mount effect). The delay guarantees all
// frames are produced before the renderer attaches (the F2 failure condition).
const RENDERER_HTML = `<!doctype html>
<html><head></head><body><script>
  window.__frames = [];
  window.catcode.subscribe(function (frame) { window.__frames.push(frame); });
  setTimeout(function () {
    window.catcode.rendererReady();
    window.catcode.rendererReady(); // StrictMode double-signal
  }, 500);
</script></body></html>`

function wireBridge(sup: SidecarSupervisor): void {
  sup.subscribe(event => {
    if (event.type !== 'frame') return
    deliver(attachmentGate.onFrame(event.sessionId, event.frame))
  })
}

ipcMain.on(CH_RENDERER_READY, () => {
  deliver(attachmentGate.onRendererReady())
})

async function readFrameKinds(window: BrowserWindow): Promise<string[]> {
  return window.webContents.executeJavaScript(
    `(window.__frames || []).map(function (f) {
       return f.kind + (f.kind === 'event' ? ':' + f.event.type : '');
     })`,
  )
}

async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs = 15_000,
): Promise<boolean> {
  const start = Date.now()
  for (;;) {
    if (await fn()) return true
    if (Date.now() - start > timeoutMs) return false
    await new Promise(r => setTimeout(r, 100))
  }
}

app.whenReady().then(async () => {
  const repoRoot = join(__dirname, '..', '..')
  const sidecarEntry = join(repoRoot, 'app', 'sidecar', 'index.ts')
  const supervisor = new SidecarSupervisor({
    sidecarCommand: process.env.CATCODE_BUN_BIN ?? 'bun',
    sidecarArgs: ['run', sidecarEntry],
    sidecarEnv: { CATCODE_SIDECAR_PROBE: '1' },
  })
  wireBridge(supervisor)
  supervisor.spawnSession()

  mainWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, '..', 'preload', 'preload.cjs'),
    },
  })
  mainWindow.webContents.on('did-start-navigation', (_e, _u, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) attachmentGate.onNavigationStart()
  })

  const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(RENDERER_HTML)}`

  const finish = (pass: boolean, detail: string) => {
    process.stdout.write(`[f2-attach-smoke] ${pass ? 'PASS' : 'FAIL'}: ${detail}\n`)
    supervisor.shutdown()
    app.exit(pass ? 0 : 1)
  }

  const count = (kinds: string[], k: string) => kinds.filter(x => x === k).length
  const gotReadyAndProbe = async () => {
    const kinds = await readFrameKinds(mainWindow!)
    return kinds.includes('ready') && kinds.includes('event:message')
  }
  // Despite the StrictMode double rendererReady, each one-shot frame must appear
  // EXACTLY once (no duplicate replay).
  const noDuplicates = async (): Promise<string | null> => {
    const kinds = await readFrameKinds(mainWindow!)
    const ready = count(kinds, 'ready')
    const probe = count(kinds, 'event:message')
    if (ready !== 1) return `expected 1 ready, got ${ready} (kinds=${JSON.stringify(kinds)})`
    if (probe !== 1) return `expected 1 probe event, got ${probe} (kinds=${JSON.stringify(kinds)})`
    return null
  }

  await mainWindow.loadURL(dataUrl)

  // First attach: renderer subscribes late, must catch up via replay.
  if (!(await waitFor(gotReadyAndProbe))) {
    return finish(false, 'first attach did not receive ready + probe via replay')
  }
  // Let a second StrictMode signal (and any erroneous re-replay) settle, then
  // assert there are no duplicates.
  await new Promise(r => setTimeout(r, 400))
  const dupFirst = await noDuplicates()
  if (dupFirst) return finish(false, `duplicate delivery on first attach: ${dupFirst}`)

  // Reload: the one-shot frames must be re-delivered (not lost) and still dup-free.
  mainWindow.reload()
  await new Promise(r => setTimeout(r, 300))
  if (!(await waitFor(gotReadyAndProbe))) {
    return finish(false, 'after reload the renderer did not re-receive ready + probe')
  }
  await new Promise(r => setTimeout(r, 400))
  const dupReload = await noDuplicates()
  if (dupReload) return finish(false, `duplicate delivery after reload: ${dupReload}`)

  finish(true, 'renderer caught up on first attach AND reload, with no duplicates')
})
