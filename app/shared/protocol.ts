/**
 * CatCode desktop IPC protocol — v1.
 *
 * This is the versioned engine/session protocol (PROGRAM-PLAN §5, layer 1): the
 * typed seam between the renderer, the Electron main process, the Electron-free
 * supervisor, and the Bun engine sidecars. It is transport-agnostic — the same
 * frames cross the renderer→main IPC bridge and the main→sidecar Unix-domain
 * socket (TRANSPORT-DECISION.md §4, D6 pin 1).
 *
 * Design constraints baked in here on purpose:
 *
 *  - **sessionId slot NOW (PHASE0-REVIEW F3).** v1 addresses every frame to a
 *    session even though P1-0 runs a single sidecar. P0-4 mandates one engine
 *    process per session (N-process), so the supervisor routes by sessionId; we
 *    reserve the field in v1 so Phase 3 multiplexing does not break the wire.
 *
 *  - **Outbound = raw SDKMessage (TRANSPORT-DECISION.md §2/§4).** The engine→UI
 *    direction ships the whole `AppSessionEvent` (incl. `event.message:
 *    SDKMessage`) — NOT the flattened `appSessionEventMapper` shape. The mapper
 *    drops `tool_use`; we route around it.
 *
 *  - **Inbound = the four allowlisted client message types (SECURITY-MINIMUM §2).**
 *    `app.submit` / `app.abort` / `permission.response` / `app.ping` and nothing
 *    else. The inbound payloads reuse the existing, transport-agnostic
 *    `appClientMessageSchema` vocabulary (appSessionProtocol.ts), validated at the
 *    sidecar (the trust boundary), never at the preload.
 */

// Engine types via the P0-3 type-only snapshot alias (NOT direct source), so the
// non-engine app processes (main/supervisor/preload/renderer) typecheck in
// isolation without dragging in the engine's Bun runtime graph. The sidecar,
// which genuinely runs engine code, imports the real modules directly.
import type { AppSessionEvent } from '@cat-code/engine/session-events'
import type {
  AppClientMessage,
  AppReadyPayload,
} from '@cat-code/engine/session-events'

/** Protocol wire version. Bump only on a breaking frame-shape change. */
export const PROTOCOL_VERSION = 1 as const

/**
 * A session address. In P1-0 there is exactly one sidecar and one sessionId,
 * but every frame carries it so the supervisor can route to the owning process
 * once Phase 3 spawns N sidecars (P0-4 N-process verdict).
 */
export type SessionId = string

/* ------------------------------------------------------------------------- *
 * Renderer/main → sidecar (inbound to the engine)
 * ------------------------------------------------------------------------- */

/**
 * The complete set of frames a client may send toward a sidecar. The `message`
 * is the existing allowlisted client vocabulary; the envelope adds only the
 * protocol version and the session address. Anything whose `message` fails
 * `appClientMessageSchema` at the sidecar is rejected (SECURITY-MINIMUM §2 R2).
 */
export type ClientFrame = {
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  message: AppClientMessage
}

/* ------------------------------------------------------------------------- *
 * Sidecar → main/renderer (outbound from the engine)
 * ------------------------------------------------------------------------- */

/**
 * `app.ready` handshake, re-homed from the WS server (AppSessionWebSocketServer
 * .ts:79-87) onto IPC. Emitted once per attach so the renderer knows the
 * channel is open and can read the initial session state.
 */
export type ReadyFrame = {
  kind: 'ready'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  payload: AppReadyPayload
}

/**
 * A single controller event, forwarded raw. `event` is the whole
 * `AppSessionEvent` — including `event.message: SDKMessage` for `type:'message'`
 * — serialized to one JSON frame. This is the raw-forwarding serializer proven
 * in TRANSPORT-DECISION.md §2, NOT `createAppSessionEventMapper`.
 */
export type EventFrame = {
  kind: 'event'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  event: AppSessionEvent
}

/**
 * A `pong` in reply to `app.ping` (liveness only, no side effects —
 * SECURITY-MINIMUM §2 A4).
 */
export type PongFrame = {
  kind: 'pong'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  nonce: string
}

/**
 * Structured error. Codes mirror the WS server's `app.error` set so the
 * renderer can share error handling regardless of transport.
 */
export type ErrorFrame = {
  kind: 'error'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  requestId?: string
  code:
    | 'bad_request'
    | 'turn_already_running'
    | 'permission_not_found'
    | 'unauthorized'
    | 'internal_error'
  message: string
  retryable: boolean
}

export type ServerFrame = ReadyFrame | EventFrame | PongFrame | ErrorFrame

/* ------------------------------------------------------------------------- *
 * Renderer-facing bridge surface (the preload allowlist, SECURITY-MINIMUM §2 R1)
 * ------------------------------------------------------------------------- */

/**
 * The ONLY API the preload exposes to the renderer. Four structured senders +
 * one subscribe. No generic `send(channel, payload)`, no `invoke`, no
 * renderer-controlled channel name. The renderer supplies payloads; the preload
 * owns the fixed internal channel names.
 */
export type CatCodeBridge = {
  /** Send one prompt to the addressed session. */
  submit(sessionId: SessionId, prompt: string, options?: SubmitOptions): void
  /** Abort the named turn on the addressed session. */
  abort(sessionId: SessionId, requestId: string, reason?: string): void
  /** Answer a currently-pending permission request on the addressed session. */
  respondPermission(
    sessionId: SessionId,
    requestId: string,
    response: PermissionResponseInput,
  ): void
  /** Liveness ping; resolves as a `pong` server frame. */
  ping(sessionId: SessionId, nonce: string): void
  /** Subscribe to all server frames. Returns an unsubscribe function. */
  subscribe(listener: (frame: ServerFrame) => void): () => void
  /**
   * Signal that the renderer has mounted and registered `subscribe`, so main can
   * replay any frames buffered before this point (F2). Must be called AFTER
   * `subscribe`, and again after every reload — main treats each call as a fresh
   * attach and replays the buffered frames (incl. the one-shot `ready` handshake
   * and the P1-0 probe) that would otherwise have been lost to a fire-and-forget
   * send.
   */
  rendererReady(): void
}

/**
 * Renderer-supplied submit options. `goalSnapshot` is intentionally `unknown`
 * on the renderer side — it is validated (and re-typed to the real `ThreadGoal`)
 * at the sidecar boundary via `parseThreadGoal`, never trusted by shape here
 * (SECURITY-MINIMUM T4).
 */
export type SubmitOptions = {
  isMeta?: boolean
  goalSnapshot?: unknown
}

/**
 * Renderer-supplied permission response. The renderer may confirm or deny a
 * prompt the engine raised; it may NOT author a different command inside an
 * allow (SECURITY-MINIMUM T6) nor install durable permission rules
 * (SECURITY-MINIMUM T6b). Those constraints are enforced at the sidecar.
 */
export type PermissionResponseInput =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string }
