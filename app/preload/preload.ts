/**
 * Electron preload — the default-deny IPC allowlist bridge (SECURITY-MINIMUM
 * §2 R1, §3 "Preload surface").
 *
 * This is the ONLY bridge between the untrusted renderer and Electron main. It
 * exposes only fixed-channel structured senders + one `subscribe`, over FIXED
 * internal channel names the renderer cannot parameterize. There is no generic
 * `send(channel, payload)`, no `invoke`, no raw `ipcRenderer` handle, and no
 * reference to `require`/`child_process`/`fs`/`process` in the exposed object.
 *
 * The renderer supplies payloads only. A generic byte/rate guard rejects
 * oversized or flooding calls before Electron IPC serialization. Main and the
 * supervisor remain authoritative, and sidecar-bound messages are validated
 * against the allowlist schema at the real engine trust boundary.
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { DeliveryAcknowledgement } from '../shared/deliveryTrace.js'
import type {
  AccountDeleteMessage,
  AccountVerbMessage,
  AskUserQuestionAnswer,
  CatCodeBridge,
  PermissionResponseInput,
  PermissionSetModeMode,
  RemoteVerbMessage,
  PromptForceMessage,
  PromptRecallMessage,
  RunControlVerbMessage,
  SessionActionVerbMessage,
  ContextBreakdownVerbMessage,
  HistoryLoadEarlierMessage,
  OpenWorkspaceFileTarget,
  ServerFrame,
  SessionId,
  SessionsCatalogSnapshot,
  SettingsVerbMessage,
  SubmitPrompt,
  SubmitOptions,
  TaskControlVerbMessage,
  TranscriptCache,
  UsageStatsRange,
  WorkspaceTrustMessage,
} from '../shared/protocol.js'
import type {
  CreateSessionInput,
  HostEvent,
  HostResult,
  SaveTextInput,
  SaveTextResult,
  SessionDescriptor,
} from '../shared/hostApi.js'
import type { DebugRendererSnapshot } from '../shared/debugState.js'
import { MAX_SAVE_TEXT_BYTES } from '../shared/limits.js'
// The fixed internal channel names. The renderer never sees or supplies these,
// and this import list is exactly the set this bridge may touch. The names
// themselves live in `../shared/ipcChannels.ts` so main listens on the same
// literals by construction rather than by hand-copying them.
import {
  CH_SUBMIT,
  CH_ABORT,
  CH_PERMISSION,
  CH_ANSWER_QUESTIONS,
  CH_SET_MODE,
  CH_ACCOUNT_VERB,
  CH_WORKSPACE_TRUST_VERB,
  CH_TASK_CONTROL_VERB,
  CH_RUN_CONTROL_VERB,
  CH_PROMPT_FORCE,
  CH_PROMPT_RECALL,
  CH_CONTEXT_BREAKDOWN_VERB,
  CH_HISTORY_LOAD_EARLIER,
  CH_SESSION_ACTION_VERB,
  CH_REMOTE_SETTINGS_VERB,
  CH_SETTINGS_VERB,
  CH_STATS_QUERY,
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
  // Control plane (HC3 — fixed, per-method senders).
  CH_HOST_CREATE,
  CH_HOST_CREATE_IN_WORKSPACE,
  CH_HOST_RESTORE,
  CH_HOST_CLOSE,
  CH_HOST_SET_PEER_WAKE_BLOCKED,
  CH_HOST_LIST,
  CH_HOST_PICK_DIR,
  CH_HOST_PICK_ATTACHMENT_FILE,
  CH_HOST_PREVIEW,
  CH_HOST_SESSIONS_CATALOG,
  CH_HOST_OPEN_HISTORY,
  CH_HOST_SAVE_TEXT,
  CH_HOST_OPEN_WORKSPACE_FILE,
  CH_HOST_ACCOUNT_DELETE,
  CH_HOST_EVENT,
  CH_HOST_VISIBLE_SESSIONS,
} from '../shared/ipcChannels.js'
import { createRendererIpcGuard } from './rendererIpcGuard.js'
import { DeliveryAckQueue } from './deliveryAckQueue.js'

declare const __CATCODE_DEV_HARNESS__: boolean

// A document reload must never acknowledge work from its predecessor.
const deliveryDocumentId = crypto.randomUUID()
const deliveryProcessInstanceId = crypto.randomUUID()
const deliveryProcessStartedAt = new Date().toISOString()
let deliverySubscriptionEpoch = 0
let rendererFaultWindowStartedAt = Date.now()
let rendererFaultCount = 0
const MAX_RENDERER_FAULTS_PER_MINUTE = 12
/**
 * Timer-scheduling latency, and nothing more. It is measured off the interval
 * below rather than at probe time, so a health sample reports the last interval's
 * value, and its practical floor is around 4 ms.
 *
 * It cannot show that the renderer is drawing. During the 2026-08-14 freeze it
 * read 4.2 to 4.7 ms continuously while `<App>` had not committed a render for
 * over two minutes; the event loop genuinely was idle, so sampling it at probe
 * time would have reported the same thing. That reading was quoted as evidence
 * of a responsive renderer and it cost the investigation hours
 * (`docs/reports/2026-08-14-desktop-logging-feedback.md` A2).
 *
 * `rendersCommitted` is the field that answers render liveness. Read this one
 * only for what it measures: timers not firing at all. Sustained values near
 * 1000 ms or 59999 ms are hidden-window throttling, not a hang (2026-08-09).
 */
