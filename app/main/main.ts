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

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  session,
  shell,
} from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'

import {
  isSidecarSendError,
  SidecarSupervisor,
} from '../supervisor/supervisor.js'
import {
  defaultTranscriptPath,
  defaultRegistryDir,
  SessionRegistry,
} from '../host/registry.js'
import { Host, type CwdValidation } from '../host/host.js'
import type {
  HostEvent,
  HostResult,
  SessionDescriptor,
} from '../shared/hostApi.js'
import {
  DEBUG_SHELL_STATE_CHANNEL,
  DEBUG_STATE_VERSION,
  type DebugRendererSnapshot,
  type DebugStateFile,
} from '../shared/debugState.js'
import {
  AttachmentGate,
  LAZY_REPLAY_FLUSH_MS,
} from './attachmentGate.js'
import {
  createCwdTokenStore,
  isTerminalLifecycleFrame,
  SIDECAR_RUNTIME_ARGS,
  selectTranscriptBackfillCandidates,
  supervisorEventToServerFrame,
} from './mainDecisions.js'
import {
  deleteCache,
  distill,
  cacheHasCurrentRunFacts,
  cacheWrittenAt,
  listCachedSessionIds,
  readCache,
  resolvePreview,
  transcriptCacheDir,
  writeCache,
} from './transcriptCache.js'
import { readSessionsCatalogCache } from './sessionsCatalogBaseline.js'
import { resolveOpenHistorySession } from './openHistorySession.js'
import {
  persistTranscriptBackfillResult,
  runTranscriptBackfill,
} from './transcriptBackfill.js'
import { MAX_TRANSCRIPT_BACKFILL_SESSIONS } from '../shared/transcriptBackfill.js'
import {
  createSessionsCatalogDriver,
  runSessionsCatalogWorker,
  type SessionsCatalogDriver,
} from './sessionsCatalogRunner.js'
import {
  createAccountsPoolDriver,
  runAccountsPoolWorker,
  type AccountsPoolDriver,
} from './accountsPoolRunner.js'
import {
  createIdleParkDriver,
  type IdleParkDriver,
} from './idleParkDriver.js'
import {
  atomicWriteJson0600,
  createDebouncedAction,
  createDevPickerBypass,
  createReadinessLatch,
  parseDebugSnapshot,
  resolveDevHarnessConfig,
  resolvePickerDefaultPath,
} from './devHarness.js'
import {
  decideWindowOpen,
  isAppOrigin,
  type NavigationConfig,
} from './navigationPolicy.js'
import { MAX_SUGGESTION_SELECTIONS } from '../shared/limits.js'
import {
  ACCOUNT_VERB_TYPES,
  PERMISSION_SET_MODE_MODES,
  PROTOCOL_VERSION,
  REMOTE_VERB_TYPES,
  RUN_CONTROL_VERB_TYPES,
  SESSION_ACTION_VERB_TYPES,
  SETTINGS_VERB_TYPES,
  TASK_CONTROL_VERB_TYPES,
  WORKSPACE_TRUST_VERB_TYPES,
  type AccountVerbMessage,
  type AccountVerbType,
  type AskUserQuestionAnswerMessage,
  type PermissionSetModeMode,
  type RemoteVerbMessage,
  type RemoteVerbType,
  type RunControlVerbMessage,
  type RunControlVerbType,
  type ServerFrame,
  type SessionActionVerbMessage,
  type SessionActionVerbType,
  type SessionId,
  type SessionsCatalogSnapshot,
  type SettingsVerbMessage,
  type SettingsVerbType,
  type TaskControlVerbMessage,
  type TaskControlVerbType,
  type SidecarClientMessage,
  type TranscriptCache,
  type WorkspaceTrustMessage,
  type WorkspaceTrustVerbType,
} from '../shared/protocol.js'
const __dirname = dirname(fileURLToPath(import.meta.url))

// Fixed internal channel names — must match preload.ts.
const CH_SUBMIT = 'catcode:submit'
const CH_ABORT = 'catcode:abort'
const CH_PERMISSION = 'catcode:permission'
const CH_ANSWER_QUESTIONS = 'catcode:answer-questions'
const CH_SET_MODE = 'catcode:set-mode'
const CH_ACCOUNT_VERB = 'catcode:account-verb'
const CH_WORKSPACE_TRUST_VERB = 'catcode:workspace-trust-verb'
const CH_AGENT_MODE_SET = 'catcode:agent-mode-set'
const CH_TASK_CONTROL_VERB = 'catcode:task-control-verb'
const CH_RUN_CONTROL_VERB = 'catcode:run-control-verb'
const CH_SESSION_ACTION_VERB = 'catcode:session-action-verb'
const CH_REMOTE_SETTINGS_VERB = 'catcode:remote-settings-verb'
const CH_SETTINGS_VERB = 'catcode:settings-verb'
const CH_PING = 'catcode:ping'
const CH_RESTART = 'catcode:restart'
const CH_SERVER_FRAME = 'catcode:server-frame'
const CH_RENDERER_READY = 'catcode:renderer-ready'

// Control-plane channels (HC3 — fixed, per-method structured senders). `invoke`
// channels return a typed HostResult; `pick-directory` returns a realpath or
// null (the native picker, HC1); the host-event channel is a one-way stream.
const CH_HOST_CREATE = 'catcode:host:create'
const CH_HOST_CREATE_IN_WORKSPACE = 'catcode:host:create-in-workspace'
const CH_HOST_RESTORE = 'catcode:host:restore'
const CH_HOST_CLOSE = 'catcode:host:close'
const CH_HOST_LIST = 'catcode:host:list'
const CH_HOST_PICK_DIR = 'catcode:host:pick-directory'
const CH_HOST_PREVIEW = 'catcode:host:preview'
const CH_HOST_SESSIONS_CATALOG = 'catcode:host:sessions-catalog'
const CH_HOST_OPEN_HISTORY = 'catcode:host:open-history'
const CH_HOST_EVENT = 'catcode:host:event'

const APP_ORIGIN_DEV = process.env.CATCODE_RENDERER_URL ?? 'http://localhost:5173'
const IS_DEV = !app.isPackaged
if (IS_DEV) app.setName('Cat Code Dev')
const APP_ICON_PATH = join(__dirname, '..', 'resources', 'icon.png')
const VITE_REACT_PREAMBLE_CSP_HASH =
  "'sha256-Z2/iFzh9VMlVkEOar1f/oSHWwQk3ve1qk/C2WdsC4Xk='"

// The supervisor is N-ready (a map). The host composes it with the durable
// registry into the typed control plane (P3-3); main is a CALLER of that host.
let supervisor: SidecarSupervisor | null = null
let host: Host | null = null
let mainWindow: BrowserWindow | null = null
let registryForDebug: SessionRegistry | null = null
let latestRendererSnapshot: DebugRendererSnapshot | null = null

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
const replayFlushTimers = new Map<SessionId, ReturnType<typeof setTimeout>>()

function scheduleReplayFlush(sessionId: SessionId): void {
  if (replayFlushTimers.has(sessionId)) return
  const timer = setTimeout(() => {
    replayFlushTimers.delete(sessionId)
    deliver(attachmentGate.flushReplayCoalescing(sessionId))
  }, LAZY_REPLAY_FLUSH_MS)
  replayFlushTimers.set(sessionId, timer)
}

