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
 *  - **Inbound = the allowlisted client message types (SECURITY-MINIMUM §2).**
 *    `app.submit` / `app.abort` / `permission.response` / `app.ping` reuse the
 *    existing, transport-agnostic `appClientMessageSchema` vocabulary
 *    (appSessionProtocol.ts); `permission.setMode` (C2,
 *    decisions/PERMISSION-BOUNDARY.md §3) is app-owned and validated by a
 *    sidecar-LOCAL schema — the engine's shared schema is deliberately not
 *    extended (the WS server shares it and has no handler for the frame).
 *    Everything is validated at the sidecar (the trust boundary), never at the
 *    preload.
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
// The host control-plane contract (P3-3). Kept in its own module (`hostApi.ts`)
// because it is a SEPARATE plane from the wire frames — its `HostErrorCode` union
// must never merge with `ErrorFrame['code']` (F3 §3). Re-surfaced on the bridge
// here because the renderer reaches both planes through the one preload.
import type {
  CreateSessionInput,
  HostEvent,
  HostResult,
  SessionDescriptor,
} from './hostApi.js'

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
 * C2 — the modes a renderer may request via `permission.setMode`
 * (decisions/PERMISSION-BOUNDARY.md §3). All four sit inside T5b's
 * already-conceded surface. `bypassPermissions` is REJECTED at the sidecar,
 * always (it escalates beyond T5b: no per-action prompt is ever raised).
 * `auto` is engine-internal/feature-gated and excluded. There is NO
 * `destination` on the wire — the sidecar pins `session` scope; a renderer
 * must never persist `permissions.defaultMode`.
 */
export const PERMISSION_SET_MODE_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
] as const

export type PermissionSetModeMode = (typeof PERMISSION_SET_MODE_MODES)[number]

/**
 * C2 inbound frame. App-owned vocabulary (NOT part of the engine's shared
 * `appClientMessageSchema`); the sidecar validates it with its own local
 * schema and applies it through the engine's `transitionPermissionMode`
 * idiom. Acknowledgement is the resulting `permission.context` snapshot —
 * a no-op switch (same mode) emits nothing.
 */
export type PermissionSetModeMessage = {
  type: 'permission.setMode'
  requestId: string
  mode: PermissionSetModeMode
}

/**
 * Everything a client may send toward a sidecar: the engine's allowlisted
 * vocabulary plus the app-owned C2 frame.
 */
export type SidecarClientMessage = AppClientMessage | PermissionSetModeMessage

/**
 * The complete set of frames a client may send toward a sidecar. The `message`
 * is the allowlisted client vocabulary; the envelope adds only the protocol
 * version and the session address. Anything whose `message` fails validation
 * at the sidecar is rejected (SECURITY-MINIMUM §2 R2).
 */
export type ClientFrame = {
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  message: SidecarClientMessage
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
  engineSessionId: string
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
  /**
   * Present (`true`) ONLY on restored-history frames a resumed sidecar replays
   * at attach (F2 — decisions/RESTORE-HISTORY.md): the same resumed `Message[]`
   * that seeded the engine's turn context (F1), converted by the engine's own
   * `toSDKMessages`. Additive under v1; a renderer may ignore it (rows render
   * identically) or use it for a "restored" divider / notification suppression.
   * Never set on live events.
   */
  replay?: true
  event: AppSessionEvent
}

/**
 * Well-known `ErrorFrame.requestId` marking a LOSSY history replay (F2): the
 * restored transcript exceeded the replay caps (`MAX_HISTORY_REPLAY_FRAMES` /
 * `MAX_HISTORY_REPLAY_BYTES`), so older events were omitted. Emitted BEFORE the
 * retained tail — same boundary idiom as main's replay-buffer truncation frame
 * (`catcode.replay-truncated`) — so a consumer can never mistake a capped
 * replay for complete history.
 */
export const HISTORY_REPLAY_TRUNCATION_REQUEST_ID = 'catcode.history-truncated'

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
	    | 'session_not_found'
	    | 'session_not_ready'
	    | 'session_disconnected'
  message: string
  retryable: boolean
}

/**
 * C3 — the read-only permission-context snapshot payload
 * (decisions/PERMISSION-BOUNDARY.md §4). Built at the sidecar from the
 * ENGINE's live `ToolPermissionContext` — never reconstructed renderer-side
 * from update echoes (settings-file and hook-applied rules would be
 * invisible). JSON-POJO shape on purpose: the engine context's
 * `additionalWorkingDirectories` is a Map, which the JSON-safety guard
 * fail-closes on, so the sidecar converts it to the entries array here.
 */
export type PermissionContextSnapshot = {
  mode: string
  /** Rule strings keyed by PermissionRuleSource (userSettings, cliArg, …). */
  alwaysAllowRules: Record<string, string[]>
  alwaysDenyRules: Record<string, string[]>
  alwaysAskRules: Record<string, string[]>
  additionalWorkingDirectories: Array<{ path: string; source: string }>
  isBypassPermissionsModeAvailable: boolean
}