let lastMeasuredEventLoopLagMs = 0
let rendersCommitted = 0

// Keep the watchdog payload metadata-only: this detects a delayed renderer
// turn without ever exposing DOM, store, or transcript state.
setInterval(() => {
  const scheduledAt = performance.now()
  setTimeout(() => {
    lastMeasuredEventLoopLagMs = Math.max(0, performance.now() - scheduledAt)
  }, 0)
}, 5_000)

function canReportRendererFault(): boolean {
  const now = Date.now()
  if (now - rendererFaultWindowStartedAt >= 60_000) {
    rendererFaultWindowStartedAt = now
    rendererFaultCount = 0
  }
  if (rendererFaultCount >= MAX_RENDERER_FAULTS_PER_MINUTE) return false
  rendererFaultCount++
  return true
}

const sendGuard = createRendererIpcGuard()

// Delivery-acknowledgement queue — diagnostics traffic (CC-40).
// Extracted to deliveryAckQueue.ts for testability; wired here with the real
// Electron IPC send and the shared rate guard.
const deliveryAckQueue = new DeliveryAckQueue(
  {
    assertAllowed: (payload, kind) => sendGuard.assertAllowed(payload, kind),
    send: (ipcChannel, payload) => ipcRenderer.send(ipcChannel, payload),
    documentId: deliveryDocumentId,
    processInstanceId: deliveryProcessInstanceId,
    processStartedAt: deliveryProcessStartedAt,
    getSubscriptionEpoch: () => deliverySubscriptionEpoch,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  },
  {
    channel: CH_DELIVERY_ACK,
    maxBatchSize: 64,
    maxPending: 1024,
    flushIntervalMs: 50,
  },
)

function sendDeliveryAcknowledgement(
  sessionId: string,
  sequence: number,
  deliveryAttempt: number,
  streamEpoch: string,
  traceId: string,
  stage: DeliveryAcknowledgement['stage'],
): void {
  deliveryAckQueue.push(sessionId, sequence, deliveryAttempt, streamEpoch, traceId, stage)
}


// `performance.memory` is Chromium-only and absent from the DOM typings.
function readJsHeapUsedBytes(): number | null {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize?: unknown } }).memory
  const used = memory?.usedJSHeapSize
  return typeof used === 'number' && Number.isFinite(used) && used >= 0 ? Math.round(used) : null
}