function cancelReplayFlush(sessionId: SessionId): void {
  const timer = replayFlushTimers.get(sessionId)
  if (timer) clearTimeout(timer)
  replayFlushTimers.delete(sessionId)
}

function cancelAllReplayFlushes(): void {
  for (const timer of replayFlushTimers.values()) clearTimeout(timer)
  replayFlushTimers.clear()
}

/**
 * IS-A — where the at-rest transcript caches live: beside the durable registry
 * (`<config-home>/desktop/transcript-cache`), same trust domain as the registry
 * file and the engine transcript JSONL. Fixed at startup (env is stable per run),
 * matching the registry's own `defaultRegistryDir()` timing.
 */
const TRANSCRIPT_CACHE_DIR = transcriptCacheDir(defaultRegistryDir())

/** One background PL-B pass per app process; never concurrent with itself. */
let transcriptBackfillStarted = false
let transcriptBackfillAbort: AbortController | null = null
let registryLaunchSettled: Promise<unknown> | null = null
const TRANSCRIPT_BACKFILL_START_DELAY_MS = 250

/**
 * Catalog owner (decision #4 shape (b)): one main-supervised, single-flight
 * driver per app process. Armed once after first paint; it re-spawns the
 * disposable engine-graph catalog worker on a timer and delivers each accepted
 * snapshot to the renderer as a read-only `sessions-catalog` host event. Null
 * until armed; re-armable after a window-all-closed/reactivate cycle.
 */
let sessionsCatalogDriver: SessionsCatalogDriver | null = null

/**
 * Accounts owner (`decisions/ACCOUNTS-OWNERSHIP.md`): the account pool is
 * process-GLOBAL state, so its read is main-owned rather than per-session — one
 * single-flight driver per app process, armed after first paint, delivering each
 * accepted redacted snapshot as a read-only `accounts-pool` host event. Same
 * lifecycle as `sessionsCatalogDriver`.
 */
let accountsPoolDriver: AccountsPoolDriver | null = null

/**
 * Kill switch for the worker a driver may have IN FLIGHT at teardown. `stop()`
 * only cancels the next scheduled run: it cannot reach a child process already
 * spawned, and that child is a full engine graph whose own watchdog timer dies
 * with Electron. Nothing else can reap it either — the launch sweep and
 * `scripts/reap-orphan-sidecars.ts` both match the sidecar entry marker, which a
 * catalog/accounts worker does not carry. Armed with the driver, aborted beside
 * every `stop()`, exactly like `transcriptBackfillAbort`.
 */
let sessionsCatalogAbort: AbortController | null = null
let accountsPoolAbort: AbortController | null = null

/**
 * IDLE-PARK (decisions/IDLE-PARK.md §4) — one main-supervised policy driver per
 * app process, mirroring `sessionsCatalogDriver`'s lifecycle: armed after first
 * paint, torn down with the window, re-armable on reactivate. It parks idle /
 * over-cap engines via a host-initiated `app.park`. Null until armed.
 */
let idleParkDriver: IdleParkDriver | null = null

/**
 * Persist one session's transcript cache (IS-A). Called at every eviction point
 * in **snapshot → atomic persist → evict** order (the caller evicts AFTER this):
 * snapshot the session's buffered frames, distill to the transcript-only cache,
 * and atomically write it. Skips a session with no buffered frames or no
 * engineSessionId (never restorable, so a cache would never be served). Wrapped
 * fail-safe: a persist error degrades to the no-cache path, never breaks
 * eviction or the synchronous quit.
 */
function persistTranscriptCache(appSessionId: SessionId): void {
  try {
    const frames = attachmentGate.snapshotSession(appSessionId)
    if (frames.length === 0) return
    const cache = distill(frames)
    if (cache.header.engineSessionId === null) return
    // The pre-distill snapshot always has a head plus state snapshots, so the
    // check above never catches a session closed before its first turn. Distilling
    // drops all of those, and a cache with no transcript frames is worse than no
    // cache: the renderer treats a readable cache as a preview and shows a
    // loading placeholder for a transcript that will never arrive.
    if (cache.frames.length === 0) return
    writeCache(TRANSCRIPT_CACHE_DIR, cache)
  } catch (error) {
    process.stderr.write(
      `[main] transcript-cache persist failed for ${appSessionId}: ${errText(error)}\n`,
    )
  }
}

/**
 * Startup cache GC (IS-A). The launch-time registry reap runs BEFORE main
 * subscribes to HostEvents, so reaped rows emit no `session-removed` — a cache
 * file whose row is gone would otherwise linger forever. Delete every cache file
 * whose id the host no longer vouches for as restorable. Runs once, after the
 * registry launch sweep settles.
 */
function gcTranscriptCache(): void {
  try {
    for (const id of listCachedSessionIds(TRANSCRIPT_CACHE_DIR)) {
      if (!host || !host.canPreview(id)) deleteCache(TRANSCRIPT_CACHE_DIR, id)
    }
  } catch (error) {
    process.stderr.write(`[main] transcript-cache GC failed: ${errText(error)}\n`)
  }
}

/**
 * Last-write time of a restorable row's engine transcript, or 0 when it cannot
 * be read. Only ever compared against a cache stamp, so "unknown" reads as
 * "not newer" and leaves the existing cache alone.
 */
function transcriptMtimeMs(session: SessionDescriptor): number {
  if (session.engineSessionId === null) return 0
  try {
    return statSync(defaultTranscriptPath(session.cwd, session.engineSessionId))
      .mtimeMs
  } catch {
    return 0
  }
}

/**
 * Whether a row's engine transcript has grown since its cache was written. A
 * session continued in the terminal after the desktop app cached it otherwise
 * previews that old conversation, and shows that old model/effort/usage beside
 * it, for as long as the cache survives.
 */
function isTranscriptNewerThanCache(session: SessionDescriptor): boolean {
  const writtenAt = cacheWrittenAt(TRANSCRIPT_CACHE_DIR, session.appSessionId)
  if (writtenAt === null) return false
  return transcriptMtimeMs(session) > writtenAt
}

/**
 * PL-B — after first window paint, backfill only uncached, restorable, non-live
 * rows. The worker reads the engine transcript; main remains engine-free and is
 * the single cache writer. Every result is race-checked against fresh host state
 * before write so an opened/live, removed, re-keyed, or concurrently-cached row
 * is skipped safely.
 */
