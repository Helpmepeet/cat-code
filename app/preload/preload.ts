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
  CatCodeBridge,
  PermissionResponseInput,
  PermissionSetModeMode,
  ServerFrame,
  SessionId,
  SubmitOptions,
} from '../shared/protocol.js'
import { createRendererIpcGuard } from './rendererIpcGuard.js'

// Fixed internal channel names. The renderer never sees or supplies these.
const CH_SUBMIT = 'catcode:submit'
const CH_ABORT = 'catcode:abort'
const CH_PERMISSION = 'catcode:permission'
const CH_SET_MODE = 'catcode:set-mode'
const CH_PING = 'catcode:ping'
const CH_RESTART = 'catcode:restart'
const CH_SERVER_FRAME = 'catcode:server-frame'
const CH_RENDERER_READY = 'catcode:renderer-ready'

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
}

contextBridge.exposeInMainWorld('catcode', bridge)
