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

import type {
  AccountsSnapshot,
  SessionId,
  SessionsCatalogSnapshot,
} from './protocol.js'

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
   * Wall-clock at which `title` last CHANGED, or null when it never has (also the
   * value for rows persisted before the field existed). Read together with the
   * sessions catalog's `capturedAtMs` (`protocol.ts`) to decide whether the app's
   * own title or the engine transcript's recorded title is the NEWER intent
   * (`app/renderer/src/sessionsCatalogState.ts` `pickTitle`) — without it a
   * terminal `/rename`, which writes only the transcript, could never reach a row
   * the app had already opened. Additive control-plane descriptor field — not a
   * wire frame, so no `protocol.ts` version bump (the `lastMessageSentAt`
   * precedent below).
   */
  titleUpdatedAt: number | null
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
  /**
   * This dead row's engine was RECLAIMED on purpose (IDLE-PARK), not lost.
   *
   * `status` cannot carry it: a park must project `disconnected` + `restorable`
   * so `foldTabMembership` keeps the tab, which is byte-identical to a crash.
   * IDLE-PARK §11 rejected this field to keep the renderer provably unaware park
   * exists — but the 2026-08-05 ruling WITHDREW that goal ("a park must not
   * present as a failure"), and without a descriptor signal the four
   * descriptor-derived surfaces (Sessions page, ⌘K palette, sidebar row,
   * debug export) went on calling an intentional reclaim `crashed` (§1b).
   *
   * False for every live row, so a restore in flight is never "parked". Pairs
   * with `restorable`: a session parked before it ever ran a turn has no
   * transcript and can never come back, and reads as dead rather than resting
   * (§1c). Additive control-plane field, not a wire frame — no `protocol.ts`
   * version bump (the `lastMessageSentAt` / `titleUpdatedAt` precedent).
   */
  parked: boolean
  createdAt: number
  lastAttachedAt: number
  /**
   * Wall-clock of the last MESSAGE SENT this session (a turn actually ran), or
   * null if none. The Sidebar's recency subtitle reads THIS, falling back to
   * `createdAt` when null — NOT `lastAttachedAt`, which every attach/open bumps
   * (the CC-2 bug; see `app/renderer/src/sidebarState.ts` deferred spec + the
   * registry's `markMessageSent`). Additive control-plane descriptor field — not
   * a wire frame, so no `protocol.ts` version bump.
   */
  lastMessageSentAt: number | null
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
  /** `MAX_LIVE_SESSIONS` or the spawn rate cap hit (HC4). */
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
 * P4-35 — the file sink (operator ruling 2026-07-30)
 * ------------------------------------------------------------------------- */

/**
 * Why `saveTextToFile` fails, as a THIRD union — deliberately neither
 * `HostErrorCode` nor `ErrorFrame['code']`, for the same reason those two are
 * separate (F3 §3, above). This is not a session control-plane call: it names no
 * session, touches no registry row, mints no process, and reaches no host method.
 * Adding `invalid_name`/`write_failed` to `HostErrorCode` would put a
 * file-sink outcome into the vocabulary a `createSession`/`restoreSession` caller
 * pattern-matches, which erases which plane failed exactly as merging the other
 * two would.
 */
export type SaveTextErrorCode =
  /** The suggested name sanitized to nothing usable (HC1 — see the sanitizer). */
  | 'invalid_name'
  /** Text absent, not a string, or past `MAX_SAVE_TEXT_BYTES`. */
  | 'invalid_text'
  /** The user chose a destination and the write itself failed. */
  | 'write_failed'

/**
 * The outcome of a save. `ok: true, saved: false` is the user DISMISSING the
 * native dialog — a normal outcome, not a failure, so the caller can stay silent
 * instead of reporting an error the user caused on purpose.
 *
 * HC1: there is no path anywhere in this type. The renderer learns whether a file
 * was written, never where. It already knows the directory it cannot name, because
 * the user picked it in main's own dialog.
 */
export type SaveTextResult =
  | { ok: true; saved: boolean }
  | { ok: false; error: { code: SaveTextErrorCode; message: string } }

/**
 * A save REQUEST as the renderer may express it (HC1). There is deliberately no
 * `path` and no `directory`: the renderer offers the text plus a name SUGGESTION,
 * and main decides the destination by asking the user. `suggestedName` is treated
 * as hostile — main reduces it to a basename and never joins it to a directory
 * itself (`sanitizeSaveFileName`).
 */
export type SaveTextInput = {
  text: string
  suggestedName: string
}

/* ------------------------------------------------------------------------- *
 * HostEvent — the row-change stream (REGISTRY.md §6.1)
 * ------------------------------------------------------------------------- */

