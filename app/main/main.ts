/**
 * Electron main process — the supervisor's client #1 (D6 pin 2).
 *
 * Electron main is NOT the engine host and NOT the supervisor: it CALLS the
 * Electron-free `SidecarSupervisor`. Its jobs:
 *   1. instantiate the supervisor and spawn the desktop sidecar;
 *   2. enforce the Electron security baseline (SECURITY-MINIMUM §3);
 *   3. bridge renderer IPC ↔ supervisor (the four allowlisted channels);
 *   4. clean up sidecars on quit (D6: die-with-window for v1 — but via the
 *      supervisor's kill API, not by welding the sidecar to the window).
 *
 * This is the ONLY module in `app/` that imports `electron`.
 */

import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'

import {
  isSidecarSendError,
  SidecarSupervisor,
  type SupervisorEvent,
} from '../supervisor/supervisor.js'
import { SessionRegistry } from '../host/registry.js'
import { Host, type CwdValidation } from '../host/host.js'
import type {
  CreateSessionRequest,
  HostEvent,
  HostResult,
  SessionDescriptor,
} from '../shared/hostApi.js'
import { AttachmentGate } from './attachmentGate.js'
import {
  decideWindowOpen,
  isAppOrigin,
  type NavigationConfig,
} from './navigationPolicy.js'
import { MAX_SUGGESTION_SELECTIONS } from '../shared/limits.js'
import {
  PERMISSION_SET_MODE_MODES,
  PROTOCOL_VERSION,
  type PermissionSetModeMode,
  type ServerFrame,
  type SessionId,
  type SidecarClientMessage,
} from '../shared/protocol.js'
const __dirname = dirname(fileURLToPath(import.meta.url))

// Fixed internal channel names — must match preload.ts.
const CH_SUBMIT = 'catcode:submit'
const CH_ABORT = 'catcode:abort'
const CH_PERMISSION = 'catcode:permission'
const CH_SET_MODE = 'catcode:set-mode'
const CH_PING = 'catcode:ping'
const CH_RESTART = 'catcode:restart'
const CH_SERVER_FRAME = 'catcode:server-frame'
const CH_RENDERER_READY = 'catcode:renderer-ready'

// Control-plane channels (HC3 — fixed, per-method structured senders). `invoke`
// channels return a typed HostResult; `pick-directory` returns a realpath or
// null (the native picker, HC1); the host-event channel is a one-way stream.
const CH_HOST_CREATE = 'catcode:host:create'
const CH_HOST_RESTORE = 'catcode:host:restore'
const CH_HOST_CLOSE = 'catcode:host:close'
const CH_HOST_LIST = 'catcode:host:list'
const CH_HOST_PICK_DIR = 'catcode:host:pick-directory'
const CH_HOST_EVENT = 'catcode:host:event'

const APP_ORIGIN_DEV = process.env.CATCODE_RENDERER_URL ?? 'http://localhost:5173'
const IS_DEV = !app.isPackaged
const VITE_REACT_PREAMBLE_CSP_HASH =
  "'sha256-Z2/iFzh9VMlVkEOar1f/oSHWwQk3ve1qk/C2WdsC4Xk='"

// The supervisor is N-ready (a map). The host composes it with the durable
// registry into the typed control plane (P3-3); main is a CALLER of that host.
let supervisor: SidecarSupervisor | null = null
let host: Host | null = null
let mainWindow: BrowserWindow | null = null

/**
 * F2 — renderer attachment. Server frames arrive from the supervisor the moment
 * the sidecar attaches (including the one-shot `ready` handshake), which
 * is BEFORE the renderer has mounted and registered its `subscribe`, and again
 * there is nothing to receive them after a reload. The `AttachmentGate` buffers
 * them and decides what to deliver on each event so a fire-and-forget
 * `webContents.send` cannot lose them and a repeat readiness signal (React
 * StrictMode double-invokes the mount effect) cannot duplicate them. The gate is
 * Electron-free and unit-tested; main just `send`s whatever it returns.
 */
const attachmentGate = new AttachmentGate()

function deliver(frames: ServerFrame[]): void {
  const contents = mainWindow?.webContents
  if (!contents) return
  for (const frame of frames) {
    contents.send(CH_SERVER_FRAME, frame satisfies ServerFrame)
  }
}