ipcRenderer.on(CH_DELIVERY_HEALTH_PROBE, () => {
  const payload = {
    documentId: deliveryDocumentId,
    subscriptionEpoch: deliverySubscriptionEpoch,
    rendererProcessInstanceId: deliveryProcessInstanceId,
    monotonicTimestampMs: performance.now(),
    eventLoopLagMs: lastMeasuredEventLoopLagMs,
    // A hidden window's timers are throttled, so lag and missed probes alone
    // cannot tell an occluded renderer from a hung one (observed 2026-08-09).
    visible: document.visibilityState === 'visible',
    jsHeapUsedBytes: readJsHeapUsedBytes(),
    rendersCommitted,
    watermarks: [...deliveryAckQueue.getWatermarks().entries()].slice(0, 32).map(([sessionId, value]) => ({ sessionId, ...value })),
  }
  // Telemetry, and wrapped like the other telemetry senders, but deliberately
  // CONTROL class for the budget (IPC-RATE-BUDGET §4): it is roughly one frame
  // per five seconds, and starving it would make main record
  // `renderer.health.missed` for a renderer that is merely rate-limited, i.e.
  // manufacture a fake outage. Budget class and failure class are separate axes.
  try {
    sendGuard.assertAllowed(payload)
    ipcRenderer.send(CH_DELIVERY_HEALTH_RESPONSE, payload)
  } catch {
    // The next probe carries the same watermarks, so a lost response costs
    // nothing beyond one sample.
  }
})

