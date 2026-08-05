/**
 * F2 — end-to-end renderer-attachment verification in a REAL Electron renderer.
 *
 * Reproduces the exact scenario the review found broken: the sidecar produces
 * its one-shot `ready` frame and the probe `tool_use` BEFORE the renderer has
 * mounted (and again after a reload). With the buffer+replay fix, a renderer
 * that attaches late must still receive both. This harness:
 *
 *   1. spins up the REAL supervisor + TWO Bun sidecars;
 *   2. uses the SAME `AttachmentGate` production `main.ts` uses (not a copy), so a
 *      regression in the gate fails this test too;
 *   3. loads a renderer that subscribes then calls rendererReady, but only AFTER a
 *      delay — so every frame is produced pre-attach (the F2 failure condition) —
 *      and calls rendererReady TWICE to mimic React StrictMode's double mount;
 *   4. asserts the renderer received both `ready` frames + addressed `pong`
 *      frames via replay,
 *      with NO duplicates (the StrictMode double-signal regression);
 *   5. reloads the renderer and asserts it re-receives them, still without dupes.
 *
 * Run: bun run app/scripts/run-f2-attach-smoke.ts   (builds + launches)
 * Exits 0 iff the renderer caught up on both first attach and reload, dup-free.
 */

import { app, BrowserWindow, ipcMain } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  isSidecarSendError,
  SidecarSupervisor,
  type SupervisorEvent,
} from '../supervisor/supervisor.js'
import { AttachmentGate } from '../main/attachmentGate.js'
import {
  PROTOCOL_VERSION,
  type LifecycleFrame,
  type ReadyFrame,
  type ServerFrame,
  type SessionId,
} from '../shared/protocol.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CH_SERVER_FRAME = 'catcode:server-frame'
const CH_RENDERER_READY = 'catcode:renderer-ready'

// The SAME gate main.ts uses — this harness is a faithful adapter, not a copy.
const attachmentGate = new AttachmentGate()
let mainWindow: BrowserWindow | null = null

function deliver(frames: ServerFrame[]): void {
  const contents = mainWindow?.webContents
  if (!contents) return
  // Match production main: one batched ServerFrame[] send (perf F3); the real
  // preload (loaded here) fans it out to `subscribe`.
  if (frames.length === 0) return
  contents.send(CH_SERVER_FRAME, frames satisfies ServerFrame[])
}

// A minimal renderer that subscribes, then after a DELAY announces readiness
// TWICE (StrictMode double-invokes the mount effect). The delay guarantees all
// frames are produced before the renderer attaches (the F2 failure condition).
const RENDERER_HTML = `<!doctype html>
<html><head></head><body><script>
  window.__frames = [];
  window.catcode.subscribe(function (frames) {
    for (var i = 0; i < frames.length; i++) window.__frames.push(frames[i]);
  });
  setTimeout(function () {
    window.catcode.rendererReady();
    window.catcode.rendererReady(); // StrictMode double-signal
  }, 500);
</script></body></html>`

function wireBridge(sup: SidecarSupervisor): void {
  sup.subscribe(event => {
    const frame = supervisorEventToServerFrame(event)
    if (!frame) return
    deliver(attachmentGate.onFrame(event.sessionId, frame))
    if (isTerminalLifecycleFrame(frame)) {
      attachmentGate.clearSession(event.sessionId)
    }
  })
}

function supervisorEventToServerFrame(event: SupervisorEvent): ServerFrame | null {
  if (event.type === 'frame') return event.frame
  if (event.type === 'exit') {
    return {
      kind: 'lifecycle',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: event.sessionId,
      status: 'exited',
      exit: { code: event.code, signal: event.signal },
    } satisfies LifecycleFrame
  }
  // Kept in step with the production mapper (`app/main/mainDecisions.ts`), which
  // this harness mirrors rather than imports: `status:'exited'` mints NO frame,
  // because the supervisor sets that status inside its own `child.on('exit')`
  // handler right after emitting the `exit` event above, so it could only ever
  // restate that death without the `exit` payload (CC-28 / IDLE-PARK §1a). This
  // harness asserts on `ready`/`pong` replay and never on lifecycle frames, so the
  // sync is for the reader, not for its own result.
  if (event.status === 'disconnected' || event.status === 'failed') {
    return {
      kind: 'lifecycle',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: event.sessionId,
      status: event.status,
    } satisfies LifecycleFrame
  }
  return null
}

