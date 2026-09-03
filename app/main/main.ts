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
  nativeTheme,
  screen,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { writeFile } from 'node:fs/promises'

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
import {
  MAX_ATTACHMENT_SOURCE_IMAGE_BYTES,
  type AttachmentFileSelection,
  type HostEvent,
  type HostResult,
  type SaveTextResult,
  type SessionDescriptor,
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
  appendAttachmentFileMention,
  createAttachmentFileTokenStore,
  createCwdTokenStore,
  detectAttachmentImageMediaType,
  createRendererHealthFlightRecorder,
  createRendererHealthMonitor,
  createRendererRecoveryPolicy,
  createStartupTimers,
  createWindowVisibilityTracker,
  isTerminalLifecycleFrame,
  parseVisibleSessions,
  RENDERER_RECOVERY_MAX_ATTEMPTS,
  selectRendererWorkingSetKiB,
  type RendererDeathReason,
  type WindowVisibilityReason,
  resolveSidecarLaunch,
  type SidecarLaunchPlan,
  runDetachedCliFallbackSpawn,
  selectTranscriptBackfillCandidates,
  frameMutatedAccountsPool,
  stampHistoryViewAnchor,
  supervisorEventToServerFrame,
  validateSaveTextRequest,
} from './mainDecisions.js'
import {
  createPeerRequestPlane,
  type PeerRequestPlane,
} from './peerRequestPlane.js'
import { readGlassPreference, writeGlassPreference } from './glassPreference.js'
import {
  clampWindowBounds,
  readWindowBounds,
  writeWindowBounds,
} from './windowBounds.js'
import {
  buildClosedSessionCache,
  deleteCache,
  cacheHasCurrentRunFacts,
  cacheWrittenAt,
  listCachedSessionIds,
  readCache,
  readCachedRunFacts,
  resolvePreview,
  transcriptCacheDir,
  writeCache,
} from './transcriptCache.js'
import { readTranscriptRunFacts } from '../shared/transcriptRunFacts.js'
import { readSessionsCatalogCache } from './sessionsCatalogBaseline.js'
import {
  resolveOpenHistorySession,
  type TrustedOpenHistorySeed,
} from './openHistorySession.js'
import { openWorkspaceFile, type OpenWorkspaceFileTarget } from './openWorkspaceFile.js'
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
  ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
  parseAccountDeleteMessage,
  type AccountsPoolWorkerDeleteResult,
} from '../shared/accountsPoolWorker.js'
import {
  createAccountsPoolPublicationGate,
  createAccountsPoolDriver,
  runAccountsPoolWorker,
  runCarriesUsageStats,
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
import { MAX_SUGGESTION_SELECTIONS, MAX_TEXT_FIELD_CHARS } from '../shared/limits.js'
import { createOperationalLogSink } from './operationalLogSink.js'
import { createOperationalRecord } from '../shared/operationalLog.js'
import { createDeliveryTraceSink, deliveryMessageKindOfFrame } from './deliveryTraceSink.js'
import { buildDiagnosticsBundle } from './diagnosticsBundle.js'
import { mintDeliveryTrace, replayDeliveryTrace, type DeliveryAcknowledgement, type DeliveryStage } from '../shared/deliveryTrace.js'
import {
  ACCOUNT_VERB_TYPES,
  PERMISSION_SET_MODE_MODES,
  PROMPT_FORCE_VERB_TYPES,
  PROMPT_RECALL_VERB_TYPES,
  PROTOCOL_VERSION,
  REMOTE_VERB_TYPES,
  RUN_CONTROL_VERB_TYPES,
  SESSION_ACTION_VERB_TYPES,
  CONTEXT_BREAKDOWN_VERB_TYPES,
  HISTORY_LOAD_EARLIER_VERB_TYPES,
  SETTINGS_VERB_TYPES,
  TASK_CONTROL_VERB_TYPES,
  WORKSPACE_TRUST_VERB_TYPES,
  type AccountVerbMessage,
  type AccountResultFrame,
  type AccountVerbType,
  type AskUserQuestionAnswerMessage,
  type PermissionSetModeMode,
  type RemoteVerbMessage,
  type RemoteVerbType,
  type PromptForceMessage,
  type PromptForceVerbType,
  type PromptRecallMessage,
  type PromptRecallVerbType,
  type RunControlVerbMessage,
  type RunControlVerbType,
  type ServerFrame,
  type SessionActionVerbMessage,
  type SessionActionVerbType,
  type ContextBreakdownVerbType,
  type ContextBreakdownVerbMessage,
  type HistoryLoadEarlierVerbType,
  type HistoryLoadEarlierMessage,
  type ErrorFrame,
  type SessionId,
  type SubmitPrompt,
  type SessionsCatalogSnapshot,
  type SettingsVerbMessage,
  type SettingsVerbType,
  type TaskControlVerbMessage,
  type TaskControlVerbType,
  type SidecarClientMessage,
  type StatsQueryMessage,
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
const CH_PROMPT_FORCE = 'catcode:prompt-force'
const CH_PROMPT_RECALL = 'catcode:prompt-recall'
const CH_CONTEXT_BREAKDOWN_VERB = 'catcode:context-breakdown-verb'
const CH_HISTORY_LOAD_EARLIER = 'catcode:history-load-earlier'
const CH_SESSION_ACTION_VERB = 'catcode:session-action-verb'
const CH_REMOTE_SETTINGS_VERB = 'catcode:remote-settings-verb'
const CH_SETTINGS_VERB = 'catcode:settings-verb'
const CH_STATS_QUERY = 'catcode:stats-query'
const CH_PING = 'catcode:ping'
const CH_RESTART = 'catcode:restart'
const CH_SERVER_FRAME = 'catcode:server-frame'
const CH_RENDERER_READY = 'catcode:renderer-ready'
const CH_DELIVERY_ACK = 'catcode:delivery-ack'
const CH_RENDERER_FAULT = 'catcode:renderer-fault'
const CH_SET_APPEARANCE = 'catcode:set-appearance'
const CH_SET_GLASS_MODE = 'catcode:set-glass-mode'

/**
 * The macOS material `createWindow` mounts, and the ONLY place it is ever set.
 * Nothing re-asserts it at runtime, and the doc block beside the appearance
 * channel records why that listener was removed rather than kept.
 */
const WINDOW_VIBRANCY = 'under-window' as const
const CH_OPEN_LOGS = 'catcode:open-logs'
const CH_SAVE_DIAGNOSTICS = 'catcode:save-diagnostics'
const CH_DELIVERY_HEALTH_PROBE = 'catcode:delivery-health-probe'
const CH_DELIVERY_HEALTH_RESPONSE = 'catcode:delivery-health-response'
const CH_REFRESH_ACCOUNTS_POOL = 'catcode:refresh-accounts-pool'

// App session ids are supervisor-minted UUIDs. Validate at the single frame
// forwarding choke point so malformed renderer payloads cannot mint an
// unbounded set of error/replay-buffer keys in main.
const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const BRANCH_OPEN_SEED_TTL_MS = 5 * 60 * 1000
const MAX_BRANCH_OPEN_SEEDS = 64
const branchOpenSeeds = new Map<
  string,
  TrustedOpenHistorySeed & { expiresAt: number }
>()

function pruneBranchOpenSeeds(now = Date.now()): void {
  for (const [engineSessionId, seed] of branchOpenSeeds) {
    if (seed.expiresAt <= now) branchOpenSeeds.delete(engineSessionId)
  }
  while (branchOpenSeeds.size > MAX_BRANCH_OPEN_SEEDS) {
    const oldest = branchOpenSeeds.keys().next().value
    if (oldest === undefined) break
    branchOpenSeeds.delete(oldest)
  }
}

function rememberBranchOpenSeed(
  appSessionId: SessionId,
  frame: Extract<ServerFrame, { kind: 'session-action.result' }>,
): void {
  if (
    !frame.ok ||
    frame.verb !== 'branchFromMessage' ||
    typeof frame.branchEngineSessionId !== 'string' ||
    !SESSION_ID_RE.test(frame.branchEngineSessionId)
  ) {
    return
  }
  const source = host
    ?.listSessions()
    .find(descriptor => descriptor.appSessionId === appSessionId)
  if (!source || source.cwd.trim().length === 0) return
  const now = Date.now()
  branchOpenSeeds.delete(frame.branchEngineSessionId)
  branchOpenSeeds.set(frame.branchEngineSessionId, {
    engineSessionId: frame.branchEngineSessionId,
    cwd: source.cwd,
    forked: true,
    ...(typeof frame.branchTitle === 'string' &&
    frame.branchTitle.trim().length > 0
      ? { title: frame.branchTitle }
      : {}),
    expiresAt: now + BRANCH_OPEN_SEED_TTL_MS,
  })
  pruneBranchOpenSeeds(now)
}

function branchOpenSeed(engineSessionId: unknown): TrustedOpenHistorySeed | undefined {
  pruneBranchOpenSeeds()
  if (typeof engineSessionId !== 'string') return undefined
  return branchOpenSeeds.get(engineSessionId)
}

// Control-plane channels (HC3 — fixed, per-method structured senders). `invoke`
// channels return a typed HostResult; `pick-directory` returns a realpath or
// null (the native picker, HC1); the host-event channel is a one-way stream.
const CH_HOST_CREATE = 'catcode:host:create'
const CH_HOST_CREATE_IN_WORKSPACE = 'catcode:host:create-in-workspace'
const CH_HOST_RESTORE = 'catcode:host:restore'
const CH_HOST_CLOSE = 'catcode:host:close'
const CH_HOST_LIST = 'catcode:host:list'
const CH_HOST_PICK_DIR = 'catcode:host:pick-directory'
const CH_HOST_PICK_ATTACHMENT_FILE = 'catcode:host:pick-attachment-file'
const CH_HOST_PREVIEW = 'catcode:host:preview'
const CH_HOST_SESSIONS_CATALOG = 'catcode:host:sessions-catalog'
const CH_HOST_OPEN_HISTORY = 'catcode:host:open-history'
// P4-35 — the file sink. Mirrors `pick-directory`: the renderer REQUESTS a native
// dialog it cannot answer, and main owns the destination (HC1).
const CH_HOST_SAVE_TEXT = 'catcode:host:save-text'
const CH_HOST_OPEN_WORKSPACE_FILE = 'catcode:host:open-workspace-file'
const CH_HOST_ACCOUNT_DELETE = 'catcode:host:account-delete'
const CH_HOST_EVENT = 'catcode:host:event'
const CH_HOST_VISIBLE_SESSIONS = 'catcode:host:visible-sessions'

const APP_ORIGIN_DEV = process.env.CATCODE_RENDERER_URL ?? 'http://localhost:5173'
const IS_DEV = !app.isPackaged
if (IS_DEV) app.setName('Cat Code Dev')
const APP_ICON_PATH = join(__dirname, '..', 'resources', 'icon.png')
const VITE_REACT_PREAMBLE_CSP_HASH =
  "'sha256-Z2/iFzh9VMlVkEOar1f/oSHWwQk3ve1qk/C2WdsC4Xk='"

// Main is the persistence owner. Other desktop planes may retain their useful
// development stderr, but only this bounded, redacted record stream is durable.
const operationalLog = createOperationalLogSink({ configDir: defaultRegistryDir() })
process.env.CATCODE_OPERATIONAL_LAUNCH_ID = operationalLog.launchId
if (IS_DEV) {
  process.stderr.write(`[main] desktop diagnostics: ${operationalLog.getDirectory()}\n`)
}
const deliveryTrace = createDeliveryTraceSink({
  configDir: defaultRegistryDir(),
  launchId: operationalLog.launchId,
})
const deliverySequences = new Map<SessionId, number>()
let rendererDocumentId: string = randomUUID()
let rendererSubscriptionEpoch = 0
const rendererHealth = createRendererHealthMonitor()
const rendererHealthFlightRecorder = createRendererHealthFlightRecorder()
let rendererHealthTimer: ReturnType<typeof setInterval> | null = null
// Last visibility a renderer response reported. A missed probe carries no
// payload of its own, so this is the only way an outage record can say whether
// the window was hidden (throttled timers) when it went quiet.
let lastKnownRendererVisible: boolean | null = null
// True from `render-process-gone` until the next document finishes loading.
// `webContents.isDestroyed()` stays false for a crashed-but-open window, so any
// send in that state throws "Render frame was disposed" (observed 2026-08-09:
// the health probe threw every 5 seconds against a dead renderer). Every
// renderer send checks this flag alongside `isDestroyed`.
let rendererGone = false
let rendererRecovering = false
const rendererRecovery = createRendererRecoveryPolicy()
let rendererRecoveryDialogShown = false
let rendererFaultWindowStartedAt = Date.now()
let rendererFaultCount = 0

function logOperational(
  event: Parameters<typeof operationalLog.write>[0]['event'],
  level: Parameters<typeof operationalLog.write>[0]['level'],
  fields: Record<string, string | number | boolean | null> = {},
  appSessionId?: string,
): void {
  operationalLog.write({
    event,
    level,
    process: 'main',
    ...(appSessionId ? { appSessionId } : {}),
    fields,
  })
}

/**
 * Write the buffered health readings the 30s sampling dedup would have dropped.
 * Called only where the renderer has already failed, so the ring costs bytes in
 * anomaly neighbourhoods and nowhere else.
 */
function flushRendererHealthFlightRecorder(reason: string): void {
  const ring = rendererHealthFlightRecorder.flush()
  if (!ring) return
  logOperational('renderer.health.flight_recorder', 'error', {
    reason,
    count: ring.count,
    samples: ring.samples,
  })
}

/** Each disposable engine-graph worker gets a distinct process timeline. */
function createWorkerLifecycleLogger(role: string): (event: {
  phase: 'started' | 'exited'
  pid: number
  code?: number | null
  signal?: NodeJS.Signals | null
}) => void {
  const processInstanceId = randomUUID()
  const processStartedAt = new Date().toISOString()
  return event => {
    try {
      operationalLog.writeRecord(createOperationalRecord(
        event.phase === 'started'
          ? { level: 'info', event: 'process.started', process: 'worker', fields: { role, pid: event.pid } }
          : {
              level: event.code === 0 ? 'info' : 'error',
              event: 'process.exited',
              process: 'worker',
              fields: {
                role,
                ...(event.code === null || event.code === undefined ? {} : { exitCode: event.code }),
                ...(event.signal === null || event.signal === undefined ? {} : { signal: event.signal }),
                expected: event.code === 0,
              },
            },
        {
          launchId: operationalLog.launchId,
          processInstanceId,
          pid: event.pid,
          processStartedAt,
        },
      ))
    } catch {
      // Worker bookkeeping is best effort and cannot affect its run.
    }
  }
}

/**
 * Transitional tee for injected legacy string callbacks. Legacy text remains
 * on stderr for a developer at the console, but only an opaque classification
 * enters the persistent support log: upstream strings can include engine
 * output, paths, and other content that an operational stream must never own.
 */
function logLegacyDiagnostic(
  line: string,
  source: string,
  processRole: 'main' | 'host' | 'supervisor' = 'main',
): void {
  process.stderr.write(`${line}\n`)
  operationalLog.write({
    event: 'diagnostic',
    level: /fail|error|invalid|dropped/i.test(line) ? 'warn' : 'info',
    process: processRole,
    fields: {
      source,
      category: /fail|error|invalid|dropped/i.test(line) ? 'legacy_failure' : 'legacy_notice',
    },
  })
}

function traceFrame(frame: ServerFrame, stage: DeliveryStage): ServerFrame {
  const created = !frame.deliveryTrace
  const trace = stage === 'attachment.replayed' && frame.deliveryTrace
    ? replayDeliveryTrace(frame.deliveryTrace)
    : frame.deliveryTrace ?? mintDeliveryTrace((deliverySequences.get(frame.sessionId) ?? 0) + 1)
  if (created) deliverySequences.set(frame.sessionId, trace.sequence)
  // Sidecar stages arrive independently on FD 3 at their actual process-clock
  // boundaries.  Do not infer or backfill them here after a socket receipt.
  if (stage === 'supervisor.socket.received') {
    if (created) {
      logOperational('diagnostic', 'warn', { source: 'deliveryTrace', reason: 'missing_source_envelope' }, frame.sessionId)
    }
  }
  deliveryTrace.mark({
    sessionId: frame.sessionId,
    trace,
    stage,
    frameKind: frame.kind,
    messageKind: deliveryMessageKindOfFrame(frame),
    documentId: rendererDocumentId,
    subscriptionEpoch: rendererSubscriptionEpoch,
  })
  return frame.deliveryTrace === trace ? frame : { ...frame, deliveryTrace: trace }
}

function parseDeliveryAcknowledgements(value: unknown): DeliveryAcknowledgement[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const batch = value as Record<string, unknown>
  if (Object.keys(batch).length !== 1 || !Array.isArray(batch.acknowledgements) || batch.acknowledgements.length < 1 || batch.acknowledgements.length > 64) return null
  const acknowledgements: DeliveryAcknowledgement[] = []
  for (const item of batch.acknowledgements) {
    const parsed = parseDeliveryAcknowledgement(item)
    if (!parsed) return null
    acknowledgements.push(parsed)
  }
  return acknowledgements
}

function parseDeliveryAcknowledgement(value: unknown): DeliveryAcknowledgement | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  if (
    Object.keys(item).length !== 10 ||
    typeof item.sessionId !== 'string' ||
    typeof item.streamEpoch !== 'string' || item.streamEpoch.length < 1 || item.streamEpoch.length > 128 ||
    typeof item.sequence !== 'number' ||
    !Number.isSafeInteger(item.sequence) ||
    item.sequence < 1 ||
    typeof item.deliveryAttempt !== 'number' ||
    !Number.isSafeInteger(item.deliveryAttempt) ||
    item.deliveryAttempt < 1 ||
    typeof item.traceId !== 'string' || item.traceId.length < 1 || item.traceId.length > 128 ||
    !['preload.received', 'renderer.subscription.received', 'renderer.state.queued', 'renderer.state.applied', 'renderer.ui.committed'].includes(item.stage as string) ||
    typeof item.documentId !== 'string' ||
    typeof item.subscriptionEpoch !== 'number' ||
    !Number.isSafeInteger(item.subscriptionEpoch) ||
    item.subscriptionEpoch < 1 ||
    typeof item.rendererProcessInstanceId !== 'string' ||
    item.rendererProcessInstanceId.length < 1 ||
    item.rendererProcessInstanceId.length > 128 ||
    typeof item.rendererProcessStartedAt !== 'string' ||
    Number.isNaN(Date.parse(item.rendererProcessStartedAt))
  ) return null
  return item as DeliveryAcknowledgement
}

type RendererHealthResponse = Readonly<{
  documentId: string
  subscriptionEpoch: number
  rendererProcessInstanceId: string
  monotonicTimestampMs: number
  eventLoopLagMs: number
  visible: boolean
  jsHeapUsedBytes: number | null
  rendersCommitted: number
  watermarks: ReadonlyArray<Readonly<{ sessionId: string; received: number; applied: number; committed: number }>>
}>

function parseRendererHealthResponse(value: unknown): RendererHealthResponse | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  if (
    Object.keys(item).length !== 9 ||
    typeof item.documentId !== 'string' || item.documentId.length < 1 || item.documentId.length > 128 ||
    !Number.isSafeInteger(item.subscriptionEpoch) || (item.subscriptionEpoch as number) < 1 ||
    typeof item.rendererProcessInstanceId !== 'string' || item.rendererProcessInstanceId.length < 1 || item.rendererProcessInstanceId.length > 128 ||
    typeof item.monotonicTimestampMs !== 'number' || !Number.isFinite(item.monotonicTimestampMs) ||
    typeof item.eventLoopLagMs !== 'number' || !Number.isFinite(item.eventLoopLagMs) || item.eventLoopLagMs < 0 || item.eventLoopLagMs > 60_000 ||
    typeof item.visible !== 'boolean' ||
    (item.jsHeapUsedBytes !== null && (
      typeof item.jsHeapUsedBytes !== 'number' ||
      !Number.isFinite(item.jsHeapUsedBytes) ||
      item.jsHeapUsedBytes < 0 ||
      item.jsHeapUsedBytes > Number.MAX_SAFE_INTEGER
    )) ||
    (typeof item.rendersCommitted !== 'number' ||
      !Number.isSafeInteger(item.rendersCommitted) ||
      item.rendersCommitted < 0 ||
      item.rendersCommitted > Number.MAX_SAFE_INTEGER) ||
    !Array.isArray(item.watermarks) || item.watermarks.length > 32
  ) return null
  for (const watermark of item.watermarks) {
    if (!watermark || typeof watermark !== 'object' || Array.isArray(watermark)) return null
    const entry = watermark as Record<string, unknown>
    if (
      Object.keys(entry).length !== 4 || typeof entry.sessionId !== 'string' || entry.sessionId.length < 1 || entry.sessionId.length > 128 ||
      !Number.isSafeInteger(entry.received) || (entry.received as number) < 0 ||
      !Number.isSafeInteger(entry.applied) || (entry.applied as number) < 0 ||
      !Number.isSafeInteger(entry.committed) || (entry.committed as number) < 0
    ) return null
  }
  return item as RendererHealthResponse
}

