/**
 * The host control-plane contract (D1 — `decisions/REGISTRY.md` §6.1; trust zone
 * — `decisions/SECURITY-MINIMUM.md` Addendum 2026-07-04, T8 / HC1–HC4).
 *
 * This is the typed seam DR-4 requires: the app's session control plane, designed
 * ONCE as a host API, not ad hoc. Its methods —
 * `createSession / restoreSession / closeSession / listSessions / subscribe` —
 * run in Electron main (the host plane), never cross into a sidecar as frames,
 * and mint engine processes. In v1 the window is client #1 of this API (a direct
 * call, not a wire frame); when a remote client exists the same surface gains a
 * wire encoding (the DR-4 watch-item — `PROTOCOL-ENVELOPE.md` E-3 / §9). Zero new
 * socket frame types are added here.
 *
 * These types live in `app/shared/` beside the wire protocol because they cross
 * the main↔renderer boundary via preload (same as the frame protocol crosses
 * main↔sidecar). They are pure data — no `electron`, no engine, no supervisor
 * import — so both sides typecheck in isolation.
 *
 * **Union separation (F3 §3, normative):** `HostErrorCode` below and the
 * transport-plane `ErrorFrame['code']` in `protocol.ts` are DELIBERATELY separate
 * unions and must never be merged. The same underlying state (a dead session)
 * surfaces as `session_disconnected` on a frame *send* and `session_not_found` on
 * a `restoreSession` of a reaped row — one is transport, one is control-plane;
 * conflating them erases which layer failed.
 */

import type { SessionId } from './protocol.js'

/* ------------------------------------------------------------------------- *
 * Requests / responses (REGISTRY.md §6.1)
 * ------------------------------------------------------------------------- */

/**
 * Create (or restore) a session — the INTERNAL (main→host) request. `cwd` and
 * `resumeEngineSessionId` are MAIN-supplied, never renderer-authored (HC1/T8):
 * `cwd` is either main's own `process.cwd()` (the startup session) or a realpath
 * main resolved from a native-picker token; `resumeEngineSessionId` is only ever
 * set by `restoreSession` from a registry row. The host re-validates `cwd`
 * regardless of origin (defense in depth). The renderer's create surface is the
 * separate `CreateSessionInput` (a picker token + a title), which cannot express
 * either field — see `CatCodeBridge.createSession`.
 */
export type CreateSessionRequest = {
  /** Session root. Host re-validates (realpath / exists / isDirectory) — HC1. */
  cwd: string
  /** Present ⇒ restore, not a fresh spawn (REGISTRY.md R3). Main-set only. */
  resumeEngineSessionId?: string
  /** Display only; length-capped by the host (`MAX_SESSION_TITLE_CHARS`). */
  title?: string
}

/**
 * The RENDERER-facing create input (HC1). The renderer never names a path: it
 * obtains a one-time `cwdToken` from `pickDirectory()` (main's native dialog) and
 * hands it back here. Main resolves the token to a realpath it minted; an unknown
 * or already-consumed token is rejected. There is deliberately NO `cwd` and NO
 * `resumeEngineSessionId` — a compromised renderer can neither author a
 * filesystem path nor forge a resume (restore is only `restoreSession(id)`).
 */
export type CreateSessionInput = {
  /** A one-time directory token from `pickDirectory()`. */
  cwdToken: string
  /** Display only; length-capped by the host. */
  title?: string
}

/** Live view of a session — the registry row projected with its live status. */
export type SessionDescriptor = {
  appSessionId: SessionId
  /** null until the ready frame arrives (the two-id bridge, REGISTRY.md §2). */
  engineSessionId: string | null
  cwd: string
  title: string | null
  /**
   * Live process/transport view. `restorable` is set when no process is live.
   * For a DEAD session the status carries the row's shutdown marking — a
   * crash-marked row (sidecar died without a graceful close, REGISTRY §4.4)
   * surfaces `disconnected`, a clean close surfaces `exited` — so a crash and a
   * close are distinguishable without a new field (P3-5b kill/close parity; the
   * minimal-extension route per the C3 extend-host-vs-change-UI precedent).
   */
  status: 'spawning' | 'ready' | 'disconnected' | 'exited'
  /** Registry row + transcript both present (the row can be re-spawned). */
  restorable: boolean
  createdAt: number
  lastAttachedAt: number
}

/**
 * The control-plane error vocabulary. SEPARATE union from the transport
 * `ErrorFrame['code']` (F3 §3 — never merge).
 */
export type HostErrorCode =
  /** HC1 validation failed (not a dir / not absolute / vanished). */
  | 'invalid_cwd'
  /** Id not in live map ∪ registry (HC2). */
  | 'session_not_found'
  /** `MAX_REGISTRY_SESSIONS` or the spawn rate cap hit (HC4). */
  | 'session_limit'
  /** Sidecar process failed to start / never sent a valid ready frame. */
  | 'spawn_failed'
  /** Registry file unwritable — sessions still work, persistence degrades. */
  | 'registry_unavailable'

/** A typed host failure — never a bare thrown string (REGISTRY.md §6.1). */
export type HostError = {
  code: HostErrorCode
  message: string
}

/**
 * Every host method returns this discriminated result (or void-on-ok for
 * `closeSession`), so a failure is a typed value the caller pattern-matches —
 * never an exception carrying internal state across the boundary (HC2).
 */
export type HostResult<T> = { ok: true; value: T } | { ok: false; error: HostError }

/* ------------------------------------------------------------------------- *
 * HostEvent — the row-change stream (REGISTRY.md §6.1)
 * ------------------------------------------------------------------------- */

/**
 * Row-level change notifications derived from supervisor events. The renderer's
 * session list is a PROJECTION of this stream, never a poll loop:
 *  - `session-added`   — a new row exists (create / restore).
 *  - `session-status`  — a live row's status changed (spawning→ready→…exited).
 *  - `session-removed` — a row left the live∪restorable set (reaped).
 *
 * Each event carries the full descriptor (except `removed`, which carries only
 * the id) so a subscriber can update without a follow-up read.
 */
export type HostEvent =
  | { type: 'session-added'; session: SessionDescriptor }
  | { type: 'session-status'; session: SessionDescriptor }
  | { type: 'session-removed'; appSessionId: SessionId }

/* ------------------------------------------------------------------------- *
 * Bounds (HC4 + title cap)
 * ------------------------------------------------------------------------- */

/**
 * Spawn rate cap (HC4): at most this many `createSession` spawns per
 * `SPAWN_RATE_WINDOW_MS`, extending T7's flood posture to process creation so a
 * compromised renderer cannot fork-bomb the machine. Paired with the registry's
 * `MAX_REGISTRY_SESSIONS` row bound; either breach → `session_limit`.
 */
export const MAX_SPAWNS_PER_WINDOW = 8
export const SPAWN_RATE_WINDOW_MS = 10_000

/** Max `title` length the host will store (display-only, length-capped §6.1). */
export const MAX_SESSION_TITLE_CHARS = 200

/**
 * The typed host API surface. The renderer reaches it only through main
 * (preload exposes fixed senders per method — HC3); a daemon (v2) would call the
 * same interface directly.
 */
export type HostApi = {
  createSession(req: CreateSessionRequest): Promise<HostResult<SessionDescriptor>>
  restoreSession(appSessionId: SessionId): Promise<HostResult<SessionDescriptor>>
  closeSession(appSessionId: SessionId): Promise<HostResult<void>>
  listSessions(): SessionDescriptor[]
  subscribe(cb: (event: HostEvent) => void): () => void
}