/**
 * C3 outbound frame. Emitted on attach (immediately after `ready`) and on
 * every change of the engine's live context (store subscription — the context
 * also mutates without boundary involvement, e.g. PermissionRequest hooks
 * applying rules mid-turn). Read-only; feeds the rules editor's read path.
 */
export type PermissionContextFrame = {
  kind: 'permission.context'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  context: PermissionContextSnapshot
}

/**
 * Supervisor-owned process/transport state. Unlike controller events, this
 * remains observable even when the sidecar has died or its socket is unusable.
 */
export type LifecycleFrame = {
  kind: 'lifecycle'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  status: 'disconnected' | 'failed' | 'exited'
  exit?: {
    code: number | null
    signal: string | null
  }
}

export type ServerFrame =
  | ReadyFrame
  | EventFrame
  | PongFrame
  | ErrorFrame
  | LifecycleFrame
  | PermissionContextFrame

/* ------------------------------------------------------------------------- *
 * Renderer-facing bridge surface (the preload allowlist, SECURITY-MINIMUM §2 R1)
 * ------------------------------------------------------------------------- */

/**
 * The ONLY API the preload exposes to the renderer. Fixed structured senders +
 * one subscribe. No generic `send(channel, payload)`, no `invoke`, no
 * renderer-controlled channel name. The renderer supplies payloads; the preload
 * owns the fixed internal channel names.
 *
 * This surface comprises:
 *  1. Direct Engine Commands (submit, abort, respondPermission, ping) - routed to the sidecar.
 *  2. Host-Level Operations (restart) - triggers sidecar process control in Electron main.
 *  3. Attachment Operations (rendererReady, subscribe) - initializes preload-to-renderer bridging.
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
  /**
   * C2 — switch the addressed session's permission mode. Session-scoped only
   * (never persisted); `bypassPermissions`/`auto` are rejected at the sidecar.
   * The updated `permission.context` snapshot frame is the acknowledgement.
   */
  setPermissionMode(sessionId: SessionId, mode: PermissionSetModeMode): void
  /** Liveness ping; resolves as a `pong` server frame. */
  ping(sessionId: SessionId, nonce: string): void
  /** Restart the addressed sidecar process while retaining renderer attachment. */
  restart(sessionId: SessionId): void
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

  /* ----------------------------------------------------------------------- *
   * Control plane (P3-3 — REGISTRY §6.1 / SECURITY-MINIMUM Addendum HC1–HC4).
   * Fixed per-method senders; the renderer never authors a cwd (it requests the
   * native picker, HC1) and never controls a channel name (HC3). Each returns a
   * typed `HostResult` — a failure crosses as data, never a thrown internal
   * error (HC2).
   * ----------------------------------------------------------------------- */

  /**
   * HC1 — request main's NATIVE directory picker. The renderer may request it,
   * never answer it: main returns a one-time `cwdToken` bound to the realpath the
   * user chose (feed it to `createSession`), or null (cancelled). The renderer
   * never sees the path itself — not a listing, not file contents, not even the
   * chosen string.
   */
  pickDirectory(): Promise<string | null>
  /**
   * Create a fresh session rooted at the directory a prior `pickDirectory()`
   * token names. The renderer supplies a token + optional title — it CANNOT
   * author a cwd or a resume id (HC1/T8). To reopen a past session use
   * `restoreSession`, not this.
   */
  createSession(input: CreateSessionInput): Promise<HostResult<SessionDescriptor>>
  /** Restore a registry row's session by id (registry-mediated; HC2). */
  restoreSession(appSessionId: SessionId): Promise<HostResult<SessionDescriptor>>
  /** Graceful close; the row is kept restorable. */
  closeSession(appSessionId: SessionId): Promise<HostResult<void>>
  /** Snapshot of live ∪ restorable sessions. */
  listSessions(): Promise<SessionDescriptor[]>
  /**
   * Subscribe to the host's row-change stream (the session list is a projection
   * of this, never a poll loop). Returns an unsubscribe function.
   */
  subscribeHost(listener: (event: HostEvent) => void): () => void
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
 * allow (SECURITY-MINIMUM T6) nor author permission rules (SECURITY-MINIMUM
 * T6b). "Always allow" is expressed as a SELECTION among the engine-minted
 * `permission_suggestions` on the pending request (`applySuggestions`), never
 * as renderer-authored update objects. All constraints are enforced at the
 * sidecar (decisions/PERMISSION-BOUNDARY.md C1).
 */
export type PermissionResponseInput =
  | {
      behavior: 'allow'
      updatedInput?: Record<string, unknown>
      /**
       * "Always allow": indices into THIS request's engine-minted
       * `permission_suggestions`. The sidecar validates every index against
       * the pending request and re-attaches the engine's own update objects
       * as `updatedPermissions`; the renderer cannot author rule content.
       * Absent or empty = allow once.
       */
      applySuggestions?: number[]
    }
  | { behavior: 'deny'; message: string }