logOperational('app.start', 'info', {
  packaged: app.isPackaged,
  platform: process.platform,
  arch: process.arch,
})
logOperational('process.started', 'info', { role: 'electron-main', pid: process.pid })

// The supervisor is N-ready (a map). The host composes it with the durable
// registry into the typed control plane (P3-3); main is a CALLER of that host.
let supervisor: SidecarSupervisor | null = null
let host: Host | null = null
let mainWindow: BrowserWindow | null = null
let registryForDebug: SessionRegistry | null = null
/**
 * HOST-REQUEST-PLANE — the consumer of `host.request` (`peerRequestPlane.ts`).
 * Rebuilt with the host, because every store it holds is per-runtime and dies
 * with the window like the rest of the session state (SESSION-LIFETIME L1).
 */
let peerPlane: PeerRequestPlane | null = null
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
const restoringSessions = new Set<SessionId>()

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
 * The post-paint driver-arming window (`ready-to-show`), cancellable so teardown
 * can drop an arm that has not fired yet. Mechanism + rationale live in
 * `mainDecisions.ts`, where they are testable without Electron. Declared after
 * the delay it reads: this initializer runs at module evaluation.
 */
const startupTimers = createStartupTimers({
  delayMs: TRANSCRIPT_BACKFILL_START_DELAY_MS,
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: handle => clearTimeout(handle),
})

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
let accountDeleteInFlight = false
let accountDeleteAbort: AbortController | null = null
const accountsPoolPublicationGate = createAccountsPoolPublicationGate()
const pendingAccountDeletionNotices = new Map<
  SessionId,
  Map<string, string>
>()

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
 * IDLE-PARK §4(b) — the sessions the renderer currently shows in a workspace
 * pane, as last reported over `CH_HOST_VISIBLE_SESSIONS`. The park driver reads
 * this to keep an on-screen session off its victim list.
 *
 * Latest-wins and never accumulates: each report REPLACES the set, so a closed
 * pane stops being protected on the very next report rather than lingering. Ids
 * are shape-validated on arrival and matched against the live set only at
 * selection time, so a stale id protects nothing.
 */
let visibleSessions: ReadonlySet<SessionId> = new Set()

/**
 * Where a session's engine transcript lives, or null when the row is gone.
 *
 * The cwd is the row's, never a renderer string, and the row survives every
 * eviction point (close/restart/quit all KEEP the row restorable; only a reap
 * removes it, and that deletes the cache anyway). A missing row means there is
 * nothing to enrich from, not that a path should be guessed.
 */
function sessionTranscriptPath(
  appSessionId: SessionId,
  engineSessionId: string,
): string | null {
  const row = host
    ?.listSessions()
    .find(session => session.appSessionId === appSessionId)
  if (!row) return null
  // The row's id must be the one the frames carry. Pairing this row's `cwd`
  // with a DIFFERENT engine session's id would read a neighbouring transcript
  // and attribute its facts here — the row is re-keyed on restart, so the two
  // can genuinely disagree.
  if (row.engineSessionId !== engineSessionId) return null
  return defaultTranscriptPath(row.cwd, engineSessionId)
}

/**
 * Persist one session's transcript cache (IS-A). Called at every eviction point
 * in **snapshot → atomic persist → evict** order (the caller evicts AFTER this):
 * snapshot the session's buffered frames, distill to the transcript-only cache,
 * enrich the header from the session's own transcript, and atomically write it.
 * Skips a session with no buffered frames or no engineSessionId (never
 * restorable, so a cache would never be served). Wrapped fail-safe: a persist
 * error degrades to the no-cache path, never breaks eviction or the synchronous
 * quit.
 *
 * The enrichment is what makes a cache written AFTER the once-per-process
 * startup backfill complete anyway. Without it, every session closed during a
 * run reverted to a headerless cache whose effort could not be recovered from
 * frames at all, and stayed that way until a later launch re-backfilled it.
 * `buildClosedSessionCache` owns the decision (and refuses to write a header
 * that would be thinner than what the frames already say).
 */