async function backfillTranscriptCaches(): Promise<void> {
  if (transcriptBackfillStarted) return
  transcriptBackfillStarted = true
  await registryLaunchSettled
  const h = host
  if (!h) return

  // Discovery must not synchronously parse + recursively secret-scan every
  // cache on Electron's main thread. One directory listing tells us which rows
  // already have an artifact; strict readCache validation still runs at the
  // preload boundary and after every backfill write.
  const cachedIds = new Set(listCachedSessionIds(TRANSCRIPT_CACHE_DIR))
  // A cached row is skipped only when its cache can already speak for the
  // session. One written before run facts existed is re-derived here, and
  // `persistTranscriptBackfillResult` keeps the write idempotent. Since sessions
  // were unified, the sidebar lists terminal-created sessions too, and those keep
  // growing outside this app: a cache is stale the moment the engine transcript
  // is newer than it.
  const items = selectTranscriptBackfillCandidates({
    sessions: h.listSessions(),
    hasCache: appSessionId => cachedIds.has(appSessionId),
    cacheHasCurrentRunFacts: appSessionId =>
      cacheHasCurrentRunFacts(TRANSCRIPT_CACHE_DIR, appSessionId),
    isTranscriptNewerThanCache,
    transcriptPath: (session, engineSessionId) =>
      defaultTranscriptPath(session.cwd, engineSessionId),
    limit: MAX_TRANSCRIPT_BACKFILL_SESSIONS,
  })
  if (items.length === 0) return

  const abort = new AbortController()
  transcriptBackfillAbort = abort
  try {
    const summary = await runTranscriptBackfill({
      items,
      command: process.env.CATCODE_BUN_BIN ?? 'bun',
      args: [
        'run',
        TRANSCRIPT_BACKFILL_WORKER_ENTRY,
        '--bare',
      ],
      cwd: process.cwd(),
      signal: abort.signal,
      onSession: result => {
        const currentHost = host
        if (!currentHost || !currentHost.canPreview(result.appSessionId)) return
        const persisted = persistTranscriptBackfillResult(
          {
            cacheDir: TRANSCRIPT_CACHE_DIR,
            getCurrentSession: appSessionId =>
              currentHost
                .listSessions()
                .find(session => session.appSessionId === appSessionId),
            transcriptExists: session =>
              session.engineSessionId !== null &&
              existsSync(defaultTranscriptPath(session.cwd, session.engineSessionId)),
            isCacheStale: (session, writtenAt) =>
              transcriptMtimeMs(session) > writtenAt,
          },
          result,
        )
        if (persisted === 'written') {
          const session = currentHost
            .listSessions()
            .find(row => row.appSessionId === result.appSessionId)
          if (session?.restorable) {
            // Reuse the existing outbound host stream. The unchanged descriptor
            // is a cache-ready nudge; PL-A performs the existing read-only
            // previewSession call and never opens a pane.
            sendHostEvent({ type: 'session-status', session })
          }
        }
        if (persisted === 'rejected') {
          process.stderr.write(
            `[main] transcript-cache backfill rejected after write for ${result.appSessionId}\n`,
          )
        }
      },
      log: line => process.stderr.write(`${line}\n`),
    })
    process.stderr.write(
      `[main] transcript-cache backfill attempted=${summary.attempted} accepted=${summary.accepted} failed=${summary.failed} rejected=${summary.rejected}\n`,
    )
  } catch (error) {
    if (abort.signal.aborted) {
      // macOS keeps the process alive after window-all-closed. The next activate
      // creates a fresh host/window and may retry after that window paints.
      transcriptBackfillStarted = false
    } else {
      process.stderr.write(
        `[main] transcript-cache backfill failed: ${errText(error)}\n`,
      )
    }
  } finally {
    if (transcriptBackfillAbort === abort) transcriptBackfillAbort = null
  }
}

/**
 * Catalog owner (decision #4 shape (b), `docs/migration/decisions/CATALOG-OWNERSHIP.md`)
 * — arm the single-flight, self-rescheduling catalog refresh after first paint,
 * alongside the PL-B transcript backfill. Each run spawns ONE disposable
 * engine-graph worker (`--bare`); on an accepted, secret-clean snapshot main
 * emits a read-only `sessions-catalog` host event to the renderer (C3 precedent,
 * no inbound verb). A failed run keeps the last good catalog (no event emitted).
 * The immediate first run means the sidebar is not empty at cold launch; the
 * per-run engine-graph import (the CATALOG-OWNERSHIP §4 boot cost) is paid off
 * the launch critical path because this fires from `ready-to-show`.
 */
function startSessionsCatalogRefresh(): void {
  if (sessionsCatalogDriver) return
  const abort = new AbortController()
  sessionsCatalogAbort = abort
  sessionsCatalogDriver = createSessionsCatalogDriver({
    run: () =>
      runSessionsCatalogWorker({
        command: process.env.CATCODE_BUN_BIN ?? 'bun',
        args: ['run', SESSIONS_CATALOG_WORKER_ENTRY, '--bare'],
        cwd: process.cwd(),
        signal: abort.signal,
        onCatalog: catalog => {
          sendHostEvent({ type: 'sessions-catalog', catalog })
        },
        log: line => process.stderr.write(`${line}\n`),
      }),
    log: line => process.stderr.write(`${line}\n`),
  })
  sessionsCatalogDriver.start()
}

/**
 * Accounts owner (`decisions/ACCOUNTS-OWNERSHIP.md`) — arm the single-flight,
 * self-rescheduling pool refresh after first paint, alongside the catalog. Each
 * run spawns ONE disposable engine-graph worker (`--bare`); on an accepted,
 * secret-clean snapshot main emits a read-only `accounts-pool` host event (C3
 * precedent, no inbound verb). A failed run keeps the last good pool (no event
 * emitted). The immediate first run means the Accounts page is populated without
 * requiring a session to exist, which is the whole point of moving this read off
 * the per-session plane.
 */
function startAccountsPoolRefresh(): void {
  if (accountsPoolDriver) return
  const abort = new AbortController()
  accountsPoolAbort = abort
  accountsPoolDriver = createAccountsPoolDriver({
    run: () =>
      runAccountsPoolWorker({
        command: process.env.CATCODE_BUN_BIN ?? 'bun',
        args: ['run', ACCOUNTS_POOL_WORKER_ENTRY, '--bare'],
        cwd: process.cwd(),
        signal: abort.signal,
        onPool: pool => {
          sendHostEvent({ type: 'accounts-pool', pool })
        },
        log: line => process.stderr.write(`${line}\n`),
      }),
    log: line => process.stderr.write(`${line}\n`),
  })
  accountsPoolDriver.start()
}

/**
 * IDLE-PARK (decisions/IDLE-PARK.md §4) — arm the policy driver after first paint
 * (alongside the catalog refresh), off the launch critical path. It captures the
 * CURRENT host + supervisor (both rebuilt as a unit on reactivate), reads the
 * live set from `host.listSessions()`, and sends a gated `app.park` to each idle/
 * over-cap victim via `supervisor.send` — the same send path `forward` uses, but
 * ORIGINATED by main's policy loop, never any renderer IPC channel (no preload
 * sender exists). A victim that raced to exit makes `supervisor.send` throw; the
 * driver catches it. Re-evaluates on each host event (cap) + on a timer (TTL).
 */
function startIdleParkDriver(): void {
  if (idleParkDriver) return
  const activeHost = host
  const activeSupervisor = supervisor
  if (!activeHost || !activeSupervisor) return
  idleParkDriver = createIdleParkDriver({
    listSessions: () => activeHost.listSessions(),
    park: appSessionId => {
      // Host-originated, gated at the sidecar. No renderer authored this — the
      // requestId is minted here purely to satisfy the frame contract (there is
      // no ack; the sidecar's PARKED_EXIT_CODE self-exit is the truth signal).
      activeSupervisor.send(appSessionId, {
        type: 'app.park',
        requestId: randomUUID(),
      })
    },
    subscribeHostEvents: listener => activeHost.subscribe(() => listener()),
    log: line => process.stderr.write(`${line}\n`),
  })
  idleParkDriver.start()
}

