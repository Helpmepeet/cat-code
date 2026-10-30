import { createExternalUrlHandler } from './externalUrl.js'
import { CH_OPEN_EXTERNAL_URL } from '../shared/ipcChannels.js'
import { createLocalhostPreviewService } from './localhostPreview.js'
import { CH_LOCALHOST_PREVIEW_CAPTURE } from '../shared/ipcChannels.js'
import { CH_LOCALHOST_PREVIEW_PREPARE, CH_LOCALHOST_PREVIEW_NAVIGATE, CH_PREVIEW_BLOCKED_NAVIGATION_OPEN } from '../shared/ipcChannels.js'
import { createFilePreviewService, parseFilePreviewUrl } from './filePreview.js'
import { createPreviewApplications } from './previewApplications.js'
import { FILE_PREVIEW_SCHEME, normalizeLocalhostPreviewUrl, type FilePreviewScroll } from '../shared/filePreview.js'
import { CH_FILE_PREVIEW_PREPARE, CH_FILE_PREVIEW_REFRESH, CH_FILE_PREVIEW_COMMIT, CH_FILE_PREVIEW_RELEASE, CH_FILE_PREVIEW_EVENT, CH_FILE_PREVIEW_SCROLL_READ, CH_FILE_PREVIEW_SCROLL_RESTORE, CH_FILE_PREVIEW_APPLICATIONS, CH_FILE_PREVIEW_APPLICATION_CHOOSE } from '../shared/ipcChannels.js'
import { parseInlineCommandPayload } from './inlineCommandPayload.js'
import { LidClosedMode, lidHelperInstalled } from './lidClosedMode.js'
import { lidClosedMenu } from './lidClosedMenu.js'
import { LidNativeClient, inspectLidHardware, installLidHelper, lidHelperCurrent } from './lidClosedNative.js'
import { LidWorkObserver, type LidWorkSession } from './lidWorkObserver.js'
import { isWorkStatusRequest, type WorkStatusRequest } from '../shared/workStatus.js'
import { isLidModeCommand } from '../shared/lidClosed.js'
import { DesktopPower } from './desktopPower.js'
import { NativePowerObservation } from './powerObservation.js'
import { SleepAssertionOwner } from '../shared/sleepAssertion.js'
import { CH_LID_READ, CH_LID_COMMAND, CH_LID_CHANGED } from '../shared/ipcChannels.js'
import { ScheduledTasks } from '../host/scheduledTasks.js'
import { parseScheduledTaskCommand, type ScheduledTasksSnapshot, type ScheduledTasksResult } from '../shared/scheduledTasks.js'
import { launchScheduledSession } from './scheduledTaskRunner.js'
import { workspaceMapSchedule } from './workspaceMapSchedule.js'
import { CH_SCHEDULED_TASKS_READ, CH_SCHEDULED_TASKS_COMMAND, CH_SCHEDULED_TASK_OPTIONS_READ } from '../shared/ipcChannels.js'
import { validScheduledTaskOptionsPayload } from '../shared/scheduledTaskOptions.js'
import { runScheduledTaskOptionsWorker } from './scheduledTaskOptionsRunner.js'
import { ScheduledTaskOptionsService } from './scheduledTaskOptionsService.js'
import { createDirectoryPickerHandlers } from './directoryPicker.js'
import { ProjectStore } from './projectStore.js'
import { ProjectCreationController } from './projectCreation.js'
import { registerProjectIpc } from './projectIpc.js'
import type { DesktopProject } from '../shared/projects.js'
import { runSessionRelocationWorker } from './sessionRelocationRunner.js'
import { parseMoveSessionCommand } from '../shared/sessionRelocationWorker.js'
import { FileProjectRoutingStore } from './projectRoutingStore.js'
import { ProjectRoutingController } from './projectRoutingController.js'
import { WorkspaceJumpCoordinator, loadWorkspaceJumpRetention } from './workspaceJumpCoordinator.js'
import { SessionCloseCoordinator } from './sessionCloseCoordinator.js'
import { WorkspaceHandoffControl, type WorkspaceControlAction, type WorkspaceControlDelivery } from './workspaceHandoffControl.js'
import { runWorkspaceListingWorker } from './workspaceListingRunner.js'
import {
  parseProjectRouteCommand,
  type ProjectRouteSnapshot,
} from '../shared/projectRouting.js'
import {
  createUsagePublication,
  isUsageDashboardEnabled,
  runUsageStatsWorker,
  USAGE_REFRESH_INTERVAL_MS,
} from './usageStatsRunner.js'
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
  clipboard,
  dialog,
  ipcMain,
  Menu,
  Notification,
  nativeImage,
  nativeTheme,
  powerMonitor,
  protocol,
  screen,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createAccountControlRunner } from './accountControlRunner.js'
import { parseAccountControlVerb } from '../shared/accountControlWorker.js'
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
import { ManagedStorage } from '../host/managedStorage.js'
import {
  MAX_ATTACHMENT_SOURCE_IMAGE_BYTES,
  type AttachmentFileSelection,
  type HostEvent,
  type HostResult,
  type SaveTextResult,
  type SettingsInventoryReadResult,
  type SettingsWriteReadResult,
  type SessionDescriptor,
  type SwitchWorkspaceBranchResult,
  type WorkspaceBranches,
  type WorkspaceBranchObservation,
} from '../shared/hostApi.js'
import {
  gitRoot,
  listWorkspaceBranches,
  createWorkspaceBranchSwitcher,
  createSessionBranchReader,
} from './workspaceBranches.js'
import { createSavedWorkspaceObservationReader, runWorkspaceObservationWorker } from './workspaceObservationRunner.js'
import {
  DEBUG_SHELL_STATE_CHANNEL,
  DEBUG_STATE_VERSION,
  type DebugRendererSnapshot,
  type DebugStateFile,
} from '../shared/debugState.js'
// The fixed internal channel names, shared with the preload so both ends listen
// and send on the same literals by construction (SECURITY-MINIMUM HC3).
import {
  CH_SUBMIT,
  CH_ABORT,
  CH_PERMISSION,
  CH_ANSWER_QUESTIONS,
  CH_SET_MODE,
  CH_ACCOUNT_VERB,
  CH_HOST_MANAGE_ACCOUNT,
  CH_WORKSPACE_TRUST_VERB,
  CH_TASK_CONTROL_VERB,
  CH_INLINE_COMMAND_START,
  CH_INLINE_COMMAND_STOP,
  CH_INLINE_COMMAND_GET,
  CH_RUN_CONTROL_VERB,
  CH_PROMPT_FORCE,
  CH_PROMPT_RECALL,
  CH_CONTEXT_BREAKDOWN_VERB,
  CH_HISTORY_LOAD_EARLIER,
  CH_SESSION_ACTION_VERB,
  CH_REMOTE_SETTINGS_VERB,
  CH_SETTINGS_VERB,
  CH_PING,
  CH_RESTART,
  CH_SERVER_FRAME,
  CH_RENDERER_READY,
  CH_DELIVERY_ACK,
  CH_RENDERER_FAULT,
  CH_SET_APPEARANCE,
  CH_SET_GLASS_MODE,
  CH_OPEN_LOGS,
  CH_SAVE_DIAGNOSTICS,
  CH_DELIVERY_HEALTH_PROBE,
  CH_DELIVERY_HEALTH_RESPONSE,
  CH_REFRESH_ACCOUNTS_POOL,
  CH_REFRESH_USAGE_DASHBOARD,
  CH_READ_SETTINGS_INVENTORY,
  CH_WRITE_DURABLE_SETTING,
  CH_PICK_SETTINGS_PROJECT,
  // Control plane (HC3 — fixed, per-method structured senders). `invoke`
  // channels return a typed HostResult; `pick-directory` returns a realpath or
  // null (the native picker, HC1); the host-event channel is a one-way stream.
  CH_HOST_CREATE,
  CH_HOST_CREATE_MANAGED,
  CH_HOST_MOVE_SESSION,
  CH_HOST_PROJECT_ROUTES,
  CH_HOST_RESOLVE_PROJECT_ROUTE,
  CH_HOST_FOLDER_STATE,
  CH_HOST_FOLDER_RECREATE,
  CH_HOST_FOLDER_OPEN,
  CH_HOST_FOLDER_COPY,
  CH_HOST_CREATE_IN_WORKSPACE,
  CH_HOST_LIST_BRANCHES,
  CH_HOST_SWITCH_BRANCH,
  CH_HOST_RESTORE,
  CH_HOST_CLOSE,
  CH_HOST_SET_PEER_WAKE_BLOCKED,
  CH_HOST_LIST,
  CH_HOST_PICK_DIR,
  CH_HOST_PICK_SCHEDULED_TASK_DIR,
  CH_HOST_PICK_ATTACHMENT_FILE,
  CH_HOST_PREVIEW,
  CH_HOST_SESSIONS_CATALOG,
  CH_HOST_OPEN_HISTORY,
  CH_HOST_SAVE_TEXT,
  CH_HOST_OPEN_WORKSPACE_FILE,
  CH_HOST_WORKSPACE_FILE_AVAILABILITY,
  CH_HOST_ACCOUNT_DELETE,
  CH_HOST_ACCOUNT_SIGN_OUT,
  CH_HOST_EVENT,
  CH_HOST_VISIBLE_SESSIONS,
} from '../shared/ipcChannels.js'
import {
  AttachmentGate,
  LAZY_REPLAY_FLUSH_MS,
} from './attachmentGate.js'
import {
  createLiveFrameDeliveryCoordinator,
  createAttachedFrameDeliveryCoordinator,
  createRendererReadyTracker,
  createRendererLossTransition,
  type LiveFrameDeliveryCoordinator,
  type LiveFrameDeliveryOrigin,
} from './liveFrameBatcher.js'
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
  selectTranscriptBackfillCandidates,
  frameMutatedAccountsPool,
  stampHistoryViewAnchor,
  supervisorEventToServerFrame,
  isSessionLive,
  isSessionReadyForFrames,
  isUserTurnSubmit,
  requiresWorkAdmission,
  canForwardWorkspaceInput,
  inlineCommandRefusalFrame,
  validateSaveTextRequest,
} from './mainDecisions.js'
import {
  createPeerRequestPlane,
  type PeerRequestPlane,
} from './peerRequestPlane.js'
import { applyGlassWindowBackground, readGlassPreference, writeGlassPreference } from './glassPreference.js'
import { readNotificationPreference, writeNotificationPreference } from './notificationPreference.js'
import { registerNotificationPreferenceIpc, registerNotificationRetryIpc, registerNotificationRetryBlockedIpc } from './notificationPreferenceIpc.js'
import { createDesktopNotifications } from './desktopNotifications.js'
import { createNotificationVisibility, registerNotificationVisibilityIpc } from './notificationVisibility.js'
import type { NotificationPreferences } from '../shared/notificationPreferences.js'
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
  retainCachedImagePreviews,
  resolvePreview,
  transcriptCacheDir,
  writeCache,
} from './transcriptCache.js'
import { readTranscriptRunFacts } from '../shared/transcriptRunFacts.js'
import { readSessionsCatalogCache } from './sessionsCatalogBaseline.js'
import { inspectSessionsCatalogSources } from '../shared/sessionsCatalogFingerprint.js'
import {
  resolveBranchOpenHistorySeed,
  resolveOpenHistorySession,
  type TrustedOpenHistorySeed,
} from './openHistorySession.js'
import { openWorkspaceFile, resolveWorkspaceFile, type OpenWorkspaceFileTarget, type SourceLocation } from './openWorkspaceFile.js'
import { createExternalAppIconService } from './externalAppIcons.js'
import { createExternalAppIconHandler } from './externalAppIconRequest.js'
import { CH_HOST_EXTERNAL_APP_ICON } from '../shared/ipcChannels.js'
import { launchEditorApp } from './editorLauncher.js'
import { workspaceFileAvailability } from './workspaceFileAvailability.js'
import {
  persistTranscriptBackfillResult,
  runTranscriptBackfill,
} from './transcriptBackfill.js'
import { MAX_TRANSCRIPT_BACKFILL_SESSIONS } from '../shared/transcriptBackfill.js'
import {
  SESSIONS_CATALOG_REFRESH_INTERVAL_MS,
  runSessionsCatalogWorker,
} from './sessionsCatalogRunner.js'
import {
  createSingleFlightDriver,
  type SingleFlightDriver,
} from './singleFlightDriver.js'
import { createVisibilityGatedRefresh } from './refreshActivityGate.js'
import {
  accountProfileSignedOutNoticeForReceipt,
  createAccountInvalidationDispatcher,
} from './accountInvalidation.js'
import {
  ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
  parseAccountDeleteMessage,
  parseAccountLogoutMessage,
  type AccountsPoolWorkerSignOutResult,
  type AccountsPoolWorkerDeleteResult,
} from '../shared/accountsPoolWorker.js'
import {
  ACCOUNTS_POOL_REFRESH_INTERVAL_MS,
  createAccountsPoolPublicationGate,
  runAccountsPoolRefresh,
  runAccountsPoolWorker,
} from './accountsPoolRunner.js'
import { runSettingsInventoryWorker } from './settingsInventoryRunner.js'
import { resolveSettingsInventoryCwd, settingsInventoryScopeArgs, settingsWriteMatchesScope } from './settingsInventoryAccess.js'
import { runSettingsWriteWorker } from './settingsWriteRunner.js'
import { parseSettingsWriteWorkerRequest } from '../shared/settingsWriteWorker.js'
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
} from './devHarness.js'
import {
  decideWindowOpen,
  isAppOrigin,
  type NavigationConfig,
} from './navigationPolicy.js'
import { decodeImageDataUrl, planContextMenu } from './contextMenuPolicy.js'
import { MAX_SUGGESTION_SELECTIONS, MAX_TEXT_FIELD_CHARS, PARKED_EXIT_CODE } from '../shared/limits.js'
import { createOperationalLogSink } from './operationalLogSink.js'
import { createOperationalRecord } from '../shared/operationalLog.js'
import { createDeliveryTraceSink, deliveryMessageKindOfFrame } from './deliveryTraceSink.js'
import { saveDiagnosticsBundle } from './saveDiagnosticsBundle.js'
import { mintDeliveryTrace, replayDeliveryTrace, type DeliveryAcknowledgement, type DeliveryStage } from '../shared/deliveryTrace.js'
import {
  SESSION_ACCOUNT_VERB_TYPES,
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
  type AccountResultFrame,
  type AccountProfileSignedOutMessage,
  type AccountSignOutReceipt,
  type AskUserQuestionAnswerMessage,
  type PermissionSetModeMode,
  type ServerFrame,
  type ErrorFrame,
  type SessionId,
  type SubmitPrompt,
  type SessionsCatalogSnapshot,
  type SidecarClientMessage,
  type TranscriptCache,
} from '../shared/protocol.js'
const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * The macOS material `createWindow` mounts, and the ONLY place it is ever set.
 * Nothing re-asserts it at runtime, and the doc block beside the appearance
 * channel records why that listener was removed rather than kept.
 */
const WINDOW_VIBRANCY = 'under-window' as const

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
  const source = host
    ?.listSessions()
    .find(descriptor => descriptor.appSessionId === appSessionId)
  const seed = resolveBranchOpenHistorySeed(frame, source)
  if (!seed || !source) return
  // The branch transcript exists as soon as this result arrives. Persist its
  // managed-storage ownership before forwarding the result makes it openable;
  // the bounded seed below only covers catalog lag in this process.
  if (
    source.binding?.kind === 'managed' &&
    !host?.recordManagedBranch(appSessionId, seed.engineSessionId)
  ) {
    logLegacyDiagnostic(
      `could not durably record managed branch ${seed.engineSessionId}`,
      'host',
      'main',
    )
  }
  const now = Date.now()
  branchOpenSeeds.delete(seed.engineSessionId)
  branchOpenSeeds.set(seed.engineSessionId, {
    ...seed,
    expiresAt: now + BRANCH_OPEN_SEED_TTL_MS,
  })
  pruneBranchOpenSeeds(now)
}

function branchOpenSeed(engineSessionId: unknown): TrustedOpenHistorySeed | undefined {
  pruneBranchOpenSeeds()
  if (typeof engineSessionId !== 'string') return undefined
  return branchOpenSeeds.get(engineSessionId)
}

