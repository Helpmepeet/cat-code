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
  CatCodeBridge,
  PermissionResponseInput,
  PermissionSetModeMode,
  ServerFrame,
  SessionId,
  SubmitOptions,
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
const CH_SET_MODE = 'catcode:set-mode'
const CH_ACCOUNT_VERB = 'catcode:account-verb'
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
  accountVerb(sessionId: SessionId, verb: AccountVerbMessage): void {
    // P4-5 — HC3 fixed sender. The renderer supplies only a decided verb payload;
    // main light-coerces the type and the sidecar is the trust boundary (schema +
    // pool-resolved re-validation). No token ever crosses in either direction.
    const payload = { sessionId, verb }
    sendGuard.assertAllowed(payload)
    ipcRenderer.send(CH_ACCOUNT_VERB, payload)
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
  subscribe(listener: (frame: ServerFrame) => void): () => void {
    const handler = (_event: unknown, frame: ServerFrame) => listener(frame)
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