// Perf (2026-07-08, F3): send the whole batch as ONE `webContents.send`, not one
// send per frame. A restore replays its history as a single `frames[]` from the
// gate (`onRendererReady` → buffer snapshot); one send ⇒ one renderer IPC task ⇒
// the preload fans out to `subscribe` synchronously ⇒ React batches all folds
// into ~1 render, instead of 95–400 separate tasks each committing a full render.
// The channel payload and the preload's `subscribe(listener)` contract are now
// `ServerFrame[]` (was a single `ServerFrame`). Outbound-only: no new channel or
// bridge method, and the on-wire `ServerFrame`/`PROTOCOL_VERSION` are unchanged —
// a batch is just the delivery envelope, so no protocol version bump.
function deliver(frames: ServerFrame[]): void {
  const contents = mainWindow?.webContents
  if (!contents) return
  if (frames.length === 0) return
  contents.send(CH_SERVER_FRAME, frames satisfies ServerFrame[])
}

/** The sidecar entry path — also the registry's orphan-identity marker (§9-A3). */
const SIDECAR_ENTRY = join(__dirname, '..', '..', 'app', 'sidecar', 'index.ts')
/** Same dev/packaged source topology as SIDECAR_ENTRY; separate worker mode. */
const TRANSCRIPT_BACKFILL_WORKER_ENTRY = join(
  __dirname,
  '..',
  '..',
  'app',
  'sidecar',
  'transcriptBackfillWorker.ts',
)
/** Catalog owner (decision #4): the disposable sessions-catalog worker entry. */
const SESSIONS_CATALOG_WORKER_ENTRY = join(
  __dirname,
  '..',
  '..',
  'app',
  'sidecar',
  'sessionsCatalogWorker.ts',
)
/** Accounts owner: the disposable account-pool worker entry. */
const ACCOUNTS_POOL_WORKER_ENTRY = join(
  __dirname,
  '..',
  '..',
  'app',
  'sidecar',
  'accountsPoolWorker.ts',
)

function createSupervisor(): SidecarSupervisor {
  // The sidecar runs the same default classifier feature as the engine bundle
  // (`scripts/build.ts`). Without the Bun runtime flag every `feature(...)`
  // branch is compiled false and genuine auto mode cannot run.
  return new SidecarSupervisor({
    sidecarCommand: process.env.CATCODE_BUN_BIN ?? 'bun',
    sidecarArgs: [...SIDECAR_RUNTIME_ARGS, SIDECAR_ENTRY],
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
    if (!statSync(real).isDirectory()) return { ok: false }
    // F6 — NFC-normalize to match the engine's canonicalization (realpath + NFC,
    // sessionStoragePortable.ts canonicalizePath): the row's cwd must sanitize
    // to the same project dir the engine writes, or a decomposed-Unicode
    // (macOS-typical) path is wrongly refused at restore.
    return { ok: true, realpath: real.normalize('NFC') }
  } catch {
    return { ok: false }
  }
}

const devHarnessConfig = resolveDevHarnessConfig({
  isPackaged: app.isPackaged,
  env: process.env,
  validateCwd,
  log: line => process.stderr.write(`${line}\n`),
})

const devPickerBypass = createDevPickerBypass(devHarnessConfig, {
  validateCwd,
  log: line => process.stderr.write(`${line}\n`),
})

const scheduleDebugStateExport = createDebouncedAction(
  () => writeDebugStateExport(),
  { delayMs: 250 },
)

const readinessLatch = createReadinessLatch(() => {
  process.stdout.write('[main] renderer ready\n')
  scheduleDebugStateExport.schedule()
})

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
    // P4-46 — a floor DERIVED from the layout, not chosen. The renderer has no
    // responsive layer (six `sm:grid-cols-*` uses, nothing else), so the window
    // must not shrink past the widest composition that cannot reflow.
    //
    // Width 852 = 48 sidebar rail (`Sidebar.tsx:407` `w-12 shrink-0`, the only
    // non-shrinking flow chrome) + 64 chat-pane padding (`App.tsx:3567` `p-8`)
    // + 740 transcript/composer column (`App.tsx:3661` and
    // `TranscriptView.tsx:233` `max-w-[740px]`, P4-24). The two pages with wider
    // columns are `max-w` + `mx-auto` and reflow: Settings' 660 column beside its
    // `w-[240px] shrink-0` rail (`SettingsShell.tsx:294,356`), and Accounts' 1000
    // (`AccountsPage.tsx:768`), which already reflows at the 1100 default above.
    //
    // Height 495 = 28 macOS title bar (Electron's min* are OUTER-window measures;
    // every other term here is CSS px) + 40 tab bar (`TabBar.tsx:119` `h-10`)
    // + 64 chat-pane padding + 16 dock gap (`App.tsx:3567` `gap-4`) + 83 composer
    // dock at rest (36 textarea + 11 pad + 2 focus rule + 12 + 22 actions bar)
    // + 264 for the transcript, which must never be shorter than the tallest
    // panel the shell opens over it: the 7-item session actions menu
    // (`sessionActions.ts:320` `estimateSessionActionsMenuHeight`), which neither
    // scrolls nor clamps its own height.
    minWidth: 852,
    minHeight: 495,
    backgroundColor: '#09090b',
    show: false,
    icon: APP_ICON_PATH,
    webPreferences: {
      // SECURITY-MINIMUM §3 BrowserWindow/webPreferences — every box checked.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      preload: join(
        __dirname,
        '..',
        'preload',
        IS_DEV ? 'preload.dev.cjs' : 'preload.cjs',
      ),
    },
  })
  mainWindow = window

  if (IS_DEV) {
    window.webContents.on('page-title-updated', event => {
      event.preventDefault()
      window.setTitle('Cat Code Dev')
    })
  }

  // F2 — a fresh document (first load OR a reload of this window) has not yet
  // re-registered `subscribe`, so live frames must not be sent to it until it
  // re-announces readiness. Reset the attach flag on every navigation start; the
  // renderer's `rendererReady` call after mount flips it back and triggers the
  // replay. `did-start-navigation` fires on the initial load and on reloads.
  window.webContents.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) {
      cancelAllReplayFlushes()
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

  window.once('ready-to-show', () => {
    window.show()
    readinessLatch.windowReady()
    // Paint first. The worker import is the ~189 MB engine-graph cost; never pay
    // it on the launch/first-window critical path.
    setTimeout(() => void backfillTranscriptCaches(), TRANSCRIPT_BACKFILL_START_DELAY_MS)
    // Catalog owner (decision #4): arm the main-supervised catalog refresh here,
    // off the launch critical path, so its first run fills the sidebar and it
    // then self-reschedules — replacing the per-sidecar catalog enumeration.
    setTimeout(startSessionsCatalogRefresh, TRANSCRIPT_BACKFILL_START_DELAY_MS)
    // Accounts owner (decisions/ACCOUNTS-OWNERSHIP.md): arm the pool refresh the
    // same way, so the Accounts page has live data with no session open.
    setTimeout(startAccountsPoolRefresh, TRANSCRIPT_BACKFILL_START_DELAY_MS)
    // IDLE-PARK (decisions/IDLE-PARK.md §4): arm the RAM-reclaim policy driver
    // here too, off the launch critical path; it self-reschedules its TTL sweep
    // and re-evaluates the cap on host events.
    setTimeout(startIdleParkDriver, TRANSCRIPT_BACKFILL_START_DELAY_MS)
  })

  if (IS_DEV) {
    void window.loadURL(APP_ORIGIN_DEV)
  } else {
    // `dev.ts` sets CATCODE_RENDERER_URL and waits for that server before
    // launching. Reaching the packaged branch anyway means the dev launcher
    // believes this is a dev run and main disagrees, so the window is about to
    // load a STALE `dist` while a live Vite server sits unused. Say so: the
    // 2026-07-28 instance cost hours precisely because it was silent. This only
    // reports the contradiction; the packaged branch still wins, so a real
    // packaged build can never be talked onto a remote origin by an env var.
    if (process.env.CATCODE_RENDERER_URL) {
      process.stderr.write(
        `[main] CATCODE_RENDERER_URL is set (${process.env.CATCODE_RENDERER_URL}) but app.isPackaged is true, so the packaged renderer is being loaded from disk. Renderer edits will NOT appear until "renderer:build" is re-run. Expected a dev launch? Check that the Electron executable is still named "electron".\n`,
      )
    }
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
    // P4-6 title-rider: the sidecar's one-shot AI title is a sidecar→host signal,
    // not a renderer frame. Relay it to the durable registry (host is engine-free,
    // so it cannot pull the engine's title) and DO NOT forward it — the title
    // reaches the sidebar/tab as a host descriptor update (HostEvent). event.sessionId
    // is the appSessionId (the supervisor's routing key = the host's row id).
    if (frame.kind === 'session-title') {
      void host?.setTitle(event.sessionId, frame.title)
      return
    }
    deliver(attachmentGate.onFrame(event.sessionId, frame))
    if (attachmentGate.hasPendingReplayCoalescing(event.sessionId)) {
      scheduleReplayFlush(event.sessionId)
    } else if (!attachmentGate.isReplayCoalescing(event.sessionId)) {
      cancelReplayFlush(event.sessionId)
    }
    if (isTerminalLifecycleFrame(frame)) {
      // IS-A — snapshot → persist → evict. A crash reaches eviction through this
      // terminal frame (the supervisor emits no exit after a host-asked kill, so
      // graceful close/quit/restart persist via the host's evictReplay callback
      // instead); persist here so a crashed session is still previewable.
      persistTranscriptCache(event.sessionId)
      cancelReplayFlush(event.sessionId)
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
    sendHostEvent(event)
    // IS-A delete-on-reap: a row that left the live∪restorable set (reaped or its
    // engineSessionId cleared) must not keep an at-rest transcript cache.
    if (event.type === 'session-removed') {
      deleteCache(TRANSCRIPT_CACHE_DIR, event.appSessionId)
    }
    scheduleDebugStateExport.schedule()
  })
}

