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
import type {
  AccountVerbMessage,
  AskUserQuestionAnswer,
  CatCodeBridge,
  PermissionResponseInput,
  PermissionSetModeMode,
  RemoteVerbMessage,
  RunControlVerbMessage,
  SessionActionVerbMessage,
  ServerFrame,
  SessionId,
  SettingsVerbMessage,
  SubmitOptions,
  TranscriptCache,
  WorkspaceTrustMessage,
} from '../shared/protocol.js'
import type {
  CreateSessionInput,
  HostEvent,
  HostResult,
  SessionDescriptor,
} from '../shared/hostApi.js'
import type { DebugRendererSnapshot } from '../shared/debugState.js'
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
const CH_RUN_CONTROL_VERB = 'catcode:run-control-verb'
const CH_SESSION_ACTION_VERB = 'catcode:session-action-verb'
const CH_REMOTE_SETTINGS_VERB = 'catcode:remote-settings-verb'
const CH_SETTINGS_VERB = 'catcode:settings-verb'
const CH_PING = 'catcode:ping'
const CH_RESTART = 'catcode:restart'
const CH_SERVER_FRAME = 'catcode:server-frame'
const CH_RENDERER_READY = 'catcode:renderer-ready'

// Control-plane channels (HC3 — fixed, per-method; must match main.ts).
const CH_HOST_CREATE = 'catcode:host:create'
const CH_HOST_RESTORE = 'catcode:host:restore'
const CH_HOST_CLOSE = 'catcode:host:close'
const CH_HOST_LIST = 'catcode:host:list'
const CH_HOST_PICK_DIR = 'catcode:host:pick-directory'
const CH_HOST_PREVIEW = 'catcode:host:preview'
const CH_HOST_EVENT = 'catcode:host:event'

const sendGuard = createRendererIpcGuard()

const bridge: CatCodeBridge = {
  submit(sessionId: SessionId, prompt: string, options?: SubmitOptions): void {
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
    const handler = (_event: unknown, frames: ServerFrame[]) => listener(frames)
    ipcRenderer.on(CH_SERVER_FRAME, handler)
    return () => {
      ipcRenderer.removeListener(CH_SERVER_FRAME, handler)
    }
  },
  rendererReady(): void {
    sendGuard.assertAllowed({ rendererReady: true })
    ipcRenderer.send(CH_RENDERER_READY)
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
