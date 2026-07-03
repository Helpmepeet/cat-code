/**
 * Electron preload — the default-deny IPC allowlist bridge (SECURITY-MINIMUM
 * §2 R1, §3 "Preload surface").
 *
 * This is the ONLY bridge between the untrusted renderer and Electron main. It
 * exposes exactly the four allowlisted senders + one `subscribe`, over FIXED
 * internal channel names the renderer cannot parameterize. There is no generic
 * `send(channel, payload)`, no `invoke`, no raw `ipcRenderer` handle, and no
 * reference to `require`/`child_process`/`fs`/`process` in the exposed object.
 *
 * The renderer supplies payloads only. Main forwards them to the supervisor,
 * which frames them to the sidecar, where they are validated against the
 * allowlist schema (the real trust boundary — renderer-side shape is UX, not
 * security, per R2).
 */

import { contextBridge, ipcRenderer } from 'electron'
import type {
  CatCodeBridge,
  PermissionResponseInput,
  ServerFrame,
  SessionId,
  SubmitOptions,
} from '../shared/protocol.js'

// Fixed internal channel names. The renderer never sees or supplies these.
const CH_SUBMIT = 'catcode:submit'
const CH_ABORT = 'catcode:abort'
const CH_PERMISSION = 'catcode:permission'
const CH_PING = 'catcode:ping'
const CH_SERVER_FRAME = 'catcode:server-frame'
const CH_RENDERER_READY = 'catcode:renderer-ready'

const bridge: CatCodeBridge = {
  submit(sessionId: SessionId, prompt: string, options?: SubmitOptions): void {
    ipcRenderer.send(CH_SUBMIT, { sessionId, prompt, options })
  },
  abort(sessionId: SessionId, requestId: string, reason?: string): void {
    ipcRenderer.send(CH_ABORT, { sessionId, requestId, reason })
  },
  respondPermission(
    sessionId: SessionId,
    requestId: string,
    response: PermissionResponseInput,
  ): void {
    ipcRenderer.send(CH_PERMISSION, { sessionId, requestId, response })
  },
  ping(sessionId: SessionId, nonce: string): void {
    ipcRenderer.send(CH_PING, { sessionId, nonce })
  },
  subscribe(listener: (frame: ServerFrame) => void): () => void {
    const handler = (_event: unknown, frame: ServerFrame) => listener(frame)
    ipcRenderer.on(CH_SERVER_FRAME, handler)
    return () => {
      ipcRenderer.removeListener(CH_SERVER_FRAME, handler)
    }
  },
  rendererReady(): void {
    ipcRenderer.send(CH_RENDERER_READY)
  },
}

contextBridge.exposeInMainWorld('catcode', bridge)