function persistTranscriptCache(appSessionId: SessionId): void {
  try {
    const frames = attachmentGate.snapshotSession(appSessionId)
    if (frames.length === 0) return
    const cache = buildClosedSessionCache(
      {
        transcriptPath: engineSessionId =>
          sessionTranscriptPath(appSessionId, engineSessionId),
        // No resolver: main is engine-free, so a window here is only ever one
        // the engine itself recorded in `run_facts`.
        readRunFacts: path => readTranscriptRunFacts(path, () => null),
        readCachedRunFacts: (id, engineSessionId) =>
          readCachedRunFacts(TRANSCRIPT_CACHE_DIR, id, engineSessionId),
      },
      frames,
    )
    if (cache === null) return
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
  if (!h) {
    // The last window closed while this awaited registry launch, before the
    // abort controller below existed for `stopBackgroundDrivers()` to abort,
    // and `window-all-closed` nulled `host`. Reset the latch so the next
    // activate's window paint can retry, matching the abort-branch reset below.
    transcriptBackfillStarted = false
    return
  }

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
  const onWorkerLifecycle = createWorkerLifecycleLogger('transcript-backfill')
  try {
    const summary = await runTranscriptBackfill({
      items,
      command: sidecarLaunch().command,
      args: sidecarLaunch().argsFor('transcript-backfill', ['--bare']),
      cwd: process.cwd(),
      signal: abort.signal,
      onWorkerLifecycle,
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
    run: () => {
      const onWorkerLifecycle = createWorkerLifecycleLogger('sessions-catalog')
      return runSessionsCatalogWorker({
        command: sidecarLaunch().command,
        args: sidecarLaunch().argsFor('catalog', ['--bare']),
        cwd: process.cwd(),
        signal: abort.signal,
        onWorkerLifecycle,
        onCatalog: catalog => {
          sendHostEvent({ type: 'sessions-catalog', catalog })
        },
        log: line => process.stderr.write(`${line}\n`),
      })
    },
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
 *
 * The same run also carries that page's usage analytics, emitted as its own
 * `usage-stats` event for the same reason and with the same last-good-value
 * failure posture.
 */
function startAccountsPoolRefresh(): void {
  if (accountsPoolDriver) return
  const abort = new AbortController()
  accountsPoolAbort = abort
  // Which run this is, so the expensive transcript aggregation rides only every
  // Nth one (see `USAGE_STATS_EVERY_N_RUNS`). Run 0 always carries it, so the
  // Accounts page is populated at launch rather than up to 5 minutes later.
  let runIndex = 0
  accountsPoolDriver = createAccountsPoolDriver({
    run: () => {
      if (accountDeleteInFlight) return Promise.resolve()
      const generation = accountsPoolPublicationGate.beginRead()
      const onWorkerLifecycle = createWorkerLifecycleLogger('accounts-pool')
      const withUsageStats = runCarriesUsageStats(runIndex)
      runIndex += 1
      return runAccountsPoolWorker({
        command: sidecarLaunch().command,
        args: sidecarLaunch().argsFor('accounts-pool', [
          '--bare',
          ...(withUsageStats ? ['--usage-stats'] : []),
        ]),
        cwd: process.cwd(),
        signal: abort.signal,
        onWorkerLifecycle,
        onPool: pool => {
          if (!accountsPoolPublicationGate.canPublish(generation)) return
          sendHostEvent({ type: 'accounts-pool', pool })
        },
        // Same run, same page, separate event: the two are independent reads and
        // a stats failure must not withhold the pool (nor the reverse).
        onUsageStats: stats => {
          if (!accountsPoolPublicationGate.canPublish(generation)) return
          sendHostEvent({ type: 'usage-stats', stats })
        },
        log: line => process.stderr.write(`${line}\n`),
      })
    },
    log: line => process.stderr.write(`${line}\n`),
  })
  accountsPoolDriver.start()
}

/**
 * Re-read the pool now because a sign-in just wrote to the vault. No-op before
 * the driver is armed (the first run is already pending) and after it stops.
 */
function refreshAccountsPoolNow(): void {
  accountsPoolDriver?.refreshNow()
}

function isMainWindowSender(event: Pick<IpcMainEvent, 'sender'>): boolean {
  const contents = mainWindow?.webContents
  return contents !== undefined && !contents.isDestroyed() && event.sender === contents
}

function sendAccountDeletionNotice(
  sessionId: SessionId,
  accountId: string,
  requestId: string,
): boolean {
  try {
    supervisor?.send(sessionId, {
      type: 'account.profileDeleted',
      requestId,
      accountId,
    })
    return true
  } catch (error) {
    process.stderr.write(
      `[main] account deletion notice to ${sessionId} deferred: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
    return false
  }
}

function notifySidecarsOfAccountDeletion(
  accountId: string,
  requestId: string,
): void {
  for (const session of supervisor?.listSessions() ?? []) {
    if (
      session.status === 'failed' ||
      session.status === 'exited'
    ) {
      continue
    }
    if (
      session.status === 'ready' &&
      sendAccountDeletionNotice(session.sessionId, accountId, requestId)
    ) {
      continue
    }
    const pending =
      pendingAccountDeletionNotices.get(session.sessionId) ?? new Map()
    pending.set(accountId, requestId)
    pendingAccountDeletionNotices.set(session.sessionId, pending)
  }
}

function flushAccountDeletionNotices(sessionId: SessionId): void {
  const pending = pendingAccountDeletionNotices.get(sessionId)
  if (!pending) return
  for (const [accountId, requestId] of pending) {
    if (!sendAccountDeletionNotice(sessionId, accountId, requestId)) return
    pending.delete(accountId)
  }
  if (pending.size === 0) pendingAccountDeletionNotices.delete(sessionId)
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
    canResume: appSessionId => activeHost.canResume(appSessionId),
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
    protectedSessions: () => visibleSessions,
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
/**
 * The one predicate `deliver` refuses on, exposed so a caller that stamps a
 * delivery-trace stage can ask BEFORE stamping it. Stamping a stage that
 * `deliver` then declines makes the trace record deliveries that never
 * happened: 1,883 `attachment.replayed` marks with no matching
 * `preload.received` were reported as a delivery pathology on 2026-08-14 and
 * were partly this artefact (`docs/reports/2026-08-14-desktop-logging-feedback.md` D1).
 * Same tick, no await between the check and the send, so the answer cannot go
 * stale in between.
 */
function deliverableContents(): WebContents | null {
  const contents = mainWindow?.webContents
  // `isDestroyed` because a send is only ever scheduled, never immediate: an
  // in-flight frame can land after the window went away. `rendererGone`
  // because a crashed renderer leaves the window open and `isDestroyed` false.
  if (!contents || contents.isDestroyed() || rendererGone) return null
  return contents
}

function deliver(frames: ServerFrame[]): void {
  const contents = deliverableContents()
  if (!contents) return
  if (frames.length === 0) return
  const traced = frames.map(frame => traceFrame(frame, 'main.ipc.queued'))
  contents.send(CH_SERVER_FRAME, traced satisfies ServerFrame[])
  for (const frame of traced) traceFrame(frame, 'main.ipc.sent')
}

/**
 * How to launch every sidecar mode, for the topology this process is running
 * (P5-1). Development spawns repository TypeScript under `bun`; a packaged
 * build spawns the compiled binary inside the bundle. Memoized rather than
 * computed at module scope so importing main never depends on Electron having
 * resolved `resourcesPath`, and lazily so the hardening harness — which forces
 * `isPackaged` on a source tree — still evaluates this module.
 */
let sidecarLaunchPlan: SidecarLaunchPlan | null = null
function sidecarLaunch(): SidecarLaunchPlan {
  if (sidecarLaunchPlan) return sidecarLaunchPlan
  sidecarLaunchPlan = resolveSidecarLaunch({
    packaged: app.isPackaged,
    mainDir: __dirname,
    resourcesPath: process.resourcesPath,
    bunBin: process.env.CATCODE_BUN_BIN,
  })
  // Same class of trap as the CATCODE_RENDERER_URL warning below, and now the
  // more expensive half of it. `app.isPackaged` comes from the executable's
  // BASENAME, so a renamed development binary reports packaged, and every
  // sidecar spawn then resolves into the stock Electron bundle where no
  // compiled sidecar exists. The only symptom would be an ENOENT naming a
  // directory nobody recognizes, once per worker, with no session ever
  // starting. Say it once, plainly, at the point the path is decided.
  if (sidecarLaunchPlan.packaged && !existsSync(sidecarLaunchPlan.command)) {
    process.stderr.write(
      `[main] no compiled sidecar at ${sidecarLaunchPlan.command}. This process reports packaged, so no session can start. ` +
        'Expected a dev launch? Check that the Electron executable is still named "electron". ' +
        'Expected a packaged launch? Rebuild with "bun run --cwd app package".\n',
    )
  }
  return sidecarLaunchPlan
}

function scheduleDebugCleanup(): void {
  // A disposable, main-supervised worker gives all session sidecars one shared
  // daily lock/marker.  Its result is intentionally non-fatal diagnostics.
  try {
    const child = spawn(sidecarLaunch().command, sidecarLaunch().argsFor('debug-cleanup'), {
      stdio: 'ignore', detached: false,
      env: { ...process.env, CATCODE_DEBUG_CLEANUP_MARKER_DIR: defaultRegistryDir() },
    })
    // F7 — a spawn failure (ENOENT: bun missing) arrives asynchronously as an
    // 'error' event, which the try/catch cannot see. Without this listener Node
    // treats it as unhandled, and the uncaughtException handler below exits the
    // whole app over a deliberately non-fatal cleanup worker.
    child.on('error', () => {
      logOperational('diagnostic', 'warn', { source: 'debugCleanup', reason: 'worker_spawn_failed' })
    })
    child.unref()
  } catch {
    logOperational('diagnostic', 'warn', { source: 'debugCleanup', reason: 'worker_spawn_failed' })
  }
}

function createSupervisor(): SidecarSupervisor {
  // The sidecar runs the desktop engine feature set declared in
  // `SIDECAR_RUNTIME_ARGS`. Without those features every `feature(...)` branch
  // is false and the desktop silently loses engine behavior — development
  // passes them as Bun runtime flags, and the packaged build bakes the same
  // list in at compile time (`app/scripts/package-app.ts`).
  return new SidecarSupervisor({
    sidecarCommand: sidecarLaunch().command,
    sidecarArgs: sidecarLaunch().argsFor('session'),
    // Default boot cwd for the single startup session. Per-session cwd now flows
    // through the host API (createSession → native picker, HC1); this stays only
    // as the supervisor-wide default for probe/legacy callers.
    sidecarCwd: process.cwd(),
    log: line => logLegacyDiagnostic(line, 'supervisor', 'supervisor'),
    onOperationalRecord: record => operationalLog.writeRecord(record),
    onDeliveryTraceRecord: record => deliveryTrace.mark({
      sessionId: record.sessionId,
      trace: record.trace,
      stage: record.stage,
      frameKind: record.frameKind,
      processInstanceId: record.processInstanceId,
      processStartedAt: record.processStartedAt,
      wallTimestamp: record.wallTimestamp,
      monotonicTimestampMs: record.monotonicTimestampMs,
    }),
    onOperationalEvent: input => operationalLog.write({
      ...input,
      process: 'supervisor',
    }),
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
  log: line => logLegacyDiagnostic(line, 'devHarness'),
})

const devPickerBypass = createDevPickerBypass(devHarnessConfig, {
  validateCwd,
  log: line => logLegacyDiagnostic(line, 'devPicker'),
})

const scheduleDebugStateExport = createDebouncedAction(
  () => writeDebugStateExport(),
  { delayMs: 250 },
)

const readinessLatch = createReadinessLatch(() => {
  process.stdout.write('[main] renderer ready\n')
  // F6 — `ready-to-show` already logs `renderer.load.ready` once per document
  // before feeding this latch; logging it again here duplicated the event for
  // every load (or was silently swallowed as `log.suppressed{rate_dedupe}` on
  // a fast one). The stdout line above is this latch's real contract: every
  // consumer (`packaged-launch-smoke.ts`, `harness-demo.ts`) reads that, not
  // the operational record.
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

/** The layout-derived floor, named because the restore clamp needs the same two
 * numbers the `BrowserWindow` does. The derivation is documented at the
 * `minWidth`/`minHeight` call site below (P4-46). */
const MIN_WINDOW_WIDTH = 852
const MIN_WINDOW_HEIGHT = 467

/** CC-84 — how long after the last resize/move the saved bounds are written. A
 * drag fires these continuously and the write is synchronous, so it is coalesced
 * to the end of the gesture. A close flushes whatever is pending. */
const WINDOW_BOUNDS_WRITE_DEBOUNCE_MS = 400

function createWindow(): void {
  const glassEnabled = readGlassPreference(app.getPath('userData'))
  // CC-84 — reopen where the operator left it. Absent, unreadable or corrupt
  // saved bounds fall through to the defaults below rather than failing the
  // launch, and a saved rectangle is fitted to the display it actually lands on
  // (`clampWindowBounds`), so bounds saved on a display that is no longer
  // attached still open somewhere reachable. `getDisplayMatching` returns the
  // primary display when nothing overlaps, which is that case.
  const savedBounds = readWindowBounds(app.getPath('userData'))
  const restoredBounds = savedBounds
    ? clampWindowBounds(
        savedBounds,
        screen.getDisplayMatching(savedBounds).workArea,
        { width: MIN_WINDOW_WIDTH, height: MIN_WINDOW_HEIGHT },
      )
    : null
  const window = new BrowserWindow({
    width: restoredBounds?.width ?? 1100,
    height: restoredBounds?.height ?? 720,
    ...(restoredBounds ? { x: restoredBounds.x, y: restoredBounds.y } : {}),
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
    // Height 467 = 40 tab bar (`TabBar.tsx:119` `h-10`) + 64 chat-pane padding
    // + 16 dock gap (`App.tsx:3567` `gap-4`) + 83 composer dock at rest (36
    // textarea + 11 pad + 2 focus rule + 12 + 22 actions bar) + 264 for the
    // transcript, which must never be shorter than the tallest panel the shell
    // opens over it: the 7-item session actions menu (`sessionActions.ts:320`
    // `estimateSessionActionsMenuHeight`), which neither scrolls nor clamps its
    // own height.
    //
    // Electron's min* are OUTER-window measures, and this used to carry a 28
    // term for the macOS title bar on top of the CSS px below it. `titleBarStyle:
    // 'hiddenInset'` removes that strip: the page now paints to the top of the
    // window, so outer and content height are the same measure again.
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    // Glass mode remains a renderer-owned view preference, but main keeps a
    // synchronized bounded copy so renderer-free paint gaps use the same native
    // background. A missing or invalid copy fails solid. On first launch after
    // this main-owned file was introduced, the renderer sends its existing
    // local-storage value on mount and seeds future launches.
    //
    // Vibrancy is mounted once and never touched again. `setVibrancy` is not
    // symmetric: it can change the material of a window that is already vibrant,
    // but it cannot make one vibrant that is not (measured 2026-08-28 on Electron
    // 33.4.11), so a window that loses its `NSVisualEffectView` cannot be repaired
    // from JS at all. Given the transparent ground below, that leaves a HOLE
    // rather than a solid window. Nothing runs `setVibrancy` after this line,
    // deliberately.
    //
    // `visualEffectState: 'active'` because the default (`followWindow`) swaps to
    // the inactive material on blur, which would shift the whole app ground every
    // time the operator clicks another window.
    //
    // The native background follows that persisted choice: solid when glass is
    // off, transparent when it is on. Renderer reload, crash, and OOM gaps
    // therefore cannot expose the desktop for the default off state.
    //
    // `#00000000` is AARRGGBB, not RRGGBBAA (`electron.d.ts`). All-zeros is the
    // same either way; a later edit to a non-zero colour is not.
    //
    // Non-darwin keeps the solid ground: `vibrancy` is a macOS material, and
    // without it a transparent window is just a transparent window.
    //
    // `hiddenInset` drops the OS title strip and lets the page paint to the top
    // of the window, keeping the OS-drawn traffic lights. They are drawn ABOVE
    // web content, so their position is a layout constraint the renderer has to
    // honour rather than a decoration: `y: 14` centres the 12px buttons in the
    // 40px tab bar (`TabBar.tsx:119` `h-10`), and that bar reserves the 84px
    // well they sit in (`TabBar.tsx` `w-[84px]` = this inset + 52px of buttons +
    // clearance). Change one of those three numbers and you must change the
    // others.
    //
    // `x: 12` is Chrome's inset, adopted 2026-08-28 after the operator measured
    // ours at 21 against Chrome's 12. macOS's own default for this style sits
    // near 20, so this is deliberately tighter than the system, not a return to
    // it.
    //
    // No `titleBarOverlay`: that is the Windows/Linux caption-button surface,
    // and this window keeps the native macOS buttons.
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 12, y: 14 },
          vibrancy: WINDOW_VIBRANCY,
          visualEffectState: 'active' as const,
          backgroundColor: glassEnabled ? '#00000000' : '#09090b',
        }
      : { backgroundColor: '#09090b' }),
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
  const healthProbe = () => {
    const event = rendererHealth.probe()
    // Annotation only: the monitor's escalation logic never sees this.
    if (event) {
      logOperational(event.event, event.level, { ...event.fields, visible: lastKnownRendererVisible })
      if (event.event === 'renderer.health.unavailable') {
        flushRendererHealthFlightRecorder('health_unavailable')
      }
    }
    if (!window.webContents.isDestroyed() && !rendererGone) {
      window.webContents.send(CH_DELIVERY_HEALTH_PROBE)
    }
  }
  const stopRendererHealthTimer = () => {
    if (rendererHealthTimer) clearInterval(rendererHealthTimer)
    rendererHealthTimer = null
  }
  const startRendererHealthTimer = () => {
    stopRendererHealthTimer()
    rendererHealth.reset()
    // F5 — the flight recorder is module-global across BrowserWindow
    // generations; without this a closed window's evidence survives into the
    // next one and can be flushed under a failure that isn't its own.
    rendererHealthFlightRecorder.reset()
    rendererHealthTimer = setInterval(healthProbe, 5_000)
  }
  rendererGone = false
  rendererRecovering = false
  startRendererHealthTimer()
  window.once('closed', stopRendererHealthTimer)
  mainWindow = window

  // The pid a macOS crash report names. The renderer process does not exist
  // until a document loads, and it is already gone by `render-process-gone`, so
  // this is read post-load and remembered for the death record.
  let rendererOsProcessId: number | null = null
  let windowCreatedLogged = false
  const readRendererOsProcessId = (): number | null => {
    try {
      const pid = window.webContents.getOSProcessId()
      return Number.isSafeInteger(pid) && pid > 0 ? pid : null
    } catch {
      return null
    }
  }

  const windowVisibility = createWindowVisibilityTracker()
  const logWindowVisibility = (reason: WindowVisibilityReason) => {
    const transition = windowVisibility.observe(reason)
    if (!transition) return
    logOperational('window.visibility.changed', 'info', {
      visible: transition.visible,
      reason: transition.reason,
    })
  }
  window.on('show', () => logWindowVisibility('show'))
  window.on('hide', () => logWindowVisibility('hide'))
  window.on('minimize', () => logWindowVisibility('minimize'))
  window.on('restore', () => logWindowVisibility('restore'))

  // CC-84 — remember the geometry. `getNormalBounds` is the restored rectangle,
  // so a maximized or full-screen window saves the size it will return to rather
  // than the screen it currently fills; a minimized one has nothing worth saving.
  let windowBoundsTimer: ReturnType<typeof setTimeout> | null = null
  const persistWindowBounds = () => {
    if (window.isDestroyed() || window.isMinimized()) return
    writeWindowBounds(app.getPath('userData'), window.getNormalBounds())
  }
  const scheduleWindowBoundsSave = () => {
    if (windowBoundsTimer) clearTimeout(windowBoundsTimer)
    windowBoundsTimer = setTimeout(() => {
      windowBoundsTimer = null
      persistWindowBounds()
    }, WINDOW_BOUNDS_WRITE_DEBOUNCE_MS)
  }
  const cancelWindowBoundsSave = () => {
    if (!windowBoundsTimer) return
    clearTimeout(windowBoundsTimer)
    windowBoundsTimer = null
  }
  window.on('resize', scheduleWindowBoundsSave)
  window.on('move', scheduleWindowBoundsSave)
  // A quit almost always lands inside the debounce window, so the pending write
  // is flushed here instead of being dropped with the timer.
  window.on('close', () => {
    cancelWindowBoundsSave()
    persistWindowBounds()
  })

  // Drop the reference the moment the window is gone. Without this, `deliver`
  // and `sendHostEvent` keep addressing a destroyed `webContents` for anything
  // still in flight during teardown.
  window.on('closed', () => {
    cancelWindowBoundsSave()
    if (mainWindow === window) mainWindow = null
  })

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
      rendererDocumentId = randomUUID()
      rendererSubscriptionEpoch = 0
      logOperational('renderer.navigation.started', 'info', { navigation: 'document' })
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
    // Capture-run hook (verification only), sibling to CATCODE_SMOKE_EXIT_MS below.
    // A headless acceptance run photographs this window with `capturePage` and
    // drives it with `sendInputEvent`; both work on a window that is never shown,
    // measured on Electron 33.4.11. Showing it would raise and focus it over
    // whatever the operator is doing, which is the one thing that path must never
    // do (`docs/migration/process/GUI-VERIFICATION.md`). Only the show is skipped:
    // the window is real, it has painted by now, and everything below still runs.
    if (process.env.CATCODE_HEADLESS_CAPTURE !== '1') {
      window.show()
    }
    logOperational('renderer.load.ready', 'info')
    readinessLatch.windowReady()
    // Paint first. The worker import is the ~189 MB engine-graph cost; never pay
    // it on the launch/first-window critical path. Every one of these is armed
    // through `startupTimers` so teardown can cancel an arm that has not fired.
    startupTimers.schedule(() => void backfillTranscriptCaches())
    // Catalog owner (decision #4): arm the main-supervised catalog refresh here,
    // off the launch critical path, so its first run fills the sidebar and it
    // then self-reschedules — replacing the per-sidecar catalog enumeration.
    startupTimers.schedule(startSessionsCatalogRefresh)
    // Accounts owner (decisions/ACCOUNTS-OWNERSHIP.md): arm the pool refresh the
    // same way, so the Accounts page has live data with no session open.
    startupTimers.schedule(startAccountsPoolRefresh)
    // IDLE-PARK (decisions/IDLE-PARK.md §4): arm the RAM-reclaim policy driver
    // here too, off the launch critical path; it self-reschedules its TTL sweep
    // and re-evaluates the cap on host events.
    startupTimers.schedule(startIdleParkDriver)
  })

  const loadRenderer = () => {
    if (IS_DEV) {
      logOperational('renderer.load.started', 'info', { source: 'dev' })
      void window.loadURL(APP_ORIGIN_DEV).catch(error => {
        logOperational('renderer.load.failed', 'error', { reason: classifyFailure(error) })
      })
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
      logOperational('renderer.load.started', 'info', { source: 'packaged' })
      void window.loadFile(PACKAGED_INDEX_PATH).catch(error => {
        logOperational('renderer.load.failed', 'error', { reason: classifyFailure(error) })
      })
    }
  }
  const giveUpOnRenderer = (reason: RendererDeathReason) => {
    logOperational('renderer.recovery.exhausted', 'error', {
      count: RENDERER_RECOVERY_MAX_ATTEMPTS,
      reason,
    })
    if (!rendererRecoveryDialogShown) {
      rendererRecoveryDialogShown = true
      dialog.showErrorBox(
        'Cat Code window crashed',
        'The window crashed several times in a row, so automatic reload stopped. Quit and reopen the app to continue.',
      )
    }
  }

  // Stderr lines are dev only: a packaged build must not gain a stderr surface.
  // Both are filtered where the operational record is not, because a diagnostic
  // that fires on routine events trains the reader to ignore it, while the
  // record should still capture every case. An abnormal renderer death also
  // auto-reloads the window (bounded by the recovery policy), because a logged
  // but unrecovered crash is a permanently black window (2026-08-09 incident).
  window.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame) {
      logOperational('renderer.load.failed', 'error', { code, reason: 'did_fail_load' })
      // -3 is ERR_ABORTED: a load superseded or cancelled, which is what an
      // ordinary dev reload looks like.
      if (IS_DEV && code !== -3) {
        process.stderr.write(`[main] the window failed to load (code ${code}).\n`)
      }
      if (rendererRecovering && code !== -3) {
        const decision = rendererRecovery.decide('load-failed')
        if (decision.action === 'reload') {
          logOperational('renderer.recovery.started', 'warn', {
            count: decision.attempt,
            reason: 'load-failed',
          })
          loadRenderer()
        } else if (decision.action === 'give-up') {
          giveUpOnRenderer('load-failed')
        }
      }
    }
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    // A crashed renderer leaves the window open and `isDestroyed()` false, so
    // without this flag every scheduled send (probe, host event, frame) throws
    // "Render frame was disposed" forever. Flag first, then stop probing a
    // process main positively knows is gone.
    rendererGone = true
    stopRendererHealthTimer()
    // The gate is still attached to the document that just died, so re-arm it
    // here: frames arriving before the replacement document announces itself
    // would otherwise be dropped by the `rendererGone` check instead of buffered
    // for its replay. Document identity stays navigation-owned.
    cancelAllReplayFlushes()
    attachmentGate.onNavigationStart()
    logOperational('renderer.process.gone', 'error', {
      reason: details.reason,
      exitCode: details.exitCode,
      // Remembered from the load: the process is gone, so asking now returns 0.
      ...(rendererOsProcessId === null ? {} : { pid: rendererOsProcessId }),
    })
    flushRendererHealthFlightRecorder('process_gone')
    // `clean-exit` is a renderer that exited 0, which is what quitting looks like.
    if (IS_DEV && details.reason !== 'clean-exit') {
      process.stderr.write(
        `[main] the window crashed (${details.reason}, exit code ${details.exitCode}); reloading it.\n`,
      )
    }
    if (window.isDestroyed()) return
    const decision = rendererRecovery.decide(details.reason)
    if (decision.action === 'reload') {
      logOperational('renderer.recovery.started', 'warn', {
        count: decision.attempt,
        reason: details.reason,
      })
      rendererRecovering = true
      loadRenderer()
    } else if (decision.action === 'give-up') {
      giveUpOnRenderer(details.reason)
    }
  })
  // A reload after a crash lands here once the fresh document is loaded; the
  // renderer-ready handshake then replays state through the attachment gate the
  // same way any reload does (F2).
  window.webContents.on('did-finish-load', () => {
    rendererGone = false
    rendererOsProcessId = readRendererOsProcessId()
    const pid: Record<string, number> =
      rendererOsProcessId === null ? {} : { pid: rendererOsProcessId }
    // Deliberately here and not beside `new BrowserWindow`: before a document
    // loads there is no renderer process to name, and the pid is the point of
    // this record. `renderer.load.started` still marks the construction moment.
    // Flagged rather than inferred from the pid, so a load that could not report
    // one does not make the next reload look like a second window.
    if (!windowCreatedLogged) {
      windowCreatedLogged = true
      logOperational('window.created', 'info', pid)
    }
    if (rendererRecovering) {
      rendererRecovering = false
      rendererRecoveryDialogShown = false
      // A reload is a different OS process, so the crash report for a SECOND
      // death would otherwise have nothing live to match against.
      logOperational('renderer.recovery.succeeded', 'info', pid)
      startRendererHealthTimer()
    }
  })
  let unresponsiveAt: number | null = null
  window.webContents.on('unresponsive', () => {
    unresponsiveAt = Date.now()
    logOperational('renderer.unresponsive', 'warn')
  })
  window.webContents.on('responsive', () => {
    logOperational('renderer.responsive', 'info', {
      durationMs: unresponsiveAt === null ? 0 : Date.now() - unresponsiveAt,
    })
    unresponsiveAt = null
  })

  loadRenderer()
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
      // It is not forwarded, but it DID cross the socket, and the sidecar spent
      // a delivery sequence on it like any other frame. Continuity is judged at
      // arrival, so returning before these marks pinned the arrival watermark
      // and made every titled session — i.e. every fresh one — report a frame
      // that never arrived. Mark what actually happened, then relay.
      const titled = traceFrame(frame, 'supervisor.socket.received')
      traceFrame(titled, 'host.received')
      void host?.setTitle(event.sessionId, frame.title)
      return
    }
    // HOST-REQUEST-PLANE §2 — the sidecar asking MAIN to do something. It is
    // consumed here and NEVER forwarded: the payload is model-authored, and the
    // renderer is the least trusted zone on this wire. Same shape as the title
    // rider above — mark the arrival that really happened, then handle it and
    // return before the attachment gate, so it enters no replay buffer and
    // reaches no window. Its `FRAME_RETENTION` entry classifies a frame this
    // return makes unreachable; the table is exhaustive, not a permission.
    //
    // `event.sessionId` is the supervisor's routing key, i.e. the identity read
    // off the connection. That, and nothing inside the frame, is the requester
    // (HR2).
    if (frame.kind === 'host.request') {
      const received = traceFrame(frame, 'supervisor.socket.received')
      traceFrame(received, 'host.received')
      void peerPlane?.handleRequest(event.sessionId, frame)
      return
    }
    if (frame.kind === 'ready') {
      logOperational('sidecar.ready', 'info', { frame: 'ready' }, event.sessionId)
      flushAccountDeletionNotices(event.sessionId)
      // §4 step 5/6 — releases anything waiting on this row's wake and re-sends
      // whatever it never acked.
      peerPlane?.onReady(event.sessionId)
    }
    if (frame.kind === 'activity') {
      // §4 step 4a — per-row presence for `peers.list`. The frame still forwards
      // normally: it is app-owned point-in-time state, and main reading it does
      // not make it main's alone.
      peerPlane?.recordActivity(event.sessionId, frame.presence)
    }
    if (isTerminalLifecycleFrame(frame)) {
      pendingAccountDeletionNotices.delete(event.sessionId)
      // Presence is a fact about a LIVE row. Absence means not live, nothing
      // else, so it is cleared here rather than left to read as stale.
      peerPlane?.onSessionDown(event.sessionId)
    }
    if (frame.kind === 'session-action.result') {
      rememberBranchOpenSeed(event.sessionId, frame)
    }
    // An account verb that landed, or a completed sign-in, changes the pool from
    // outside this worker's cadence. The frame still forwards normally; the
    // accounts owner stays main (decisions/ACCOUNTS-OWNERSHIP.md) rather than the
    // session snapshot being promoted to drive these surfaces. The predicate is
    // Electron-free so it can be unit-driven; nothing here can execute in a test.
    if (frameMutatedAccountsPool(frame)) {
      refreshAccountsPoolNow()
    }
    const traced = traceFrame(frame, 'supervisor.socket.received')
    // Receipt is true whether the attachment gate forwards immediately or
    // buffers for replay; record that before deciding its outcome.
    traceFrame(traced, 'host.received')
    const gated = attachmentGate.onFrame(event.sessionId, traced)
    if (gated.length === 0) traceFrame(traced, 'attachment.buffered')
    deliver(gated)
    if (
      attachmentGate.hasPendingReplayCoalescing(event.sessionId) &&
      attachmentGate.isLazyReplayCoalescing(event.sessionId)
    ) {
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
      // HOST-REQUEST-PLANE §5 — every per-row and per-pair peer store is
      // cleared on reap. They are in-memory only, so this is not persistence
      // hygiene: it is what keeps a reused NAME from inheriting the previous
      // row's chain, rate bucket or pending messages.
      peerPlane?.onSessionRemoved(event.appSessionId)
    }
    scheduleDebugStateExport.schedule()
  })
}