/** The sidecar entry path — also the registry's orphan-identity marker (§9-A3). */
const SIDECAR_ENTRY = join(__dirname, '..', '..', 'app', 'sidecar', 'index.ts')

function createSupervisor(): SidecarSupervisor {
  // Dev: `bun run <repo>/app/sidecar/index.ts`. Packaged: the --compile'd Bun
  // binary path (W5). Injected so the supervisor stays runtime-agnostic.
  return new SidecarSupervisor({
    sidecarCommand: process.env.CATCODE_BUN_BIN ?? 'bun',
    sidecarArgs: ['run', SIDECAR_ENTRY],
    // Default boot cwd for the single startup session. Per-session cwd now flows
    // through the host API (createSession → native picker, HC1); this stays only
    // as the supervisor-wide default for probe/legacy callers.
    sidecarCwd: process.cwd(),
  })
}

/**
 * HC1 — canonicalize + existence/isDirectory-check a cwd, regardless of origin.
 * The host calls this before every spawn; a renderer never authors a path (the
 * native picker or a registry row is the only source), but this is the
 * defense-in-depth revalidation the addendum mandates.
 */
function validateCwd(cwd: string): CwdValidation {
  try {
    const real = realpathSync(cwd)
    if (statSync(real).isDirectory()) return { ok: true, realpath: real }
    return { ok: false }
  } catch {
    return { ok: false }
  }
}

function applySecurityBaseline(): void {
  // CSP for any rendered content (SECURITY-MINIMUM §3 CSP). Delivered as a
  // response header on the app load so it also covers the dev server.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          [
            "default-src 'none'",
            // F9 — no 'unsafe-inline'/'unsafe-eval' for scripts, in dev or prod
            // (SECURITY-MINIMUM §3). Vite dev serves its client + the React
            // preamble as an inline module. Allow only that exact script via
            // its SHA-256; never weaken script-src with unsafe-inline.
            IS_DEV
              ? `script-src 'self' http://localhost:5173 ${VITE_REACT_PREAMBLE_CSP_HASH}`
              : "script-src 'self'",
            // Styles still allow inline: Tailwind v4 dev + injected style tags.
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data:",
            IS_DEV
              ? "connect-src 'self' http://localhost:5173 ws://localhost:5173"
              : "connect-src 'self'",
            "font-src 'self' data:",
            "frame-src 'none'",
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'none'",
          ].join('; '),
        ],
      },
    })
  })
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1100,
    height: 720,
    backgroundColor: '#09090b',
    show: false,
    webPreferences: {
      // SECURITY-MINIMUM §3 BrowserWindow/webPreferences — every box checked.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      preload: join(__dirname, '..', 'preload', 'preload.cjs'),
    },
  })
  mainWindow = window

  // F2 — a fresh document (first load OR a reload of this window) has not yet
  // re-registered `subscribe`, so live frames must not be sent to it until it
  // re-announces readiness. Reset the attach flag on every navigation start; the
  // renderer's `rendererReady` call after mount flips it back and triggers the
  // replay. `did-start-navigation` fires on the initial load and on reloads.
  window.webContents.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) {
      attachmentGate.onNavigationStart()
    }
  })

  // Navigation lockdown (SECURITY-MINIMUM §3 Navigation / window.open — T3). The
  // DECISIONS live in the pure, unit-tested `navigationPolicy`; here we only wire
  // them to the real Electron events and apply the effect.
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAppOrigin(url, navigationConfig())) {
      event.preventDefault()
    }
  })
  window.webContents.on('will-redirect', (event, url) => {
    if (!isAppOrigin(url, navigationConfig())) {
      event.preventDefault()
    }
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    const decision = decideWindowOpen(url)
    if ('openExternal' in decision) {
      void shell.openExternal(decision.openExternal)
    }
    return { action: 'deny' }
  })

  window.once('ready-to-show', () => window.show())

  if (IS_DEV) {
    void window.loadURL(APP_ORIGIN_DEV)
  } else {
    void window.loadFile(PACKAGED_INDEX_PATH)
  }
}

/** The exact packaged renderer entry file (production nav target). */
const PACKAGED_INDEX_PATH = join(__dirname, '..', 'renderer', 'dist', 'index.html')