const APP_ORIGIN_DEV = process.env.CATCODE_RENDERER_URL ?? 'http://localhost:5173'
protocol.registerSchemesAsPrivileged([{ scheme: FILE_PREVIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])

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
let scheduledTasks: ScheduledTasks | null = null
let scheduledTasksError: string | undefined
let projectRouting: ProjectRoutingController | null = null
let workspaceJump: WorkspaceJumpCoordinator | null = null
const observedWorkspaceHandoffs = new Map<string, { generation: string; operationId: string; tipUuid: string; toolUseId: string }>()
let workspaceControl: WorkspaceHandoffControl | null = null
let workspaceStatusTimer: ReturnType<typeof setInterval> | null = null
let mainWindow: BrowserWindow | null = null
let desktopNotifications: ReturnType<typeof createDesktopNotifications> | null = null
let notificationPreferences: NotificationPreferences | null = null
let notificationRetryBlocked = new Set<SessionId>()
let pendingNotificationOpen: Extract<HostEvent, { type: 'notification-open' }> | null = null
let notificationScreenSuspended = false
let notificationScreenLocked = false
let notificationUserInactive = false
const notificationVisibility = createNotificationVisibility({
  hasSession: id => host?.getSessionDescriptor(id) !== undefined,
  screenAvailable: () => !notificationScreenSuspended && !notificationScreenLocked &&
    !notificationUserInactive && powerMonitor.getSystemIdleState(1) !== 'locked',
  changed: id => desktopNotifications?.onScreenChanged(id),
})

function openNotificationSession(sessionId: SessionId, accounts = false): void {
  const session = host?.listSessions().find(row => row.appSessionId === sessionId)
  if (!session || !mainWindow || mainWindow.isDestroyed()) return
  pendingNotificationOpen = { type: 'notification-open', appSessionId: sessionId, accounts }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  flushNotificationOpen()
}

function flushNotificationOpen(): void {
  if (!pendingNotificationOpen || !attachmentGate.isAttached || !deliverableContents()) return
  const session = host?.listSessions().find(row => row.appSessionId === pendingNotificationOpen!.appSessionId)
  if (!session || (sendHostEvent({ type: 'session-status', session }) && sendHostEvent(pendingNotificationOpen))) pendingNotificationOpen = null
}

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
let liveFrameDelivery: LiveFrameDeliveryCoordinator | null = null
let attachedFrameDelivery: ReturnType<typeof createAttachedFrameDeliveryCoordinator> | null = null
let handleRendererDeliveryFailure: ((error: unknown) => void) | null = null
let markRendererDocumentReady: ((documentId: string) => void) | null = null
let disposeRendererRecovery: (() => void) | null = null
const replayFlushTimers = new Map<SessionId, ReturnType<typeof setTimeout>>()
const restoringSessions = new Set<SessionId>()
// A host row records lastMessageSentAt only after a turn result. Branch
// switching must also refuse the interval from accepted submit to result.
const sessionsWithSubmit = new Set<SessionId>()
// Set before the first asynchronous Git read. All prompt paths consult this
// while an empty session is being moved to another branch.
const switchingSessionIds = new Set<SessionId>()
const closeHostUnavailable = (): HostResult<void> => ({
  ok: false, error: { code: 'spawn_failed', message: 'host is not running' },
})
const sessionCloseCoordinator = new SessionCloseCoordinator({
  authorize: sessionId => host ? host.authorizeCloseCancellation(sessionId) : Promise.resolve(closeHostUnavailable()),
  blocked: sessionId => Boolean(switchingSessionIds.has(sessionId) || workspaceJump?.isReserved(sessionId) ||
    host?.isMoving(sessionId) || host?.isRestoring(sessionId)),
  cancel: async sessionId => {
    projectRouting?.cancel(sessionId)
    if (workspaceJump?.isReserved(sessionId)) await workspaceJump.cancel(sessionId, undefined, 'close')
  },
  observe: sessionId => workspaceJump?.queryStatus(sessionId),
  close: sessionId => host ? host.closeSession(sessionId) : Promise.resolve(closeHostUnavailable()),
  onFailure: (sessionId, error) => logLegacyDiagnostic(`close cleanup failed for ${sessionId}: ${String(error)}`, 'host', 'main'),
})

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
 * (`transcriptCacheDir()`), same trust domain as the registry
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
let sessionsCatalogDriver: SingleFlightDriver | null = null
let sessionsCatalogActivityGate: ReturnType<typeof createVisibilityGatedRefresh> | null = null

/**
 * Accounts owner (`decisions/ACCOUNTS-OWNERSHIP.md`): the account pool is
 * process-GLOBAL state, so its read is main-owned rather than per-session — one
 * single-flight driver per app process, armed after first paint, delivering each
 * accepted redacted snapshot as a read-only `accounts-pool` host event. Same
 * lifecycle as `sessionsCatalogDriver`.
 */
const usagePublication = createUsagePublication()
let usageDriver: SingleFlightDriver | null = null
let usageActivityGate: ReturnType<typeof createVisibilityGatedRefresh> | null = null
let usageAbort: AbortController | null = null
let usagePending = false
const usageEnabled = isUsageDashboardEnabled()
let accountsPoolDriver: SingleFlightDriver | null = null
let accountsPoolActivityGate: ReturnType<typeof createVisibilityGatedRefresh> | null = null
let accountControl: ReturnType<typeof createAccountControlRunner> | null = null
let scheduledOptions: ScheduledTaskOptionsService | null = null
let accountProfileMutationInFlight = false
let accountProfileMutationAbort: AbortController | null = null
const accountsPoolPublicationGate = createAccountsPoolPublicationGate()
const accountInvalidation = createAccountInvalidationDispatcher({
  send: (sessionId, notice) => {
    try {
      supervisor?.send(sessionId, notice)
      return true
    } catch (error) {
      process.stderr.write(
        `[main] account invalidation notice to ${sessionId} deferred: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      )
      return false
    }
  },
})

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
const settingsInventoryReads = new Set<AbortController>()
const settingsWriteRuns = new Set<AbortController>()
/** Directories explicitly chosen for Settings in this app process. */
const settingsPickedProjects = new Set<string>()
let settingsWriteTail: Promise<void> = Promise.resolve()
let settingsWritePending = 0
let settingsWriteGeneration = 0

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
    writeCache(
      TRANSCRIPT_CACHE_DIR,
      retainCachedImagePreviews(
        cache,
        readCache(TRANSCRIPT_CACHE_DIR, appSessionId),
      ),
    )
  } catch (error) {
    process.stderr.write(
      `[main] transcript-cache persist failed for ${appSessionId}: ${errText(error)}\n`,
    )
  }
}

/**
 * Startup cache GC (IS-A). The launch-time registry reap runs BEFORE main
 * subscribes to HostEvents, so reaped rows emit no `session-removed` — a cache
 * file whose row is gone would otherwise linger forever. Delete current-generation
 * files whose ids the host no longer vouches for. Older builds keep their copies.
 * Runs once, after the
 * registry launch sweep settles.
 */
function gcTranscriptCache(): void {
  try {
    for (const id of listCachedSessionIds(TRANSCRIPT_CACHE_DIR)) {
      if (!host || !host.canPreview(id)) deleteCache(TRANSCRIPT_CACHE_DIR, id, false)
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
 * alongside the PL-B transcript backfill. Main checks the engine-free source
 * fingerprint first; unchanged ticks do not spawn the disposable engine-graph
 * worker. A changed catalog is validated before main emits the read-only
 * `sessions-catalog` host event (C3 precedent, no inbound verb). A failed run
 * keeps the last good catalog (no event emitted).
 * The immediate first run means the sidebar is not empty at cold launch; the
 * immediate cold run is paid off the launch critical path because this fires
 * from `ready-to-show`.
 */
function startSessionsCatalogRefresh(): void {
  if (sessionsCatalogDriver) return
  const abort = new AbortController()
  sessionsCatalogAbort = abort
  sessionsCatalogActivityGate = createVisibilityGatedRefresh(() => {
    const onWorkerLifecycle = createWorkerLifecycleLogger('sessions-catalog')
    return runSessionsCatalogWorker({
      command: sidecarLaunch().command,
      args: sidecarLaunch().argsFor('catalog', ['--bare']),
      cwd: process.cwd(),
      signal: abort.signal,
      shouldSkip: async () => (await inspectSessionsCatalogSources()).unchanged,
      onWorkerLifecycle,
      onCatalog: catalog => {
        sendHostEvent({ type: 'sessions-catalog', catalog })
      },
      log: line => process.stderr.write(`${line}\n`),
    })
  }, hasReadableWindow)
  sessionsCatalogDriver = createSingleFlightDriver({
    intervalMs: SESSIONS_CATALOG_REFRESH_INTERVAL_MS,
    logLabel: 'catalog-runner',
    run: () => sessionsCatalogActivityGate!.run(),
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
 * Usage analytics have an independent read-only worker and driver below.
 */
function startUsageRefresh(): void {
  if (usageDriver) return
  if (!usageEnabled) {
    sendHostEvent({ type: 'usage-dashboard', result: { type: 'error', version: 1, code: 'unavailable' } })
    return
  }
  const abort = new AbortController()
  usageAbort = abort
  let restoreSaved = true
  usageActivityGate = createVisibilityGatedRefresh(async () => {
    usagePending = true
    sendHostEvent({ type: 'usage-dashboard-loading' })
    const generation = usagePublication.begin()
    if (restoreSaved) {
      restoreSaved = false
      const saved = await runUsageStatsWorker({
        command: sidecarLaunch().command,
        args: sidecarLaunch().argsFor('usage-stats', ['--bare', '--cached']),
        cwd: process.cwd(), signal: abort.signal, timeoutMs: 5000,
      })
      if (!abort.signal.aborted && saved.type === 'usage' && usagePublication.accept(generation, saved)) {
        sendHostEvent({ type: 'usage-dashboard', result: saved })
        sendHostEvent({ type: 'usage-dashboard-loading' })
      }
    }
    const result = await runUsageStatsWorker({
      command: sidecarLaunch().command,
      args: sidecarLaunch().argsFor('usage-stats', ['--bare']),
      cwd: process.cwd(), signal: abort.signal,
      onDiagnostic: diagnostic => logOperational('worker.failed', 'warn', {
        role: 'usage-stats',
        reason: diagnostic.reason,
        phase: diagnostic.phase,
        elapsedMs: diagnostic.elapsedMs,
        ...(diagnostic.guard ? { category: diagnostic.guard } : {}),
        ...(diagnostic.observed === undefined ? {} : { count: diagnostic.observed }),
        ...(diagnostic.limit === undefined ? {} : { limit: diagnostic.limit }),
        ...(diagnostic.sqliteCode ? { code: diagnostic.sqliteCode } : {}),
        ...(diagnostic.sources === undefined ? {} : { sources: diagnostic.sources }),
        ...(diagnostic.rows === undefined ? {} : { rows: diagnostic.rows }),
      }),
    })
    usagePending = false
    if (!abort.signal.aborted && usagePublication.accept(generation, result)) sendHostEvent({ type: 'usage-dashboard', result })
  }, hasReadableWindow)
  usageDriver = createSingleFlightDriver({
    intervalMs: USAGE_REFRESH_INTERVAL_MS,
    logLabel: 'usage-runner',
    run: () => usageActivityGate!.run(),
  })
  usageDriver.start()
}

function startAccountsPoolRefresh(): void {
  if (accountsPoolDriver) return
  const abort = new AbortController()
  accountsPoolAbort = abort
  let restoreCached = true
  accountsPoolActivityGate = createVisibilityGatedRefresh(() => {
    if (accountProfileMutationInFlight) return Promise.resolve()
    const generation = accountsPoolPublicationGate.beginRead()
    const onWorkerLifecycle = createWorkerLifecycleLogger('accounts-pool')
    const restore = restoreCached
    restoreCached = false
    return runAccountsPoolRefresh({
      command: sidecarLaunch().command,
      args: sidecarLaunch().argsFor('accounts-pool', ['--bare']),
      cwd: process.cwd(), signal: abort.signal, onWorkerLifecycle,
      onPool: pool => {
        if (!accountsPoolPublicationGate.canPublish(generation)) return
        sendHostEvent({ type: 'accounts-pool', pool })
      },
      log: line => process.stderr.write(`${line}\n`),
    }, restore)
  }, hasReadableWindow)
  accountsPoolDriver = createSingleFlightDriver({
    intervalMs: ACCOUNTS_POOL_REFRESH_INTERVAL_MS,
    logLabel: 'accounts-runner',
    run: () => accountsPoolActivityGate!.run(),
    // Teardown cancels this read intentionally; keep real runtime failures visible.
    log: line => { if (!abort.signal.aborted) process.stderr.write(`${line}\n`) },
  })
  accountsPoolDriver.start()
}

/**
 * Re-read the pool now because a sign-in just wrote to the vault. No-op before
 * the driver is armed (the first run is already pending) and after it stops.
 *
 * WHY THIS EXISTS. The Accounts page and the account-health bar both read the
 * host-plane pool (`selectGlobalAccountsSnapshot`, `accountsState.ts:261`),
 * which prefers this worker's snapshot over any session's. A sidecar that
 * re-broadcasts `accounts.snapshot` on OAuth success therefore cannot move
 * either surface, so without this a finished sign-in left the dead row dead and
 * the danger bar up for up to a full interval, which reads as the sign-in
 * having failed. Only for events that change the pool itself; the timer covers
 * everything else, and calling this on renderer activity would turn a 60 s
 * cadence into a per-interaction engine boot.
 */
function refreshAccountsPoolNow(): void {
  accountsPoolActivityGate?.allowNextRun()
  accountsPoolDriver?.refreshNow()
}

function refreshUsageDashboardNow(): void {
  if (!usageDriver) {
    startUsageRefresh()
    return
  }
  usageActivityGate?.allowNextRun()
  usageDriver?.refreshNow()
}

function hasReadableWindow(): boolean {
  return BrowserWindow.getAllWindows().some(
    window => !window.isDestroyed() && window.isVisible() && !window.isMinimized(),
  )
}

function isMainWindowSender(event: Pick<IpcMainEvent, 'sender'>): boolean {
  const contents = mainWindow?.webContents
  return contents !== undefined && !contents.isDestroyed() && event.sender === contents
}

function notifySidecarsOfAccountDeletion(
  accountId: string,
  requestId: string,
): void {
  scheduledOptions?.invalidate()
  accountInvalidation.notifyDeletion(
    accountId,
    requestId,
    supervisor?.listSessions() ?? [],
  )
}

function notifySidecarsOfAccountSignOut(
  notice: AccountProfileSignedOutMessage,
): void {
  scheduledOptions?.invalidate()
  accountInvalidation.notifySignOut(
    notice,
    supervisor?.listSessions() ?? [],
  )
}

function flushAccountInvalidationNotices(sessionId: SessionId): void {
  accountInvalidation.flush(sessionId)
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
      if (workspaceJump?.isReserved(appSessionId)) return
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

function sendServerFramesNow(frames: ServerFrame[]): void {
  const contents = deliverableContents()
  if (!contents) throw new Error('renderer destination unavailable')
  const traced = frames.map(frame => traceFrame(frame, 'main.ipc.queued'))
  contents.send(CH_SERVER_FRAME, traced satisfies ServerFrame[])
  for (const frame of traced) traceFrame(frame, 'main.ipc.sent')
}

function deliver(
  frames: ServerFrame[],
  origin: LiveFrameDeliveryOrigin = 'immediate',
): void {
  if (frames.length === 0) return
  liveFrameDelivery?.deliver(frames, origin)
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
    onOperationalRecord: record => {
      operationalLog.writeRecord(record)
      if (record.event === 'workspace.jump.timing' && record.fields.phase === 'continuation_to_provider_request' &&
          record.fields.outcome === 'completed' && record.appSessionId && record.engineSessionId &&
          typeof record.fields.operationId === 'string' && typeof record.fields.generation === 'string') {
        workspaceJump?.observeProviderRequest(record.appSessionId, record.engineSessionId, record.fields.operationId, record.fields.generation)
      }
    },
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

const filePreviews = createFilePreviewService({
  sessions: () => host?.listSessions() ?? [],
  options: { generatedImagesRoot: join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.cat-code'), 'generated-images') },
  publish: event => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.mainFrame.send(CH_FILE_PREVIEW_EVENT, event)
  },
})
const localFrameBindings = new Map<number, { id: string; revision: number }>()
const restoringLocalRoutes = new Map<number, string>()
const localhostPreviews = createLocalhostPreviewService({
  sessions: () => host?.listSessions() ?? [], devOrigin: IS_DEV ? APP_ORIGIN_DEV : null,
  publish: event => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.mainFrame.send(CH_FILE_PREVIEW_EVENT, event) },
  isLive: id => !!mainWindow?.webContents.mainFrame.frames.some(frame => localFrameBindings.get(frame.frameTreeNodeId)?.id === id),
})
function localFrameBinding(frame: Electron.WebFrameMain | null | undefined) {
  if (!frame || frame.parent !== mainWindow?.webContents.mainFrame) return null
  const binding = localFrameBindings.get(frame.frameTreeNodeId)
  return binding && localhostPreviews.descriptor(binding.id, binding.revision) ? binding : null
}
function issuedLocalFrame(frame: Electron.WebFrameMain | null | undefined) {
  if (!frame || frame.parent !== mainWindow?.webContents.mainFrame) return null
  const match = /^cat-localhost-preview-([a-f0-9]{48})-([1-9][0-9]*)$/.exec(frame.name)
  return match && localhostPreviews.descriptor(match[1]!, Number(match[2])) ? { id: match[1]!, revision: Number(match[2]) } : null
}
function previewDescriptor(id: string, revision: number) {
  return filePreviews.descriptor(id, revision) ?? localhostPreviews.descriptor(id, revision)
}
function localPreviewIdentity(value: unknown) {
  const record = value && typeof value === 'object' ? value as { src?: unknown; name?: unknown } : null
  if (!record || typeof record.name !== 'string') return null
  const match = /^cat-localhost-preview-([a-f0-9]{48})-([1-9][0-9]*)$/.exec(record.name)
  return match && localhostPreviews.descriptor(match[1]!, Number(match[2])) ? { id: match[1]!, revision: Number(match[2]) } : null
}
async function localFrameRouteState(frame: Electron.WebFrameMain, url: string): Promise<{ state: unknown; previous: FilePreviewScroll; replace: boolean } | null> {
  try {
    const serialized = await frame.executeJavaScript(`(() => {
      let state = null;
      try { state = JSON.stringify(history.state); } catch {}
      if (typeof state !== 'string' || state.length > 65536) state = null;
      const tracker = window.__catcodeLocalHistory;
      let entry = null;
      if (tracker && Array.isArray(tracker.queue)) {
        const index = tracker.queue.findIndex(item => item && item.url === location.href);
        if (index >= 0) entry = tracker.queue.splice(index, 1)[0];
      }
      let output;
      try { output = JSON.stringify({url:location.href,state,previous:entry?.previous ?? tracker?.interaction ?? null,replace:entry?.replace === true}); } catch { return null; }
      return typeof output === 'string' && output.length <= 70000 ? output : null;
    })()`)
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > 70_000) return null
    const value = JSON.parse(serialized) as { url?: unknown; state?: unknown; previous?: { x?: unknown; y?: unknown }; replace?: unknown }
    if (value.url !== url) return null
    let state: unknown = null
    if (typeof value.state === 'string' && Buffer.byteLength(value.state) <= 65_536) { try { state = JSON.parse(value.state) } catch {} }
    const x = value.previous?.x, y = value.previous?.y
    return { state, previous: { x: typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 1e8 ? x : 0, y: typeof y === 'number' && Number.isFinite(y) && Math.abs(y) <= 1e8 ? y : 0 }, replace: value.replace === true }
  } catch { return null }
}
async function localNavigationMethod(frame: Electron.WebFrameMain, target: string): Promise<string> {
  const pending = frame.executeJavaScript(`(() => {
    const tracker=window.__catcodeLocalHistory;
    if(!tracker)return 'UNKNOWN';
    const form=tracker.form;
    tracker.form=null;
    if(form&&typeof form.url==='string'&&form.url.length<=4096){
      try{const actual=new URL(${JSON.stringify(target)}),submitted=new URL(form.url);if(actual.origin===submitted.origin&&actual.pathname===submitted.pathname)return form.method==='GET'?'GET':'POST';}catch{}
    }
    return 'GET';
  })()`).then(value=>value==='GET'?'GET':'POST',()=> 'UNKNOWN')
  return new Promise(resolve=>{const timer=setTimeout(()=>resolve('UNKNOWN'),150);pending.then(value=>{clearTimeout(timer);resolve(value)},()=>{clearTimeout(timer);resolve('UNKNOWN')})})
}
function installLocalHistory(frame: Electron.WebFrameMain): void {
  void frame.executeJavaScript(`(() => {
    if (window.__catcodeLocalHistory) return;
    const position = () => { const x=scrollX,y=scrollY; return {x:typeof x==='number'&&x>=-1e8&&x<=1e8?x:0,y:typeof y==='number'&&y>=-1e8&&y<=1e8?y:0}; };
    const tracker = {queue:[],interaction:position(),form:null};
    Object.defineProperty(window,'__catcodeLocalHistory',{value:tracker,configurable:true});
    for (const method of ['pushState','replaceState']) {
      const original = history[method];
      history[method] = function(...args) {
        const previous=position();
        const result=Reflect.apply(original,this,args);
        tracker.queue.push({url:location.href,previous,replace:method==='replaceState'});
        if(tracker.queue.length>32) tracker.queue.shift();
        return result;
      };
    }
    const submitted = form => { try {tracker.form={url:new URL(form.action,location.href).href,method:form.method.toUpperCase()};}catch{} };
    addEventListener('submit',event=>{if(event.target instanceof HTMLFormElement)submitted(event.target)},true);
    const submit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function(...args){submitted(this);return Reflect.apply(submit,this,args)};
    addEventListener('pointerdown',()=>{tracker.interaction=position()},true);
    addEventListener('keydown',()=>{tracker.interaction=position()},true);
  })()`).catch(() => {})
}
const previewScroll = new Map<string, FilePreviewScroll>()
const pendingPreviewScroll = new Map<string, Promise<FilePreviewScroll>>()
function previewFrame(id: string, revision: number) {
  return mainWindow?.webContents.mainFrame.framesInSubtree.find(frame => {
    const parsed = parseFilePreviewUrl(frame.url)
    const local = localFrameBinding(frame)
    return frame.parent === mainWindow?.webContents.mainFrame && (parsed?.id === id && parsed.revision === revision || local?.id === id && local.revision === revision)
  })
}
const pendingPreviewReadiness = new Map<string, Promise<boolean>>()
async function previewRenderReady(id: string, revision: number): Promise<boolean> {
  const descriptor = previewDescriptor(id, revision)
  if (!descriptor) return false
  if (descriptor.kind !== 'html' && descriptor.kind !== 'svg' && descriptor.kind !== 'localhost') return true
  const frame = previewFrame(id, revision)
  if (!frame) return false
  const key = `${id}:${revision}`
  let pending = pendingPreviewReadiness.get(key)
  if (!pending) {
    if (pendingPreviewReadiness.size >= 4) return false
    // Read completed image dimensions instead of awaiting decode() in staging.
    // This is a rendering check only. Nothing supplied by the page
    // is forwarded as an app command or accepted as filesystem authority.
    pending = frame.executeJavaScript(`(() => {
      if (${descriptor.kind === 'svg'} && document.getElementsByTagNameNS('*', 'parsererror').length) return false;
      const images = document.images;
      if (images.length > 2048) return false;
      const local = new Map();
      for (let index = 0; index < images.length; index++) {
        const image = images[index];
        const source = image.currentSrc || image.src;
        if (!source || !image.complete) continue;
        let url;
        try { url = new URL(source, document.baseURI); } catch { continue; }
        if (url.protocol === 'http:' || url.protocol === 'https:') continue;
        local.set(url.href, image);
        if (local.size > 128) return false;
      }
      return [...local.values()].every(image => image.naturalWidth > 0 || image.naturalHeight > 0);
    })()`).then(result => result === true, () => false).finally(() => pendingPreviewReadiness.delete(key))
    pendingPreviewReadiness.set(key, pending)
  }
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 1000)
    pending!.then(result => { clearTimeout(timer); resolve(result) }, () => { clearTimeout(timer); resolve(false) })
  })
}
function previewPayload(value: unknown, keys: string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  return Object.keys(record).length === keys.length && keys.every(key => Object.hasOwn(record, key)) ? record : null
}
function previewIdentity(value: unknown, revision = false) {
  const record = previewPayload(value, revision ? ['id', 'revision'] : ['id'])
  return record && typeof record.id === 'string' && /^[a-f0-9]{48}$/.test(record.id) &&
    (!revision || typeof record.revision === 'number' && Number.isSafeInteger(record.revision) && record.revision > 0) ? record : null
}
function trustedPreviewSender(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  return isMainWindowSender(event) && event.senderFrame === mainWindow?.webContents.mainFrame
}
function timelyPreviewScroll(key: string, pending: Promise<FilePreviewScroll>): Promise<FilePreviewScroll> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(previewScroll.get(key) ?? { x: 0, y: 0 }), 150)
    pending.then(value => { clearTimeout(timer); resolve(value) }, () => { clearTimeout(timer); resolve(previewScroll.get(key) ?? { x: 0, y: 0 }) })
  })
}
function readPreviewScroll(id: string, revision: number): Promise<FilePreviewScroll> {
  const key = `${id}:${revision}`
  if (!previewDescriptor(id, revision)) return Promise.resolve({ x: 0, y: 0 })
  const existing = pendingPreviewScroll.get(key)
  if (existing) return timelyPreviewScroll(key, existing)
  const frame = previewFrame(id, revision)
  if (!frame) return Promise.resolve(previewScroll.get(key) ?? { x: 0, y: 0 })
  const promise = frame.executeJavaScript(`(() => { const x=scrollX,y=scrollY; return {x:typeof x==='number'&&x>=-1e8&&x<=1e8?x:0,y:typeof y==='number'&&y>=-1e8&&y<=1e8?y:0}; })()`).then(value => {
    const result = value as FilePreviewScroll
    if (result && Number.isFinite(result.x) && Number.isFinite(result.y) && Math.abs(result.x) <= 1e8 && Math.abs(result.y) <= 1e8 && previewDescriptor(id, revision)) previewScroll.set(key, { x: result.x, y: result.y })
    return previewScroll.get(key) ?? { x: 0, y: 0 }
  }).catch(() => previewScroll.get(key) ?? { x: 0, y: 0 }).finally(() => pendingPreviewScroll.delete(key))
  pendingPreviewScroll.set(key, promise)
  return timelyPreviewScroll(key, promise)
}
function applySecurityBaseline(): void {
  // CSP for any rendered content (SECURITY-MINIMUM §3 CSP). Delivered as a
  // response header on the app load so it also covers the dev server.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const parsed = parseFilePreviewUrl(details.url)
    const isPreview = parsed !== null && (filePreviews.has(parsed.id) || localhostPreviews.has(parsed.id))
    const isOwnedWindow = details.webContentsId === mainWindow?.webContents.id
    if (details.url.startsWith(`${FILE_PREVIEW_SCHEME}:`) && (!isPreview || !isOwnedWindow || details.resourceType === 'mainFrame')) {
      callback({ cancel: true }); return
    }
    // A preview must never acquire the app origin, even in a subframe redirect.
    if (details.resourceType === 'subFrame' && !isPreview && !(localFrameBinding(details.frame) && localhostPreviews.allowed(details.url))) { callback({ cancel: true }); return }
    callback({})
  })
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const parsed = parseFilePreviewUrl(details.url)
    if (parsed && (filePreviews.has(parsed.id) || localhostPreviews.has(parsed.id)) && details.webContentsId === mainWindow?.webContents.id) {
      callback({ responseHeaders: details.responseHeaders }); return
    }
    if (localFrameBinding(details.frame)) {
      const headers = { ...details.responseHeaders }
      if (details.resourceType === 'subFrame' && localhostPreviews.allowed(details.url)) {
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === 'x-frame-options') delete headers[key]
          else if (key.toLowerCase() === 'content-security-policy') headers[key] = headers[key]!.map(value => value.split(';').filter(directive => !/^\s*frame-ancestors(?:\s|$)/i.test(directive)).join(';'))
        }
      }
      callback({ responseHeaders: headers }); return
    }
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
            "img-src 'self' data: cat-preview:",
            IS_DEV
              ? "connect-src 'self' http://localhost:5173 ws://localhost:5173"
              : "connect-src 'self'",
            "font-src 'self' data:",
            "frame-src cat-preview: http:",
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
    // Width 852 is an ergonomic minimum, NOT a clipping floor: nothing in the
    // shell breaks below it. Every surface reflows — the transcript column is
    // `max-w-[var(--transcript-width)]` + `mx-auto`, prose carries
    // `min-w-0 truncate`, and wide content (code, diffs, tool output) scrolls
    // inside its own `overflow-x-auto` box. The collapsed sidebar rail
    // (`Sidebar.tsx`, `w-12 shrink-0`) is the only non-shrinking flow chrome.
    //
    // This once carried an arithmetic derivation ending in 852, anchored to a
    // hardcoded 740px transcript column. That literal is now the
    // `--transcript-width` token (`app/renderer/src/theme.css`) at a different
    // value, so the arithmetic stopped following from anything while still
    // reading as authoritative. It is deleted rather than re-pinned: a
    // derivation that lives in prose cannot be kept honest by the edit that
    // breaks it. Below roughly rail + token the transcript simply renders
    // narrower than its designed measure.
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
      devTools: IS_DEV,
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
  const scrollTimer = setInterval(() => {
    if (window.isDestroyed()) return
    for (const frame of window.webContents.mainFrame.frames) {
      const parsed = parseFilePreviewUrl(frame.url) ?? localFrameBinding(frame)
      if (parsed && (filePreviews.has(parsed.id) || localhostPreviews.has(parsed.id))) void readPreviewScroll(parsed.id, parsed.revision)
    }
  }, 100)
  scrollTimer.unref()
  window.once('closed', () => {
    clearInterval(scrollTimer)
    filePreviews.dispose()
    localhostPreviews.dispose()
    localFrameBindings.clear()
    restoringLocalRoutes.clear()
    previewScroll.clear()
    pendingPreviewScroll.clear()
    pendingPreviewReadiness.clear()
  })
  window.webContents.on('will-frame-navigate', event => {
    if (event.isMainFrame) return
    const frame = event.frame, local = localFrameBinding(frame)
    if (local) {
      if (event.initiator === window.webContents.mainFrame && localhostPreviews.allowed(event.url)) return
      event.preventDefault()
      const target = localhostPreviews.allowed(event.url)
      if (!target) { localhostPreviews.leave(local.id, event.url); return }
      if (!frame) return
      void localNavigationMethod(frame,target).then(method=>{
        if(method!=='GET'||window.isDestroyed()||!localhostPreviews.has(local.id))return
        const current=localhostPreviews.current(local.id)
        if(target===current?.path)void localhostPreviews.refresh(local.id)
        else window.webContents.mainFrame.send(CH_FILE_PREVIEW_EVENT,{id:local.id,kind:'navigate',path:target})
      })
      return
    }
    const issued = issuedLocalFrame(frame)
    if (issued && event.initiator === window.webContents.mainFrame) {
      const descriptor = localhostPreviews.descriptor(issued.id, issued.revision)!
      if (event.url.split('#')[0] === descriptor.url.split('#')[0]) {
        localFrameBindings.set(frame!.frameTreeNodeId, issued)
        return
      }
    }
    const target = parseFilePreviewUrl(event.url)
    const origin = frame && parseFilePreviewUrl(frame.url)
    if (origin && filePreviews.has(origin.id)) {
      if (target && filePreviews.has(target.id) && event.initiator === window.webContents.mainFrame) return
      event.preventDefault()
      if (target?.id === origin.id && filePreviews.has(target.id)) window.webContents.mainFrame.send(CH_FILE_PREVIEW_EVENT, { id: origin.id, kind: 'navigate', path: target.path })
      return
    }
    if (!target || !filePreviews.has(target.id)) event.preventDefault()
  })
  window.webContents.on('will-redirect', (event, url) => {
    if (event.isMainFrame) return
    const local = localFrameBinding(event.frame)
    if (!local || !localhostPreviews.allowed(url)) { event.preventDefault(); if (local) localhostPreviews.leave(local.id, url) }
  })
  window.webContents.on('frame-created', (_event, details) => { details.frame?.on('dom-ready', () => { if (details.frame && localFrameBinding(details.frame)) installLocalHistory(details.frame) }) })
  window.webContents.on('did-navigate-in-page', (_event, url, isMainFrame, processId, routingId) => {
    if (isMainFrame) return
    const frame = window.webContents.mainFrame.frames.find(frame => frame.processId === processId && frame.routingId === routingId)
    const local = localFrameBinding(frame)
    if (!frame || !local || !localhostPreviews.allowed(url)) return
    if (restoringLocalRoutes.get(frame.frameTreeNodeId) === url) { restoringLocalRoutes.delete(frame.frameTreeNodeId); return }
    const current = localhostPreviews.current(local.id)
    if (!current || current.revision !== local.revision) return
    void localFrameRouteState(frame, url).then(state => {
      if (!localFrameBinding(frame)) return
      const previous = state?.previous ?? previewScroll.get(`${local.id}:${local.revision}`) ?? {x:0,y:0}
      localhostPreviews.route(local.id, url, previous, state?.state ?? null, state?.replace ?? false)
    })
  })
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const key = input.key.toLowerCase()
    const shellChord = input.meta && !input.control && !input.alt &&
      (['k', 't', 'w'].includes(key) || /^[1-9]$/.test(key) || input.shift && key === 'b')
    if (input.key !== 'Escape' && !shellChord) return
    const live = window.webContents.mainFrame.frames.map(frame => parseFilePreviewUrl(frame.url) ?? localFrameBinding(frame)).find(parsed => parsed && (filePreviews.has(parsed.id) || localhostPreviews.has(parsed.id)))
    if (!live) return
    // Suppress the native Close Window accelerator before asynchronous routing.
    if (shellChord) event.preventDefault()
    void window.webContents.mainFrame.executeJavaScript(`(() => { const el = document.activeElement; return el instanceof HTMLIFrameElement ? {src:el.src,name:el.name} : null })()`)
      .then(value => {
        const focused = value && typeof value === 'object' ? parseFilePreviewUrl((value as {src:string}).src) ?? localPreviewIdentity(value) : null
        const parsed = focused || (shellChord ? live : null)
        if (parsed && (filePreviews.has(parsed.id) || localhostPreviews.has(parsed.id))) window.webContents.mainFrame.send(CH_FILE_PREVIEW_EVENT, {
          id: parsed.id, kind: 'key', key: input.key, code: input.code,
          metaKey: input.meta, shiftKey: input.shift, altKey: input.alt, ctrlKey: input.control,
        })
      }).catch(() => {})
  })
  const catchUpSkippedRefreshes = () => {
    // Resume only work whose scheduled tick was skipped while no window was
    // visible. Focus changes alone never affect an already-visible window's cadence.
    if (sessionsCatalogActivityGate?.takeSkippedInterval()) sessionsCatalogDriver?.refreshNow()
    if (accountsPoolActivityGate?.takeSkippedInterval()) accountsPoolDriver?.refreshNow()
    if (usageActivityGate?.takeSkippedInterval()) usageDriver?.refreshNow()
  }
  window.on('focus', catchUpSkippedRefreshes)
  window.on('focus', () => desktopNotifications?.focusChanged())
  window.on('blur', () => desktopNotifications?.focusChanged())
  let notificationWindowShown = false
  const updateNotificationWindow = () => notificationVisibility.windowChanged(
    notificationWindowShown && !window.isMinimized(),
  )
  window.on('show', () => { notificationWindowShown = true; updateNotificationWindow() })
  window.on('hide', () => { notificationWindowShown = false; updateNotificationWindow() })
  window.on('minimize', updateNotificationWindow)
  window.on('restore', updateNotificationWindow)

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
  window.on('show', () => {
    logWindowVisibility('show')
    catchUpSkippedRefreshes()
  })
  window.on('hide', () => logWindowVisibility('hide'))
  window.on('minimize', () => logWindowVisibility('minimize'))
  window.on('restore', () => {
    logWindowVisibility('restore')
    catchUpSkippedRefreshes()
  })

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
    notificationVisibility.windowChanged(false)
    notificationVisibility.reset()
    cancelWindowBoundsSave()
    // Preserve AttachmentGate until window-all-closed runs shutdownRuntime:
    // Host.shutdownAll snapshots each session before its evictReplay callback
    // clears it. Only delivery/recovery timers die at the earlier close event.
    liveFrameDelivery?.dispose()
    liveFrameDelivery = null
    handleRendererDeliveryFailure = null
    markRendererDocumentReady = null
    disposeRendererRecovery?.()
    disposeRendererRecovery = null
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
      projectCreation?.reset()
      notificationVisibility.reset()
      rendererDocumentId = randomUUID()
      rendererSubscriptionEpoch = 0
      logOperational('renderer.navigation.started', 'info', { navigation: 'document' })
      cancelAllReplayFlushes()
      attachedFrameDelivery?.onNavigationStart()
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
    if (event.isMainFrame && !isAppOrigin(url, navigationConfig())) {
      event.preventDefault()
    }
  })
  window.webContents.setWindowOpenHandler(({ url, referrer }) => {
    const local = localhostPreviews.bindings().find(binding => { try { return new URL(binding.url).origin === new URL(referrer.url).origin } catch { return false } })
    if (local) { localhostPreviews.leave(local.id, url); return { action: 'deny' } }
    const liveLocal=window.webContents.mainFrame.frames.some(frame=>localFrameBinding(frame)!==null)
    if(liveLocal&&!isAppOrigin(referrer.url,navigationConfig())){
      void window.webContents.mainFrame.executeJavaScript(`(() => {const element=document.activeElement;return element instanceof HTMLIFrameElement?{src:element.src,name:element.name}:null})()`).then(value=>{const source=localPreviewIdentity(value);if(source)localhostPreviews.leave(source.id,url)}).catch(()=>{})
      return {action:'deny'}
    }
    const decision = decideWindowOpen(url)
    if ('openExternal' in decision) {
      void shell.openExternal(decision.openExternal)
    }
    return { action: 'deny' }
  })

  // Electron ships no right-click menu. Controls that own a menu (sidebar rows,
  // file paths) preventDefault the DOM event, so this only fires for the rest.
  window.webContents.on('context-menu', (_event, params) => {
    const plan = planContextMenu(params)
    const template: Electron.MenuItemConstructorOptions[] = []
    if (plan.copyImage) {
      template.push({
        label: 'Copy Image',
        click: () => window.webContents.copyImageAt(params.x, params.y),
      })
    }
    if (plan.saveImage) {
      template.push({
        label: 'Save Image As…',
        click: () => {
          const decoded = decodeImageDataUrl(params.srcURL)
          if (!decoded) return
          void dialog
            .showSaveDialog(window, { defaultPath: `image.${decoded.extension}` })
            .then(async result => {
              if (result.canceled || !result.filePath) return
              await writeFile(result.filePath, decoded.bytes)
            })
            .catch(error => {
              process.stderr.write(`[main] save-image failed: ${errText(error)}\n`)
              dialog.showErrorBox('Could not save image', 'Try another location.')
            })
        },
      })
    }
    if (plan.edit === 'editable') {
      if (template.length > 0) template.push({ type: 'separator' })
      template.push(
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        { role: 'selectAll' },
      )
    } else if (plan.edit === 'selection') {
      if (template.length > 0) template.push({ type: 'separator' })
      template.push({ role: 'copy' }, { role: 'selectAll' })
    }
    if (template.length > 0) Menu.buildFromTemplate(template).popup({ window })
  })

  window.once('ready-to-show', () => {
    updateLidMenu(lidMode?.read())
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

  let rendererLoadGeneration = 0
  const loadRenderer = () => {
    const generation = ++rendererLoadGeneration
    const loadFailed = (error: unknown) => {
      logOperational('renderer.load.failed', 'error', { reason: classifyFailure(error) })
      // Electron also emits did-fail-load for this rejection. The promise owns
      // the attempt, so a superseded load cannot consume its replacement's
      // budget and the two observations cannot spend two retries.
      if (generation !== rendererLoadGeneration) return
      if (error !== null && typeof error === 'object' &&
          (('code' in error && error.code === 'ERR_ABORTED') ||
           ('errno' in error && error.errno === -3))) return
      rendererLossTransition.loadFailed('load-failed')
    }
    if (IS_DEV) {
      logOperational('renderer.load.started', 'info', { source: 'dev' })
      void window.loadURL(APP_ORIGIN_DEV).catch(loadFailed)
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
      void window.loadFile(PACKAGED_INDEX_PATH).catch(loadFailed)
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
        reason === 'load-failed' ? 'Could not open Cat Code' : 'Cat Code window crashed',
        reason === 'load-failed'
          ? 'The window could not finish opening after several attempts. Quit and reopen the app to try again.'
          : 'The window crashed several times in a row, so automatic reload stopped. Quit and reopen the app to continue.',
      )
    }
  }

  // A synchronous IPC send failure and Electron's later process-loss event are
  // two observations of one document loss. This transition owns both so the
  // reload budget is consumed once and a failed send cannot strand an attached
  // gate while waiting for an event Electron may never emit.
  const rendererLossTransition = createRendererLossTransition<RendererDeathReason>({
    isDisposed: () => window.isDestroyed(),
    onUnavailable: () => {
      rendererGone = true
      stopRendererHealthTimer()
      cancelAllReplayFlushes()
      if (attachedFrameDelivery) attachedFrameDelivery.onNavigationStart()
      else attachmentGate.onNavigationStart()
    },
    decide: reason => rendererRecovery.decide(reason),
    onReload: (reason, attempt) => {
      logOperational('renderer.recovery.started', 'warn', {
        count: attempt,
        reason,
      })
      rendererRecovering = true
      loadRenderer()
    },
    onGiveUp: giveUpOnRenderer,
    timeoutReason: 'load-failed',
  })
  disposeRendererRecovery = () => rendererLossTransition.dispose()
  const rendererReadyTracker = createRendererReadyTracker(() => {
    // The ready document id is independent evidence of a new destination. If
    // Electron missed/delayed did-start-navigation, discard old delivery copies
    // and re-arm replay before spending the one-shot attachment latch below.
    attachedFrameDelivery?.onNavigationStart()
    rendererLossTransition.documentReady()
    if (rendererRecovering) {
      rendererRecovering = false
      rendererRecoveryDialogShown = false
      const pid = readRendererOsProcessId()
      logOperational('renderer.recovery.succeeded', 'info', pid === null ? {} : { pid })
      startRendererHealthTimer()
    }
  })
  markRendererDocumentReady = documentId => {
    rendererReadyTracker.ready(documentId)
  }
  handleRendererDeliveryFailure = error => {
    logOperational('diagnostic', 'error', {
      source: 'rendererDelivery',
      reason: classifyFailure(error),
    })
    rendererLossTransition.lose('crashed')
  }
  liveFrameDelivery?.dispose()
  liveFrameDelivery = createLiveFrameDeliveryCoordinator({
    // The measured policy remains immediate until the isolated Electron
    // benchmark proves a candidate against the fixed CPU and commit-latency bars.
    delayMs: 0,
    sendNow: sendServerFramesNow,
    isDestinationAvailable: () => deliverableContents() !== null,
    onSendFailure: error => handleRendererDeliveryFailure?.(error),
  })
  attachedFrameDelivery = createAttachedFrameDeliveryCoordinator(
    attachmentGate,
    liveFrameDelivery,
  )

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
    }
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    projectCreation?.reset()
    notificationVisibility.reset()
    // A crashed renderer leaves the window open and `isDestroyed()` false, so
    // without this flag every scheduled send (probe, host event, frame) throws
    // "Render frame was disposed" forever. Flag first, then stop probing a
    // process main positively knows is gone.
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
    rendererLossTransition.lose(details.reason)
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
  const observer = lidWorkObserver
  const power = ensureDesktopPower()
  sup.subscribe(event => {
    if (event.type === 'status') observer?.onSessionsChanged()
    if (event.type === 'exit') {
      if (event.code === 0 || event.code === PARKED_EXIT_CODE) observer?.onSessionsChanged()
      else observer?.loseSupervision()
    }
    const frame = supervisorEventToServerFrame(event)
    if (!frame) return
    if (frame.kind === 'work.status') {
      const { deliveryTrace: _trace, ...statusFrame } = frame
      observer?.onFrame(statusFrame, event.sessionId)
    } else {
      observer?.onFrame(frame, event.sessionId)
    }
    power?.receive(event.sessionId, frame)
    scheduledTasks?.receive(event.sessionId, frame)
    desktopNotifications?.receive(event.sessionId, frame)
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
    if (frame.kind === 'lid.work') {
      // Retired job observations remain host-only for older sidecars.
      return
    }
    if (frame.kind === 'work.status') {
      const received = traceFrame(frame, 'supervisor.socket.received')
      traceFrame(received, 'host.received')
      return
    }
    if (frame.kind === 'error' && observer?.handleError(frame, event.sessionId)) {
      const received = traceFrame(frame, 'supervisor.socket.received')
      traceFrame(received, 'host.received')
      return
    }
    if (frame.kind === 'host.request') {
      // Main-local receipt of the supervisor-delivered frame, before tracing
      // and peer-plane validation. Never sourced from the request payload.
      const receivedAt = performance.now()
      const received = traceFrame(frame, 'supervisor.socket.received')
      traceFrame(received, 'host.received')
      void peerPlane?.handleRequest(event.sessionId, frame, receivedAt)
      return
    }
    if (frame.kind === 'workspace.handoff.result' || frame.kind === 'workspace.handoff.state') {
      const received = traceFrame(frame, 'supervisor.socket.received')
      traceFrame(received, 'host.received')
      const { deliveryTrace: _deliveryTrace, ...controlFrame } = frame
      workspaceControl?.receiveFrame(event.sessionId, controlFrame)
      return
    }
    if (frame.kind === 'event' && !frame.replay && frame.event.type === 'message' &&
        frame.event.message.type === 'result' && frame.event.message.subtype === 'handoff') {
      const generation = host?.getSessionGeneration(event.sessionId)
      const result = frame.event.message as import('../shared/sdk-types.snapshot.js').SDKResultHandoff
      if (generation) observedWorkspaceHandoffs.set(event.sessionId, { generation, operationId: result.operation_id,
        tipUuid: result.transcript_boundary.tip_uuid, toolUseId: result.transcript_boundary.tool_use_id })
    }
    if (frame.kind === 'ready') {
      logOperational('sidecar.ready', 'info', { frame: 'ready' }, event.sessionId)
      try {
        const recovery = workspaceJump?.snapshot(event.sessionId)
        if (recovery) workspaceJump?.queryStatus(event.sessionId, true)
      } catch { /* unreadable state remains retained */ }
      flushAccountInvalidationNotices(event.sessionId)
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
    if (frame.kind === 'submit.result') {
      projectRouting?.onSubmitResult(
        event.sessionId,
        frame.submitId,
        frame.accepted,
      )
    }
    if (frame.kind === 'run-controls.snapshot') {
      // The roster's model/effort, from the row's OWN engine-resolved state
      // rather than from anything a create asked for. Read here for the same
      // reason `activity` is: it is app-owned point-in-time state, and the frame
      // still forwards normally to the composer that asked for it.
      peerPlane?.recordRunControls(event.sessionId, {
        model: frame.runControls.model.current,
        effort: frame.runControls.effort.current,
      })
    }
    if (isTerminalLifecycleFrame(frame)) {
      projectRouting?.interrupted(event.sessionId)
      observedWorkspaceHandoffs.delete(event.sessionId)
      workspaceControl?.disconnect(event.sessionId)
      accountInvalidation.clear(event.sessionId)
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
      scheduledOptions?.invalidate()
      refreshAccountsPoolNow()
    }
    const traced = traceFrame(frame, 'supervisor.socket.received')
    // Receipt is true whether the attachment gate forwards immediately or
    // buffers for replay; record that before deciding its outcome.
    traceFrame(traced, 'host.received')
    // A closed Chat can be briefly warmed to capture engine controls. Those
    // frames are internal to relocation; forwarding ready would open its pane.
    if (host?.isHiddenMoveWarmup(event.sessionId)) return
    const gated = attachedFrameDelivery?.onFrame(event.sessionId, traced) ?? []
    if (gated.length === 0) traceFrame(traced, 'attachment.buffered')
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
  const power = desktopPower
  const observer = lidWorkObserver
  const ownerSupervisor = supervisor
  h.subscribe(event => {
    if (event.type === 'session-added' || event.type === 'session-status') {
      const session = event.session
      observer?.onLifecycle({
        sessionId: session.appSessionId,
        generation: ownerSupervisor?.getSessionGeneration(session.appSessionId) ?? '',
        status: session.status,
        confirmedTerminal: session.status === 'exited',
      })
      if (['exited', 'failed', 'parked'].includes(session.status)) {
        observer?.endPeerWorkspaceTransitions(session.appSessionId)
      }
    } else if (event.type === 'session-removed') {
      observer?.onLifecycle({ sessionId: event.appSessionId, generation: '', status: 'exited', confirmedTerminal: true })
      observer?.endPeerWorkspaceTransitions(event.appSessionId)
    }
    power?.receiveHostEvent(event)
    scheduledTasks?.receiveHostEvent(event)
    desktopNotifications?.receiveHostEvent(event)
    notificationVisibility.refresh()
    sendHostEvent(event)
    // The durable row now carries the completed turn; the in-memory pre-result
    // marker is needed only while that row still reads null.
    if (event.type === 'session-status' && event.session.lastMessageSentAt !== null) {
      sessionsWithSubmit.delete(event.session.appSessionId)
    }
    // IS-A delete-on-reap: a row that left the live∪restorable set (reaped or its
    // engineSessionId cleared) must not keep an at-rest transcript cache.
    if (event.type === 'session-removed') {
      workspaceJump?.forgetHandles(event.appSessionId)
      sessionsWithSubmit.delete(event.appSessionId)
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

function sendHostEvent(event: HostEvent): boolean {
  // Host rows can remove/replace session state, so they are ordered barriers:
  // all earlier server deltas reach the document before the host transition.
  liveFrameDelivery?.flush()
  const contents = deliverableContents()
  if (!contents) return false
  try {
    contents.send(CH_HOST_EVENT, event)
    return true
  } catch (error) {
    handleRendererDeliveryFailure?.(error)
    return false
  }
}

/**
 * The verb channels main relays VERBATIM: the renderer sends `{sessionId, verb}`
 * and main forwards `verb` unchanged once its `type` is in that channel's closed
 * list. This table IS that part of the IPC surface; adding a row widens it and
 * removing one silently breaks a renderer verb.
 *
 * Light UX coercion only. The SIDECAR is the trust boundary and fully
 * re-validates each of these (Zod schema plus that domain's own rules, noted per
 * row below); dropping a frame whose `type` is not in the list is fail-closed
 * housekeeping, so main never forwards a message guaranteed to be rejected. The
 * only other field these verbs carry is a `requestId` the renderer authors for
 * result correlation, which is a UX field rather than a security one and which
 * the sidecar bounds structurally.
 *
 * Handlers that do more than relay stay hand-written below: CH_SUBMIT resolves
 * attachment tokens, CH_SET_MODE mints the requestId in
 * main, CH_PERMISSION and
 * CH_ANSWER_QUESTIONS carry engine-minted ids.
 */
const RELAYED_VERB_CHANNELS: ReadonlyArray<
  readonly [channel: string, verbTypes: readonly string[]]
> = [
  // Session-local account verbs still use the sidecar's pool-resolved business
  // rules. Global profile mutations have dedicated host handlers below and
  // never enter this session relay.
  [CH_ACCOUNT_VERB, SESSION_ACCOUNT_VERB_TYPES],
  // P4-15 — sidecar re-validates schema + the engine's trust persist for its OWN
  // cwd. HC1: no path crosses, the verb carries only a `requestId`.
  [CH_WORKSPACE_TRUST_VERB, WORKSPACE_TRUST_VERB_TYPES],
  // P4-24c — sidecar re-validates schema + the engine's own setter.
  [CH_RUN_CONTROL_VERB, RUN_CONTROL_VERB_TYPES],
  [CH_PROMPT_FORCE, PROMPT_FORCE_VERB_TYPES],
  // D1b — the sidecar decides for itself what is recallable. The verb carries no
  // target, so there is no other field to coerce.
  [CH_PROMPT_RECALL, PROMPT_RECALL_VERB_TYPES],
  // decisions/HISTORY-LOAD-EARLIER.md — the sidecar re-validates against a closed
  // key allowlist and decides for itself which file it reads and how much of it.
  // The frame's one main-authored field, `viewAnchorUuid`, is stamped in
  // `forward` rather than here, so it cannot be missed by a second route into
  // the verb — see the comment there.
  [CH_HISTORY_LOAD_EARLIER, HISTORY_LOAD_EARLIER_VERB_TYPES],
  // The analysis takes no renderer input beyond the request itself.
  [CH_CONTEXT_BREAKDOWN_VERB, CONTEXT_BREAKDOWN_VERB_TYPES],
  // P4-6b — sidecar re-validates schema + the engine's own op.
  [CH_SESSION_ACTION_VERB, SESSION_ACTION_VERB_TYPES],
  // P4-8b — the engine's own `stopTask` re-resolves the id against the live store.
  [CH_TASK_CONTROL_VERB, TASK_CONTROL_VERB_TYPES],
  // P4-13 — sidecar re-validates schema + live-state re-derivation.
  [CH_REMOTE_SETTINGS_VERB, REMOTE_VERB_TYPES],
  // P4-19 — sidecar re-validates schema + EDITABLE_SETTINGS allowlist + per-key
  // value-type check + a SettingsUpdater-under-lock write.
  [CH_SETTINGS_VERB, SETTINGS_VERB_TYPES],
]

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
    if (sessionCloseCoordinator.isPending(arg.sessionId)) {
      answerUnforwardedSubmit(arg.sessionId, options?.submitId, 'session_not_ready')
      return
    }
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
    const message: Extract<SidecarClientMessage, { type: 'app.submit' }> = {
      type: 'app.submit',
      requestId: generateRequestId(),
      prompt,
      options,
    }
    if (projectRouting && !projectRouting.acceptsNewSubmit(arg.sessionId, options?.submitId)) {
      answerUnforwardedSubmit(arg.sessionId, options?.submitId, 'bad_request')
      return
    }
    const failure = forward(arg.sessionId, message)
    if (failure !== null) answerUnforwardedSubmit(arg.sessionId, options?.submitId, failure)
  })

  ipcMain.on(
    CH_ABORT,
    (_e, arg: { sessionId: SessionId; requestId: string; reason?: string }) => {
      if (typeof arg?.sessionId !== 'string' || typeof arg?.requestId !== 'string') return
      projectRouting?.cancel(arg.sessionId)
      if (workspaceJump?.isReserved(arg.sessionId)) { void workspaceJump.cancel(arg.sessionId, undefined, 'stop'); workspaceJump.queryStatus(arg.sessionId); return }
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

  // One handler per relayed verb channel (`RELAYED_VERB_CHANNELS`). The channel
  // decides which closed `type` list applies; nothing else about the frame
  // differs, so nothing else is written eleven times.
  for (const [channel, verbTypes] of RELAYED_VERB_CHANNELS) {
    ipcMain.on(channel, (_e, arg: { sessionId: SessionId; verb: unknown }) => {
      if (typeof arg?.sessionId !== 'string') return
      const verb = arg.verb as { type?: unknown } | null | undefined
      if (typeof verb?.type !== 'string' || !verbTypes.includes(verb.type)) return
      forward(arg.sessionId, arg.verb as SidecarClientMessage)
    })
  }

  // Decision: docs/plans/2026-10-22-inline-command-run.md §4A,B.
  for (const [channel, type] of [
    [CH_INLINE_COMMAND_START, 'inline-command.start'],
    [CH_INLINE_COMMAND_STOP, 'inline-command.stop'],
    [CH_INLINE_COMMAND_GET, 'inline-command.get'],
  ] as const) {
    ipcMain.on(channel, (event, raw: unknown) => {
      if (!isMainWindowSender(event)) return
      const payload = parseInlineCommandPayload(raw, type)
      if (payload) forward(payload.sessionId, payload.verb)
    })
  }

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
      return host.restartSession(sessionId, { workspaceJumpReserved: workspaceJump?.isReserved(sessionId) ?? false }).then(result => {
        if (result.ok) scheduledTasks?.interrupt(sessionId)
        return result
      })
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
    markRendererDocumentReady?.(payload.documentId)
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
    for (const result of usagePublication.replay()) {
      if (usageEnabled && result.type === 'error' && result.code === 'unavailable') continue
      sendHostEvent({ type: 'usage-dashboard', result })
    }
    if (usagePending) sendHostEvent({ type: 'usage-dashboard-loading' })
    const oauth = accountControl?.replay()
    if (oauth) sendHostEvent({ type: 'account-oauth', provider: oauth.provider, progress: oauth.progress })
    flushNotificationOpen()
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
    applyGlassWindowBackground(mainWindow, enabled)
  })
  registerNotificationPreferenceIpc<IpcMainInvokeEvent>({
    handle: (channel, listener) => ipcMain.handle(channel, listener),
    isTrustedSender: isMainWindowSender,
    read: () => notificationPreferences ??= readNotificationPreference(app.getPath('userData')),
    write: value => notificationPreferences = writeNotificationPreference(app.getPath('userData'), value),
    changed: () => desktopNotifications?.preferencesChanged(),
  })
  registerNotificationRetryIpc<IpcMainInvokeEvent>({
    handle: (channel, listener) => ipcMain.handle(channel, listener),
    isTrustedSender: isMainWindowSender,
    retry: (id, resultId) => desktopNotifications?.retry(id, resultId) ?? false,
  })
  registerNotificationRetryBlockedIpc<IpcMainEvent>({
    on: (channel, listener) => ipcMain.on(channel, listener),
    isTrustedSender: isMainWindowSender,
    changed: sessionIds => {
      notificationRetryBlocked = new Set(sessionIds)
      desktopNotifications?.retryBlockedChanged()
    },
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

  ipcMain.on(CH_REFRESH_USAGE_DASHBOARD, event => {
    if (!isMainWindowSender(event)) return
    refreshUsageDashboardNow()
  })

  ipcMain.handle(CH_PICK_SETTINGS_PROJECT, async (event): Promise<{ cwd: string; name: string } | null> => {
    if (!isMainWindowSender(event)) return null
    const parent = mainWindow ?? undefined
    const result = parent
      ? await dialog.showOpenDialog(parent, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    const selected = validateCwd(result.filePaths[0])
    if (!selected.ok) return null
    settingsPickedProjects.add(selected.realpath)
    return { cwd: selected.realpath, name: basename(selected.realpath) }
  })

  ipcMain.handle(
    CH_READ_SETTINGS_INVENTORY,
    async (event, projectCwd: unknown): Promise<SettingsInventoryReadResult> => {
      const unavailable = (): SettingsInventoryReadResult => ({
        ok: false,
        error: { code: 'unavailable', message: 'Could not load configuration. Try again.' },
      })
      if (!isMainWindowSender(event)) return unavailable()

      const knownProjects = new Set([
        ...settingsPickedProjects,
        ...storedProjectsForDiscovery().map(project => project.cwd),
        ...(host?.listSessions().map(row => row.cwd) ?? []),
        ...(readSessionsCatalogCache(defaultRegistryDir())?.entries.map(row => row.cwd) ?? []),
      ])
      const cwd = resolveSettingsInventoryCwd(
        projectCwd,
        app.getPath('home'),
        knownProjects,
        validateCwd,
        process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.cat-code'),
      )
      if (!cwd) {
        return { ok: false, error: { code: 'invalid_project', message: 'Choose a known project.' } }
      }
      if (settingsInventoryReads.size >= 4) return unavailable()

      const abort = new AbortController()
      settingsInventoryReads.add(abort)
      let accepted: SettingsInventoryReadResult | null = null
      try {
        await runSettingsInventoryWorker({
          command: sidecarLaunch().command,
          args: sidecarLaunch().argsFor(
            'settings-inventory',
            settingsInventoryScopeArgs(projectCwd),
          ),
          cwd,
          signal: abort.signal,
          onWorkerLifecycle: createWorkerLifecycleLogger('settings-inventory'),
          onInventory: inventory => {
            if (inventory.cwd === cwd) accepted = { ok: true, inventory }
          },
          log: line => process.stderr.write(`${line}\n`),
        })
      } catch (error) {
        process.stderr.write(
          `[main] settings inventory read failed: ${error instanceof Error ? error.message : String(error)}\n`,
        )
      } finally {
        settingsInventoryReads.delete(abort)
      }
      return abort.signal.aborted ? unavailable() : accepted ?? unavailable()
    },
  )

  ipcMain.handle(
    CH_WRITE_DURABLE_SETTING,
    async (event, projectCwd: unknown, rawVerb: unknown): Promise<SettingsWriteReadResult> => {
      const unavailable = (): SettingsWriteReadResult => ({
        ok: false,
        error: { code: 'unavailable', message: 'Could not save this setting. Try again.' },
      })
      if (!isMainWindowSender(event)) return unavailable()
      const request = parseSettingsWriteWorkerRequest({
        type: 'settings-write',
        version: 1,
        verb: rawVerb,
      })
      if (!request || !settingsWriteMatchesScope(request.verb.source, projectCwd)) {
        return { ok: false, error: { code: 'invalid_write', message: 'Choose a valid setting and scope.' } }
      }
      const knownProjects = new Set([
        ...settingsPickedProjects,
        ...storedProjectsForDiscovery().map(project => project.cwd),
        ...(host?.listSessions().map(row => row.cwd) ?? []),
        ...(readSessionsCatalogCache(defaultRegistryDir())?.entries.map(row => row.cwd) ?? []),
      ])
      const cwd = resolveSettingsInventoryCwd(
        projectCwd,
        app.getPath('home'),
        knownProjects,
        validateCwd,
        process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.cat-code'),
      )
      if (!cwd) {
        return { ok: false, error: { code: 'invalid_project', message: 'Choose a known project.' } }
      }
      if (settingsWritePending >= 8) return unavailable()
      settingsWritePending += 1
      const generation = settingsWriteGeneration
      const priorWrite = settingsWriteTail
      let releaseWrite!: () => void
      settingsWriteTail = new Promise<void>(resolve => { releaseWrite = resolve })
      try {
        await priorWrite
        if (generation !== settingsWriteGeneration) return unavailable()
        const abort = new AbortController()
        settingsWriteRuns.add(abort)
        try {
          const result = await runSettingsWriteWorker({
            command: sidecarLaunch().command,
            args: sidecarLaunch().argsFor('settings-write'),
            cwd,
            request,
            signal: abort.signal,
            onWorkerLifecycle: createWorkerLifecycleLogger('settings-write'),
            log: line => process.stderr.write(`${line}\n`),
          })
          if (abort.signal.aborted) return unavailable()
          if (result.ok && request.verb.key === 'model') scheduledOptions?.invalidate()
          return result.ok
            ? { ok: true, message: result.message }
            : { ok: false, error: { code: 'unavailable', message: result.message } }
        } finally {
          settingsWriteRuns.delete(abort)
        }
      } catch (error) {
        process.stderr.write(
          `[main] durable setting write failed: ${error instanceof Error ? error.message : String(error)}\n`,
        )
        return unavailable()
      } finally {
        settingsWritePending -= 1
        releaseWrite()
      }
    },
  )

  ipcMain.on(CH_OPEN_LOGS, () => {
    void shell.openPath(operationalLog.getDirectory())
  })
  ipcMain.handle(CH_SAVE_DIAGNOSTICS, () =>
    saveDiagnosticsBundle({
      chooseDestination: () => mainWindow
        ? dialog.showSaveDialog(mainWindow, { defaultPath: 'cat-code-diagnostics.json' })
        : dialog.showSaveDialog({ defaultPath: 'cat-code-diagnostics.json' }),
      bundleOptions: {
        logsDirectory: operationalLog.getDirectory(),
        appVersion: app.getVersion(),
        packaged: app.isPackaged,
        currentLaunchId: operationalLog.launchId,
        buildId: process.env.CATCODE_BUILD_ID,
        commitId: process.env.CATCODE_COMMIT_ID,
        power: () => desktopPower?.read(),
      },
      onFailure: error => logOperational('diagnostic', 'error', {
        source: 'diagnosticsExport', reason: classifyFailure(error),
      }),
    }),
  )

  // IDLE-PARK §4(b) — the renderer reports which sessions are on screen so the
  // park policy skips them. Validated HERE, at the boundary, not at the preload
  // (`parseVisibleSessions` in mainDecisions.ts carries the trust reasoning). A
  // malformed payload yields an empty set, which protects nothing and parks
  // normally: this hint may only ever SUPPRESS a park, never cause one, and never
  // reaches a sidecar.
  ipcMain.on(CH_HOST_VISIBLE_SESSIONS, (event, payload: unknown) => {
    if (!isMainWindowSender(event)) return
    visibleSessions = parseVisibleSessions(payload)
  })
  registerNotificationVisibilityIpc<IpcMainEvent>({
    on: (channel, listener) => ipcMain.on(channel, listener),
    isTrustedSender: event => isMainWindowSender(event) &&
      event.senderFrame === mainWindow?.webContents.mainFrame,
    receive: raw => notificationVisibility.receive(raw),
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
const projectStore = new ProjectStore(defaultRegistryDir())
let projectCreation: ProjectCreationController | null = null

/** Discovery can retain legacy projects if the new store is unreadable.
 * The strict list/create/launch paths still surface the failure and never write
 * over a damaged document. */
function storedProjectsForDiscovery(): DesktopProject[] {
  try {
    return projectStore.list().filter(project => {
      const checked = validateCwd(project.cwd)
      return checked.ok && checked.realpath === project.cwd
    })
  }
  catch (error) {
    logLegacyDiagnostic(`[projects] discovery failed: ${errText(error)}`, 'projects', 'host')
    return []
  }
}

/**
 * Control-plane IPC (HC3 — fixed, per-method structured senders; no generic
 * invoke, no renderer-controlled channel names, no method returning filesystem
 * contents). Each returns a typed `HostResult` (or the picker's single realpath)
 * so a failure crosses the boundary as data, never a thrown internal error (HC2).
 * Handlers read the module-level `host`, so they survive a host rebuild (F5)
 * without re-registering listeners.
 */
let lidMode: LidClosedMode | undefined
let lidWorkObserver: LidWorkObserver | undefined
let desktopPower: DesktopPower | undefined
function lidAssetsDirectory(): string {
  return app.isPackaged ? join(process.resourcesPath, 'lid-closed') : join(__dirname, '../native/lid-closed/dist')
}
function ensureDesktopPower(): DesktopPower | undefined {
  if (process.platform !== 'darwin') return
  if (!desktopPower) {
    const assertion = new SleepAssertionOwner({
      enabled: true,
      spawn: () => spawn('/usr/bin/caffeinate', ['-i', '-t', '300', '-w', String(process.pid)], { stdio: 'ignore' }),
      setTimeout, clearTimeout,
      log: message => logOperational('diagnostic', message === 'caffeinate recovered' ? 'info' : 'warn', {
        source: 'main', category: 'idle-sleep',
        reason: message === 'caffeinate recovered' ? 'assertion-process-recovered' :
          message.startsWith('caffeinate spawn failed') ? 'spawn-failed' :
          message.startsWith('caffeinate process error') ? 'process-error' :
          message.startsWith('caffeinate termination') ? 'termination-failed' :
          message === 'caffeinate spawn confirmation timed out' ? 'spawn-confirmation-timeout' : 'unexpected-exit' }),
    })
    const observation = new NativePowerObservation(join(lidAssetsDirectory(), 'helper'), reason => {
      const state = desktopPower?.read().hardware.observation
      const unusual = state && (state.lid === 'closed' && state.display === 'software-awake' ||
        state.thermal === 'serious' || state.thermal === 'critical')
      logOperational('diagnostic', unusual || reason === 'hardware-observer-unavailable' ? 'warn' : 'info', { source: 'main', category: 'power-observation',
        reason: state && reason === 'hardware-state' ? `${state.lid}:${state.display}:${state.thermal}` : reason })
    })
    desktopPower = new DesktopPower(assertion, observation, reason =>
      logOperational('diagnostic', 'info', { source: 'main', category: 'idle-sleep', reason }))
  }
  return desktopPower
}
let lidReady: Promise<void> = Promise.resolve()
const updateLidMenu = lidClosedMenu(async () => { await lidReady; return lidMode?.readPresence() }, command => { void lidReady.then(() => lidMode?.command(command)).catch(() => {}) })
function ensureLidMode(): void {
  if (lidMode) return
  const previous = lidReady
  const assets = lidAssetsDirectory()
  const mode = new LidClosedMode({
    native: new LidNativeClient(),
    marker: join(defaultRegistryDir(), 'lid-closed-recovery.json'),
    installed: lidHelperInstalled,
    current: () => lidHelperCurrent(assets),
    hardware: () => inspectLidHardware(assets),
    install: recoveryOnly => installLidHelper(assets, recoveryOnly),
    work: lidWorkObserver!,
    changed: view => {
      if (lidMode !== mode) return
      updateLidMenu(view)
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(CH_LID_CHANGED, view)
    },
  })
  lidMode = mode
  // A window reopened during old-owner cleanup must wait for restoration,
  // and old-owner notifications must never overwrite its new global state.
  lidReady = previous.catch(() => {}).then(async () => { if (lidMode === mode) await mode.initialize() }).catch(() => {})
}
function registerHostControlPlane(): void {
  ipcMain.handle(CH_LID_READ, async event => {
    if (!isMainWindowSender(event)) throw new Error('Unavailable')
    await lidReady
    return lidMode?.readPresence()
  })
  ipcMain.handle(CH_LID_COMMAND, async (event, raw: unknown) => {
    if (!isMainWindowSender(event) || !isLidModeCommand(raw)) throw new Error('Invalid lid-closed command')
    await lidReady
    return lidMode?.command(raw)
  })
  const optionsService = new ScheduledTaskOptionsService(
    () => runScheduledTaskOptionsWorker({ command: sidecarLaunch().command,
      args: sidecarLaunch().argsFor('scheduled-options'), cwd: process.cwd() }),
    validateCwd,
    Date.now,
    storedProjectsForDiscovery,
  )
  scheduledOptions = optionsService
  ipcMain.handle(CH_SCHEDULED_TASK_OPTIONS_READ, (event, payload: unknown) => {
    if (!isMainWindowSender(event) || !validScheduledTaskOptionsPayload(payload)) {
      return { models: [], defaultEffortOptions: [], projects: [], error: 'Scheduled task options are unavailable' }
    }
    return optionsService.read(payload)
  })
  ipcMain.handle(CH_SCHEDULED_TASKS_READ, (event): ScheduledTasksSnapshot => {
    if (!isMainWindowSender(event)) return { tasks: [], runs: [], error: 'Scheduled tasks are unavailable' }
    return scheduledTasks?.snapshot() ?? { tasks: [], runs: [], error: scheduledTasksError ?? 'Scheduled tasks are starting' }
  })
  ipcMain.handle(CH_SCHEDULED_TASKS_COMMAND, (event, payload: unknown): ScheduledTasksResult => {
    if (!isMainWindowSender(event)) return { ok: false, error: 'Scheduled tasks are unavailable' }
    const command = parseScheduledTaskCommand(payload)
    if (!command) return { ok: false, error: 'Invalid scheduled task' }
    if (!host || !scheduledTasks) return { ok: false, error: scheduledTasksError ?? 'Scheduled tasks are starting' }
    try {
      if (command.type === 'save' || command.type === 'workspace-maps') {
        const input = command.type === 'save' ? command.task : null
        const workspaceId = command.type === 'workspace-maps' ? command.workspaceId : input?.workspaceId
        const cwdToken = command.type === 'workspace-maps' ? command.cwdToken : input?.cwdToken
        const previous = input?.id ? scheduledTasks.snapshot().tasks.find(task => task.id === input.id) : undefined
        const cwd = cwdToken ? cwdTokens.consume(cwdToken) : workspaceId ? optionsService.resolve(workspaceId) : previous?.cwd
        if (!cwd) return { ok: false, error: 'Choose a project folder for this task' }
        const checked = validateCwd(cwd)
        if (!checked.ok) return { ok: false, error: 'The project folder is unavailable' }
        if (command.type === 'workspace-maps') {
          if (scheduledTasks.snapshot().tasks.some(task => task.cwd === checked.realpath && task.name === 'Refresh workspace maps')) return { ok: false, error: 'This project already has a workspace-map task' }
          scheduledTasks.save(workspaceMapSchedule(checked.realpath, defaultRegistryDir()), checked.realpath)
        } else scheduledTasks.save(command.task, checked.realpath)
      } else if (command.type === 'run') scheduledTasks.run(command.id)
      else scheduledTasks.change(command.type, command.id)
      return { ok: true, snapshot: scheduledTasks.snapshot() }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'The scheduled task could not be saved' } }
  })
  const noHost = <T>(): HostResult<T> => ({
    ok: false,
    error: { code: 'spawn_failed', message: 'host is not running' },
  })

  // All folder flows share the native chooser. Only main interprets its path:
  // sessions/tasks receive short-lived tokens; project dialogs retain a draft.
  const chooseDirectory = async (defaultPath?: string): Promise<string | null> => {
    if (devPickerBypass.enabled) {
      return devPickerBypass.pick()
    }
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
    return result.filePaths[0]!
  }
  const pickDirectory = async (defaultPath?: string): Promise<string | null> => {
    const path = await chooseDirectory(defaultPath)
    if (path === null) return null
    const chosen = validateCwd(path)
    if (!chosen.ok) return null
    return cwdTokens.mint(chosen.realpath)
  }
  const creation = new ProjectCreationController({
    store: projectStore,
    pick: () => chooseDirectory(),
    validateCwd,
    legacyKnown: () => [
      ...(host?.listSessions() ?? []),
      ...(readSessionsCatalogCache(defaultRegistryDir())?.entries ?? []),
    ].filter(row => row.binding?.kind !== 'managed' && row.cwd).map(row => ({
      cwd: row.cwd, name: basename(row.cwd) || row.cwd,
    })),
    log: (message, error) => logLegacyDiagnostic(`[projects] ${message}: ${errText(error)}`, 'projects', 'host'),
  })
  projectCreation = creation
  registerProjectIpc<IpcMainInvokeEvent>({
    handle: (channel, listener) => ipcMain.handle(channel, listener),
    isAuthorized: isMainWindowSender,
    list: () => projectStore.list(),
    begin: () => creation.begin(),
    pick: id => creation.pick(id),
    create: input => creation.create(input),
    cancel: id => creation.cancel(id),
    validate: validateCwd,
    createSession: cwd => host ? host.createSession({ cwd }) : Promise.resolve(noHost<SessionDescriptor>()),
    onCreated: projects => {
      optionsService.invalidate()
      sendHostEvent({ type: 'projects', projects })
    },
  })
  const directoryPickers = createDirectoryPickerHandlers({
    isAuthorized: isMainWindowSender,
    sessions: () => host?.listSessions() ?? [],
    pick: pickDirectory,
  })
  ipcMain.handle(
    CH_HOST_PICK_DIR,
    directoryPickers.legacy,
  )
  ipcMain.handle(
    CH_HOST_PICK_SCHEDULED_TASK_DIR,
    directoryPickers.scheduled,
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

  ipcMain.handle(CH_HOST_CREATE_MANAGED, async (): Promise<HostResult<SessionDescriptor>> => {
    if (!host) return noHost<SessionDescriptor>()
    return host.createManagedChat()
  })

  ipcMain.handle(CH_HOST_MOVE_SESSION, async (_e, input: unknown): Promise<HostResult<SessionDescriptor>> => {
    if (!host) return noHost<SessionDescriptor>()
    const command = parseMoveSessionCommand(input)
    if (!command) return { ok: false, error: { code: 'invalid_cwd', message: 'Invalid move request' } }
    if (workspaceJump?.isReserved(command.appSessionId)) return { ok: false, error: { code: 'invalid_cwd', message: 'Wait for the workspace change to settle.' } }
    projectRouting?.cancel(command.appSessionId)
    const cwd = command.cwdToken === null ? null : cwdTokens.consume(command.cwdToken)
    if (cwd === undefined) return { ok: false, error: { code: 'invalid_cwd', message: 'Choose the project folder again' } }
    try {
      const result = await host.moveSession(command.appSessionId, cwd)
      return result
    } catch (error) {
      attachmentGate.cancelRelocationReplayCoalescing(command.appSessionId)
      throw error
    }
  })

  ipcMain.handle(CH_HOST_PROJECT_ROUTES, (): ProjectRouteSnapshot[] =>
    projectRouting?.snapshots() ?? [],
  )

  ipcMain.handle(CH_HOST_RESOLVE_PROJECT_ROUTE, async (_e, input: unknown): Promise<HostResult<void>> => {
    const command = parseProjectRouteCommand(input)
    if (!command || !projectRouting || !projectRouting.hasPending(command.appSessionId)) {
      return { ok: false, error: { code: 'session_not_found', message: 'This pending message is no longer available' } }
    }
    await projectRouting.resolve(command)
    return { ok: true, value: undefined }
  })

  ipcMain.handle(CH_HOST_FOLDER_STATE, async (_e, id: unknown) => {
    if (!host) return noHost<'available' | 'missing'>()
    return host.getSessionFolderState(String(id))
  })

  ipcMain.handle(CH_HOST_FOLDER_RECREATE, async (_e, id: unknown) => {
    if (!host) return noHost<SessionDescriptor>()
    return host.recreateManagedChatFolder(String(id))
  })

  ipcMain.handle(CH_HOST_FOLDER_OPEN, async (_e, id: unknown): Promise<HostResult<void>> => {
    if (!host) return noHost<void>()
    const path = await host.copySessionFolderPath(String(id))
    if (!path.ok) return path
    const error = await shell.openPath(path.value)
    return error ? { ok: false, error: { code: 'invalid_cwd', message: 'could not open this chat folder' } } : { ok: true, value: undefined }
  })

  ipcMain.handle(CH_HOST_FOLDER_COPY, async (_e, id: unknown): Promise<HostResult<void>> => {
    if (!host) return noHost<void>()
    const path = await host.copySessionFolderPath(String(id))
    if (!path.ok) return path
    clipboard.writeText(path.value)
    return { ok: true, value: undefined }
  })

  ipcMain.handle(
    CH_HOST_RESTORE,
    async (_e, appSessionId: unknown): Promise<HostResult<SessionDescriptor>> => {
      if (!host) return Promise.resolve(noHost<SessionDescriptor>())
      // HC2 — the host validates id shape + membership; pass through as unknown.
      const sessionId = String(appSessionId)
      if (sessionCloseCoordinator.isPending(sessionId)) {
        return { ok: false, error: { code: 'session_unreachable', message: 'This chat is stopping. Retry opening it shortly.' } }
      }
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
      return sessionCloseCoordinator.close(sessionId)
    },
  )

  ipcMain.handle(
    CH_HOST_SET_PEER_WAKE_BLOCKED,
    (
      event,
      appSessionId: unknown,
      blocked: unknown,
    ): Promise<HostResult<void>> => {
      // PEER-SESSIONS §6 — the user's standing "don't let peers reopen this"
      // decision. Validated HERE and again at the host (HC2): the renderer is
      // the least trusted zone, so the id must be a real string and the state a
      // real boolean, never a coerced truthy value. `String(x)`/`!!x` would turn
      // a broken caller into a silent write of the WRONG state, which for a
      // control whose whole point is durability is the worst failure available.
      if (!isMainWindowSender(event)) {
        return Promise.resolve({
          ok: false,
          error: { code: 'session_not_found', message: 'unknown sender' },
        } satisfies HostResult<void>)
      }
      if (typeof appSessionId !== 'string' || typeof blocked !== 'boolean') {
        return Promise.resolve({
          ok: false,
          error: { code: 'session_not_found', message: 'invalid request' },
        } satisfies HostResult<void>)
      }
      if (!host) return Promise.resolve(noHost<void>())
      return host.setPeerWakeBlocked(appSessionId, blocked)
    },
  )

  ipcMain.handle(CH_HOST_LIST, async (): Promise<SessionDescriptor[]> => {
    const currentHost = host
    if (!currentHost) return []
    await currentHost.whenReady()
    if (host !== currentHost) return []
    return currentHost.listSessions()
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

  const readSavedWorkspace = createSavedWorkspaceObservationReader((cwd, engineSessionId) =>
    runWorkspaceObservationWorker({
      command: sidecarLaunch().command,
      args: sidecarLaunch().argsFor('workspace-observation', ['--bare']),
      cwd, engineSessionId,
    }),
  )
  const readSessionBranch = createSessionBranchReader({
    host: () => host,
    isLive: id => isSessionLive(supervisor?.listSessions() ?? [], id),
    readSaved: descriptor => {
      if (!descriptor.engineSessionId) throw new Error('Conversation identity is unavailable')
      return readSavedWorkspace(descriptor.cwd, descriptor.engineSessionId,
        defaultTranscriptPath(descriptor.cwd, descriptor.engineSessionId))
    },
  })
  ipcMain.handle(
    CH_HOST_LIST_BRANCHES,
    async (_e, appSessionId: unknown, purpose: unknown): Promise<HostResult<WorkspaceBranches | WorkspaceBranchObservation>> => {
      if (purpose === 'readout') return readSessionBranch(appSessionId)
      if (purpose !== undefined) return { ok: false, error: { code: 'branch_unavailable', message: 'Invalid branch request.' } }
      const h = host
      const descriptor = h?.listSessions().find(row => row.appSessionId === appSessionId)
      if (!h || !descriptor) return { ok: false, error: { code: 'session_not_found', message: 'Session not found.' } }
      const observation = h.getWorkspaceObservation(descriptor.appSessionId)
      if (!observation) return { ok: false, error: { code: 'branch_unavailable', message: 'Wait for this chat to connect.' } }
      const listed = await listWorkspaceBranches(observation.cwd)
      if (!listed.ok) return listed
      const root = await gitRoot(observation.cwd)
      const liveRecords = supervisor?.listSessions() ?? []
      const otherChats: NonNullable<WorkspaceBranches['otherChats']> = []
      for (const row of h.listSessions()) {
        if (row.appSessionId === descriptor.appSessionId || !isSessionLive(liveRecords, row.appSessionId)) continue
        const other = h.getWorkspaceObservation(row.appSessionId)
        if (other && await gitRoot(other.cwd) === root) {
          otherChats.push({ appSessionId: row.appSessionId, title: row.title ?? basename(row.cwd) })
        }
      }
      return { ok: true, value: {
        ...listed.value, otherChats,
        ...(observation.lastWorkingBranch !== undefined ? { recordedBranch: observation.lastWorkingBranch } : {}),
      } }
    },
  )

  const branchTransitionObservers = new Map<SessionId, LidWorkObserver>()
  const switchBranch = createWorkspaceBranchSwitcher({
    host: () => host,
    closeRequested: id => sessionCloseCoordinator.isPending(id),
    switchingSessionIds,
    sessionsWithSubmit,
    isWorkspaceReserved: id => workspaceJump?.isReserved(id) ?? false,
    isLive: id => isSessionLive(supervisor?.listSessions() ?? [], id),
    validateCwd,
    transferFiles: (from, to) => attachmentFileTokens.transfer(from, to),
    log: message => logLegacyDiagnostic(message, 'host', 'main'),
    onTransition: (id, active) => {
      if (active) {
        const observer = lidWorkObserver
        if (observer) {
          branchTransitionObservers.set(id, observer)
          observer.beginWorkspaceTransition(id, 'branch')
        }
      } else {
        branchTransitionObservers.get(id)?.endWorkspaceTransition(id, 'branch')
        branchTransitionObservers.delete(id)
      }
    },
  })
  ipcMain.handle(CH_HOST_SWITCH_BRANCH,
    (_e, appSessionId: unknown, branch: unknown): Promise<SwitchWorkspaceBranchResult> =>
      switchBranch(appSessionId, branch),
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
  async function ensureManagedHistoryPreview(
    descriptor: SessionDescriptor,
    engineId: string,
  ): Promise<HostResult<SessionDescriptor>> {
    const result = { ok: true as const, value: descriptor }
    if (!host?.canPreview(descriptor.appSessionId)) return result
    const existingCache = readCache(TRANSCRIPT_CACHE_DIR, descriptor.appSessionId)
    if (existingCache?.header.engineSessionId === engineId) return result

    // Registry eviction can remove the preview cache. Rebuild it from the
    // host-owned transcript before opening the pane, without starting an engine.
    await runTranscriptBackfill({
      items: [{
        appSessionId: descriptor.appSessionId,
        engineSessionId: engineId,
        transcriptPath: defaultTranscriptPath(descriptor.cwd, engineId),
      }],
      command: sidecarLaunch().command,
      args: sidecarLaunch().argsFor('transcript-backfill', ['--bare']),
      cwd: process.cwd(),
      onSession: workerResult => {
        const currentHost = host
        if (!currentHost?.canPreview(descriptor.appSessionId)) return
        persistTranscriptBackfillResult({
          cacheDir: TRANSCRIPT_CACHE_DIR,
          getCurrentSession: id => currentHost.listSessions().find(row => row.appSessionId === id),
          transcriptExists: row => row.engineSessionId !== null &&
            existsSync(defaultTranscriptPath(row.cwd, row.engineSessionId)),
        }, workerResult)
      },
    })
    return readCache(TRANSCRIPT_CACHE_DIR, descriptor.appSessionId)?.header.engineSessionId === engineId
      ? result
      : { ok: false, error: { code: 'session_unreachable', message: 'Could not load this chat history.' } }
  }
  ipcMain.handle(
    CH_HOST_OPEN_HISTORY,
    async (_e, engineSessionId: unknown): Promise<HostResult<SessionDescriptor>> => {
      const openingHost = host
      if (!openingHost) return noHost<SessionDescriptor>()
      await openingHost.whenReady()
      if (host !== openingHost) return noHost<SessionDescriptor>()
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
      const engineId = resolution.kind === 'existing'
        ? resolution.descriptor.engineSessionId!
        : resolution.resumeEngineSessionId
      const inflight = openHistoryInFlight.get(engineId)
      if (inflight) return inflight
      if (resolution.kind === 'existing') {
        // Already a ready app row — the renderer switches/restores it; no spawn.
        branchOpenSeeds.delete(resolution.descriptor.engineSessionId ?? '')
        if (resolution.descriptor.binding?.kind === 'managed' && resolution.descriptor.restorable) {
          const promise = ensureManagedHistoryPreview(resolution.descriptor, engineId)
            .catch(() => ({
              ok: false as const,
              error: { code: 'session_unreachable' as const, message: 'Could not load this chat history.' },
            })).finally(() => openHistoryInFlight.delete(engineId))
          openHistoryInFlight.set(engineId, promise)
          return promise
        }
        return Promise.resolve({ ok: true, value: resolution.descriptor })
      }
      // A just-created branch normally has its ledger identity already. If a
      // transient write failed, its trusted in-process seed can still take the
      // existing resume-create path and retry recording ownership on open.
      if (resolution.binding?.kind === 'managed' &&
        (!branchOpenSeed(engineId) || host.hasManagedHistoryIdentity(engineId))) {
        const promise = host.adoptManagedHistorySession(
          engineId,
          resolution.title,
          resolution.forked === true,
        ).then(async result => {
          if (!result.ok) return result
          return ensureManagedHistoryPreview(result.value, engineId)
        }).catch(() => ({
          ok: false as const,
          error: { code: 'session_unreachable' as const, message: 'Could not load this chat history.' },
        })).finally(() => {
          openHistoryInFlight.delete(engineId)
        })
        openHistoryInFlight.set(engineId, promise)
        return promise
      }
      // Spawn a resume through the SAME machinery restore uses. A completed
      // relocation reopens under its original app identity; ordinary history
      // uses createSession with a MAIN-resolved cwd + resumeEngineSessionId.
      // The supervisor sets
      // CATCODE_SIDECAR_RESUME_SESSION_ID → sessionResume.ts (the engine's real
      // resume path). The workspace-trust gate still fail-closes the first turn at
      // that cwd (sidecarServer.ts:987); concurrent-resume of a terminal-live
      // transcript is unguarded here exactly as the engine's own /resume is
      // (SESSIONS-UNIFICATION.md, engine-precedent flag).
      const promise = (async () => {
        const relocated = await host.openRelocatedHistorySession(
          engineId,
          resolution.title,
          resolution.forked === true,
        )
        if (relocated) return relocated
        return host.createSession({
          cwd: resolution.cwd,
          resumeEngineSessionId: engineId,
          // Title is main-resolved from the sidecar-written catalog cache
          // (engine-derived, HC1-safe — never renderer-authored), so a resumed
          // open-from-history session's tab/sidebar shows its real name instead
          // of the cwd basename (bug-sweep #2, 2026-07-21).
          ...(resolution.title !== undefined ? { title: resolution.title } : {}),
          ...(resolution.forked === true ? { forked: true } : {}),
          ...(resolution.binding !== undefined ? { binding: resolution.binding } : {}),
        })
      })()
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
          // Armed here rather than before the spawn because ordinary history
          // opens mint an app session id in `createSession`. The race that would
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

  ipcMain.handle(CH_HOST_MANAGE_ACCOUNT, async (event, raw: unknown): Promise<AccountResultFrame> => {
    const verb = parseAccountControlVerb(raw)
    const failure = (): AccountResultFrame => ({
      kind: 'account.result', protocolVersion: PROTOCOL_VERSION, sessionId: '',
      requestId: verb?.requestId ?? '', verb: verb?.type ?? 'account.login',
      ok: false, message: 'Could not complete this account action. Try again.',
    })
    if (!isMainWindowSender(event) || !verb) return failure()
    accountControl ??= createAccountControlRunner({
      launch: () => ({
        command: sidecarLaunch().command,
        args: sidecarLaunch().argsFor('account-control'),
        cwd: app.getPath('home'),
        onWorkerLifecycle: createWorkerLifecycleLogger('account-control'),
        log: line => process.stderr.write(`${line}\n`),
      }),
      onProgress: update => sendHostEvent({ type: 'account-oauth', provider: update.provider, progress: update.progress }),
      onPoolChanged: () => {
        scheduledOptions?.invalidate()
        accountsPoolPublicationGate.invalidate()
        refreshAccountsPoolNow()
      },
    })
    try { return await accountControl.run(verb) } catch { return failure() }
  })

  ipcMain.handle(
    CH_HOST_ACCOUNT_DELETE,
    async (
      event: IpcMainInvokeEvent,
      input: unknown,
    ): Promise<AccountResultFrame> => {
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
      if (!isMainWindowSender(event)) {
        return failure('Account deletion request refused.', '')
      }
      if (!verb) return failure('Invalid account deletion request.', '')
      if (accountProfileMutationInFlight) {
        return failure('Another account deletion is already in progress.')
      }

      accountProfileMutationInFlight = true
      accountsPoolPublicationGate.invalidate()
      const abort = new AbortController()
      accountProfileMutationAbort = abort
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
        if (accountProfileMutationAbort === abort) {
          accountProfileMutationAbort = null
        }
        accountProfileMutationInFlight = false
      }
    },
  )

  ipcMain.handle(
    CH_HOST_ACCOUNT_SIGN_OUT,
    async (
      event: IpcMainInvokeEvent,
      input: unknown,
    ): Promise<AccountResultFrame> => {
      const verb = parseAccountLogoutMessage(input)
      const failure = (
        message: string,
        requestId = verb?.requestId ?? '',
        signOut: AccountSignOutReceipt | undefined = undefined,
      ): AccountResultFrame => ({
        kind: 'account.result',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: '',
        requestId,
        verb: 'account.logout',
        ok: false,
        message,
        ...(signOut === undefined ? {} : { signOut }),
      })
      if (!isMainWindowSender(event)) {
        return failure('Account sign-out request refused.', '')
      }
      if (!verb) return failure('Invalid account sign-out request.', '')
      if (accountProfileMutationInFlight) {
        return failure('Another account change is already in progress.')
      }
      const retryableUnknown = (): AccountSignOutReceipt => ({
        outcome: 'retryable_unknown',
        accountId: verb.accountId,
        expectedCredentialGeneration: verb.expectedCredentialGeneration,
        observedCredentialGeneration: null,
        lifecycleState: null,
        operationId: verb.requestId,
        targetWasActive: false,
        replacementActiveAccountId: null,
      })
      const unresolved = (): AccountResultFrame =>
        failure(
          'Could not confirm account sign-out.',
          verb.requestId,
          retryableUnknown(),
        )

      accountProfileMutationInFlight = true
      accountsPoolPublicationGate.invalidate()
      let accepted = false
      let firstWorkerAborted = false
      const runSignOutWorker = async (
        recovery: boolean,
      ): Promise<AccountsPoolWorkerSignOutResult | null> => {
        const abort = new AbortController()
        accountProfileMutationAbort = abort
        const delivery: {
          value: AccountsPoolWorkerSignOutResult | null
        } = { value: null }
        try {
          const launch = sidecarLaunch()
          const outcome = await runAccountsPoolWorker({
            command: launch.command,
            args: launch.argsFor('accounts-pool', [
              '--bare',
              '--account-sign-out',
              ...(recovery ? ['--account-sign-out-recovery'] : []),
            ]),
            cwd: process.cwd(),
            signal: abort.signal,
            forceKillOnAbort: true,
            input: {
              type: 'account-sign-out',
              version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
              verb,
            },
            onAccountSignOut: result => {
              delivery.value = result
            },
            log: line => process.stderr.write(`${line}\n`),
          })
          return outcome === 'delivered' ? delivery.value : null
        } catch (error) {
          if (!recovery && abort.signal.aborted) firstWorkerAborted = true
          throw error
        } finally {
          if (accountProfileMutationAbort === abort) {
            accountProfileMutationAbort = null
          }
        }
      }

      const messageForOutcome = (
        outcome: AccountsPoolWorkerSignOutResult['receipt']['outcome'],
      ): string => {
        switch (outcome) {
          case 'committed':
            return 'Account signed out.'
          case 'already_committed':
            return 'Account is already signed out.'
          case 'superseded':
            return 'Account changed before sign-out completed.'
          case 'cleanup_pending':
            return 'Account sign-out is still pending.'
          case 'retryable_unknown':
            return 'Could not confirm account sign-out.'
        }
      }

      try {
        let delivered: AccountsPoolWorkerSignOutResult | null = null
        try {
          delivered = await runSignOutWorker(false)
        } catch {
          if (firstWorkerAborted) {
            return unresolved()
          }
        }
        if (!delivered) {
          try {
            delivered = await runSignOutWorker(true)
          } catch {
            delivered = null
          }
        }
        if (!delivered) {
          return unresolved()
        }
        accepted = true
        const outcome = delivered.receipt.outcome
        const notice =
          delivered.receipt.accountId === verb.accountId &&
          delivered.receipt.expectedCredentialGeneration ===
            verb.expectedCredentialGeneration
            ? accountProfileSignedOutNoticeForReceipt(
                delivered.requestId,
                delivered.receipt,
              )
            : null
        if (notice) notifySidecarsOfAccountSignOut(notice)
        return {
          kind: 'account.result',
          protocolVersion: PROTOCOL_VERSION,
          sessionId: '',
          requestId: delivered.requestId,
          verb: 'account.logout',
          ok: outcome === 'committed' || outcome === 'already_committed',
          message: messageForOutcome(outcome),
          signOut: delivered.receipt,
        }
      } catch {
        return unresolved()
      } finally {
        accountProfileMutationInFlight = false
        if (accepted) queueMicrotask(refreshAccountsPoolNow)
      }
    },
  )

  ipcMain.handle(CH_OPEN_EXTERNAL_URL, createExternalUrlHandler<IpcMainInvokeEvent>({ isTrustedSender: trustedPreviewSender, open: url => shell.openExternal(url) }))
  ipcMain.handle(CH_LOCALHOST_PREVIEW_CAPTURE, () => undefined)
  ipcMain.handle(CH_LOCALHOST_PREVIEW_PREPARE, (event, input: unknown) => trustedPreviewSender(event) ? localhostPreviews.prepare(input) : {ok:false,reason:'refused'})
  ipcMain.handle(CH_LOCALHOST_PREVIEW_NAVIGATE, async (event, input: unknown) => {
    const value = previewPayload(input, ['id','routeKey','scroll'])
    if (!trustedPreviewSender(event) || !value || typeof value.id !== 'string' || typeof value.routeKey !== 'string' || value.routeKey.length !== 48) return null
    const known = localhostPreviews.routeFor(value.id, value.routeKey), current = localhostPreviews.current(value.id)
    const scroll = previewPayload(value.scroll, ['x','y'])
    if (!known || !current || !scroll || typeof scroll.x !== 'number' || typeof scroll.y !== 'number' || !Number.isFinite(scroll.x) || !Number.isFinite(scroll.y) || Math.abs(scroll.x)>1e8 || Math.abs(scroll.y)>1e8) return null
    const frame = previewFrame(value.id,current.revision)
    if (!frame || !localhostPreviews.allowed(frame.url)) return null
    restoringLocalRoutes.set(frame.frameTreeNodeId, known.url)
    const state = JSON.stringify(known.state)
    await frame.executeJavaScript(`history.replaceState(JSON.parse(${JSON.stringify(state)}),'',${JSON.stringify(known.url)});dispatchEvent(new PopStateEvent('popstate',{state:history.state}));scrollTo(${scroll.x},${scroll.y})`).catch(()=>{})
    return localhostPreviews.restoreRoute(value.id,value.routeKey)
  })
  ipcMain.handle(CH_PREVIEW_BLOCKED_NAVIGATION_OPEN, async (event,input:unknown) => {
    const value=previewPayload(input,['id','target'])
    if(!trustedPreviewSender(event)||!value||typeof value.id!=='string'||(value.target!=='chrome'&&value.target!=='safari'))return false
    const url=localhostPreviews.blockedUrl(value.id)
    if(!url)return false
    const opened=await launchTargetOpener(url,value.target)
    if(opened===true||opened==='')localhostPreviews.clearBlocked(value.id)
    return opened===true||opened===''
  })
  protocol.handle(FILE_PREVIEW_SCHEME, request => { const parsed=parseFilePreviewUrl(request.url); return parsed&&localhostPreviews.has(parsed.id) ? localhostPreviews.respond(parsed.id,parsed.revision,parsed.path) ?? new Response(null,{status:404}) : filePreviews.respond(request) })
  ipcMain.handle(CH_FILE_PREVIEW_PREPARE, (event, input: unknown) => trustedPreviewSender(event) ? filePreviews.prepare(input) : null)
  ipcMain.handle(CH_FILE_PREVIEW_REFRESH, (event, input: unknown) => {
    const value = previewIdentity(input)
    return trustedPreviewSender(event) && value ? localhostPreviews.has(value.id as string) ? localhostPreviews.refresh(value.id as string) : filePreviews.refresh(value.id as string) : null
  })
  ipcMain.handle(CH_FILE_PREVIEW_COMMIT, async (event, input: unknown) => {
    const value = previewIdentity(input, true)
    if (!trustedPreviewSender(event) || !value) return false
    if (!await previewRenderReady(value.id as string, value.revision as number)) {
      filePreviews.rejectRender(value.id as string, value.revision as number)
      return false
    }
    const local = localhostPreviews.descriptor(value.id as string,value.revision as number)
    if(local){
      const frame=previewFrame(local.id,local.revision)
      const known=local.routeKey?localhostPreviews.routeFor(local.id,local.routeKey):null
      if(frame&&known&&localhostPreviews.allowed(frame.url)&&frame.url!==known.url){
        restoringLocalRoutes.set(frame.frameTreeNodeId,known.url)
        await frame.executeJavaScript(`history.replaceState(JSON.parse(${JSON.stringify(JSON.stringify(known.state))}),'',${JSON.stringify(known.url)});dispatchEvent(new PopStateEvent('popstate',{state:history.state}))`).catch(()=>{})
      }
      if(frame){installLocalHistory(frame);void localFrameRouteState(frame,local.path).then(state=>{if(state)localhostPreviews.rememberRoute(local.id,local.path,state.state)})}
    }
    const ok = local ? localhostPreviews.commit(value.id as string,value.revision as number) : filePreviews.commit(value.id as string, value.revision as number)
    if (ok) for (const key of previewScroll.keys()) if (key.startsWith(`${value.id}:`) && key !== `${value.id}:${value.revision}`) previewScroll.delete(key)
    return ok
  })
  ipcMain.on(CH_FILE_PREVIEW_RELEASE, (event, input: unknown) => {
    const value = previewIdentity(input)
    if (trustedPreviewSender(event) && value) {
      filePreviews.release(value.id as string)
      localhostPreviews.release(value.id as string)
      for(const [node,binding]of localFrameBindings)if(binding.id===value.id){localFrameBindings.delete(node);restoringLocalRoutes.delete(node)}
      for (const cache of [previewScroll, pendingPreviewScroll, pendingPreviewReadiness]) {
        for (const key of cache.keys()) if (key.startsWith(`${value.id}:`)) cache.delete(key)
      }
    }
  })
  ipcMain.handle(CH_FILE_PREVIEW_SCROLL_READ, (event, input: unknown): Promise<FilePreviewScroll> | FilePreviewScroll => {
    const value = previewIdentity(input, true)
    return trustedPreviewSender(event) && value ? readPreviewScroll(value.id as string, value.revision as number) : { x: 0, y: 0 }
  })
  ipcMain.handle(CH_FILE_PREVIEW_SCROLL_RESTORE, async (event, input: unknown) => {
    const value = previewPayload(input, ['id', 'revision', 'scroll'])
    if (!trustedPreviewSender(event) || !value || !previewIdentity({ id: value.id, revision: value.revision }, true) || !previewDescriptor(value.id as string, value.revision as number)) return
    const scroll = previewPayload(value.scroll, ['x', 'y'])
    if (!scroll || typeof scroll.x !== 'number' || typeof scroll.y !== 'number' ||
      !Number.isFinite(scroll.x) || !Number.isFinite(scroll.y) || Math.abs(scroll.x) > 1e8 || Math.abs(scroll.y) > 1e8) return
    const frame = previewFrame(value.id as string, value.revision as number)
    if (frame) await frame.executeJavaScript(`scrollTo(${scroll.x},${scroll.y})`).catch(() => {})
    previewScroll.set(`${value.id}:${value.revision}`, { x: scroll.x, y: scroll.y })
  })
  ipcMain.handle(CH_HOST_OPEN_WORKSPACE_FILE, (_e, input: unknown): Promise<boolean> => {
    if (!host) return Promise.resolve(false)
    return openWorkspaceFile(
      input,
      host.listSessions(),
      (path, target, location) => launchTargetOpener(path, target, location),
      {
        generatedImagesRoot: join(
          process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.cat-code'),
          'generated-images',
        ),
      },
    )
  })
  const externalAppIcons = createExternalAppIconService()
  ipcMain.handle(CH_HOST_EXTERNAL_APP_ICON, createExternalAppIconHandler<IpcMainInvokeEvent>({
    isTrustedSender: isMainWindowSender,
    read: (target, path) => externalAppIcons.read(target, path),
    resolveFile: async (appSessionId, path) => {
      if (!host) return null
      const resolved = await resolveWorkspaceFile({ appSessionId, path }, host.listSessions(), {
        generatedImagesRoot: join(
          process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.cat-code'),
          'generated-images',
        ),
      })
      return resolved?.path ?? null
    },
  }))
  const previewApplications = createPreviewApplications({
    userData: app.getPath('userData'), sessions: () => host?.listSessions() ?? [],
    options: { generatedImagesRoot: join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.cat-code'), 'generated-images') },
    installed: (target, path) => externalAppIcons.installed(target, path),
    localAllowed: url => localhostPreviews.allowed(url),
    open: (path, target) => launchTargetOpener(path, target),
  })
  ipcMain.handle(CH_FILE_PREVIEW_APPLICATIONS, (event, input: unknown) => trustedPreviewSender(event) ? previewApplications.list(input) : { applications: [], selected: 'default' })
  ipcMain.handle(CH_FILE_PREVIEW_APPLICATION_CHOOSE, (event, input: unknown) => trustedPreviewSender(event) ? previewApplications.choose(input) : false)
  // docs/decisions/2026-10-11-workspace-file-availability.md: metadata only,
  // with the same canonical regular-file policy and no operating-system action.
  let availabilityReads = 0
  ipcMain.handle(CH_HOST_WORKSPACE_FILE_AVAILABILITY, async (event, input: unknown): Promise<boolean> => {
    if (!host || !isMainWindowSender(event) || availabilityReads >= 8) return false
    availabilityReads++
    try {
      return await workspaceFileAvailability(input, host.listSessions(), {
        generatedImagesRoot: join(
          process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.cat-code'),
          'generated-images',
        ),
      })
    } finally {
      availabilityReads--
    }
  })
}

function launchTargetOpener(
  path: string,
  target?: OpenWorkspaceFileTarget,
  location?: SourceLocation,
): Promise<boolean | string> {
  if (target === 'chrome' || target === 'safari') {
    return new Promise(resolve => {
      const child = spawn('/usr/bin/open', ['-b', target === 'chrome' ? 'com.google.Chrome' : 'com.apple.Safari', path], { stdio: 'ignore' })
      child.once('error', () => resolve(false))
      child.once('exit', code => resolve(code === 0))
    })
  }
  if (target === 'finder') {
    shell.showItemInFolder(path)
    return Promise.resolve(true)
  }
  if (target === 'vscode') {
    return launchEditorApp('vscode', 'Visual Studio Code', [
      join('/Applications', 'Visual Studio Code.app', 'Contents', 'Resources', 'app', 'bin', 'code'),
      join(homedir(), 'Applications', 'Visual Studio Code.app', 'Contents', 'Resources', 'app', 'bin', 'code'),
      'code',
    ], path, location)
  }
  if (target === 'zed') {
    return launchEditorApp('zed', 'Zed', [
      join('/Applications', 'Zed.app', 'Contents', 'MacOS', 'cli'),
      join(homedir(), 'Applications', 'Zed.app', 'Contents', 'MacOS', 'cli'),
      'zed',
    ], path, location)
  }
  if (target === 'cursor') {
    return launchEditorApp('cursor', 'Cursor', [
      join('/Applications', 'Cursor.app', 'Contents', 'Resources', 'app', 'bin', 'cursor'),
      join(homedir(), 'Applications', 'Cursor.app', 'Contents', 'Resources', 'app', 'bin', 'cursor'),
      'cursor',
    ], path, location)
  }
  return shell.openPath(path)
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
  return handOff(sessionId, message, 'renderer')
}

/**
 * The same hand-off, for a message NO renderer request is waiting on.
 *
 * The peer request plane's traffic is internal: a `host.result` answering the
 * engine's own `host.request`, and a `peer.deliver` message the recipient pane
 * never asked for. It rides main's socket, but its failures are the plane's to
 * read, not the window's to see. Notifying the renderer of them is actively
 * wrong: `connectionState.ts` reduces `session_not_found`, `session_not_ready`
 * and `session_disconnected` into the pane's connection status by CODE alone,
 * with no reference to any request id, so one failed internal ack flips the
 * banner and locks the composer of a session whose user did nothing, over a
 * request id that belongs to no renderer request at all.
 *
 * The failure code still comes back unchanged. The plane uses failure versus
 * success, and chooses `delivery_failed` or `wake_failed` from prior readiness.
 * Only the notification half is skipped.
 */
function forwardInternal(
  sessionId: SessionId,
  message: SidecarClientMessage,
): ErrorFrame['code'] | null {
  return handOff(sessionId, message, 'internal')
}

/**
 * The shared body of the two above. `audience` is REQUIRED and has no default:
 * whether a failure reaches the window is the whole difference between them,
 * and a defaulted answer to that question is the kind of thing a new caller
 * inherits by accident.
 */
function handOff(
  sessionId: SessionId,
  message: SidecarClientMessage,
  audience: 'renderer' | 'internal',
): ErrorFrame['code'] | null {
  const refuseEarly = (code: ErrorFrame['code']): ErrorFrame['code'] => {
    if (audience === 'renderer') {
      const frame = inlineCommandRefusalFrame(sessionId, message, audience, code)
      if (frame) deliver(attachmentGate.onFrame(sessionId, frame))
    }
    return code
  }
  if (!SESSION_ID_RE.test(sessionId)) return refuseEarly('bad_request')
  if (host?.isMoving(sessionId) && message.type !== 'host.result' && message.type !== 'app.abort' && message.type !== 'workspace.handoff') return refuseEarly('session_not_ready')
  if (!canForwardWorkspaceInput(sessionId, message, workspaceJump)) return 'session_not_ready'
  if (switchingSessionIds.has(sessionId) && (message.type === 'app.submit' || message.type === 'peer.deliver')) {
    return 'session_not_ready'
  }
  message = stampHistoryViewAnchor(
    message,
    attachmentGate.viewAnchorUuid(sessionId),
    attachmentGate.viewTruncated(sessionId),
  )

  let admission: string | undefined
  let admissionFinished = false
  const finishAdmission = (sent: boolean) => {
    if (admission === undefined || admissionFinished) return
    admissionFinished = true
    lidWorkObserver?.finishAdmission(admission, sent)
  }

  if (!supervisor) {
    finishAdmission(false)
    if (audience === 'renderer') {
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
    }
    process.stderr.write(`[main] forward to ${sessionId} failed: no live host\n`)
    return 'session_not_found'
  }
  try {
    if ((message.type === 'app.submit' || message.type === 'inline-command.start') && !host?.ensureManagedSubmitIdentity(sessionId)) {
      finishAdmission(false)
      const messageText = "This chat's storage could not be verified. Check its folder, then retry."
      if (audience === 'renderer') {
        const frame: ServerFrame = {
          kind: 'error',
          protocolVersion: PROTOCOL_VERSION,
          sessionId,
          requestId: message.requestId,
          code: 'session_not_ready',
          message: messageText,
          retryable: true,
        }
        deliver(attachmentGate.onFrame(sessionId, frame))
      }
      process.stderr.write(`[main] forward to ${sessionId} failed: ${messageText}\n`)
      return 'session_not_ready'
    }
    if (requiresWorkAdmission(message)) {
      admission = lidWorkObserver?.beginAdmission(sessionId)
      if (admission !== undefined) lidMode?.onAdmissionStarted()
    }
    supervisor.send(sessionId, message)
    finishAdmission(true)
    if (message.type === 'app.submit' || message.type === 'peer.deliver') sessionsWithSubmit.add(sessionId)
    if (isUserTurnSubmit(message, audience)) peerPlane?.onUserMessage(sessionId)
    return null
  } catch (error) {
    finishAdmission(false)
    const messageText = error instanceof Error ? error.message : String(error)
    const code = isSidecarSendError(error) ? error.code : 'bad_request'
    if (audience === 'renderer') {
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
    }
    process.stderr.write(
      `[main] forward to ${sessionId} failed: ${messageText}\n`,
    )
    return code
  }
}

function sanitizeSubmitOptions(options: unknown): {
  observedProposal?: import('../shared/protocol.js').SubmitOptions['observedProposal']
  isMeta?: boolean
  goalSnapshot?: unknown
  submitId?: string
} | undefined {
  if (typeof options !== 'object' || options === null) return undefined
  const o = options as {
    observedProposal?: unknown
    isMeta?: unknown
    goalSnapshot?: unknown
    submitId?: unknown
  }
  const result: { isMeta?: boolean; goalSnapshot?: unknown; submitId?: string; observedProposal?: import('../shared/protocol.js').SubmitOptions['observedProposal'] } = {}
  // Preserve malformed input too: the receiving schema must reject it, not
  // silently turn it into a different context selection.
  if ('observedProposal' in o) result.observedProposal = o.observedProposal as import('../shared/protocol.js').SubmitOptions['observedProposal']
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

function requestWorkspaceControl(sessionId: string, operationId: string, action: WorkspaceControlAction): Promise<WorkspaceControlDelivery> {
  return workspaceControl?.request(sessionId, operationId, action) ?? Promise.resolve({ kind: 'unavailable' })
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
  notificationPreferences ??= readNotificationPreference(app.getPath('userData'))
  desktopNotifications?.dispose()
  desktopNotifications = createDesktopNotifications({
    getSession: id => {
      const session = host?.getSessionDescriptor(id)
      // Match the live ∪ restorable list without rebuilding the saved registry
      // for every streaming frame. Supervisor tombstones are still listed.
      return session && (session.restorable || supervisor?.listSessions().some(row => row.sessionId === id))
        ? session : undefined
    },
    isAppFocused: () => mainWindow?.isFocused() === true,
    isRetryBlocked: id => notificationRetryBlocked.has(id) || host?.isMoving(id) === true ||
      switchingSessionIds.has(id) || projectRouting?.hasPending(id) === true,
    getPreferences: () => notificationPreferences!,
    createNotification: options => Notification.isSupported() ? new Notification(options) : null,
    setBadge: text => app.dock?.setBadge(text),
    openSession: openNotificationSession,
    send: (id, message) => forward(id, message) === null,
    onError: () => logOperational('diagnostic', 'warn', { source: 'notifications', reason: 'delivery_failed' }),
  })
  desktopNotifications.preferencesChanged()
  supervisor = createSupervisor()
  const currentSupervisor = supervisor
  lidWorkObserver?.stop()
  lidWorkObserver = new LidWorkObserver({
    listSessions: (): LidWorkSession[] => currentSupervisor.listSessions().map(session => ({
      sessionId: session.sessionId,
      generation: currentSupervisor.getSessionGeneration(session.sessionId) ?? '',
      status: session.status as LidWorkSession['status'],
    })),
    send: (sessionId, message: WorkStatusRequest) => {
      if (!isWorkStatusRequest(message)) return
      currentSupervisor.send(sessionId, message)
    },
  })
  const currentWorkObserver = lidWorkObserver
  ensureLidMode()
  wireRendererBridge(supervisor)

  // The registry lives beside the supervisor in the host plane. Default storage
  // dir (<config-home>/desktop) unless overridden for tests. The session
  // sidecar's own launch string is the §9-A3 orphan-identity marker so the
  // launch sweep never SIGTERMs an innocent same-pid process.
  const routingStore = new FileProjectRoutingStore(join(defaultRegistryDir(), 'project-routing.json'))
  let recoveredPending = new Set<string>()
  let retainUnreadableLegacy = false
  const recoveredJumps = loadWorkspaceJumpRetention()
  try { recoveredPending = new Set(routingStore.load().filter(row => row.outcome !== 'accepted').map(row => row.sessionId)) }
  catch (error) { retainUnreadableLegacy = true; logLegacyDiagnostic(`[project-routing] recovery failed: ${errText(error)}`, 'project-routing', 'host') }
  const hasPendingSubmit = (id: string) => retainUnreadableLegacy || recoveredJumps.retainAll ||
    (projectRouting?.hasPending(id) ?? recoveredPending.has(id)) ||
    (workspaceJump?.retains(id) ?? recoveredJumps.appSessionIds.has(id))
  const registry = new SessionRegistry({
    retainSession: hasPendingSubmit,
    sidecarCommandMarker: sidecarLaunch().identityMarker,
    log: line => logLegacyDiagnostic(line, 'registry', 'host'),
  })
  const managedStorage = new ManagedStorage({
    appDataBase: app.getPath('userData'),
    ownershipDir: join(defaultRegistryDir(), 'chat-workspaces'),
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
    timing: input => operationalLog.write({ ...input, process: 'host' }),
    hasPendingSubmit,
    supervisor,
    registry,
    validateCwd,
    managedStorage,
    prepareSessionRecovery: appSessionId => {
      if (!workspaceJump) throw new Error('Workspace recovery is unavailable')
      const previous = workspaceJump.snapshot(appSessionId)
      workspaceJump.recover(appSessionId)
      const recovered = workspaceJump.snapshot(appSessionId)
      if (previous && recovered && previous.revision !== recovered.revision) {
        logOperational('diagnostic', 'info', {
          source: 'host', category: 'workspace-recovery',
          reason: `${previous.continuation.outcome}_to_${recovered.continuation.outcome}`,
        }, appSessionId)
      }
    },
    relocate: request => {
      const invocation = randomUUID()
      return runSessionRelocationWorker({
        command: sidecarLaunch().command,
        args: sidecarLaunch().argsFor('relocation'),
        cwd: request.source.cwd,
        request: { type: 'session-relocation', version: 1, ...request },
        onTiming: measurement => operationalLog.write({ process: 'main', level: 'info', event: 'workspace.jump.timing',
          appSessionId: request.appSessionId, engineSessionId: request.engineSessionId,
          fields: { ...measurement, invocationId: invocation } }),
      })
    },
    peerMoveState: appSessionId => ({
      presence: peerPlane?.presenceOf(appSessionId),
      pending: peerPlane?.pendingFor(appSessionId).length ?? 0,
      reservations: peerPlane?.reservationsFor(appSessionId) ?? 0,
    }),
    peerMoveSettled: appSessionId => peerPlane?.onMoveSettled(appSessionId),
    prepareMoveReplayRecovery: (appSessionId, options) => {
      const beforeClear = () => {
        if (options.persistSourceCache) persistTranscriptCache(appSessionId)
        cancelReplayFlush(appSessionId)
      }
      if (attachedFrameDelivery) attachedFrameDelivery.evictSession(appSessionId, beforeClear)
      else {
        beforeClear()
        attachmentGate.clearSession(appSessionId)
      }
      attachmentGate.startRelocationReplayCoalescing(appSessionId)
    },
    cancelMoveReplayCoalescing: appSessionId =>
      attachmentGate.cancelRelocationReplayCoalescing(appSessionId),
    launched,
    log: line => logLegacyDiagnostic(line, 'host', 'host'),
    // The P3-0 carry: a closed/restarted session's replay buffer must be evicted
    // so a reload never replays a dead session's frames. IS-A: persist the
    // transcript cache FIRST (snapshot → persist → evict). This fires on
    // close/restart AND — synchronously — on the quit path (host.shutdownAll),
    // so the persist here uses a synchronous atomic write. Restart persisting a
    // cache is acceptable (a bounded extra sync write).
    evictReplay: appSessionId => {
      const beforeClear = () => {
        persistTranscriptCache(appSessionId)
        cancelReplayFlush(appSessionId)
      }
      if (attachedFrameDelivery) {
        attachedFrameDelivery.evictSession(appSessionId, beforeClear)
      } else {
        beforeClear()
        attachmentGate.clearSession(appSessionId)
      }
      // This is the exact handoff between the parked source and replacement.
      // The sidecar's completion frame, not a timer, releases ready plus replay.
      if (host?.isMoving(appSessionId) && !host.isHiddenMoveWarmup(appSessionId)) {
        attachmentGate.startRelocationReplayCoalescing(appSessionId)
      }
    },
  })
  wireHostEvents(host)
  projectRouting = new ProjectRoutingController({
    store: routingStore,
    prepareForward: appSessionId => host!.prepareRoutedSubmit(appSessionId),
    currentCwd: appSessionId => host?.listSessions().find(session => session.appSessionId === appSessionId)?.cwd ?? null,
    forward,
    answerRefused: answerUnforwardedSubmit,
    publish: (appSessionId, snapshot) =>
      sendHostEvent({ type: 'project-routing', appSessionId, snapshot }),
    log: line => logLegacyDiagnostic(line, 'project-routing', 'host'),
  })

  workspaceControl?.dispose()
  workspaceControl = new WorkspaceHandoffControl({
    generation: id => host?.getSessionGeneration(id),
    send: (id, message) => forwardInternal(id, message) === null,
    acceptsStatus: (id, status) => registry.sessions.find(row => row.appSessionId === id)?.engineSessionId === status.engineSessionId,
    observe: (id, status) => { try { workspaceJump?.observe(id, status) } catch { /* retain unreadable state */ } },
    recover: (id, _operationId) => { try { workspaceJump?.requestFreshEvidence(id) } catch { /* retain unreadable state */ } },
  })
  if (workspaceStatusTimer) clearInterval(workspaceStatusTimer)
  workspaceStatusTimer = setInterval(() => {
    for (const row of registry.sessions) if (host?.getSessionGeneration(row.appSessionId)) {
      try { workspaceJump?.queryStatus(row.appSessionId) } catch { /* retained for next attachment */ }
    }
  }, 30_000)
  workspaceStatusTimer.unref()
  workspaceJump?.dispose()
  workspaceJump = new WorkspaceJumpCoordinator({
    timing: input => operationalLog.write({ ...input, process: 'main' }),
    host,
    row: appSessionId => registry.sessions.find(row => row.appSessionId === appSessionId),
    knownProjects: () => [
      ...storedProjectsForDiscovery().map(project => ({
        path: project.cwd, name: project.name, lastUsedAt: project.createdAt,
      })),
      ...host!.listSessions().filter(row => row.binding?.kind === 'project').map(row => ({
        path: row.cwd, lastUsedAt: Math.max(row.lastMessageSentAt ?? 0, row.lastAttachedAt),
      })),
      ...(readSessionsCatalogCache(defaultRegistryDir())?.entries ?? []).filter(row => row.binding?.kind === 'project' && row.cwdExists).map(row => ({
        path: row.cwd, lastUsedAt: row.modifiedAtMs,
      })),
    ],
    validateCwd,
    trustedProjectRoots: async roots => {
      const invocation = randomUUID()
      const started = performance.now()
      let outcome: 'completed' | 'failed' = 'failed'
      // Invocation identity binds child-local durations to this complete main
      // wait. Child clocks are never compared with main's monotonic clock.
      const record = (measurement: { phase: string; durationMs: number; outcome: 'completed' | 'failed' }) => {
        try { operationalLog.write({ process: 'main', level: 'info', event: 'workspace.jump.timing',
          fields: { ...measurement, invocationId: invocation } }) } catch { /* Observation only. */ }
      }
      try {
        const result = await runWorkspaceListingWorker({ command: sidecarLaunch().command,
          args: sidecarLaunch().argsFor('workspace-listing'), cwd: process.cwd(),
          request: { type: 'workspace-list', version: 1, roots: [...roots] }, onTiming: record })
        outcome = 'completed'
        return result
      } finally { record({ phase: 'listing_worker', durationMs: performance.now() - started, outcome }) }
    },
    verifyReady: async (identity, boundary, state) => {
      const observed = observedWorkspaceHandoffs.get(identity.appSessionId)
      if (!observed || observed.generation !== identity.generation || observed.operationId !== state.operationId ||
          observed.tipUuid !== boundary.tipUuid || observed.toolUseId !== boundary.toolUseId) return false
      const delivery = await requestWorkspaceControl(identity.appSessionId, state.operationId,
        { action: 'verify', tipUuid: boundary.tipUuid, toolUseId: boundary.toolUseId })
      return delivery.kind === 'result' && ['accepted','already_applied'].includes(delivery.result.disposition)
    },
    control: (state, action) => requestWorkspaceControl(state.appSessionId, state.operationId, action),
    waitForControlSlot: (id, operationId, generation) => workspaceControl?.waitForSlot(id, operationId, generation) ?? Promise.resolve(false),
    controlSlotOccupied: (id, operationId) => workspaceControl?.isSlotOccupied(id, operationId) ?? true,
    onPeerInputOpen: appSessionId => peerPlane?.onPeerInputOpen(appSessionId),
    onStateChanged: state => {
      const transitionId = `workspace-jump:${state.operationId}`
      if (state.phase === 'settled') currentWorkObserver?.endWorkspaceTransition(state.appSessionId, transitionId)
      else currentWorkObserver?.beginWorkspaceTransition(state.appSessionId, transitionId)
      host?.publishWorkspaceJumpDisplay(state)
    },
  })
  // Startup may display shared ledgers, but only a claimed restore may recover
  // one. Another app can still be running its destination continuation.
  for (const appSessionId of recoveredJumps.appSessionIds) {
    try {
      const displayState = workspaceJump.snapshot(appSessionId)
      if (displayState) host.publishWorkspaceJumpDisplay(displayState)
    } catch { /* unreadable records retain their rows and refuse admission */ }
  }

  // HOST-REQUEST-PLANE §5 — the request plane, composed from the same host and
  // registry this function just built. It gets NARROW capabilities on purpose:
  // two read-only registry views, the two host methods its three verbs need,
  // main's own `forward`, and one log writer. It cannot reach a window, a file,
  // the supervisor, or any host method beyond these — which is what makes the
  // §3 trust rules reviewable in one module instead of across main.
  const liveHost = host
  const liveRegistry = registry
  peerPlane = createPeerRequestPlane({
    workspaceTransitions: {
      begin: (id, operationId) => {
        const began = liveHost.beginWorkspaceTransition(id, operationId)
        if (began) currentWorkObserver?.beginWorkspaceTransition(id, `peer:${operationId}`)
        return began
      },
      finish: (id, operationId, cwd) => {
        const finished = liveHost.finishWorkspaceTransition(id, operationId, cwd)
        if (finished) currentWorkObserver?.endWorkspaceTransition(id, `peer:${operationId}`)
        return finished
      },
    },
    workspaceRequests: {
      // Carry the main frame-receive clock through validation and dispatch.
      handleRequest: (appSessionId, request, receivedAt) => workspaceJump!.handleRequest(appSessionId, request, receivedAt),
      afterResponse: (appSessionId, request, answered) => workspaceJump!.afterResponse(appSessionId, request, answered),
      isPeerAccessBlocked: appSessionId => workspaceJump!.isPeerAccessBlocked(appSessionId),
    },
    rows: () => liveRegistry.readCurrentSessions(),
    setPeerNotice: (appSessionId, notice) => liveRegistry.setPeerNotice(appSessionId, notice),
    // Membership in `listSessions()` is NOT liveness: the supervisor keeps a
    // record after the child exits, and an idle park IS an exit. The predicate
    // lives in `mainDecisions.ts` so it is executable by a test rather than
    // being the one line of this plane nothing could reach.
    isLive: appSessionId =>
      supervisor !== null && isSessionLive(supervisor.listSessions(), appSessionId),
    // …and existence is NOT readiness. `spawning`, `connecting` and
    // `disconnected` are all non-terminal, so the row above reads live while
    // `SidecarSupervisor.send` still refuses its frame. The delivery branch asks
    // this stricter question instead, so a row in one of those three is woken
    // rather than written to and lost.
    isReady: appSessionId =>
      supervisor !== null && isSessionReadyForFrames(supervisor.listSessions(), appSessionId),
    // …and a row that is not live is only addressable if it could be reopened.
    // The plane reads RAW registry rows, so the host's own restorable filter
    // never reached it: a session opened and never typed in holds an
    // engineSessionId pointing at a transcript the engine has not written, and
    // the roster offered it as a peer that no wake could ever reach. Same
    // predicate the sidebar's `restorable` flag is built from, not a second copy.
    canResume: appSessionId => liveHost.canResume(appSessionId),
    hasLiveForeignOwner: appSessionId => liveHost.hasLiveForeignOwner(appSessionId),
    isMoving: appSessionId => liveHost.isMoving(appSessionId),
    createSessionInWorkspace: (fromAppSessionId, peer) =>
      liveHost.createSessionInWorkspace(fromAppSessionId, peer),
    restoreSession: async appSessionId => {
      const result = await liveHost.restoreSession(appSessionId)
      return result.ok ? { ok: true } : { ok: false, error: result.error }
    },
    // Not `forward`: see `forwardInternal`. Plane traffic answers the engine,
    // not the window, and the renderer-facing path turns a failure into an
    // error frame that flips a pane's connection status by code alone.
    forward: forwardInternal,
    logRouted: (appSessionId, fields) =>
      logOperational('peer.message.routed', 'info', fields, appSessionId),
    log: line => logLegacyDiagnostic(line, 'host', 'main'),
  })

  // Scheduled tasks share the real host and transport. The single-instance app owns their atomic store.
  void launched.then(() => {
    if (host !== liveHost || !supervisor) return
    try {
      const liveSupervisor = supervisor
      scheduledTasks = new ScheduledTasks(join(defaultRegistryDir(), 'scheduled-tasks.json'), {
        launch: (task, id) => launchScheduledSession(liveHost, liveSupervisor, task, id, registry),
        submit: (id, prompt, submitId) => {
          sessionsWithSubmit.add(id)
          const options = { submitId } as import('../shared/protocol.js').SubmitOptions
          return forwardInternal(id, { type: 'app.submit', requestId: generateRequestId(), prompt, options }) === null
        },
      })
      scheduledTasksError = undefined
      scheduledTasks.start()
    } catch { scheduledTasksError = 'Scheduled tasks could not be opened. Close any other Cat Code app and check their saved storage before restarting.' }
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
    powerMonitor.on('suspend', () => { notificationScreenSuspended = true; notificationVisibility.refresh() })
    powerMonitor.on('resume', () => { notificationScreenSuspended = false; notificationVisibility.refresh() })
    powerMonitor.on('lock-screen', () => { notificationScreenLocked = true; notificationVisibility.refresh() })
    powerMonitor.on('unlock-screen', () => { notificationScreenLocked = false; notificationVisibility.refresh() })
    powerMonitor.on('user-did-resign-active', () => { notificationUserInactive = true; notificationVisibility.refresh() })
    powerMonitor.on('user-did-become-active', () => { notificationUserInactive = false; notificationVisibility.refresh() })
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
  workspaceJump?.dispose()
  if (workspaceStatusTimer) clearInterval(workspaceStatusTimer)
  workspaceStatusTimer = null
  desktopPower?.dispose()
  desktopPower = undefined
  lidWorkObserver?.stop()
  lidWorkObserver = undefined
  const endingLidMode = lidMode
  lidMode = undefined
  updateLidMenu()
  if (endingLidMode) lidReady = endingLidMode.shutdown().catch(() => {})
  scheduledTasks?.stop()
  scheduledTasks = null
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
  desktopNotifications?.dispose()
  desktopNotifications = null
  pendingNotificationOpen = null
  accountControl?.dispose()
  accountControl = null
  startupTimers.cancelAll()
  transcriptBackfillAbort?.abort()
  transcriptBackfillAbort = null
  sessionsCatalogDriver?.stop()
  sessionsCatalogDriver = null
  sessionsCatalogActivityGate = null
  sessionsCatalogAbort?.abort()
  sessionsCatalogAbort = null
  usagePublication.invalidate()
  usageDriver?.stop()
  usageDriver = null
  usageActivityGate = null
  usageAbort?.abort()
  usageAbort = null
  accountsPoolDriver?.stop()
  accountsPoolDriver = null
  accountsPoolActivityGate = null
  accountsPoolAbort?.abort()
  accountsPoolAbort = null
  for (const read of settingsInventoryReads) read.abort()
  settingsInventoryReads.clear()
  for (const write of settingsWriteRuns) write.abort()
  settingsWriteRuns.clear()
  settingsWriteGeneration += 1
  accountProfileMutationAbort?.abort()
  accountProfileMutationAbort = null
  accountInvalidation.clearAll()
  idleParkDriver?.stop()
  idleParkDriver = null
  // The window that reported them is going away; a stale visible set must not
  // outlive it and protect sessions in a re-armed driver after reactivate.
  visibleSessions = new Set()
}

/**
 * Fallback when Node receives a signal directly, including Ctrl-C in the dev
 * launcher. Electron installs native shutdown signal handlers after startup
 * that call Browser::Quit, so a running packaged app normally enters
 * `before-quit` instead. Marking is synchronous on this direct-exit route too,
 * so the next launch does not mistake live rows for crashed sessions.
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
  liveFrameDelivery?.dispose()
  disposeRendererRecovery?.()
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
  workspaceJump = null
  projectRouting = null
  peerPlane = null
  observedWorkspaceHandoffs.clear()
  workspaceControl?.dispose()
  registryForDebug = null
  scheduleDebugStateExport.cancel()
  // F2 — drop buffered frames from the closed window so a macOS reopen never
  // replays dead-session frames into the new renderer.
  attachedFrameDelivery?.reset()
  attachedFrameDelivery = null
  liveFrameDelivery?.dispose()
  liveFrameDelivery = null
  handleRendererDeliveryFailure = null
  markRendererDocumentReady = null
  disposeRendererRecovery?.()
  disposeRendererRecovery = null
  cancelAllReplayFlushes()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

let lidQuitFinished = false
app.on('before-quit', event => {
  filePreviews.dispose()
  if (!lidQuitFinished && lidMode) {
    event.preventDefault()
    const ending = lidMode; lidMode = undefined
    void ending.shutdown().finally(() => {
      // Electron drains microtasks before its native before-quit emission
      // returns. Re-entering quit there lets the canceled outer quit overwrite
      // the nested quit's flag, so macOS parks after the windows close.
      setImmediate(() => { lidQuitFinished = true; app.quit() })
    })
    return
  }
  logOperational('app.shutdown.started', 'info', { reason: 'before-quit' })
  // B3 — same clean-marking on ⌘Q; idempotent if window-all-closed already ran
  // (no live rows left to mark).
  shutdownRuntime()
  stopBackgroundDrivers()
  liveFrameDelivery?.dispose()
  disposeRendererRecovery?.()
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
