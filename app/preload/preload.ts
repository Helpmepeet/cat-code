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
  AccountVerbMessage,
  AskUserQuestionAnswer,
  CatCodeBridge,
  PermissionResponseInput,
  PermissionSetModeMode,
  RemoteVerbMessage,
  RunControlVerbMessage,
  SessionActionVerbMessage,
  ContextBreakdownVerbMessage,
  ServerFrame,
  SessionId,
  SessionsCatalogSnapshot,
  SettingsVerbMessage,
  SubmitPrompt,
  SubmitOptions,
  TaskControlVerbMessage,
  TranscriptCache,
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
import { createRendererIpcGuard } from './rendererIpcGuard.js'

declare const __CATCODE_DEV_HARNESS__: boolean

// Fixed internal channel names. The renderer never sees or supplies these.
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
const CH_CONTEXT_BREAKDOWN_VERB = 'catcode:context-breakdown-verb'
const CH_SESSION_ACTION_VERB = 'catcode:session-action-verb'
const CH_REMOTE_SETTINGS_VERB = 'catcode:remote-settings-verb'
const CH_SETTINGS_VERB = 'catcode:settings-verb'
const CH_PING = 'catcode:ping'
const CH_RESTART = 'catcode:restart'
const CH_SERVER_FRAME = 'catcode:server-frame'
const CH_RENDERER_READY = 'catcode:renderer-ready'
const CH_DELIVERY_ACK = 'catcode:delivery-ack'
const CH_RENDERER_FAULT = 'catcode:renderer-fault'
const CH_OPEN_LOGS = 'catcode:open-logs'
const CH_SAVE_DIAGNOSTICS = 'catcode:save-diagnostics'
const CH_DELIVERY_HEALTH_PROBE = 'catcode:delivery-health-probe'
const CH_DELIVERY_HEALTH_RESPONSE = 'catcode:delivery-health-response'

// A document reload must never acknowledge work from its predecessor.
const deliveryDocumentId = crypto.randomUUID()
const deliveryProcessInstanceId = crypto.randomUUID()
const deliveryProcessStartedAt = new Date().toISOString()
let deliverySubscriptionEpoch = 0
const deliveryWatermarks = new Map<string, { received: number; applied: number; committed: number }>()
const pendingDeliveryAcknowledgements: DeliveryAcknowledgement[] = []
let deliveryAcknowledgementFlushScheduled = false
const MAX_DELIVERY_ACKS_PER_BATCH = 64
/**
 * A microtask drains at the end of the CURRENT task, and each delivered frame
 * arrives in its own task, so a microtask flush coalesced nothing in steady
 * state: one frame cost one guarded send. A short timer batches across tasks,
 * which is what keeps diagnostics from spending the shared inbound budget
 * (`MAX_FRAMES_PER_WINDOW`) that real user actions draw on.
 */
const DELIVERY_ACK_FLUSH_MS = 50
let rendererFaultWindowStartedAt = Date.now()
let rendererFaultCount = 0
const MAX_RENDERER_FAULTS_PER_MINUTE = 12
let lastMeasuredEventLoopLagMs = 0

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

function sendDeliveryAcknowledgement(
  sessionId: string,
  sequence: number,
  deliveryAttempt: number,
  streamEpoch: string,
  traceId: string,
  stage: DeliveryAcknowledgement['stage'],
): void {
  const payload: DeliveryAcknowledgement = {
    sessionId,
    streamEpoch,
    sequence,
    deliveryAttempt,
    traceId,
    stage,
    documentId: deliveryDocumentId,
    subscriptionEpoch: deliverySubscriptionEpoch,
    rendererProcessInstanceId: deliveryProcessInstanceId,
    rendererProcessStartedAt: deliveryProcessStartedAt,
  }
  pendingDeliveryAcknowledgements.push(payload)
  if (pendingDeliveryAcknowledgements.length >= MAX_DELIVERY_ACKS_PER_BATCH) {
    flushDeliveryAcknowledgements()
  } else if (!deliveryAcknowledgementFlushScheduled) {
    deliveryAcknowledgementFlushScheduled = true
    setTimeout(flushDeliveryAcknowledgements, DELIVERY_ACK_FLUSH_MS)
  }
  const current = deliveryWatermarks.get(sessionId) ?? { received: 0, applied: 0, committed: 0 }
  if (stage === 'preload.received' || stage === 'renderer.subscription.received') current.received = Math.max(current.received, sequence)
  if (stage === 'renderer.state.applied') current.applied = Math.max(current.applied, sequence)
  if (stage === 'renderer.ui.committed') current.committed = Math.max(current.committed, sequence)
  deliveryWatermarks.set(sessionId, current)
}