/**
 * Row-level change notifications derived from supervisor events. The renderer's
 * session list is a PROJECTION of this stream, never a poll loop:
 *  - `session-added`   — a new row exists (create / restore).
 *  - `session-status`  — a live row's status changed (spawning→ready→…exited).
 *  - `session-removed` — a row left the live∪restorable set (reaped).
 *  - `sessions-catalog` — the global cross-workspace sessions catalog (engine
 *    transcript history) refreshed. Catalog owner decision #4 (shape (b),
 *    `docs/migration/decisions/CATALOG-OWNERSHIP.md`): main re-spawns a
 *    disposable engine-graph worker on a timer, which enumerates the catalog off
 *    any sidecar; main delivers the accepted snapshot to the renderer here.
 *    Read-only OUTBOUND display metadata (C3 precedent) — NOT a roster row and
 *    NOT a renderer-authored write; carries no session descriptor. `secretGuard`
 *    ran on it at the worker and again at main's parse boundary.
 *  - `accounts-pool` — the global account pool (Codex + Anthropic) refreshed.
 *    Accounts owner (`docs/migration/decisions/ACCOUNTS-OWNERSHIP.md`): the pool
 *    is process-GLOBAL vault state with no session input, so main re-spawns a
 *    disposable engine-graph worker on a timer exactly as it does for the
 *    catalog, and delivers the accepted snapshot here. This is what lets the
 *    Accounts page show live usage with NO session open. Read-only OUTBOUND and
 *    ALREADY redacted (no token, no vault path by construction); `secretGuard`
 *    ran on it at the worker and again at main's parse boundary. Account WRITES
 *    remain session-plane `account.*` verbs — this event never carries one.
 *
 * The first three carry the full descriptor (except `removed`, which carries only
 * the id) so a subscriber can update without a follow-up read.
 */
export type HostEvent =
  | { type: 'session-added'; session: SessionDescriptor }
  | { type: 'session-status'; session: SessionDescriptor }
  | { type: 'session-removed'; appSessionId: SessionId }
  | { type: 'sessions-catalog'; catalog: SessionsCatalogSnapshot }
  | { type: 'accounts-pool'; pool: AccountsSnapshot }

/* ------------------------------------------------------------------------- *
 * Bounds (HC4 + title cap)
 * ------------------------------------------------------------------------- */

/**
 * Concurrency cap (HC4): at most this many engine processes live at once —
 * `createSession` refuses beyond it with `session_limit`. Under the N-process
 * model each live session is a real sidecar, so this is the standing-fleet half
 * of HC4's fork-bomb defense (the rate cap below is the burst half).
 *
 * Deliberately SEPARATE from the registry's `MAX_REGISTRY_SESSIONS` row bound,
 * which it was fused with until 2026-07-26. That bound is a file-growth
 * backstop over live + closed-but-restorable rows and had to be raised to stop
 * browsing from evicting restorable sessions; this one bounds *processes* and
 * must not move with it. Value unchanged (32) across that split — the effective
 * live limit is exactly what it has always been.
 */
export const MAX_LIVE_SESSIONS = 32

/**
 * Spawn rate cap (HC4): at most this many `createSession` spawns per
 * `SPAWN_RATE_WINDOW_MS`, extending T7's flood posture to process creation so a
 * compromised renderer cannot fork-bomb the machine. Paired with
 * `MAX_LIVE_SESSIONS`; either breach → `session_limit`.
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
  /**
   * Create a FRESH session in an existing workspace, named by a REGISTRY id (a
   * representative session already rooted at that workspace's cwd) — the
   * per-workspace "+" (#15). The renderer authors NO path: the host looks the id
   * up in its OWN registry, RE-VALIDATES the row's cwd (realpath / exists /
   * isDirectory — never trusting a stale row), and spawns a brand-new session
   * there with NO resume (a new `appSessionId`, no `resumeEngineSessionId`). The
   * cwd is sourced from the registry exactly as `restoreSession` sources it, so a
   * compromised renderer can neither author nor smuggle a filesystem path
   * (HC1/T8). Unlike restore this needs neither a transcript nor an
   * engineSessionId on the row.
   */
  createSessionInWorkspace(
    appSessionId: SessionId,
  ): Promise<HostResult<SessionDescriptor>>
  closeSession(appSessionId: SessionId): Promise<HostResult<void>>
  listSessions(): SessionDescriptor[]
  /**
   * IDLE-PARK §1c — may this row's engine session id be resumed if its live
   * process is reclaimed? Unlike `canPreview`, this deliberately permits a live
   * row: the park driver asks before it sends a reclaim request. The host owns
   * this read because it alone knows both transcript existence and this-run
   * resume-failure verdicts.
   */
  canResume(appSessionId: SessionId): boolean
  /**
   * IS-A — read-only restorability gate for the transcript-cache preview path.
   * True only for a not-live row with a non-null engineSessionId (the descriptor's
   * `restorable`); main calls it before reading a cache off disk.
   */
  canPreview(appSessionId: SessionId): boolean
  subscribe(cb: (event: HostEvent) => void): () => void
}