function isTerminalLifecycleFrame(frame: ServerFrame): boolean {
  return (
    frame.kind === 'lifecycle' &&
    (frame.status === 'disconnected' ||
      frame.status === 'failed' ||
      frame.status === 'exited')
  )
}

ipcMain.on(CH_RENDERER_READY, () => {
  deliver(attachmentGate.onRendererReady())
})

async function readFrames(window: BrowserWindow): Promise<ServerFrame[]> {
  return window.webContents.executeJavaScript(`window.__frames || []`)
}

async function readFrameKinds(window: BrowserWindow): Promise<string[]> {
  return window.webContents.executeJavaScript(
    `(window.__frames || []).map(function (f) {
       return f.kind + ':' + f.sessionId + (f.kind === 'pong' ? ':' + f.nonce : '');
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
    // Non-probe sessions boot the real engine, which requires a session root
    // (P3-1: cwd is caller-supplied; the P1_1_CWD hardcode is retired).
    sidecarCwd: process.cwd(),
  })
  wireBridge(supervisor)
  const supervisorEvents: SupervisorEvent[] = []
  supervisor.subscribe(event => supervisorEvents.push(event))
  const sessionA = supervisor.spawnSession('f3-smoke-a')
  const sessionB = supervisor.spawnSession('f3-smoke-b')

  const readyFor = (sessionId: SessionId): ReadyFrame | undefined => {
    const event = supervisorEvents.find(
      event =>
        event.type === 'frame' &&
        event.sessionId === sessionId &&
        event.frame.kind === 'ready',
    )
    return event?.type === 'frame' && event.frame.kind === 'ready'
      ? event.frame
      : undefined
  }

  const sawPong = (sessionId: SessionId, nonce: string): boolean =>
    supervisorEvents.some(
      event =>
        event.type === 'frame' &&
        event.sessionId === sessionId &&
        event.frame.kind === 'pong' &&
        event.frame.nonce === nonce,
    )

  const bothReady = await waitFor(
    async () => readyFor(sessionA) !== undefined && readyFor(sessionB) !== undefined,
  )
  if (!bothReady) {
    process.stdout.write('[f2-attach-smoke] FAIL: both sidecars did not become ready\n')
    supervisor.shutdown()
    app.exit(1)
    return
  }
  process.stdout.write(
    `[f2-attach-smoke] ready ${sessionA} engineSessionId=${readyFor(sessionA)!.engineSessionId}\n`,
  )
  process.stdout.write(
    `[f2-attach-smoke] ready ${sessionB} engineSessionId=${readyFor(sessionB)!.engineSessionId}\n`,
  )

  supervisor.send(sessionA, { type: 'app.ping', nonce: 'pre-attach-a' })
  supervisor.send(sessionB, { type: 'app.ping', nonce: 'pre-attach-b' })
  const bothPonged = await waitFor(
    async () =>
      sawPong(sessionA, 'pre-attach-a') && sawPong(sessionB, 'pre-attach-b'),
  )
  if (!bothPonged) {
    process.stdout.write('[f2-attach-smoke] FAIL: both sidecars did not answer pre-attach pings\n')
    supervisor.shutdown()
    app.exit(1)
    return
  }

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
  const gotInitialFrames = async () => {
    const frames = await readFrames(mainWindow!)
    return (
      frames.some(frame => frame.kind === 'ready' && frame.sessionId === sessionA) &&
      frames.some(frame => frame.kind === 'ready' && frame.sessionId === sessionB) &&
      frames.some(
        frame =>
          frame.kind === 'pong' &&
          frame.sessionId === sessionA &&
          frame.nonce === 'pre-attach-a',
      ) &&
      frames.some(
        frame =>
          frame.kind === 'pong' &&
          frame.sessionId === sessionB &&
          frame.nonce === 'pre-attach-b',
      )
    )
  }
  // Despite the StrictMode double rendererReady, each one-shot frame must appear
  // EXACTLY once (no duplicate replay).
  const noDuplicates = async (): Promise<string | null> => {
    const kinds = await readFrameKinds(mainWindow!)
    const readyA = count(kinds, `ready:${sessionA}`)
    const readyB = count(kinds, `ready:${sessionB}`)
    const pongA = count(kinds, `pong:${sessionA}:pre-attach-a`)
    const pongB = count(kinds, `pong:${sessionB}:pre-attach-b`)
    if (readyA !== 1) return `expected 1 ready for A, got ${readyA} (kinds=${JSON.stringify(kinds)})`
    if (readyB !== 1) return `expected 1 ready for B, got ${readyB} (kinds=${JSON.stringify(kinds)})`
    if (pongA !== 1) return `expected 1 pre-attach pong for A, got ${pongA} (kinds=${JSON.stringify(kinds)})`
    if (pongB !== 1) return `expected 1 pre-attach pong for B, got ${pongB} (kinds=${JSON.stringify(kinds)})`
    return null
  }

  await mainWindow.loadURL(dataUrl)

  // First attach: renderer subscribes late, must catch up via replay.
  if (!(await waitFor(gotInitialFrames))) {
    return finish(false, 'first attach did not receive both ready + pong frames via replay')
  }
  // Let a second StrictMode signal (and any erroneous re-replay) settle, then
  // assert there are no duplicates.
  await new Promise(r => setTimeout(r, 400))
  const dupFirst = await noDuplicates()
  if (dupFirst) return finish(false, `duplicate delivery on first attach: ${dupFirst}`)

  // Reload: the one-shot frames must be re-delivered (not lost) and still dup-free.
  mainWindow.reload()
  await new Promise(r => setTimeout(r, 300))
  if (!(await waitFor(gotInitialFrames))) {
    return finish(false, 'after reload the renderer did not re-receive both ready + pong frames')
  }
  await new Promise(r => setTimeout(r, 400))
  const dupReload = await noDuplicates()
  if (dupReload) return finish(false, `duplicate delivery after reload: ${dupReload}`)

  const crashedPid = supervisor.getSessionProcessId(sessionA)
  if (!crashedPid) {
    return finish(false, `no process id for ${sessionA}`)
  }
  process.kill(crashedPid, 'SIGTERM')
  if (
    !(await waitFor(async () =>
      supervisorEvents.some(
        event =>
          event.type === 'status' &&
          event.sessionId === sessionA &&
          event.status === 'exited',
      ),
    ))
  ) {
    return finish(false, `terminated sidecar ${sessionA} did not report exited`)
  }
  let killedCode = 'none'
  try {
    supervisor.send(sessionA, { type: 'app.ping', nonce: 'dead-a' })
  } catch (error) {
    killedCode = isSidecarSendError(error) ? error.code : 'unexpected'
  }
  process.stdout.write(
    `[f2-attach-smoke] killed ${sessionA}; send produced ${killedCode}\n`,
  )
  if (killedCode !== 'session_disconnected') {
    return finish(false, `send to killed session produced ${killedCode}`)
  }

  supervisor.send(sessionB, { type: 'app.ping', nonce: 'post-kill-b' })
  if (
    !(await waitFor(async () => {
      const frames = await readFrames(mainWindow!)
      return frames.some(
        frame =>
          frame.kind === 'pong' &&
          frame.sessionId === sessionB &&
          frame.nonce === 'post-kill-b',
      )
    }))
  ) {
    return finish(false, 'surviving sidecar did not answer after peer kill')
  }

  mainWindow.reload()
  await new Promise(r => setTimeout(r, 300))
  if (
    !(await waitFor(async () => {
      const frames = await readFrames(mainWindow!)
      return (
        frames.length > 0 &&
        frames.every(frame => frame.sessionId !== sessionA) &&
        frames.some(frame => frame.kind === 'ready' && frame.sessionId === sessionB)
      )
    }))
  ) {
    return finish(false, 'killed session ghost-replayed after eviction')
  }

  process.stdout.write(
    '[f2-attach-smoke] observed shared settings-file class risk: both real sidecars initialize from the same settings roots; no concurrent settings write was exercised\n',
  )
  finish(true, 'two sidecars routed independently; survivor stayed live; killed session was evicted')
})