function flushDeliveryAcknowledgements(): void {
  deliveryAcknowledgementFlushScheduled = false
  while (pendingDeliveryAcknowledgements.length > 0) {
    const acknowledgements = pendingDeliveryAcknowledgements.splice(0, MAX_DELIVERY_ACKS_PER_BATCH)
    const payload = { acknowledgements }
    // These are diagnostics. The guard still rejects the batch when the shared
    // inbound budget is spent — dropping it is strictly more restrictive than
    // sending, so T7's cap is unchanged — but the rejection must not escape:
    // this runs on a React effect stack whenever the 64-item branch above fires
    // synchronously, and an exception there reaches the error boundary, whose
    // own reporter is blocked by the same spent budget. That pair unmounted the
    // renderer to a black window on 2026-08-09. The trace sink already accounts
    // for missing stage records, so a dropped batch degrades evidence, not the
    // session.
    try {
      sendGuard.assertAllowed(payload)
      ipcRenderer.send(CH_DELIVERY_ACK, payload)
    } catch {
      return
    }
  }
}

ipcRenderer.on(CH_DELIVERY_HEALTH_PROBE, () => {
  const payload = {
    documentId: deliveryDocumentId,
    subscriptionEpoch: deliverySubscriptionEpoch,
    rendererProcessInstanceId: deliveryProcessInstanceId,
    monotonicTimestampMs: performance.now(),
    eventLoopLagMs: lastMeasuredEventLoopLagMs,
    watermarks: [...deliveryWatermarks.entries()].slice(0, 32).map(([sessionId, value]) => ({ sessionId, ...value })),
  }
  sendGuard.assertAllowed(payload)
  ipcRenderer.send(CH_DELIVERY_HEALTH_RESPONSE, payload)
})

// Control-plane channels (HC3 — fixed, per-method; must match main.ts).
const CH_HOST_CREATE = 'catcode:host:create'
const CH_HOST_CREATE_IN_WORKSPACE = 'catcode:host:create-in-workspace'
const CH_HOST_RESTORE = 'catcode:host:restore'
const CH_HOST_CLOSE = 'catcode:host:close'
const CH_HOST_LIST = 'catcode:host:list'
const CH_HOST_PICK_DIR = 'catcode:host:pick-directory'
const CH_HOST_PREVIEW = 'catcode:host:preview'
const CH_HOST_SESSIONS_CATALOG = 'catcode:host:sessions-catalog'
const CH_HOST_OPEN_HISTORY = 'catcode:host:open-history'
const CH_HOST_SAVE_TEXT = 'catcode:host:save-text'
const CH_HOST_EVENT = 'catcode:host:event'
const CH_HOST_VISIBLE_SESSIONS = 'catcode:host:visible-sessions'

const sendGuard = createRendererIpcGuard()

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
  workspaceTrustVerb(sessionId: SessionId, verb: WorkspaceTrustMessage): void {
    // P4-15 — HC3 fixed sender for the trust-gate accept. Same posture as
    // `accountVerb`: the renderer supplies only a decided verb payload; main
    // light-coerces the type and the sidecar is the trust boundary (schema +
    // engine trust persist for its OWN cwd). No path, no token crosses.
    const payload = { sessionId, verb }
    sendGuard.assertAllowed(payload)
    ipcRenderer.send(CH_WORKSPACE_TRUST_VERB, payload)
  },
  setAgentMode(sessionId: SessionId, active: boolean): void {
    // P4-8b — HC3 fixed sender for the in-session Orchestrator toggle. Same
    // posture as `setPermissionMode`: the renderer supplies only a scalar intent;
    // main mints the `requestId` and light-coerces the type, and the sidecar is
    // the trust boundary (Zod schema + engine `matchSessionMode`). No path, no
    // token crosses; the renderer never authors an engine object or a cwd.
    const payload = { sessionId, active }
    sendGuard.assertAllowed(payload)
    ipcRenderer.send(CH_AGENT_MODE_SET, payload)
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
  ping(sessionId: SessionId, nonce: string): void {
    const payload = { sessionId, nonce }
    sendGuard.assertAllowed(payload)
    ipcRenderer.send(CH_PING, payload)
  },
  restart(sessionId: SessionId): void {
    const payload = { sessionId }
    sendGuard.assertAllowed(payload)
    ipcRenderer.send(CH_RESTART, payload)
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
  openLogsFolder(): void {
    sendGuard.assertAllowed({ openLogs: true })
    ipcRenderer.send(CH_OPEN_LOGS)
  },
  saveDiagnosticsBundle(): Promise<boolean> {
    sendGuard.assertAllowed({ saveDiagnostics: true })
    return ipcRenderer.invoke(CH_SAVE_DIAGNOSTICS) as Promise<boolean>
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