function sendHostEvent(event: HostEvent): void {
  const contents = mainWindow?.webContents
  if (contents && !contents.isDestroyed() && !rendererGone) contents.send(CH_HOST_EVENT, event)
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
  ipcMain.on(CH_SUBMIT, (_e, arg: { sessionId: SessionId; prompt: unknown; options?: unknown }) => {
    if (
      typeof arg?.sessionId !== 'string' ||
      (typeof arg?.prompt !== 'string' && !Array.isArray(arg?.prompt))
    ) {
      return
    }
    const options = sanitizeSubmitOptions(arg.options)
    const fileAttachmentToken = readFileAttachmentToken(arg.options)
    const selectedFile = fileAttachmentToken
      ? attachmentFileTokens.resolve(arg.sessionId, fileAttachmentToken)
      : undefined
    if (fileAttachmentToken && !selectedFile) {
      deliver(
        attachmentGate.onFrame(arg.sessionId, {
          kind: 'error',
          protocolVersion: PROTOCOL_VERSION,
          sessionId: arg.sessionId,
          code: 'bad_request',
          message: 'Selected file is no longer available. Choose it again.',
          retryable: false,
        }),
      )
      answerUnforwardedSubmit(arg.sessionId, options?.submitId, 'bad_request')
      return
    }
    const prompt: SubmitPrompt = selectedFile
      ? appendAttachmentFileMention(arg.prompt as SubmitPrompt, selectedFile)
      : (arg.prompt as SubmitPrompt)
    const failure = forward(arg.sessionId, {
      type: 'app.submit',
      requestId: generateRequestId(),
      prompt,
      options,
    })
    // The submit never left main, so no sidecar will ever answer it. Say so with
    // the renderer's own id rather than letting the retained message sit forever
    // waiting for a frame that cannot come.
    if (failure !== null) {
      answerUnforwardedSubmit(arg.sessionId, options?.submitId, failure)
    }
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
      // re-validates (`auto` rejected there explicitly). A value outside the
      // wire allowlist drops the whole message fail-closed rather than
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
    CH_PROMPT_FORCE,
    (_e, arg: { sessionId: SessionId; verb: unknown }) => {
      if (typeof arg?.sessionId !== 'string') return
      const verb = arg.verb as { type?: unknown } | null | undefined
      if (
        typeof verb?.type !== 'string' ||
        !PROMPT_FORCE_VERB_TYPES.includes(verb.type as PromptForceVerbType)
      ) {
        return
      }
      forward(arg.sessionId, arg.verb as PromptForceMessage)
    },
  )

  ipcMain.on(
    CH_PROMPT_RECALL,
    (_e, arg: { sessionId: SessionId; verb: unknown }) => {
      if (typeof arg?.sessionId !== 'string') return
      // D1b — light UX coercion only; the SIDECAR is the trust boundary and fully
      // re-validates (Zod schema), then decides for itself what is recallable.
      // Drop any frame whose `type` is not the recall verb fail-closed. There is
      // no other field to coerce: the verb carries no target, only the renderer's
      // `requestId` for result correlation (a UX field, not a security one).
      const verb = arg.verb as { type?: unknown } | null | undefined
      if (
        typeof verb?.type !== 'string' ||
        !PROMPT_RECALL_VERB_TYPES.includes(verb.type as PromptRecallVerbType)
      ) {
        return
      }
      forward(arg.sessionId, arg.verb as PromptRecallMessage)
    },
  )

  ipcMain.on(
    CH_HISTORY_LOAD_EARLIER,
    (_e, arg: { sessionId: SessionId; verb: unknown }) => {
      if (typeof arg?.sessionId !== 'string') return
      // Load earlier messages (decisions/HISTORY-LOAD-EARLIER.md) — light UX
      // coercion only; the SIDECAR is the trust boundary and fully re-validates
      // (Zod schema + closed key allowlist), then decides for itself which file
      // it reads and how much of it. Drop any frame whose `type` is not the
      // load-earlier verb fail-closed. There is no other field to coerce here:
      // the verb carries no target and no extent, only the renderer's
      // `requestId` for result correlation (a UX field, not a security one).
      // The frame's one main-authored field, `viewAnchorUuid`, is stamped in
      // `forward` rather than here, so it cannot be missed by a second route
      // into the verb — see the comment there.
      const verb = arg.verb as { type?: unknown } | null | undefined
      if (
        typeof verb?.type !== 'string' ||
        !HISTORY_LOAD_EARLIER_VERB_TYPES.includes(
          verb.type as HistoryLoadEarlierVerbType,
        )
      ) {
        return
      }
      forward(arg.sessionId, arg.verb as HistoryLoadEarlierMessage)
    },
  )

  ipcMain.on(
    CH_CONTEXT_BREAKDOWN_VERB,
    (_e, arg: { sessionId: SessionId; verb: unknown }) => {
      if (typeof arg?.sessionId !== 'string') return
      // Light UX coercion only; the SIDECAR is the trust boundary and fully
      // re-validates. Drop any frame whose `type` is not the breakdown request
      // fail-closed. The renderer authors the `requestId` for correlation (a UX
      // field, not a security one; the sidecar bounds it), and there is no other
      // field to coerce — the analysis takes no renderer input.
      const verb = arg.verb as { type?: unknown } | null | undefined
      if (
        typeof verb?.type !== 'string' ||
        !CONTEXT_BREAKDOWN_VERB_TYPES.includes(
          verb.type as ContextBreakdownVerbType,
        )
      ) {
        return
      }
      forward(arg.sessionId, arg.verb as ContextBreakdownVerbMessage)
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

  ipcMain.on(
    CH_STATS_QUERY,
    (_e, arg: { sessionId: SessionId; verb: unknown }) => {
      if (typeof arg?.sessionId !== 'string') return
      const verb = arg.verb as { type?: unknown; range?: unknown } | null | undefined
      if (
        verb?.type !== 'stats.query' ||
        (verb.range !== '7d' && verb.range !== '30d')
      ) {
        return
      }
      forward(arg.sessionId, arg.verb as StatsQueryMessage)
    },
  )

  ipcMain.on(CH_PING, (_e, arg: { sessionId: SessionId; nonce: string }) => {
    if (typeof arg?.sessionId !== 'string' || typeof arg?.nonce !== 'string') return
    forward(arg.sessionId, { type: 'app.ping', nonce: arg.nonce })
  })

  ipcMain.handle(
    CH_RESTART,
    (event: IpcMainInvokeEvent, arg: unknown): Promise<HostResult<void>> => {
      if (!isMainWindowSender(event) || typeof (arg as { sessionId?: unknown })?.sessionId !== 'string') {
        return Promise.resolve({
          ok: false,
          error: { code: 'session_not_found', message: 'restart request refused' },
        })
      }
      if (!host) {
        return Promise.resolve({
          ok: false,
          error: { code: 'spawn_failed', message: 'host is not running' },
        })
      }
      const sessionId = (arg as { sessionId: SessionId }).sessionId
    // SF5 — route through the host so the registry's advisory fields (pid /
    // socketPath) are refreshed from the fresh child; the host also evicts replay.
      return host.restartSession(sessionId)
    },
  )

  // F2 — the renderer signals it has mounted and subscribed. The gate replays the
  // buffered frames (including the one-shot `ready` handshake) once per document
  // load and returns nothing on a repeat signal (StrictMode double-invoke).
  ipcMain.on(CH_RENDERER_READY, (_e, payload: { documentId?: unknown }) => {
    if (typeof payload?.documentId !== 'string' || payload.documentId.length > 128) return
    // An IPC message from the renderer is positive proof of a live committed
    // frame, and the mount effect that sends it can beat `did-finish-load`, so
    // clearing the flag only there left the one-shot replay below discarded.
    rendererGone = false
    rendererDocumentId = payload.documentId
    rendererSubscriptionEpoch++
    // Stamp only what `deliver` will actually hand to `webContents.send`. The
    // gate's one-shot replay latch is spent for this document by the call below
    // (the buffer itself survives, and `onNavigationStart` re-arms it), so a
    // replay this load cannot deliver gets its own record rather than a silent
    // absence (D1). `count` is the magnitude that distinguishes a lost frame
    // from a lost restore; reading the record without it was the 2026-08-14
    // mistake in miniature.
    const pending = attachmentGate.onRendererReady()
    if (pending.length > 0 && !deliverableContents()) {
      logOperational('diagnostic', 'warn', {
        source: 'attachmentReplay',
        reason: 'renderer_unavailable',
        count: pending.length,
      })
    } else {
      deliver(pending.map(frame => traceFrame(frame, 'attachment.replayed')))
    }
    readinessLatch.rendererReady()
  })

  ipcMain.on(CH_DELIVERY_ACK, (_e, payload: unknown) => {
    const acknowledgements = parseDeliveryAcknowledgements(payload)
    if (!acknowledgements) {
      logOperational('diagnostic', 'warn', { source: 'deliveryAck', reason: 'rejected' })
      return
    }
    for (const acknowledgement of acknowledgements) {
      if (
        acknowledgement.documentId !== rendererDocumentId ||
        acknowledgement.subscriptionEpoch !== rendererSubscriptionEpoch ||
        !deliveryTrace.accepts(
          acknowledgement.sessionId,
          acknowledgement.streamEpoch,
          acknowledgement.sequence,
          acknowledgement.documentId,
          acknowledgement.subscriptionEpoch,
        )
      ) {
        deliveryTrace.recordAcknowledgementRejected({
          sessionId: acknowledgement.sessionId,
          streamEpoch: acknowledgement.streamEpoch,
          sequence: acknowledgement.sequence,
          reason: acknowledgement.documentId !== rendererDocumentId || acknowledgement.subscriptionEpoch !== rendererSubscriptionEpoch
            ? 'stale_document'
            : 'unknown_sequence',
        })
        logOperational('diagnostic', 'warn', { source: 'deliveryAck', reason: 'rejected' })
        continue
      }
      const trace = deliveryTrace.traceFor(
        acknowledgement.sessionId,
        acknowledgement.streamEpoch,
        acknowledgement.sequence,
      )
      if (
        !trace ||
        trace.deliveryAttempt !== acknowledgement.deliveryAttempt ||
        trace.streamEpoch !== acknowledgement.streamEpoch ||
        trace.traceId !== acknowledgement.traceId
      ) {
        deliveryTrace.recordAcknowledgementRejected({
          sessionId: acknowledgement.sessionId,
          streamEpoch: acknowledgement.streamEpoch,
          sequence: acknowledgement.sequence,
          reason: 'stale_attempt',
        })
        logOperational('diagnostic', 'warn', { source: 'deliveryAck', reason: 'stale_attempt' })
        continue
      }
      deliveryTrace.mark({
        sessionId: acknowledgement.sessionId,
        trace,
        stage: acknowledgement.stage,
        documentId: acknowledgement.documentId,
        subscriptionEpoch: acknowledgement.subscriptionEpoch,
        processInstanceId: acknowledgement.rendererProcessInstanceId,
        processStartedAt: acknowledgement.rendererProcessStartedAt,
      })
    }
  })

  ipcMain.on(CH_DELIVERY_HEALTH_RESPONSE, (event, payload: unknown) => {
    const item = parseRendererHealthResponse(payload)
    if (!item) return
    if (
      item.documentId !== rendererDocumentId ||
      item.subscriptionEpoch !== rendererSubscriptionEpoch ||
      item.rendererProcessInstanceId.length === 0
    ) return
    lastKnownRendererVisible = item.visible
    const health = rendererHealth.response()
    const rendererWorkingSetKiB = selectRendererWorkingSetKiB(
      app.getAppMetrics(),
      event.sender.getOSProcessId(),
    )
    rendererHealthFlightRecorder.record({
      eventLoopLagMs: item.eventLoopLagMs,
      visible: item.visible,
      jsHeapUsedBytes: item.jsHeapUsedBytes,
      rendererWorkingSetKiB,
      rendersCommitted: item.rendersCommitted,
    })
    if (!health.shouldSample) return
    logOperational(
      health.recovered
        ? 'renderer.health.recovered'
        : 'renderer.health.sample',
      'info',
      {
        sessions: item.watermarks.length,
        eventLoopLagMs: item.eventLoopLagMs,
        visible: item.visible,
        jsHeapUsedBytes: item.jsHeapUsedBytes,
        rendererWorkingSetKiB,
        rendersCommitted: item.rendersCommitted,
        ...(health.recovered
          ? {
              missed: health.priorMisses,
              durationMs: health.outageDurationMs,
            }
          : {}),
      },
    )
  })

  ipcMain.on(CH_RENDERER_FAULT, (_e, payload: unknown) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return
    const item = payload as { kind?: unknown; message?: unknown }
    if (
      Object.keys(item).length !== 2 ||
      !['javascript', 'promise', 'component'].includes(item.kind as string) ||
      typeof item.message !== 'string' ||
      item.message.length > 512
    ) return
    const now = Date.now()
    if (now - rendererFaultWindowStartedAt >= 60_000) {
      rendererFaultWindowStartedAt = now
      rendererFaultCount = 0
    }
    if (rendererFaultCount >= 12) {
      logOperational('diagnostic', 'warn', { source: 'rendererFault', reason: 'rate_limited' })
      return
    }
    rendererFaultCount++
    logOperational(
      item.kind === 'component' ? 'renderer.component.failed' : item.kind === 'promise' ? 'renderer.promise.unhandled' : 'renderer.javascript.error',
      'error',
      { source: 'renderer', reason: 'fault_reported' },
    )
  })

  /**
   * The appearance preference's only main-side effect
   * (`app/renderer/src/colorScheme.ts`, `protocol.ts` `setAppearance`).
   *
   * macOS chooses a window's vibrancy material from the app's effective
   * `NSAppearance`, and only main can move it. Verified rather than assumed:
   * assigning `themeSource` flips `systemPreferences.getEffectiveAppearance()`
   * on a window that already exists, so this needs no persistence and no
   * involvement in window creation.
   *
   * IT RECEIVES THE USER'S CHOICE, NOT THE APPEARANCE BEING PAINTED, and
   * `'system'` is the value that makes the feature work rather than a widening.
   * `themeSource` is an OVERRIDE: assigning `light` or `dark` supersedes the OS
   * and pins the renderer's own `prefers-color-scheme`, which is the query the
   * renderer resolves `system` against. An earlier version sent the resolved
   * appearance, so the first time anyone left the app on "Match system" main
   * force-pinned that value and the OS could never move it again. `system`
   * releases the override; the three values are exactly the state machine
   * Electron's own `themeSource` documentation prescribes.
   *
   * FAIL CLOSED on the vocabulary, like every other inbound handler here: the
   * set is closed and anything outside it is dropped rather than coerced, so a
   * malformed payload can neither pin nor release the appearance.
   */
  ipcMain.on(CH_SET_APPEARANCE, (_event, scheme: unknown) => {
    if (scheme !== 'system' && scheme !== 'light' && scheme !== 'dark') return
    nativeTheme.themeSource = scheme
  })

  ipcMain.on(CH_SET_GLASS_MODE, (event, enabled: unknown) => {
    if (!isMainWindowSender(event) || typeof enabled !== 'boolean') return
    writeGlassPreference(app.getPath('userData'), enabled)
    mainWindow?.setBackgroundColor(enabled ? '#00000000' : '#09090b')
  })

  /**
   * THERE IS DELIBERATELY NO RE-MINT HERE, and the assignment above is the whole
   * feature. A listener on `nativeTheme`'s `updated` event, calling `setVibrancy` on
   * every window, used to sit at this spot. It is removed as CLEANUP: it is not
   * needed for an appearance change, and it was never shown to repair anything.
   * It is NOT the fix for the failure described at the bottom of this comment,
   * and nothing here should be read as claiming it was.
   *
   * IT IS NOT NEEDED FOR AN APPEARANCE CHANGE. The claim it rested on — that
   * macOS resolves the material once at window creation and leaves it in the
   * appearance the window was BORN in — does not hold on Electron 33.4.11.
   * Measured 2026-08-28 by capturing the composited window and reading the page
   * ground's pixels, with no `setVibrancy` call anywhere in the probe: a window
   * carrying this file's exact options and born while `themeSource` was still
   * `'system'` reads #2E2E30 under dark, #929294 after an override to `'light'`,
   * and #2E2E30 again on the way back. A twin re-minted on every `updated` event
   * matched it within capture variation (about one RGB level; the two windows sat
   * at different screen positions, so they were never byte-identical). Confirmed
   * independently against the native view: reasserting the same material twenty
   * times leaves the SAME `NSVisualEffectView` pointer, material and active state,
   * so a same-value re-mint does not even rebuild the view it was supposed to.
   *
   * ON THE SHIPPED APP it answers from the other side: a live window running this
   * renderer does not follow `themeSource` at all. Moved to `'light'`
   * (`shouldUseDarkColors` false, `getEffectiveAppearance()` `'light'`) its ground
   * stayed #2F2F31, and a re-mint issued by hand left it at #2F2F31 too. That
   * reading was taken while light glass was still inert (`6a90d30f`), so an
   * opaque light page ground could equally have explained it; it stopped being
   * inert on 2026-08-28 and the light half is a coat now, which means this is the
   * one claim here that a light session can finally contradict. If the window
   * ever goes light and the ground does NOT move off `--app-bg`, the material is
   * genuinely stuck in the appearance the window was born in, and a re-mint
   * belongs back at this spot — with that measurement written down beside it.
   *
   * WHAT IS NOT ESTABLISHED, corrected 2026-08-28 after an independent review
   * inspected the native hierarchy that pixels cannot see. An earlier version of
   * this comment claimed `setVibrancy` is asymmetric — that it cannot make a
   * window vibrant that is not — on the evidence that a window born WITHOUT the
   * `vibrancy` option stayed at #252525 after a later `setVibrancy` call. The
   * pixel was real and the inference was wrong: the call DOES create the
   * `NSVisualEffectView`, and that window's opaque backing simply covered it.
   * The backing cannot be cleared from JS afterwards (`setBackgroundColor` drops
   * the alpha on a window not born transparent, so it stays `#000000`), which is
   * why the pixel never moved.
   *
   * THE FAILURE THIS REPLACED, kept because it is unresolved rather than fixed,
   * and NOT a vibrancy fault at all. On 2026-08-28 the operator's window, in dark
   * with glass on, showed no effective material: with the page's own coat forced
   * to alpha 0 it composited to #FCFCFE, against #FFFFFF for a window drawing
   * nothing and #424242 for a correct one created seconds later in the SAME
   * process, same options, same display, same Space. `setVibrancy` in every
   * material did not bring it back.
   *
   * THE NATIVE VIEW WAS FINE, which is the thing to remember. Read out of the
   * live process before it was lost: exactly one `NSVisualEffectView` under the
   * content view, `material` 21, `state` active, `blendingMode` behind-window,
   * `alpha` 1, not hidden, `frame` {0,0,2560,1050} — an exact match for the
   * window's bounds, so it tracked the operator's resize correctly too. Every
   * "the view was dropped / stale / mis-sized" story is dead.
   *
   * SO SOMETHING ABOVE IT COMPOSITES OPAQUE. The corroborating measurement is
   * accidental: setting this window's background to opaque RED during probing
   * turned the ground #0F0F0F rather than red, which is Chromium repainting its
   * own base from the `color-scheme: dark` default (#121212). The web layer owns
   * a base colour and it responds; its default is white, and white under the 20%
   * coat lands at about #CECECE against the #D3D3D3 that was measured. Two
   * candidates remain and this JS cannot separate them: the window's own
   * `opaque` flag flipped, or the render surface lost the transparency the
   * `vibrancy` option gives it. The next read is one more native field —
   * `NSWindow.opaque` and its `backgroundColor` — not another pixel.
   *
   * Reproduction failed against re-mints, re-mints while hidden, maximize,
   * fullscreen, hide/show, minimize/restore, a move across displays of differing
   * backing scale, docked DevTools, and 100 reloads — but every one of those was
   * scored on the effect view, which we now know was never the casualty. They do
   * not rule out the surface.
   */

  ipcMain.on(CH_REFRESH_ACCOUNTS_POOL, event => {
    if (!isMainWindowSender(event)) return
    refreshAccountsPoolNow()
  })

  ipcMain.on(CH_OPEN_LOGS, () => {
    void shell.openPath(operationalLog.getDirectory())
  })
  ipcMain.handle(CH_SAVE_DIAGNOSTICS, async (): Promise<boolean> => {
    const result = mainWindow
      ? await dialog.showSaveDialog(mainWindow, { defaultPath: 'cat-code-diagnostics.json' })
      : await dialog.showSaveDialog({ defaultPath: 'cat-code-diagnostics.json' })
    if (result.canceled || !result.filePath) return false
    try {
      await writeFile(
        result.filePath,
        buildDiagnosticsBundle({
          logsDirectory: operationalLog.getDirectory(),
          appVersion: app.getVersion(),
          packaged: app.isPackaged,
          currentLaunchId: operationalLog.launchId,
          buildId: process.env.CATCODE_BUILD_ID,
          commitId: process.env.CATCODE_COMMIT_ID,
        }),
        'utf8',
      )
      return true
    } catch (error) {
      logOperational('diagnostic', 'error', { source: 'diagnosticsExport', reason: classifyFailure(error) })
      return false
    }
  })

  // IDLE-PARK §4(b) — the renderer reports which sessions are on screen so the
  // park policy skips them. Validated HERE, at the boundary, not at the preload
  // (`parseVisibleSessions` in mainDecisions.ts carries the trust reasoning). A
  // malformed payload yields an empty set, which protects nothing and parks
  // normally: this hint may only ever SUPPRESS a park, never cause one, and never
  // reaches a sidecar.
  ipcMain.on(CH_HOST_VISIBLE_SESSIONS, (_e, payload: unknown) => {
    visibleSessions = parseVisibleSessions(payload)
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
const attachmentFileTokens = createAttachmentFileTokenStore()

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
    CH_HOST_PICK_ATTACHMENT_FILE,
    async (
      event,
      appSessionId: unknown,
    ): Promise<AttachmentFileSelection | null> => {
      if (!isMainWindowSender(event) || typeof appSessionId !== 'string') return null
      const parent = mainWindow ?? undefined
      const result = parent
        ? await dialog.showOpenDialog(parent, { properties: ['openFile'] })
        : await dialog.showOpenDialog({ properties: ['openFile'] })
      if (result.canceled || result.filePaths.length === 0) return null
      try {
        const realpath = realpathSync(result.filePaths[0]!)
        const stats = statSync(realpath)
        if (!stats.isFile() || realpath.includes('"')) return null
        const handle = openSync(realpath, 'r')
        const header = new Uint8Array(12)
        let headerBytes = 0
        try {
          headerBytes = readSync(handle, header, 0, header.length, 0)
        } finally {
          closeSync(handle)
        }
        const mediaType = detectAttachmentImageMediaType(
          header.subarray(0, headerBytes),
        )
        if (mediaType) {
          if (stats.size > MAX_ATTACHMENT_SOURCE_IMAGE_BYTES) {
            return {
              kind: 'error',
              message: 'This image is too large to attach.',
            }
          }
          const bytes = readFileSync(realpath)
          if (bytes.byteLength > MAX_ATTACHMENT_SOURCE_IMAGE_BYTES) {
            return {
              kind: 'error',
              message: 'This image is too large to attach.',
            }
          }
          return {
            kind: 'image',
            name: basename(realpath),
            mediaType,
            bytes: new Uint8Array(bytes),
          }
        }
        return attachmentFileTokens.mint(appSessionId, realpath)
      } catch {
        return null
      }
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
      const descriptor = host
        .listSessions()
        .find(candidate => candidate.appSessionId === sessionId)
      if (descriptor?.engineSessionId) {
        const eligibility = resolveOpenHistorySession(
          descriptor.engineSessionId,
          [descriptor],
          readSessionsCatalogCache(defaultRegistryDir()),
        )
        if (eligibility.kind === 'reject') {
          return Promise.resolve({ ok: false, error: eligibility.error })
        }
      }
      // The host protects direct callers too, but claiming the replay gate here
      // prevents a losing IPC call from flushing the winning restore's shared
      // bootstrap batch.
      if (restoringSessions.has(sessionId)) {
        return Promise.resolve({
          ok: false,
          error: {
            code: 'session_not_found',
            message: `session ${sessionId} is already restoring`,
          },
        })
      }
      restoringSessions.add(sessionId)
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
      } finally {
        restoringSessions.delete(sessionId)
      }
    },
  )

  ipcMain.handle(
    CH_HOST_CLOSE,
    (event, appSessionId: unknown): Promise<HostResult<void>> => {
      const sessionId = String(appSessionId)
      // Provenance, logged BEFORE the close runs and from main rather than the
      // renderer, so it survives the teardown and any reload that follows. A
      // close kills the engine and ends the turn: on 2026-08-29 one arrived
      // that the operator did not make, and nothing recorded that it had been
      // asked for at all, which is why that investigation could not name the
      // caller. `close` is not `create`: it needs a record either way.
      if (!isMainWindowSender(event)) {
        logOperational(
          'session.close.requested',
          'warn',
          { source: 'ipc', reason: 'sender_rejected' },
          sessionId,
        )
        return Promise.resolve({
          ok: false,
          error: { code: 'session_not_found', message: 'unknown sender' },
        } satisfies HostResult<void>)
      }
      logOperational(
        'session.close.requested',
        'info',
        { source: 'renderer' },
        sessionId,
      )
      if (!host) return Promise.resolve(noHost<void>())
      return host.closeSession(sessionId)
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
        branchOpenSeed(engineSessionId),
      )
      if (resolution.kind === 'reject') {
        return Promise.resolve({ ok: false, error: resolution.error })
      }
      if (resolution.kind === 'existing') {
        // Already a ready app row — the renderer switches/restores it; no spawn.
        branchOpenSeeds.delete(resolution.descriptor.engineSessionId ?? '')
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
          ...(resolution.forked === true ? { forked: true } : {}),
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
            branchOpenSeeds.delete(engineId)
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

  // P4-35 (operator ruling 2026-07-30) — the app's ONLY file sink, and the exact
  // mirror of CH_HOST_PICK_DIR above. The renderer hands over TEXT plus a name
  // SUGGESTION and can express nothing else: `SaveTextInput` has no path field, so
  // there is no destination for it to author (HC1). Main decides where the bytes
  // go by asking the USER in its own native dialog, sanitizes the suggestion to a
  // basename it never joins to a directory itself, bounds the text, and performs
  // the write. Nothing about the chosen path travels back (HC1) — the result says
  // only whether a file was written.
  //
  // Deliberately NOT a host method and NOT a socket frame: it names no session,
  // reads no registry row and spawns nothing, so it adds zero inbound wire
  // vocabulary and never reaches a sidecar (SECURITY-MINIMUM, Addendum §control
  // plane). It is a main-owned capability like the picker.
  ipcMain.handle(
    CH_HOST_SAVE_TEXT,
    async (_e, input: unknown): Promise<SaveTextResult> => {
      const validated = validateSaveTextRequest(input)
      if (!validated.ok) {
        return {
          ok: false,
          error: { code: validated.code, message: validated.message },
        }
      }
      const parent = mainWindow ?? undefined
      const result = parent
        ? await dialog.showSaveDialog(parent, { defaultPath: validated.fileName })
        : await dialog.showSaveDialog({ defaultPath: validated.fileName })
      // A dismissal is a normal outcome the user chose, not an error to report.
      if (result.canceled || !result.filePath) return { ok: true, saved: false }
      try {
        await writeFile(result.filePath, validated.text, 'utf8')
      } catch (error) {
        // The path is main's, not the renderer's: log it here, and hand back a
        // message that does not carry it across the boundary.
        process.stderr.write(`[main] save-text write failed: ${errText(error)}\n`)
        return {
          ok: false,
          error: {
            code: 'write_failed',
            message: 'The file could not be written. Try another location.',
          },
        }
      }
      return { ok: true, saved: true }
    },
  )

  ipcMain.handle(
    CH_HOST_ACCOUNT_DELETE,
    async (_e, input: unknown): Promise<AccountResultFrame> => {
      const verb = parseAccountDeleteMessage(input)
      const failure = (
        message: string,
        requestId = verb?.requestId ?? '',
      ): AccountResultFrame => ({
        kind: 'account.result',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: '',
        requestId,
        verb: 'account.delete',
        ok: false,
        message,
      })
      if (!verb) return failure('Invalid account deletion request.', '')
      if (accountDeleteInFlight) {
        return failure('Another account deletion is already in progress.')
      }

      accountDeleteInFlight = true
      accountsPoolPublicationGate.invalidate()
      const abort = new AbortController()
      accountDeleteAbort = abort
      const delivery: { value: AccountsPoolWorkerDeleteResult | null } = {
        value: null,
      }
      try {
        const launch = sidecarLaunch()
        const outcome = await runAccountsPoolWorker({
          command: launch.command,
          args: launch.argsFor('accounts-pool', [
            '--bare',
            '--account-delete',
          ]),
          cwd: process.cwd(),
          signal: abort.signal,
          forceKillOnAbort: true,
          input: {
            type: 'account-delete',
            version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
            verb,
          },
          onAccountDelete: result => {
            delivery.value = result
          },
          log: line => process.stderr.write(`${line}\n`),
        })
        const delivered = delivery.value
        if (outcome !== 'delivered' || !delivered) {
          return failure('Could not delete that account.')
        }
        sendHostEvent({ type: 'accounts-pool', pool: delivered.pool })
        if (delivered.ok) {
          notifySidecarsOfAccountDeletion(
            verb.accountId,
            delivered.requestId,
          )
        }
        return {
          kind: 'account.result',
          protocolVersion: PROTOCOL_VERSION,
          sessionId: '',
          requestId: delivered.requestId,
          verb: 'account.delete',
          ok: delivered.ok,
          message: delivered.message,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        process.stderr.write(
          `[main] account delete worker failed: ${message}\n`,
        )
        return failure('Could not delete that account.')
      } finally {
        if (accountDeleteAbort === abort) accountDeleteAbort = null
        accountDeleteInFlight = false
      }
    },
  )

  ipcMain.handle(CH_HOST_OPEN_WORKSPACE_FILE, (_e, input: unknown): Promise<boolean> => {
    if (!host) return Promise.resolve(false)
    return openWorkspaceFile(input, host.listSessions(), (path, target) =>
      launchTargetOpener(path, target),
    )
  })
}

function launchTargetOpener(
  path: string,
  target?: OpenWorkspaceFileTarget,
): Promise<boolean | string> {
  if (target === 'finder') {
    shell.showItemInFolder(path)
    return Promise.resolve(true)
  }
  if (target === 'vscode') {
    return launchEditorApp(['Visual Studio Code'], ['code'], path)
  }
  if (target === 'zed') {
    return launchEditorApp(['Zed'], ['zed'], path)
  }
  if (target === 'cursor') {
    return launchEditorApp(['Cursor'], ['cursor'], path)
  }
  return shell.openPath(path)
}

function launchEditorApp(
  appNames: readonly string[],
  cliBinaries: readonly string[],
  filePath: string,
): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    let resolved = false
    const finish = (ok: boolean) => {
      if (!resolved) {
        resolved = true
        resolve(ok)
      }
    }

    if (process.platform === 'darwin' && appNames.length > 0) {
      try {
        const child = spawn('open', ['-a', appNames[0], filePath], {
          stdio: 'ignore',
        })
        child.on('error', () => {
          tryCliFallback()
        })
        child.on('exit', code => {
          if (code === 0) finish(true)
          else tryCliFallback()
        })
      } catch {
        tryCliFallback()
      }
      return
    }

    tryCliFallback()

    function tryCliFallback() {
      if (cliBinaries.length === 0) {
        finish(false)
        return
      }
      runDetachedCliFallbackSpawn({
        spawn: () =>
          spawn(cliBinaries[0], [filePath], {
            detached: true,
            stdio: 'ignore',
          }),
        setTimer: (run, ms) => setTimeout(run, ms),
        settleDelayMs: 150,
      }).then(finish)
    }
  })
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

/**
 * Hand a renderer message to the supervisor. Returns the closed code of the
 * failure it synthesized, or null when the message was handed over.
 *
 * The return value exists for one caller: a submit that never reached the
 * supervisor is a certain loss, and only main knows it happened
 * (`answerUnforwardedSubmit`). Every other caller ignores it, exactly as before.
 *
 * This is also where main AUTHORS the load-earlier view anchor
 * (decisions/HISTORY-LOAD-EARLIER.md §The view anchor). It is stamped here, not
 * in the IPC handler, because this is the one point every renderer frame passes
 * through on its way to a sidecar: a second route into the verb would inherit
 * the property instead of needing to remember it. The renderer's own value is
 * dropped rather than merged (`stampHistoryViewAnchor`), so nothing
 * renderer-authored widens the inbound surface.
 */
function forward(
  sessionId: SessionId,
  message: SidecarClientMessage,
): ErrorFrame['code'] | null {
  if (!SESSION_ID_RE.test(sessionId)) return 'bad_request'
  message = stampHistoryViewAnchor(
    message,
    attachmentGate.viewAnchorUuid(sessionId),
  )

  if (!supervisor) {
    const frame: ServerFrame = {
      kind: 'error',
      protocolVersion: PROTOCOL_VERSION,
      sessionId,
      ...('requestId' in message && typeof message.requestId === 'string'
        ? { requestId: message.requestId }
        : {}),
      code: 'session_not_found',
      message: 'That session is no longer available.',
      retryable: false,
    }
    deliver(attachmentGate.onFrame(sessionId, frame))
    process.stderr.write(`[main] forward to ${sessionId} failed: no live host\n`)
    return 'session_not_found'
  }
  try {
    supervisor.send(sessionId, message)
    return null
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
    return code
  }
}

function sanitizeSubmitOptions(options: unknown): {
  isMeta?: boolean
  goalSnapshot?: unknown
  submitId?: string
} | undefined {
  if (typeof options !== 'object' || options === null) return undefined
  const o = options as {
    isMeta?: unknown
    goalSnapshot?: unknown
    submitId?: unknown
  }
  const result: { isMeta?: boolean; goalSnapshot?: unknown; submitId?: string } = {}
  if (typeof o.isMeta === 'boolean') result.isMeta = o.isMeta
  // goalSnapshot passed through as-is; the SIDECAR validates it (T4).
  if ('goalSnapshot' in o) result.goalSnapshot = o.goalSnapshot
  // The renderer's own correlation id (SubmitOptions.submitId). Admitted rather
  // than stripped, because it is what lets the renderer pair the answer with the
  // message it is holding. Bounded here for UX and re-validated at the sidecar,
  // which is the trust boundary; anything else is dropped, exactly like a
  // non-boolean `isMeta`.
  if (
    typeof o.submitId === 'string' &&
    o.submitId.length > 0 &&
    o.submitId.length <= MAX_TEXT_FIELD_CHARS
  ) {
    result.submitId = o.submitId
  }
  return result
}

function readFileAttachmentToken(options: unknown): string | undefined {
  if (typeof options !== 'object' || options === null) return undefined
  const token = (options as { fileAttachmentToken?: unknown }).fileAttachmentToken
  return typeof token === 'string' && token.length > 0 && token.length <= MAX_TEXT_FIELD_CHARS
    ? token
    : undefined
}

/**
 * Answer a submit main could not forward at all, with the renderer's own
 * correlation id (SubmitResultFrame). `forward` already synthesized the `error`
 * frame that says WHY; this is what tells the renderer WHICH message is gone, so
 * the copy it is holding comes back with its image instead of being stranded.
 *
 * Main is the only party that can send this one: the supervisor never saw the
 * frame, so no sidecar will ever answer it. It is a certain loss, and the
 * renderer used to be told nothing at all.
 */
function answerUnforwardedSubmit(
  sessionId: SessionId,
  submitId: string | undefined,
  code: ErrorFrame['code'],
): void {
  if (submitId === undefined) return
  deliver(
    attachmentGate.onFrame(sessionId, {
      kind: 'submit.result',
      protocolVersion: PROTOCOL_VERSION,
      sessionId,
      submitId,
      accepted: false,
      code,
    }),
  )
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
 * composition. Called on startup AND on macOS `activate` (F5), so reopening the
 * window after `window-all-closed` creates a functioning host without reviving
 * the shut-down supervisor.
 *
 * The single-instance lock (taken in `whenReady`, REGISTRY §5) guarantees this
 * is the ONLY writer of the registry file, so its launch sweep runs unraced.
 */
function ensureHost(): Host {
  if (host) return host
  supervisor = createSupervisor()
  wireRendererBridge(supervisor)

  // The registry lives beside the supervisor in the host plane. Default storage
  // dir (<config-home>/desktop) unless overridden for tests. The session
  // sidecar's own launch string is the §9-A3 orphan-identity marker so the
  // launch sweep never SIGTERMs an innocent same-pid process.
  const registry = new SessionRegistry({
    sidecarCommandMarker: sidecarLaunch().identityMarker,
    log: line => logLegacyDiagnostic(line, 'registry', 'host'),
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
    log: line => logLegacyDiagnostic(line, 'host', 'host'),
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

  // HOST-REQUEST-PLANE §5 — the request plane, composed from the same host and
  // registry this function just built. It gets NARROW capabilities on purpose:
  // two read-only registry views, the two host methods its three verbs need,
  // main's own `forward`, and one log writer. It cannot reach a window, a file,
  // the supervisor, or any host method beyond these — which is what makes the
  // §3 trust rules reviewable in one module instead of across main.
  const liveHost = host
  const liveRegistry = registry
  peerPlane = createPeerRequestPlane({
    rows: () => liveRegistry.sessions,
    isLive: appSessionId =>
      supervisor?.listSessions().some(row => row.sessionId === appSessionId) === true,
    createSessionInWorkspace: (fromAppSessionId, peer) =>
      liveHost.createSessionInWorkspace(fromAppSessionId, peer),
    restoreSession: async appSessionId => {
      const result = await liveHost.restoreSession(appSessionId)
      return result.ok ? { ok: true } : { ok: false, error: result.error }
    },
    forward,
    logRouted: (appSessionId, fields) =>
      logOperational('peer.message.routed', 'info', fields, appSessionId),
    log: line => logLegacyDiagnostic(line, 'host', 'main'),
  })

  // IS-A startup GC: after the launch sweep settles (its reaps predate the
  // HostEvent subscription, so they emit no session-removed), drop any orphaned
  // cache file whose row is no longer restorable.
  void launched.then(() => gcTranscriptCache())

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

/** A stable, non-content failure classification for persistent diagnostics. */
function classifyFailure(error: unknown): string {
  return error instanceof Error ? 'error' : 'unknown_failure'
}

// Single-instance lock (REGISTRY §5 / R5): the registry is a shared mutable file
// and the host is its SINGLE writer by construction. Take the OS lock BEFORE any
// host is constructed; a second app instance never builds a host — it focuses the
// existing window and quits. This is the client-layer half of the write
// discipline (the module-layer advisory lockfile is the belt to this braces).
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  logOperational('app.single_instance.refused', 'info')
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
    logOperational('app.ready', 'info')
    // BrowserWindow's `icon` option doesn't reach the Dock tile (SECURITY-MINIMUM
    // is silent on this — it's cosmetic, not a trust boundary); the Dock image
    // comes from the running bundle's own Info.plist/icns unless overridden here.
    if (process.platform === 'darwin') {
      app.dock?.setIcon(nativeImage.createFromPath(APP_ICON_PATH))
    }
    applySecurityBaseline()
    scheduleDebugCleanup()
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

/**
 * B3 — mark live rows CLEAN, then kill the sidecars. A clean quit must not
 * resurface as crash recovery on the next launch. Falls back to a bare
 * supervisor shutdown if the host never came up. Synchronous throughout
 * (`markLiveCleanSync`), so it is safe on a path that exits immediately after.
 */
function shutdownRuntime(): void {
  if (host) {
    host.shutdownAll()
  } else {
    supervisor?.shutdown()
  }
}

/**
 * Stop every post-paint driver and abort any worker already in flight. Shared by
 * all three teardown routes (window-all-closed, before-quit, signal) so a driver
 * added to one can never be forgotten in the others. Idempotent.
 *
 * `stop()` cancels only the NEXT scheduled run, so each abort controller rides
 * beside it to reach a worker child that is already spawned; `startupTimers.cancelAll`
 * covers the window where a driver has not been armed yet.
 */
function stopBackgroundDrivers(): void {
  startupTimers.cancelAll()
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
  accountDeleteAbort?.abort()
  accountDeleteAbort = null
  pendingAccountDeletionNotices.clear()
  idleParkDriver?.stop()
  idleParkDriver = null
  // The window that reported them is going away; a stale visible set must not
  // outlive it and protect sessions in a re-armed driver after reactivate.
  visibleSessions = new Set()
}

/**
 * Ctrl-C in the dev launcher — and any other SIGTERM — kills Electron outright:
 * neither `window-all-closed` nor `before-quit` runs, so `host.shutdownAll()`
 * never marks live rows clean and the NEXT launch's orphan sweep
 * (`host/registry.ts` sweepOrphans) reports every session of this run as
 * `crashed`. Marking is synchronous, so it completes before the exit below.
 *
 * `app.exit` rather than `app.quit`: the teardown has already run here, and
 * `quit` would re-enter it through `before-quit`.
 */
let signalTeardownStarted = false
function teardownOnSignal(signal: 'SIGINT' | 'SIGTERM'): void {
  if (signalTeardownStarted) return
  signalTeardownStarted = true
  stopBackgroundDrivers()
  shutdownRuntime()
  cancelAllReplayFlushes()
  // Without these the launch has no completion record, so every later export
  // reads a Ctrl-C run as an interrupted launch and reports the whole window's
  // evidence as incomplete. Same pair `before-quit` writes; both are synchronous
  // enough to land before the exit below.
  logOperational('app.shutdown.started', 'info', { reason: signal === 'SIGINT' ? 'sigint' : 'sigterm' })
  logOperational('app.shutdown.completed', 'info')
  logOperational('process.exited', 'info', { role: 'electron-main', signal, expected: true })
  operationalLog.close()
  deliveryTrace.close()
  app.exit(signal === 'SIGINT' ? 130 : 143)
}

process.on('SIGINT', () => teardownOnSignal('SIGINT'))
process.on('SIGTERM', () => teardownOnSignal('SIGTERM'))

app.on('window-all-closed', () => {
  // On darwin this route parks in the dock (see the platform branch at the end):
  // the runtime goes away, the process does not, and `app.shutdown.completed`
  // correctly never arrives. Logging it as a shutdown start therefore read as a
  // shutdown that hung, which cost the 2026-08-10 investigation a full pass.
  // Elsewhere `app.quit()` below really does start a shutdown.
  if (process.platform === 'darwin') {
    logOperational('app.parked.windowless', 'info')
  } else {
    logOperational('app.shutdown.started', 'info', { reason: 'window-all-closed' })
  }
  // D6: die-with-window for v1 — tear down every sidecar via the supervisor's
  // kill API (NOT by welding the sidecar to the window's lifecycle). `activate`
  // rebuilds the host on reopen (F5).
  shutdownRuntime()
  // Drivers are window-scoped: a fresh `activate` re-arms them after the next paint.
  stopBackgroundDrivers()
  supervisor = null
  // Drop the host too so `ensureHost` rebuilds supervisor + registry + host as a
  // unit on the next `activate` (a fresh registry re-reads the file and re-runs
  // its launch sweep).
  host = null
  registryForDebug = null
  scheduleDebugStateExport.cancel()
  // F2 — drop buffered frames from the closed window so a macOS reopen never
  // replays dead-session frames into the new renderer.
  attachmentGate.reset()
  cancelAllReplayFlushes()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  logOperational('app.shutdown.started', 'info', { reason: 'before-quit' })
  // B3 — same clean-marking on ⌘Q; idempotent if window-all-closed already ran
  // (no live rows left to mark).
  shutdownRuntime()
  stopBackgroundDrivers()
  logOperational('app.shutdown.completed', 'info')
  logOperational('process.exited', 'info', { role: 'electron-main', expected: true })
  operationalLog.close()
  deliveryTrace.close()
})

process.on('uncaughtException', error => {
  operationalLog.flushFatal({
    level: 'fatal',
    event: 'app.fatal',
    process: 'main',
    fields: { reason: classifyFailure(error) },
  })
  app.exit(1)
})
process.on('unhandledRejection', reason => {
  operationalLog.flushFatal({
    level: 'fatal',
    event: 'app.fatal',
    process: 'main',
    fields: { reason: classifyFailure(reason) },
  })
  app.exit(1)
})