function sendHostEvent(event: HostEvent): void {
  const contents = mainWindow?.webContents
  if (contents) contents.send(CH_HOST_EVENT, event)
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
    CH_ANSWER_QUESTIONS,
    (_e, arg: { sessionId: SessionId; requestId: string; answers: unknown }) => {
      // C5 (P4-20) — light UX shape coercion only; the SIDECAR is the trust
      // boundary (T5a + tool gate + Zod + engine-label re-attach). Drop a frame
      // whose `answers` is not an array fail-closed rather than forward one
      // guaranteed to be rejected. The renderer authors the engine-minted
      // `requestId` (T5a) + option indices + freeform — no engine object crosses.
      if (
        typeof arg?.sessionId !== 'string' ||
        typeof arg?.requestId !== 'string' ||
        !Array.isArray(arg.answers)
      ) {
        return
      }
      forward(arg.sessionId, {
        type: 'askUserQuestion.answer',
        requestId: arg.requestId,
        answers: arg.answers as AskUserQuestionAnswerMessage['answers'],
      })
    },
  )

  ipcMain.on(
    CH_SET_MODE,
    (_e, arg: { sessionId: SessionId; mode: unknown }) => {
      if (typeof arg?.sessionId !== 'string') return
      // C2 — light UX coercion only; the SIDECAR is the trust boundary and
      // re-validates (`auto` rejected there explicitly; `bypassPermissions`
      // honoured only when the trusted launch flag enabled it). A value outside
      // the wire allowlist drops the whole message fail-closed rather than
      // forwarding a frame that is guaranteed to be rejected.
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

  ipcMain.on(
    CH_ACCOUNT_VERB,
    (_e, arg: { sessionId: SessionId; verb: unknown }) => {
      if (typeof arg?.sessionId !== 'string') return
      // P4-5 — light UX coercion only; the SIDECAR is the trust boundary and
      // fully re-validates (schema + pool-resolved business rules). Drop any
      // frame whose `type` is not an account verb fail-closed, rather than
      // forwarding a message guaranteed to be rejected. The renderer authors the
      // `requestId` for result correlation (a UX field, not a security one; the
      // sidecar bounds it structurally).
      const verb = arg.verb as { type?: unknown } | null | undefined
      if (
        typeof verb?.type !== 'string' ||
        !ACCOUNT_VERB_TYPES.includes(verb.type as AccountVerbType)
      ) {
        return
      }
      forward(arg.sessionId, arg.verb as AccountVerbMessage)
    },
  )

  ipcMain.on(
    CH_WORKSPACE_TRUST_VERB,
    (_e, arg: { sessionId: SessionId; verb: unknown }) => {
      if (typeof arg?.sessionId !== 'string') return
      // P4-15 — light UX coercion only; the SIDECAR is the trust boundary and
      // fully re-validates (Zod schema + engine trust persist for its OWN cwd).
      // Drop any frame whose `type` is not the workspace-trust verb fail-closed,
      // rather than forwarding a message guaranteed to be rejected. HC1: no path
      // crosses — the verb carries only a `requestId`.
      const verb = arg.verb as { type?: unknown } | null | undefined
      if (
        typeof verb?.type !== 'string' ||
        !WORKSPACE_TRUST_VERB_TYPES.includes(verb.type as WorkspaceTrustVerbType)
      ) {
        return
      }
      forward(arg.sessionId, arg.verb as WorkspaceTrustMessage)
    },
  )

  ipcMain.on(
    CH_AGENT_MODE_SET,
    (_e, arg: { sessionId: SessionId; active: unknown }) => {
      if (typeof arg?.sessionId !== 'string') return
      // P4-8b — light UX coercion only; the SIDECAR is the trust boundary and
      // fully re-validates (Zod schema + engine `matchSessionMode`). Drop a
      // non-boolean `active` fail-closed rather than forwarding a frame that is
      // guaranteed to be rejected. main mints the `requestId` (a UX correlation
      // field, not a security one; the sidecar bounds it structurally).
      if (typeof arg.active !== 'boolean') return
      forward(arg.sessionId, {
        type: 'agent-mode.set',
        requestId: generateRequestId(),
        active: arg.active,
      })
    },
  )

  ipcMain.on(
    CH_RUN_CONTROL_VERB,
    (_e, arg: { sessionId: SessionId; verb: unknown }) => {
      if (typeof arg?.sessionId !== 'string') return
      // P4-24c — light UX coercion only; the SIDECAR is the trust boundary and
      // fully re-validates (Zod schema + the engine's own setter). Drop any frame
      // whose `type` is not a run-control verb fail-closed, rather than forwarding a
      // message guaranteed to be rejected. The renderer authors the `requestId` for
      // result correlation (a UX field, not a security one; the sidecar bounds it).
      const verb = arg.verb as { type?: unknown } | null | undefined
      if (
        typeof verb?.type !== 'string' ||
        !RUN_CONTROL_VERB_TYPES.includes(verb.type as RunControlVerbType)
      ) {
        return
      }
      forward(arg.sessionId, arg.verb as RunControlVerbMessage)
    },
  )

  ipcMain.on(
    CH_SESSION_ACTION_VERB,
    (_e, arg: { sessionId: SessionId; verb: unknown }) => {
      if (typeof arg?.sessionId !== 'string') return
      // P4-6b — light UX coercion only; the SIDECAR is the trust boundary and fully
      // re-validates (Zod schema + the engine's own op). Drop any frame whose `type`
      // is not a session-action verb fail-closed, rather than forwarding a message
      // guaranteed to be rejected. The renderer authors the `requestId` for result
      // correlation (a UX field, not a security one; the sidecar bounds it).
      const verb = arg.verb as { type?: unknown } | null | undefined
      if (
        typeof verb?.type !== 'string' ||
        !SESSION_ACTION_VERB_TYPES.includes(verb.type as SessionActionVerbType)
      ) {
        return
      }
      forward(arg.sessionId, arg.verb as SessionActionVerbMessage)
    },
  )

  ipcMain.on(
    CH_TASK_CONTROL_VERB,
    (_e, arg: { sessionId: SessionId; verb: unknown }) => {
      if (typeof arg?.sessionId !== 'string') return
      // P4-8b — light UX coercion only; the SIDECAR is the trust boundary and
      // fully re-validates (Zod schema + the engine's own `stopTask` re-resolving
      // the id against the live store). Drop any frame whose `type` is not the
      // task-control verb fail-closed, rather than forwarding a message guaranteed
      // to be rejected. The renderer authors the `requestId` for result correlation
      // (a UX field, not a security one; the sidecar bounds it structurally).
      const verb = arg.verb as { type?: unknown } | null | undefined
      if (
        typeof verb?.type !== 'string' ||
        !TASK_CONTROL_VERB_TYPES.includes(verb.type as TaskControlVerbType)
      ) {
        return
      }
      forward(arg.sessionId, arg.verb as TaskControlVerbMessage)
    },
  )

  ipcMain.on(
    CH_REMOTE_SETTINGS_VERB,
    (_e, arg: { sessionId: SessionId; verb: unknown }) => {
      if (typeof arg?.sessionId !== 'string') return
      // P4-13 — light UX coercion only; the SIDECAR is the trust boundary and
      // fully re-validates (schema + live-state re-derivation). Drop any frame
      // whose `type` is not a RemoteSettings verb fail-closed, rather than
      // forwarding a message guaranteed to be rejected.
      const verb = arg.verb as { type?: unknown } | null | undefined
      if (
        typeof verb?.type !== 'string' ||
        !REMOTE_VERB_TYPES.includes(verb.type as RemoteVerbType)
      ) {
        return
      }
      forward(arg.sessionId, arg.verb as RemoteVerbMessage)
    },
  )

  ipcMain.on(
    CH_SETTINGS_VERB,
    (_e, arg: { sessionId: SessionId; verb: unknown }) => {
      if (typeof arg?.sessionId !== 'string') return
      // P4-19 — light UX coercion only; the SIDECAR is the trust boundary and
      // fully re-validates (Zod schema + EDITABLE_SETTINGS allowlist + per-key
      // value-type check + SettingsUpdater-under-lock write). Drop any frame
      // whose `type` is not a settings verb fail-closed, rather than forwarding a
      // message guaranteed to be rejected.
      const verb = arg.verb as { type?: unknown } | null | undefined
      if (
        typeof verb?.type !== 'string' ||
        !SETTINGS_VERB_TYPES.includes(verb.type as SettingsVerbType)
      ) {
        return
      }
      forward(arg.sessionId, arg.verb as SettingsVerbMessage)
    },
  )

  ipcMain.on(CH_PING, (_e, arg: { sessionId: SessionId; nonce: string }) => {
    if (typeof arg?.sessionId !== 'string' || typeof arg?.nonce !== 'string') return
    forward(arg.sessionId, { type: 'app.ping', nonce: arg.nonce })
  })

  ipcMain.on(CH_RESTART, (_e, arg: { sessionId: SessionId }) => {
    if (typeof arg?.sessionId !== 'string' || !host) return
    // SF5 — route through the host so the registry's advisory fields (pid /
    // socketPath) are refreshed from the fresh child; the host also evicts replay.
    // A typed error is swallowed here (fire-and-forget IPC); the renderer already
    // learns liveness from status events.
    void host.restartSession(arg.sessionId)
  })

  // F2 — the renderer signals it has mounted and subscribed. The gate replays the
  // buffered frames (including the one-shot `ready` handshake) once per document
  // load and returns nothing on a repeat signal (StrictMode double-invoke).
  ipcMain.on(CH_RENDERER_READY, () => {
    deliver(attachmentGate.onRendererReady())
    readinessLatch.rendererReady()
  })

  registerHostControlPlane()
  registerDebugStateHandler()
}

/**
 * HC1 — the picker's single-use directory tokens (`mainDecisions.ts`). One store
 * per app process: a token minted by `pickDirectory` is spent by `createSession`,
 * so the renderer only ever holds an opaque handle to a path the USER chose.
 */
const cwdTokens = createCwdTokenStore()

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
  // renderer may REQUEST it, never answer it. Returns a one-time TOKEN bound to
  // the realpath the user chose (never the path itself), or null (cancelled). The
  // renderer feeds the token to createSession; it can never author a path.
  ipcMain.handle(
    CH_HOST_PICK_DIR,
    async (_event, activeSessionId?: unknown): Promise<string | null> => {
      if (devPickerBypass.enabled) {
        const bypassed = devPickerBypass.pick()
        return bypassed ? cwdTokens.mint(bypassed) : null
      }
      const defaultPath = resolvePickerDefaultPath(
        host?.listSessions() ?? [],
        activeSessionId,
      )
      const parent = mainWindow ?? undefined
      const result = parent
        ? await dialog.showOpenDialog(parent, {
            properties: ['openDirectory', 'createDirectory'],
            ...(defaultPath ? { defaultPath } : {}),
          })
        : await dialog.showOpenDialog({
            properties: ['openDirectory', 'createDirectory'],
            ...(defaultPath ? { defaultPath } : {}),
          })
      if (result.canceled || result.filePaths.length === 0) return null
      const chosen = validateCwd(result.filePaths[0])
      if (!chosen.ok) return null
      return cwdTokens.mint(chosen.realpath)
    },
  )

  ipcMain.handle(
    CH_HOST_CREATE,
    (_e, input: unknown): Promise<HostResult<SessionDescriptor>> => {
      if (!host) return Promise.resolve(noHost<SessionDescriptor>())
      // HC1/T8 — the renderer supplies only a picker TOKEN + a title. Resolve the
      // token to the realpath MAIN minted; an unknown/expired/reused token is an
      // invalid cwd. The renderer can neither author a path nor forge a resume id
      // (resume is only reachable via restoreSession → a registry row).
      const token = readString(input, 'cwdToken')
      const cwd = token ? cwdTokens.consume(token) : undefined
      if (!cwd) {
        return Promise.resolve({
          ok: false,
          error: {
            code: 'invalid_cwd',
            message: 'a valid directory token from pickDirectory() is required',
          },
        })
      }
      const title = readString(input, 'title')
      return host.createSession({ cwd, ...(title !== undefined ? { title } : {}) })
    },
  )

  ipcMain.handle(
    CH_HOST_RESTORE,
    async (_e, appSessionId: unknown): Promise<HostResult<SessionDescriptor>> => {
      if (!host) return Promise.resolve(noHost<SessionDescriptor>())
      // HC2 — the host validates id shape + membership; pass through as unknown.
      const sessionId = String(appSessionId)
      // IS-B/M4 — only a renderer-requested lazy restore enters bootstrap/replay
      // coalescing. Fresh create, restart, and ordinary live traffic keep their
      // existing delivery behavior.
      attachmentGate.startReplayCoalescing(sessionId)
      try {
        const result = await host.restoreSession(sessionId)
        if (!result.ok) {
          cancelReplayFlush(sessionId)
          deliver(attachmentGate.cancelReplayCoalescing(sessionId))
        }
        return result
      } catch (error) {
        cancelReplayFlush(sessionId)
        deliver(attachmentGate.cancelReplayCoalescing(sessionId))
        throw error
      }
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

  ipcMain.handle(
    CH_HOST_SESSIONS_CATALOG,
    (): SessionsCatalogSnapshot | null => {
      // F2 — the cold-launch sessions-catalog baseline. Read-only, id-less: main
      // reads the sidecar-written cache beside its own registry (the SAME dir
      // `defaultRegistryDir()` gives the registry) and validates it fail-closed
      // (size / schema), returning null on a missing / corrupt file. No renderer
      // input, no engine call, no file bytes returned — a parsed display snapshot.
      return readSessionsCatalogCache(defaultRegistryDir())
    },
  )

  ipcMain.handle(
    CH_HOST_PREVIEW,
    (_e, appSessionId: unknown): TranscriptCache | null => {
      // IS-A — read a dead session's transcript cache. The host VALIDATES the id
      // (canPreview: not-live + restorable row) BEFORE any disk touch; a
      // non-restorable / live / unknown id never reads a file (resolvePreview
      // short-circuits without calling readCache). readCache then re-validates the
      // file fail-closed (size / schema / secret re-scan) and returns null on any
      // failure. Never returns file contents for an id the host does not vouch for.
      const h = host
      if (!h) return null
      return resolvePreview(
        {
          canPreview: id => h.canPreview(id),
          readCache: id => readCache(TRANSCRIPT_CACHE_DIR, id),
        },
        String(appSessionId),
      )
    },
  )

  ipcMain.handle(
    CH_HOST_CREATE_IN_WORKSPACE,
    (_e, appSessionId: unknown): Promise<HostResult<SessionDescriptor>> => {
      if (!host) return Promise.resolve(noHost<SessionDescriptor>())
      // #15 — the renderer names an EXISTING registry id (a representative session
      // in the target workspace); it authors NO cwd and NO resume id. The host
      // re-derives + re-validates the row's cwd from its own registry (HC1/T8),
      // exactly as restoreSession sources a cwd, and spawns a FRESH session there.
      // A fresh create takes no replay-coalescing (no transcript to replay).
      return host.createSessionInWorkspace(String(appSessionId))
    },
  )

  // SESSIONS-UNIFICATION: coalesce concurrent open-history spawns of the SAME
  // transcript. The resolver's dedup catches a registry row that ALREADY has its
  // `engineSessionId` (filled only on the ready frame). During the pre-ready spawn
  // window (~1–3s for a resume) that row's engineSessionId is still null, so a
  // rapid second activation would miss dedup and spawn a SECOND sidecar onto the
  // same JSONL. This map makes a second open of an in-flight id return the SAME
  // promise (→ the same session), never a duplicate; cleared on completion. (A
  // much narrower residual — a click in the sub-ms gap between createSession
  // resolving and the ready frame filling the id — collapses to the already-
  // accepted unguarded-concurrent-resume decision; SESSIONS-UNIFICATION.md.)
  const openHistoryInFlight = new Map<
    string,
    Promise<HostResult<SessionDescriptor>>
  >()
  ipcMain.handle(
    CH_HOST_OPEN_HISTORY,
    (_e, engineSessionId: unknown): Promise<HostResult<SessionDescriptor>> => {
      if (!host) return Promise.resolve(noHost<SessionDescriptor>())
      // SESSIONS-UNIFICATION (operator ruling 2026-07-20) — open a terminal-
      // created session (a transcript with no desktop registry row) as a real
      // desktop session. HC1: the renderer supplies ONLY an ENGINE session id; it
      // authors no cwd. Validation + dedup + cwd resolution are the pure resolver's
      // job — the cwd comes from the sidecar-written baseline cache (engine-derived
      // data, `defaultRegistryDir()`), never from the renderer, and a missing /
      // empty-cwd id fails closed with a typed error (resolveOpenHistorySession).
      const resolution = resolveOpenHistorySession(
        engineSessionId,
        host.listSessions(),
        readSessionsCatalogCache(defaultRegistryDir()),
      )
      if (resolution.kind === 'reject') {
        return Promise.resolve({ ok: false, error: resolution.error })
      }
      if (resolution.kind === 'existing') {
        // Already a ready app row — the renderer switches/restores it; no spawn.
        return Promise.resolve({ ok: true, value: resolution.descriptor })
      }
      const engineId = resolution.resumeEngineSessionId
      const inflight = openHistoryInFlight.get(engineId)
      if (inflight) return inflight
      // Spawn a resume through the SAME machinery restore uses: createSession with
      // a MAIN-resolved cwd + resumeEngineSessionId → supervisor sets
      // CATCODE_SIDECAR_RESUME_SESSION_ID → sessionResume.ts (the engine's real
      // resume path). The workspace-trust gate still fail-closes the first turn at
      // that cwd (sidecarServer.ts:987); concurrent-resume of a terminal-live
      // transcript is unguarded here exactly as the engine's own /resume is
      // (SESSIONS-UNIFICATION.md, engine-precedent flag).
      const promise = host
        .createSession({
          cwd: resolution.cwd,
          resumeEngineSessionId: engineId,
          // Title is main-resolved from the sidecar-written catalog cache
          // (engine-derived, HC1-safe — never renderer-authored), so a resumed
          // open-from-history session's tab/sidebar shows its real name instead
          // of the cwd basename (bug-sweep #2, 2026-07-21).
          ...(resolution.title !== undefined ? { title: resolution.title } : {}),
        })
        .then(result => {
          // Bootstrap coalescing, the same guard `CH_HOST_RESTORE` arms: this
          // create RESUMES a transcript, so `ready` (sent first) must not reach
          // the renderer ahead of the history replay (sent last). Delivered
          // alone, `ready.payload.inputEnabled` trips the preview→live swap
          // (`previewTranscriptState.ts:146`), which resets the live transcript
          // and drops the cached preview — blanking a pane that was showing the
          // conversation until the replay lands (operator-observed 2026-07-20).
          // The ruling at CH_HOST_RESTORE ("only a renderer-requested lazy
          // restore") predates open-from-history, when a create could never
          // resume; a resuming create belongs on the restore side of it.
          //
          // Armed here rather than before the spawn because the app session id
          // does not exist until `createSession` mints it. The race that would
          // defeat it is a sidecar attaching before this microtask runs — it
          // must first cold-start Bun, build the engine session and load the
          // transcript, so it cannot; failing it would merely reproduce the
          // pre-fix behavior, never something worse. No flush is scheduled here:
          // the supervisor frame path already arms the timer on the first held
          // frame, so a resume that replays nothing still goes live.
          if (result.ok) {
            attachmentGate.startReplayCoalescing(result.value.appSessionId)
          }
          return result
        })
        .finally(() => {
          openHistoryInFlight.delete(engineId)
        })
      openHistoryInFlight.set(engineId, promise)
      return promise
    },
  )
}

function registerDebugStateHandler(): void {
  if (!IS_DEV || !devHarnessConfig.debugState) return
  ipcMain.on(DEBUG_SHELL_STATE_CHANNEL, (_event, snapshot: unknown) => {
    const parsed = parseDebugSnapshot(snapshot)
    if (!parsed.ok) {
      process.stderr.write(`[main] dropped invalid debug snapshot: ${parsed.error}\n`)
      return
    }
    latestRendererSnapshot = parsed.value
    scheduleDebugStateExport.schedule()
  })
}

function writeDebugStateExport(): void {
  if (!IS_DEV || !devHarnessConfig.debugState) return
  try {
    const rows = registryForDebug?.sessions ?? []
    const byId = new Map(rows.map(row => [row.appSessionId, row]))
    const sessions = (host?.listSessions() ?? []).map(session => {
      const row = byId.get(session.appSessionId)
      return {
        ...session,
        ...(typeof row?.enginePid === 'number' ? { enginePid: row.enginePid } : {}),
        ...(typeof row?.socketPath === 'string' ? { socketPath: row.socketPath } : {}),
        ...(row ? { shutdown: row.shutdown } : {}),
      }
    })
    const file: DebugStateFile = {
      debugStateVersion: DEBUG_STATE_VERSION,
      writtenAt: Date.now(),
      rendererStateAt: latestRendererSnapshot?.rendererStateAt ?? null,
      sessions,
      renderer: latestRendererSnapshot?.renderer ?? null,
    }
    atomicWriteJson0600(join(defaultRegistryDir(), 'debug', 'state.json'), file)
  } catch (error) {
    process.stderr.write(`[main] debug-state write failed: ${errText(error)}\n`)
  }
}

/** Read a string field off an unknown IPC payload, or undefined. */
function readString(payload: unknown, key: string): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
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
  registryForDebug = registry

  // B4 — kick off the launch sequence (read → sweep orphans → reap) and hand the
  // promise to the host as its readiness GATE. Every host op awaits this before
  // touching the registry, so a renderer create that races startup can never
  // interleave its write with the launch's read-modify-write (REGISTRY §4).
  const launched = registry.launch().catch(error => {
    process.stderr.write(`[main] registry launch failed: ${errText(error)}\n`)
  })
  registryLaunchSettled = launched

  host = new Host({
    supervisor,
    registry,
    validateCwd,
    launched,
    // The P3-0 carry: a closed/restarted session's replay buffer must be evicted
    // so a reload never replays a dead session's frames. IS-A: persist the
    // transcript cache FIRST (snapshot → persist → evict). This fires on
    // close/restart AND — synchronously — on the quit path (host.shutdownAll),
    // so the persist here uses a synchronous atomic write. Restart persisting a
    // cache is acceptable (a bounded extra sync write).
    evictReplay: appSessionId => {
      persistTranscriptCache(appSessionId)
      cancelReplayFlush(appSessionId)
      attachmentGate.clearSession(appSessionId)
    },
  })
  wireHostEvents(host)

  // IS-A startup GC: after the launch sweep settles (its reaps predate the
  // HostEvent subscription, so they emit no session-removed), drop any orphaned
  // cache file whose row is no longer restorable.
  void launched.then(() => gcTranscriptCache())

  // The primary startup session: main's OWN process.cwd() (trusted main input,
  // not a renderer string). host.createSession awaits `launched` internally, so
  // this runs strictly after the sweep.
  const primaryCwd = devHarnessConfig.initialCwd ?? process.cwd()
  if (devHarnessConfig.initialCwdInvalid) {
    process.stderr.write('[main] primary session skipped: invalid CATCODE_INITIAL_CWD\n')
  } else {
    void host
      .createSession({ cwd: primaryCwd })
      .then(result => {
        if (!result.ok) {
          process.stderr.write(
            `[main] primary session create failed: ${result.error.code} ${result.error.message}\n`,
          )
        }
        scheduleDebugStateExport.schedule()
      })
      .catch(error => {
        process.stderr.write(`[main] primary session create threw: ${errText(error)}\n`)
      })
  }

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
    // BrowserWindow's `icon` option doesn't reach the Dock tile (SECURITY-MINIMUM
    // is silent on this — it's cosmetic, not a trust boundary); the Dock image
    // comes from the running bundle's own Info.plist/icns unless overridden here.
    if (process.platform === 'darwin') {
      app.dock?.setIcon(nativeImage.createFromPath(APP_ICON_PATH))
    }
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
  // rebuilds a fresh host on reopen (F5). B3 — go through host.shutdownAll so
  // live rows are marked CLEAN before the kill; a clean quit must not resurface
  // as crash recovery on the next launch. Fall back to a bare supervisor
  // shutdown if the host never came up.
  if (host) {
    host.shutdownAll()
  } else {
    supervisor?.shutdown()
  }
  transcriptBackfillAbort?.abort()
  transcriptBackfillAbort = null
  // Catalog owner (decision #4): stop the refresh driver with the window; a fresh
  // `activate` re-arms it after the next paint. `stop()` cancels only the NEXT
  // run, so abort beside it to kill a worker already in flight.
  sessionsCatalogDriver?.stop()
  sessionsCatalogDriver = null
  sessionsCatalogAbort?.abort()
  sessionsCatalogAbort = null
  // Accounts owner: same window-scoped lifetime as the catalog driver.
  accountsPoolDriver?.stop()
  accountsPoolDriver = null
  accountsPoolAbort?.abort()
  accountsPoolAbort = null
  // IDLE-PARK: stop the policy driver with the window (it holds the now-dead host/
  // supervisor); a fresh `activate` re-arms it against the rebuilt host.
  idleParkDriver?.stop()
  idleParkDriver = null
  supervisor = null
  // Drop the host too so `ensureHost` rebuilds supervisor + registry + host as a
  // unit on the next `activate` (a fresh registry re-reads the file and re-runs
  // its launch sweep — the dock-reopen session goes through createSession again).
  host = null
  registryForDebug = null
  scheduleDebugStateExport.cancel()
  // F2 — drop the old session's buffered frames so a macOS reopen (which spawns a
  // NEW session id via `ensureHost`) never replays dead-session frames into the
  // fresh window.
  attachmentGate.reset()
  cancelAllReplayFlushes()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  // B3 — same clean-marking on ⌘Q; idempotent if window-all-closed already ran
  // (no live rows left to mark).
  if (host) {
    host.shutdownAll()
  } else {
    supervisor?.shutdown()
  }
  transcriptBackfillAbort?.abort()
  transcriptBackfillAbort = null
  sessionsCatalogDriver?.stop()
  sessionsCatalogDriver = null
  sessionsCatalogAbort?.abort()
  sessionsCatalogAbort = null
  accountsPoolDriver?.stop()
  accountsPoolDriver = null
  accountsPoolAbort?.abort()
  accountsPoolAbort = null
  idleParkDriver?.stop()
  idleParkDriver = null
})