/** The current process's navigation policy config (dev origin vs packaged file). */
function navigationConfig(): NavigationConfig {
  return IS_DEV
    ? { isDev: true, devOrigin: APP_ORIGIN_DEV }
    : { isDev: false, packagedIndexPath: PACKAGED_INDEX_PATH }
}

/**
 * Per-supervisor: hand every server frame to the attachment gate and deliver
 * whatever it returns (F2) — live if a renderer is attached, otherwise buffered
 * for the next replay so nothing is lost to a fire-and-forget send.
 */
function wireRendererBridge(sup: SidecarSupervisor): void {
  sup.subscribe(event => {
    const frame = supervisorEventToServerFrame(event)
    if (!frame) return
    deliver(attachmentGate.onFrame(event.sessionId, frame))
    if (isTerminalLifecycleFrame(frame)) {
      attachmentGate.clearSession(event.sessionId)
    }
  })
}

/**
 * Bridge the host's `HostEvent` row-change stream to the renderer over the fixed
 * one-way channel. The renderer's session list is a PROJECTION of this stream
 * (REGISTRY §6.1), never a poll loop. HostEvents are host-authored typed data
 * (no filesystem contents, HC3) — the same trust posture as server frames.
 */
function wireHostEvents(h: Host): void {
  h.subscribe(event => {
    const contents = mainWindow?.webContents
    if (!contents) return
    contents.send(CH_HOST_EVENT, event satisfies HostEvent)
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
    }
  }
  if (
    event.status === 'disconnected' ||
    event.status === 'failed' ||
    event.status === 'exited'
  ) {
    return {
      kind: 'lifecycle',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: event.sessionId,
      status: event.status,
    }
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

/**
 * Register the renderer→supervisor IPC handlers ONCE. They read the module-level
 * `supervisor`, so they keep working across a host rebuild (F5) without
 * double-registering listeners on `ipcMain`.
 */
function registerIpcHandlers(): void {
  // Renderer → supervisor: the four allowlisted channels. Main does light shape
  // coercion for UX, but the SIDECAR is the trust boundary (R2) — it re-validates
  // everything with the allowlist schema and applies T4/T6/T6b.
  ipcMain.on(CH_SUBMIT, (_e, arg: { sessionId: SessionId; prompt: string; options?: unknown }) => {
    if (typeof arg?.sessionId !== 'string' || typeof arg?.prompt !== 'string') return
    forward(arg.sessionId, {
      type: 'app.submit',
      requestId: generateRequestId(),
      prompt: arg.prompt,
      options: sanitizeSubmitOptions(arg.options),
    })
  })

  ipcMain.on(
    CH_ABORT,
    (_e, arg: { sessionId: SessionId; requestId: string; reason?: string }) => {
      if (typeof arg?.sessionId !== 'string' || typeof arg?.requestId !== 'string') return
      forward(arg.sessionId, {
        type: 'app.abort',
        requestId: arg.requestId,
        ...(typeof arg.reason === 'string' ? { reason: arg.reason } : {}),
      })
    },
  )

  ipcMain.on(
    CH_PERMISSION,
    (_e, arg: { sessionId: SessionId; requestId: string; response: unknown }) => {
      if (typeof arg?.sessionId !== 'string' || typeof arg?.requestId !== 'string') return
      const response = coercePermissionResponse(arg.response)
      if (!response) return
      forward(arg.sessionId, {
        type: 'permission.response',
        requestId: arg.requestId,
        response,
      })
    },
  )

  ipcMain.on(
    CH_SET_MODE,
    (_e, arg: { sessionId: SessionId; mode: unknown }) => {
      if (typeof arg?.sessionId !== 'string') return
      // C2 — light UX coercion only; the SIDECAR is the trust boundary and
      // re-validates (bypassPermissions/auto rejected there explicitly). A
      // value outside the wire allowlist drops the whole message fail-closed
      // rather than forwarding a frame that is guaranteed to be rejected.
      if (
        !PERMISSION_SET_MODE_MODES.includes(arg.mode as PermissionSetModeMode)
      ) {
        return
      }
      forward(arg.sessionId, {
        type: 'permission.setMode',
        requestId: generateRequestId(),
        mode: arg.mode as PermissionSetModeMode,
      })
    },
  )

  ipcMain.on(CH_PING, (_e, arg: { sessionId: SessionId; nonce: string }) => {
    if (typeof arg?.sessionId !== 'string' || typeof arg?.nonce !== 'string') return
    forward(arg.sessionId, { type: 'app.ping', nonce: arg.nonce })
  })

  ipcMain.on(CH_RESTART, (_e, arg: { sessionId: SessionId }) => {
    if (typeof arg?.sessionId !== 'string' || !supervisor) return
    if (!supervisor.listSessions().some(session => session.sessionId === arg.sessionId)) {
      return
    }
    attachmentGate.clearSession(arg.sessionId)
    supervisor.restartSession(arg.sessionId)
  })

  // F2 — the renderer signals it has mounted and subscribed. The gate replays the
  // buffered frames (including the one-shot `ready` handshake) once per document
  // load and returns nothing on a repeat signal (StrictMode double-invoke).
  ipcMain.on(CH_RENDERER_READY, () => {
    deliver(attachmentGate.onRendererReady())
  })

  registerHostControlPlane()
}

/**
 * Control-plane IPC (HC3 — fixed, per-method structured senders; no generic
 * invoke, no renderer-controlled channel names, no method returning filesystem
 * contents). Each returns a typed `HostResult` (or the picker's single realpath)
 * so a failure crosses the boundary as data, never a thrown internal error (HC2).
 * Handlers read the module-level `host`, so they survive a host rebuild (F5)
 * without re-registering listeners.
 */
function registerHostControlPlane(): void {
  const noHost = <T>(): HostResult<T> => ({
    ok: false,
    error: { code: 'spawn_failed', message: 'host is not running' },
  })

  // HC1 — the ONLY way a renderer obtains a cwd. Native picker in main; the
  // renderer may REQUEST it, never answer it. Returns a single realpath the user
  // explicitly chose, or null (cancelled) — not a listing, not file contents.
  ipcMain.handle(CH_HOST_PICK_DIR, async (): Promise<string | null> => {
    const parent = mainWindow ?? undefined
    const result = parent
      ? await dialog.showOpenDialog(parent, {
          properties: ['openDirectory', 'createDirectory'],
        })
      : await dialog.showOpenDialog({
          properties: ['openDirectory', 'createDirectory'],
        })
    if (result.canceled || result.filePaths.length === 0) return null
    const chosen = validateCwd(result.filePaths[0])
    return chosen.ok ? chosen.realpath : null
  })

  ipcMain.handle(
    CH_HOST_CREATE,
    (_e, req: unknown): Promise<HostResult<SessionDescriptor>> => {
      if (!host) return Promise.resolve(noHost<SessionDescriptor>())
      // Coerce to the request shape; the host re-validates cwd (HC1) and id-shape
      // (HC2), so a malformed field becomes a typed error, never a throw.
      return host.createSession(coerceCreateRequest(req))
    },
  )

  ipcMain.handle(
    CH_HOST_RESTORE,
    (_e, appSessionId: unknown): Promise<HostResult<SessionDescriptor>> => {
      if (!host) return Promise.resolve(noHost<SessionDescriptor>())
      // HC2 — the host validates id shape + membership; pass through as unknown.
      return host.restoreSession(String(appSessionId))
    },
  )

  ipcMain.handle(
    CH_HOST_CLOSE,
    (_e, appSessionId: unknown): Promise<HostResult<void>> => {
      if (!host) return Promise.resolve(noHost<void>())
      return host.closeSession(String(appSessionId))
    },
  )

  ipcMain.handle(CH_HOST_LIST, (): SessionDescriptor[] => {
    return host ? host.listSessions() : []
  })
}

/**
 * Shape-coerce a renderer-supplied create request. Only the three contract
 * fields survive; anything else is dropped. The host still re-validates cwd and
 * caps the title — this is UX coercion, not the trust boundary (HC1 is the host).
 */
function coerceCreateRequest(req: unknown): CreateSessionRequest {
  const r =
    typeof req === 'object' && req !== null
      ? (req as {
          cwd?: unknown
          resumeEngineSessionId?: unknown
          title?: unknown
        })
      : {}
  return {
    cwd: typeof r.cwd === 'string' ? r.cwd : '',
    ...(typeof r.resumeEngineSessionId === 'string'
      ? { resumeEngineSessionId: r.resumeEngineSessionId }
      : {}),
    ...(typeof r.title === 'string' ? { title: r.title } : {}),
  }
}

function forward(sessionId: SessionId, message: SidecarClientMessage): void {
  if (!supervisor) {
    const frame: ServerFrame = {
      kind: 'error',
      protocolVersion: PROTOCOL_VERSION,
      sessionId,
      ...('requestId' in message && typeof message.requestId === 'string'
        ? { requestId: message.requestId }
        : {}),
      code: 'session_not_found',
      message: `session ${sessionId} was not found`,
      retryable: false,
    }
    deliver(attachmentGate.onFrame(sessionId, frame))
    process.stderr.write(`[main] forward to ${sessionId} failed: no live host\n`)
    return
  }
  try {
    supervisor.send(sessionId, message)
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error)
    const code = isSidecarSendError(error) ? error.code : 'bad_request'
    const frame: ServerFrame = {
      kind: 'error',
      protocolVersion: PROTOCOL_VERSION,
      sessionId,
      ...('requestId' in message && typeof message.requestId === 'string'
        ? { requestId: message.requestId }
        : {}),
      code,
      message: messageText,
      retryable: isSidecarSendError(error) ? error.retryable : false,
    }
    deliver(attachmentGate.onFrame(sessionId, frame))
    process.stderr.write(
      `[main] forward to ${sessionId} failed: ${messageText}\n`,
    )
  }
}

function sanitizeSubmitOptions(options: unknown): { isMeta?: boolean; goalSnapshot?: unknown } | undefined {
  if (typeof options !== 'object' || options === null) return undefined
  const o = options as { isMeta?: unknown; goalSnapshot?: unknown }
  const result: { isMeta?: boolean; goalSnapshot?: unknown } = {}
  if (typeof o.isMeta === 'boolean') result.isMeta = o.isMeta
  // goalSnapshot passed through as-is; the SIDECAR validates it (T4).
  if ('goalSnapshot' in o) result.goalSnapshot = o.goalSnapshot
  return result
}

type CoercedPermissionResponse =
  | {
      behavior: 'allow'
      updatedInput: Record<string, unknown>
      applySuggestions?: number[]
    }
  | { behavior: 'deny'; message: string }

function coercePermissionResponse(response: unknown): CoercedPermissionResponse | null {
  if (typeof response !== 'object' || response === null) return null
  const r = response as {
    behavior?: unknown
    updatedInput?: unknown
    message?: unknown
    applySuggestions?: unknown
  }
  if (r.behavior === 'deny' && typeof r.message === 'string') {
    return { behavior: 'deny', message: r.message }
  }
  if (r.behavior === 'allow') {
    // updatedInput is echo-only downstream (T6, enforced at the sidecar). Pass an
    // object or default to empty ("use original").
    const updatedInput =
      typeof r.updatedInput === 'object' && r.updatedInput !== null && !Array.isArray(r.updatedInput)
        ? (r.updatedInput as Record<string, unknown>)
        : {}
    // C1 — "always allow" suggestion selection (decisions/PERMISSION-BOUNDARY.md).
    // Indices only; the sidecar re-validates against the pending request's
    // engine-minted suggestions. A malformed selection drops the whole response
    // (fail-closed) rather than silently downgrading "always" to allow-once.
    if (r.applySuggestions !== undefined) {
      if (
        !Array.isArray(r.applySuggestions) ||
        r.applySuggestions.length > MAX_SUGGESTION_SELECTIONS ||
        !r.applySuggestions.every(
          value => typeof value === 'number' && Number.isInteger(value) && value >= 0,
        )
      ) {
        return null
      }
      if (r.applySuggestions.length > 0) {
        return {
          behavior: 'allow',
          updatedInput,
          applySuggestions: r.applySuggestions as number[],
        }
      }
    }
    return { behavior: 'allow', updatedInput }
  }
  return null
}

function generateRequestId(): string {
  return randomUUID()
}

/**
 * (Re)create the host: supervisor + durable registry + the typed control-plane
 * composition, then the primary session. Called on startup AND on macOS
 * `activate` (F5) so reopening the window after `window-all-closed` produces a
 * NEW functioning session rather than a shell wired to a shut-down supervisor.
 *
 * The fresh-session-per-activate now flows through `host.createSession` so
 * registry hygiene (the launch sweep, row bound, clean/crashed marking) applies
 * to dock-reopen sessions (D1 §9-A5). The single-instance lock (taken in
 * `whenReady`, REGISTRY §5) guarantees this is the ONLY writer of the registry
 * file, so its launch sweep runs unraced.
 */
function ensureHost(): Host {
  if (host) return host
  supervisor = createSupervisor()
  wireRendererBridge(supervisor)

  // The registry lives beside the supervisor in the host plane. Default storage
  // dir (<config-home>/desktop) unless overridden for tests. The sidecar entry
  // path is the §9-A3 orphan-identity marker so the launch sweep never SIGTERMs
  // an innocent same-pid process.
  const registry = new SessionRegistry({
    sidecarCommandMarker: SIDECAR_ENTRY,
  })

  host = new Host({
    supervisor,
    registry,
    validateCwd,
    // The P3-0 carry: a closed/restarted session's replay buffer must be evicted
    // so a reload never replays a dead session's frames.
    evictReplay: appSessionId => attachmentGate.clearSession(appSessionId),
  })
  wireHostEvents(host)

  // Run the launch sequence (read+validate → sweep orphans → reap), THEN spawn
  // the primary session through the host so registry hygiene applies. Both are
  // async; a launch/spawn failure logs but never crashes main.
  void registry
    .launch()
    .catch(error => {
      process.stderr.write(`[main] registry launch failed: ${errText(error)}\n`)
    })
    .then(() => host?.createSession({ cwd: process.cwd() }))
    .then(result => {
      if (result && !result.ok) {
        process.stderr.write(
          `[main] primary session create failed: ${result.error.code} ${result.error.message}\n`,
        )
      }
    })
    .catch(error => {
      process.stderr.write(`[main] primary session create threw: ${errText(error)}\n`)
    })

  // Smoke-run hook (verification only): if CATCODE_SMOKE_EXIT_MS is set, log the
  // frames the supervisor receives and exit after the timeout. Lets a headless
  // CI/verify run prove the sidecar spawns and the tool_use frame round-trips
  // through main without needing a visible window.
  const smokeMs = Number(process.env.CATCODE_SMOKE_EXIT_MS ?? '0')
  if (smokeMs > 0) {
    supervisor.subscribe(event => {
      if (event.type === 'frame') {
        if (event.frame.kind === 'ready') {
          process.stdout.write(
            `[main-smoke] ready ${JSON.stringify(event.frame.payload)}\n`,
          )
        } else {
          process.stdout.write(`[main-smoke] frame ${event.frame.kind}\n`)
        }
      }
    })
    setTimeout(() => {
      supervisor?.shutdown()
      app.exit(0)
    }, smokeMs)
  }

  return host
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Single-instance lock (REGISTRY §5 / R5): the registry is a shared mutable file
// and the host is its SINGLE writer by construction. Take the OS lock BEFORE any
// host is constructed; a second app instance never builds a host — it focuses the
// existing window and quits. This is the client-layer half of the write
// discipline (the module-layer advisory lockfile is the belt to this braces).
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // A second launch defers to us: surface our window instead.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    applySecurityBaseline()
    registerIpcHandlers() // once — handlers read the module-level host/supervisor
    // Host construction (and thus the registry's launch sweep) runs only after we
    // hold the single-instance lock, so the sweep is never raced by a sibling.
    ensureHost()
    // Hand the renderer its session id once it loads (via the ready frame's
    // sessionId; renderer reads it off the first frame it receives).
    createWindow()

    app.on('activate', () => {
      // F5 — reopening on macOS must rebuild a live host if it was torn down.
      ensureHost()
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  // D6: die-with-window for v1 — tear down every sidecar via the supervisor's
  // kill API (NOT by welding the sidecar to the window's lifecycle). `activate`
  // rebuilds a fresh host on reopen (F5).
  supervisor?.shutdown()
  supervisor = null
  // Drop the host too so `ensureHost` rebuilds supervisor + registry + host as a
  // unit on the next `activate` (a fresh registry re-reads the file and re-runs
  // its launch sweep — the dock-reopen session goes through createSession again).
  host = null
  // F2 — drop the old session's buffered frames so a macOS reopen (which spawns a
  // NEW session id via `ensureHost`) never replays dead-session frames into the
  // fresh window.
  attachmentGate.reset()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  supervisor?.shutdown()
})