const bridge: CatCodeBridge = {
  submit(sessionId: SessionId, prompt: SubmitPrompt, options?: SubmitOptions): void {
    const payload = { sessionId, prompt, options }
    sendGuard.assertAllowed(payload)
    ipcRenderer.send(CH_SUBMIT, payload)
  },
  abort(sessionId: SessionId, requestId: string, reason?: string): void {
    const payload = { sessionId, requestId, reason }
    sendGuard.assertAllowed(payload)
    ipcRenderer.send(CH_ABORT, payload)
  },
  respondPermission(
    sessionId: SessionId,
    requestId: string,
    response: PermissionResponseInput,
  ): void {
    const payload = { sessionId, requestId, response }
    sendGuard.assertAllowed(payload)
    ipcRenderer.send(CH_PERMISSION, payload)
  },
  setPermissionMode(sessionId: SessionId, mode: PermissionSetModeMode): void {
    const payload = { sessionId, mode }
    sendGuard.assertAllowed(payload)
    ipcRenderer.send(CH_SET_MODE, payload)
  },
  answerQuestions(
    sessionId: SessionId,
    requestId: string,
    answers: AskUserQuestionAnswer[],
  ): void {
    // C5 (P4-20) — same posture as `respondPermission`: the renderer supplies the
    // engine-minted `requestId` + a decided answer payload (option indices +
    // freeform); main light-coerces and the SIDECAR is the trust boundary (T5a +
    // tool gate + Zod + label re-attach). No engine object, no cwd, no token.
    const payload = { sessionId, requestId, answers }
    sendGuard.assertAllowed(payload)
    ipcRenderer.send(CH_ANSWER_QUESTIONS, payload)
  },
  accountVerb(sessionId: SessionId, verb: AccountVerbMessage): void {
    // P4-5 — HC3 fixed sender. The renderer supplies only a decided verb payload;
    // main light-coerces the type and the sidecar is the trust boundary (schema +
    // pool-resolved re-validation). No token ever crosses in either direction.
    const payload = { sessionId, verb }
    sendGuard.assertAllowed(payload)
    ipcRenderer.send(CH_ACCOUNT_VERB, payload)
  },
  deleteAccount(verb: AccountDeleteMessage) {
    sendGuard.assertAllowed(verb)
    return ipcRenderer.invoke(CH_HOST_ACCOUNT_DELETE, verb)
  },
  workspaceTrustVerb(sessionId: SessionId, verb: WorkspaceTrustMessage): void {
    // P4-15 — HC3 fixed sender for the trust-gate accept. Same posture as
    // `accountVerb`: the renderer supplies only a decided verb payload; main
    // light-coerces the type and the sidecar is the trust boundary (schema +
    // engine trust persist for its OWN cwd). No path, no token crosses.
    const payload = { sessionId, verb }
    sendGuard.assertAllowed(payload)
    ipcRenderer.send(CH_WORKSPACE_TRUST_VERB, payload)
  },
  taskControlVerb(sessionId: SessionId, verb: TaskControlVerbMessage): void {
    // P4-8b — HC3 fixed sender for the worker Stop/kill action. Same posture as
    // `accountVerb`: the renderer supplies only a decided verb payload (a target
    // taskId + requestId); main light-coerces the type and the sidecar is the trust
    // boundary (Zod schema + the engine's own `stopTask` re-resolving the id against
    // the live store). No engine object, no path, no token crosses in either direction.
    const payload = { sessionId, verb }
    sendGuard.assertAllowed(payload)
    ipcRenderer.send(CH_TASK_CONTROL_VERB, payload)
  },
  runControlVerb(sessionId: SessionId, verb: RunControlVerbMessage): void {
    // P4-24c — HC3 fixed sender for the composer run-controls (Model / Reasoning /
    // Fast). Same posture as `accountVerb`: the renderer supplies only a decided
    // verb payload (a value/selection + requestId); main light-coerces the type and
    // the sidecar is the trust boundary (Zod schema + the engine's own setter). No
    // engine object, no path, no token crosses in either direction.
    const payload = { sessionId, verb }
    sendGuard.assertAllowed(payload)
    ipcRenderer.send(CH_RUN_CONTROL_VERB, payload)
  },
  recallPrompts(sessionId: SessionId, verb: PromptRecallMessage): void {
    // D1b — HC3 fixed sender for taking back a message that is still waiting for
    // the running response. The thinnest of the verbs: the payload is a
    // requestId and nothing else, because the recall has no target — the sidecar
    // decides what is recallable from its own live queue. main light-coerces the
    // type and the sidecar is the trust boundary (Zod schema + the engine's own
    // queue primitive). The messages come back on `prompt-recall.result`.
    const payload = { sessionId, verb }
    sendGuard.assertAllowed(payload)
    ipcRenderer.send(CH_PROMPT_RECALL, payload)
  },
  forcePrompt(sessionId: SessionId, verb: PromptForceMessage): void {
    const payload = { sessionId, verb }
    sendGuard.assertAllowed(payload)
    ipcRenderer.send(CH_PROMPT_FORCE, payload)
  },
  loadEarlierHistory(
    sessionId: SessionId,
    verb: HistoryLoadEarlierMessage,
  ): void {
    // HC3 fixed sender for the load-earlier read
    // (decisions/HISTORY-LOAD-EARLIER.md). As thin as `recallPrompts`: what the
    // renderer sends is a requestId and nothing else, because the verb has no
    // target and no extent. The renderer cannot name a file, an offset or a
    // count, so the only thing crossing is the intent to read further back. The
    // frame's one other field, `viewAnchorUuid`, is not sent from here: main
    // authors it at `forward` and overwrites whatever arrived, so a renderer
    // that set it anyway gains nothing. main light-coerces the type and the
    // sidecar is the trust boundary (Zod schema + closed key allowlist + its own
    // in-flight guard). What comes back is the existing `replay: true` event
    // vocabulary, closed by one `history.loadEarlier.result`.
    const payload = { sessionId, verb }
    sendGuard.assertAllowed(payload)
    ipcRenderer.send(CH_HISTORY_LOAD_EARLIER, payload)
  },
  contextBreakdownVerb(
    sessionId: SessionId,
    verb: ContextBreakdownVerbMessage,
  ): void {
    // HC3 fixed sender for the on-demand context-breakdown refresh. The lightest
    // of the verbs: the payload is a requestId and nothing else, because the
    // analysis reads engine-side state only. main light-coerces the type and the
    // sidecar is the trust boundary (Zod schema). Nothing crosses back but the
    // existing read-only snapshot broadcast.
    const payload = { sessionId, verb }
    sendGuard.assertAllowed(payload)
    ipcRenderer.send(CH_CONTEXT_BREAKDOWN_VERB, payload)
  },
  sessionActionVerb(sessionId: SessionId, verb: SessionActionVerbMessage): void {
    // P4-6b — HC3 fixed sender for the Sessions ⋯ mutating verbs (rename / export /
    // branch). Same posture as `runControlVerb`: the renderer supplies only a decided
    // verb payload (intent + requestId); main light-coerces the type and the sidecar
    // is the trust boundary (Zod schema + the engine's own op). No engine object, no
    // path, no token crosses in either direction.
    const payload = { sessionId, verb }
    sendGuard.assertAllowed(payload)
    ipcRenderer.send(CH_SESSION_ACTION_VERB, payload)
  },
  remoteSettingsVerb(sessionId: SessionId, verb: RemoteVerbMessage): void {
    // P4-13 — HC3 fixed sender. Same posture as `accountVerb`: the renderer
    // supplies only a decided verb payload; main light-coerces the type and the
    // sidecar is the trust boundary (schema + live-state re-validation). No
    // token ever crosses in either direction.
    const payload = { sessionId, verb }
    sendGuard.assertAllowed(payload)
    ipcRenderer.send(CH_REMOTE_SETTINGS_VERB, payload)
  },
  settingsVerb(sessionId: SessionId, verb: SettingsVerbMessage): void {
    // P4-19 — HC3 fixed sender for the FIRST settings write. Same posture as the
    // other verbs: the renderer supplies only a decided `{ source, key, value }`
    // payload; main light-coerces the type and the sidecar is the trust boundary
    // (Zod schema + EDITABLE_SETTINGS allowlist + SettingsUpdater-under-lock
    // write). The renderer never authors an engine object or a cwd.
    const payload = { sessionId, verb }
    sendGuard.assertAllowed(payload)
    ipcRenderer.send(CH_SETTINGS_VERB, payload)
  },
  queryStats(sessionId: SessionId, range: UsageStatsRange): void {
    const payload = {
      sessionId,
      verb: { type: 'stats.query', range, requestId: crypto.randomUUID() },
    }
    sendGuard.assertAllowed(payload)
    ipcRenderer.send(CH_STATS_QUERY, payload)
  },
  ping(sessionId: SessionId, nonce: string): void {
    const payload = { sessionId, nonce }
    sendGuard.assertAllowed(payload)
    ipcRenderer.send(CH_PING, payload)
  },
  restart(sessionId: SessionId): Promise<HostResult<void>> {
    const payload = { sessionId }
    sendGuard.assertAllowed(payload)
    return ipcRenderer.invoke(CH_RESTART, payload) as Promise<HostResult<void>>
  },
  subscribe(listener: (frames: ServerFrame[]) => void): () => void {
    // Main batches a delivery as one `ServerFrame[]` message (perf F3); hand the
    // whole batch to the renderer so it folds each store in one dispatch. A live
    // single frame arrives as a one-element array. Outbound-only; no inbound
    // surface or validation change.
    const handler = (_event: unknown, frames: ServerFrame[]) => {
      for (const frame of frames) {
        if (frame.deliveryTrace) {
          sendDeliveryAcknowledgement(
            frame.sessionId,
            frame.deliveryTrace.sequence,
            frame.deliveryTrace.deliveryAttempt,
            frame.deliveryTrace.streamEpoch,
            frame.deliveryTrace.traceId,
            'preload.received',
          )
        }
      }
      // Preload receipt is durable before the renderer is invoked. The renderer
      // itself emits `renderer.subscription.received` at its callback entry.
      listener(frames)
    }
    ipcRenderer.on(CH_SERVER_FRAME, handler)
    return () => {
      ipcRenderer.removeListener(CH_SERVER_FRAME, handler)
    }
  },
  rendererReady(): void {
    deliverySubscriptionEpoch++
    sendGuard.assertAllowed({ rendererReady: true, documentId: deliveryDocumentId })
    ipcRenderer.send(CH_RENDERER_READY, { documentId: deliveryDocumentId })
  },
  deliveryAck(sessionId, sequence, deliveryAttempt, streamEpoch, traceId, stage): void {
    sendDeliveryAcknowledgement(sessionId, sequence, deliveryAttempt, streamEpoch, traceId, stage)
  },
  recordRenderCommit(): void {
    if (rendersCommitted < Number.MAX_SAFE_INTEGER) rendersCommitted++
  },
  reportRendererFault(kind, message): void {
    if (!canReportRendererFault()) return
    const payload = { kind, message: message.slice(0, 512) }
    // The fault reporter runs from `componentDidCatch` and from the global
    // error handlers, i.e. only ever while something has already failed. It
    // shares the one inbound budget with every other channel, so the very
    // condition worth reporting (a flood that spent the budget) is the
    // condition under which the guard rejects this report. Throwing here
    // escalated a caught error into a full React unmount. Losing the report is
    // the acceptable failure; losing the window is not.
    try {
      sendGuard.assertAllowed(payload)
      ipcRenderer.send(CH_RENDERER_FAULT, payload)
    } catch {
      // Diagnostics only. Never surfaces to the caller.
    }
  },
  setAppearance(scheme: 'system' | 'light' | 'dark'): void {
    // Narrowed HERE as well as in main, even though main is the trust boundary
    // and re-checks it. This one is cheap and it keeps the preload's promise
    // that nothing leaves this file whose shape it has not stated: the renderer
    // is compiled against a three-value union, and a bundle that drifted off it
    // should stop here rather than reach an `ipcMain` handler.
    if (scheme !== 'system' && scheme !== 'light' && scheme !== 'dark') return
    sendGuard.assertAllowed({ scheme })
    ipcRenderer.send(CH_SET_APPEARANCE, scheme)
  },
  setGlassMode(enabled: boolean): void {
    if (typeof enabled !== 'boolean') return
    sendGuard.assertAllowed({ enabled })
    ipcRenderer.send(CH_SET_GLASS_MODE, enabled)
  },
  refreshAccountsPool(): void {
    sendGuard.assertAllowed({ refreshAccountsPool: true })
    ipcRenderer.send(CH_REFRESH_ACCOUNTS_POOL)
  },
  openLogsFolder(): void {
    sendGuard.assertAllowed({ openLogs: true })
    ipcRenderer.send(CH_OPEN_LOGS)
  },
  saveDiagnosticsBundle(): Promise<boolean> {
    sendGuard.assertAllowed({ saveDiagnostics: true })
    return ipcRenderer.invoke(CH_SAVE_DIAGNOSTICS) as Promise<boolean>
  },
  openWorkspaceFile(
    appSessionId: SessionId,
    path: string,
    target?: OpenWorkspaceFileTarget,
  ): Promise<boolean> {
    const payload = target ? { appSessionId, path, target } : { appSessionId, path }
    sendGuard.assertAllowed(payload)
    return ipcRenderer.invoke(CH_HOST_OPEN_WORKSPACE_FILE, payload) as Promise<boolean>
  },
  pickAttachmentFile(appSessionId: SessionId) {
    const payload = { appSessionId }
    sendGuard.assertAllowed(payload)
    return ipcRenderer.invoke(CH_HOST_PICK_ATTACHMENT_FILE, appSessionId) as Promise<import('../shared/hostApi.js').AttachmentFileSelection | null>
  },
  reportVisibleSessions(sessionIds: SessionId[]): void {
    // IDLE-PARK §4(b) — a one-way hint naming the panes on screen so main's park
    // policy skips them. Fixed channel, guarded like every other sender; main
    // re-validates shape + bounds (`parseVisibleSessions`) because the preload
    // runs in the renderer's process and is never the boundary.
    const payload = { sessionIds }
    sendGuard.assertAllowed(payload)
    ipcRenderer.send(CH_HOST_VISIBLE_SESSIONS, payload)
  },

  // --- Control plane (HC3 — fixed per-method senders; no generic invoke, no
  // renderer-controlled channel names; each returns typed data, never file
  // contents). Rate/size-guarded like the frame senders. ---
  pickDirectory(activeSessionId?: SessionId | null): Promise<string | null> {
    const payload = { pickDirectory: true, activeSessionId }
    sendGuard.assertAllowed(payload)
    // Returns a one-time cwdToken (or null), NOT the chosen path.
    return ipcRenderer.invoke(CH_HOST_PICK_DIR, activeSessionId) as Promise<string | null>
  },
  createSession(
    input: CreateSessionInput,
  ): Promise<HostResult<SessionDescriptor>> {
    // The renderer can only carry a picker token + a title — no cwd, no resume id.
    sendGuard.assertAllowed(input)
    return ipcRenderer.invoke(CH_HOST_CREATE, input) as Promise<
      HostResult<SessionDescriptor>
    >
  },
  restoreSession(
    appSessionId: SessionId,
  ): Promise<HostResult<SessionDescriptor>> {
    sendGuard.assertAllowed({ appSessionId })
    return ipcRenderer.invoke(CH_HOST_RESTORE, appSessionId) as Promise<
      HostResult<SessionDescriptor>
    >
  },
  createSessionInWorkspace(
    appSessionId: SessionId,
  ): Promise<HostResult<SessionDescriptor>> {
    // #15 — the renderer names an EXISTING registry id (a representative session
    // in the target workspace), NEVER a path. Same id-only posture as
    // restoreSession; main passes the id through and the HOST re-derives +
    // re-validates the cwd from its own registry (HC1/T8). A fresh session, no
    // resume — the renderer cannot author or smuggle a cwd.
    sendGuard.assertAllowed({ appSessionId })
    return ipcRenderer.invoke(CH_HOST_CREATE_IN_WORKSPACE, appSessionId) as Promise<
      HostResult<SessionDescriptor>
    >
  },
  previewSession(appSessionId: SessionId): Promise<TranscriptCache | null> {
    // IS-A — instant session open. Modeled exactly on restoreSession: id-only,
    // rate/size-guarded, fixed channel. Read-only; main validates the id against
    // the host's restorable roster before reading any cache off disk, and never
    // returns file contents for an id the host does not vouch for.
    sendGuard.assertAllowed({ appSessionId })
    return ipcRenderer.invoke(CH_HOST_PREVIEW, appSessionId) as Promise<
      TranscriptCache | null
    >
  },
  closeSession(appSessionId: SessionId): Promise<HostResult<void>> {
    sendGuard.assertAllowed({ appSessionId })
    return ipcRenderer.invoke(CH_HOST_CLOSE, appSessionId) as Promise<
      HostResult<void>
    >
  },
  setPeerWakeBlocked(
    appSessionId: SessionId,
    blocked: boolean,
  ): Promise<HostResult<void>> {
    // PEER-SESSIONS §6 — the user's "don't let peers reopen this" decision.
    // Id-only + a boolean, the same posture as closeSession: the renderer names
    // an EXISTING row and authors no rule, no path and no peer. Main re-validates
    // and the host re-checks the id against its own rows (HC2), because the
    // preload runs in the renderer's process and is never the boundary.
    sendGuard.assertAllowed({ appSessionId, blocked })
    // `preloadSource.test.ts` scrapes `ipcRenderer.invoke(` for the channel
    // constant that follows it, and cross-checks that scrape against an
    // independent count of the call sites. A channel argument it cannot read (a
    // helper call, a cast, a literal) now FAILS that guard instead of vanishing
    // from it, so no sender can hide from the proof that none rides a
    // renderer-supplied channel name.
    return ipcRenderer.invoke(CH_HOST_SET_PEER_WAKE_BLOCKED, appSessionId, blocked) as Promise<
      HostResult<void>
    >
  },
  listSessions(): Promise<SessionDescriptor[]> {
    sendGuard.assertAllowed({ listSessions: true })
    return ipcRenderer.invoke(CH_HOST_LIST) as Promise<SessionDescriptor[]>
  },
  readSessionsCatalog(): Promise<SessionsCatalogSnapshot | null> {
    // F2 — read-only, id-less cold-launch baseline. Same fixed-channel posture as
    // listSessions (no renderer input at all); main reads its registry-dir cache,
    // validates it fail-closed, and returns the snapshot or null. Never file bytes.
    sendGuard.assertAllowed({ readSessionsCatalog: true })
    return ipcRenderer.invoke(CH_HOST_SESSIONS_CATALOG) as Promise<
      SessionsCatalogSnapshot | null
    >
  },
  openHistorySession(
    engineSessionId: string,
  ): Promise<HostResult<SessionDescriptor>> {
    // SESSIONS-UNIFICATION (operator ruling 2026-07-20) — open a terminal-created
    // session by its ENGINE session id. Same id-only posture as restoreSession:
    // the renderer carries ONLY the engine id (HC1 — no cwd, no path, no token);
    // main resolves the cwd from the engine-written baseline cache and spawns via
    // the same resume machinery. Rate/size-guarded, fixed channel.
    sendGuard.assertAllowed({ engineSessionId })
    return ipcRenderer.invoke(CH_HOST_OPEN_HISTORY, engineSessionId) as Promise<
      HostResult<SessionDescriptor>
    >
  },
  saveTextToFile(input: SaveTextInput): Promise<SaveTextResult> {
    // P4-35 — the mirror of pickDirectory (HC1): the renderer REQUESTS a native
    // save dialog and cannot answer it. `SaveTextInput` carries text plus a name
    // SUGGESTION and has no path field, so no destination is expressible here;
    // main sanitizes the name to a basename, asks the user, and writes.
    //
    // The guard runs on the request WITHOUT the body, for two reasons. It is the
    // rate cap that matters on this channel (T7's flood posture, unchanged), and
    // the body is a transcript the engine rendered, which routinely exceeds
    // `MAX_FRAME_BYTES` — the cap that still governs every other inbound payload
    // and does not move. The body has its own bound, checked here for a fast local
    // failure and enforced again at MAIN, which is the actual trust boundary.
    sendGuard.assertAllowed({ saveTextToFile: true, suggestedName: input.suggestedName })
    if (new TextEncoder().encode(input.text).byteLength > MAX_SAVE_TEXT_BYTES) {
      throw new Error(`save text exceeds ${MAX_SAVE_TEXT_BYTES} bytes`)
    }
    return ipcRenderer.invoke(CH_HOST_SAVE_TEXT, input) as Promise<SaveTextResult>
  },
  subscribeHost(listener: (event: HostEvent) => void): () => void {
    const handler = (_event: unknown, event: HostEvent) => listener(event)
    ipcRenderer.on(CH_HOST_EVENT, handler)
    return () => {
      ipcRenderer.removeListener(CH_HOST_EVENT, handler)
    }
  },
}

if (__CATCODE_DEV_HARNESS__) {
  const CH_DEBUG_SHELL_STATE = 'catcode:debug:shell-state'
  bridge.reportDebugShellState = (snapshot: DebugRendererSnapshot): void => {
    sendGuard.assertAllowed(snapshot)
    ipcRenderer.send(CH_DEBUG_SHELL_STATE, snapshot)
  }
}

contextBridge.exposeInMainWorld('catcode', bridge)
