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
 *  - **New outbound facts grow an existing snapshot; they never repurpose a
 *    field.** `PROTOCOL_VERSION` stays put for an addition because no reader's
 *    existing field changes shape. `RunControlsSnapshot.model.currentLabel` and
 *    `.contextWindow` (2026-07-29), and `RunControlsSnapshot.autoCompact`
 *    (2026-07-30), are that kind of addition: display facts
 *    about the CURRENT model that ONLY the engine can compute (a marketing
 *    name; a context window that depends on betas, model capabilities, and env
 *    overrides). They exist because the composer face printed a canonical model
 *    id and the donut divided every model by 200k. `current` deliberately keeps
 *    its meaning — the resolved model id — because `selectContextUsage` matches
 *    it against `result.modelUsage` keys, so re-spelling it would break the
 *    live gauge.
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
  SaveTextInput,
  SaveTextResult,
  SessionDescriptor,
} from './hostApi.js'
import type { DebugRendererSnapshot } from './debugState.js'
import type {
  EditableSettingSource,
  EditableSettingValue,
  SettingsWriteValue,
} from './settingsEditable.js'

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
 * (decisions/PERMISSION-BOUNDARY.md §3). The first four sit inside T5b's
 * already-conceded surface. `bypassPermissions` is on the wire but is NOT
 * freely grantable: the sidecar rejects it UNLESS the session was launched with
 * the trusted opt-in (`CATCODE_ALLOW_BYPASS=1` → the context's
 * `isBypassPermissionsModeAvailable`), mirroring the CLI's
 * `--dangerously-skip-permissions` trusted-surface model. A renderer alone
 * (a browser-like surface) can never escalate to it. `auto` is classifier-backed
 * and may be selected only while the sidecar's live engine gate reports it
 * available; the sidecar re-checks that gate before applying the transition.
 * There is NO `destination` on the wire — the sidecar pins `session` scope; a
 * renderer must never persist `permissions.defaultMode`.
 */
export const PERMISSION_SET_MODE_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions',
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
 * C5 — one AskUserQuestion answer, per question, position-aligned to the gated
 * `questions` array (decisions/ASK-USER-QUESTION-ANSWER.md). Two channels:
 *
 *  - `optionIndices` — indices into THIS question's engine-minted `options[]`.
 *    The sidecar re-attaches the engine's own `options[i].label` (C1
 *    selection-by-index, PERMISSION-BOUNDARY.md §2); no renderer byte becomes an
 *    option label. A single-select question accepts at most one component total.
 *  - `other` — the built-in "Other…" freeform answer. Genuine user-authored text,
 *    the one part index-selection cannot reach; model-visible text only, never a
 *    privileged action, so it is security-equivalent to an `app.submit` prompt.
 */
export type AskUserQuestionAnswer = {
  optionIndices: number[]
  other?: string
}

/**
 * C5 inbound frame (decisions/ASK-USER-QUESTION-ANSWER.md). App-owned vocabulary
 * (NOT part of the engine's shared `appClientMessageSchema`); the sidecar
 * validates it with a sidecar-LOCAL schema, re-reads the gated `questions` from
 * the ENGINE's own pending request, reconstructs `updatedInput.answers` from
 * engine-minted labels + the bounded freeform text, and resolves the pending
 * request through the engine's existing `respondToPermissionRequest` allow path
 * (zero `src/` changes). `requestId` is the pending engine-minted permission
 * requestId (T5a); the frame is valid ONLY for an `AskUserQuestion` request.
 * Cancel/decline reuses `permission.response` deny — there is no verb for it.
 */
export type AskUserQuestionAnswerMessage = {
  type: 'askUserQuestion.answer'
  requestId: string
  answers: AskUserQuestionAnswer[]
}

/* ------------------------------------------------------------------------- *
 * P4-5 — account lifecycle verbs (app-owned inbound; sidecar-LOCAL schema)
 * ------------------------------------------------------------------------- *
 *
 * The Accounts domain is the first W4 domain to accept MUTATION frames. Like
 * `permission.setMode` (C2), these are app-owned vocabulary the engine's shared
 * `appClientMessageSchema` deliberately does NOT carry — each is validated by a
 * sidecar-LOCAL Zod schema at the trust boundary and dispatched to the engine's
 * OWN account machinery (`codexAccountPool`/`codexTokenRefresh`), never a
 * re-implementation.
 *
 * The decision that makes these safe (recorded here inline, the way C2's
 * reasoning lives in PERMISSION-BOUNDARY.md §3):
 *
 *  - **Secret-owner invariant is untouched (SECURITY-MINIMUM §4).** No verb
 *    carries or returns token material, and none makes a token cross IPC. The
 *    renderer NAMES an account (by `accountId`) or an alias string; it never
 *    sees, sends, or receives a credential. Deletion/logout are availability
 *    operations, not confidentiality ones — the redacted `accounts.snapshot`
 *    read-seam remains the only account data the renderer ever holds.
 *  - **T6 — renderer authors no policy, only a target.** The sidecar RE-RESOLVES
 *    every `accountId` against the live pool (never trusts a renderer-held
 *    record), validates aliases against the engine's OWN regex + uniqueness rule
 *    (`validateCodexAccountAlias`, not a renderer claim), and re-derives every
 *    guard (switchable/vault-backed) from the real pool. The worst a compromised
 *    renderer gains is the ability to run the same account commands the user can
 *    already run in the TUI (`/switch-account`, `/rename-account`,
 *    `/delete-account`, `/logout`, `/touch-all`, `/login`) — TUI-equivalent, and
 *    strictly less than the live auto-approval T5b already concedes.
 *  - **Destructive ops fail closed.** `account.delete` requires an explicit
 *    `confirm: true` (mirroring the TUI's `--confirm`); a missing/false confirm
 *    is rejected at the boundary, request unperformed.
 *  - **T5a-analog — every verb carries a renderer-minted `requestId`** echoed on
 *    the resulting `account.result` frame, so a UI can correlate the outcome;
 *    the sidecar never mints account state from an unmatched id.
 *  - **T7 — the existing inbound size/rate caps apply unchanged.**
 *
 * `account.login` begins the engine's REAL OAuth flow (browser + localhost:1455
 * callback, `codex-client.ts`); the engine owns the token write. Its live
 * completion/alias sub-protocol is coordinated with P4-15 (first-run auth owns
 * the shared OAuth surface); here the renderer drives navigation and the newly
 * added account simply appears on the next `accounts.snapshot` re-broadcast.
 */
export const ACCOUNT_VERB_TYPES = [
  'account.switch',
  'account.rename',
  'account.delete',
  'account.logout',
  'account.touchAll',
  'account.login',
  // P4-15 — the OAuth login sub-protocol (paste-code fallback, alias step,
  // cancel). Same secret-owner + T5a + T7 posture as the other account verbs:
  // the renderer authors only the user-typed code/alias string, never a token,
  // and the engine owns every credential write. Progress flows back on the
  // `oauth.login.progress` outbound frame (non-secret state only).
  'account.oauthPasteCode',
  'account.oauthAlias',
  'account.oauthCancel',
] as const

export type AccountVerbType = (typeof ACCOUNT_VERB_TYPES)[number]

/** Subscription provider selected for a desktop OAuth sign-in. */
export type AccountLoginProvider = 'anthropic' | 'openai'

/** Switch the persisted active account new sessions seed from. Synchronous. */
export type AccountSwitchMessage = {
  type: 'account.switch'
  requestId: string
  accountId: string
  /** Pool containing the target account. Defaults to OpenAI for older clients. */
  provider?: AccountLoginProvider
}

/** Rename a vault-backed account's alias. Alias re-validated at the sidecar. */
export type AccountRenameMessage = {
  type: 'account.rename'
  requestId: string
  accountId: string
  alias: string
}

/** Delete a vault-backed account profile. Destructive → requires `confirm`. */
export type AccountDeleteMessage = {
  type: 'account.delete'
  requestId: string
  accountId: string
  confirm: true
}

/** Sign out the active account (clears its token; the profile stays on disk). */
export type AccountLogoutMessage = {
  type: 'account.logout'
  requestId: string
}

/** Refresh OAuth tokens for every unlocked vault account (per-account result). */
export type AccountTouchAllMessage = {
  type: 'account.touchAll'
  requestId: string
}

/** Begin the engine's real OAuth login flow (engine owns the token write). */
export type AccountLoginMessage = {
  type: 'account.login'
  requestId: string
  /** Defaults to OpenAI for backward compatibility with older renderer calls. */
  provider?: AccountLoginProvider
}

/**
 * P4-15 — the OAuth paste-code fallback. When the browser callback does not land
 * (port 1455 busy, browser blocked), the user pastes the authorization code/URL
 * shown by the provider; the ENGINE (`codex-client.ts` `onManualInput`) consumes
 * it and exchanges it for tokens. The renderer authors ONLY the user-typed
 * string — never a token. Bounded like every renderer-controlled string.
 */
export type AccountOAuthPasteCodeMessage = {
  type: 'account.oauthPasteCode'
  requestId: string
  /** The raw pasted authorization code or full redirect URL (engine parses it). */
  code: string
}

/**
 * P4-15 — submit the post-login account alias (Codex `waiting_for_alias` step).
 * `alias` MAY be empty (the prototype's "leave blank to use the account email"
 * skip); the ENGINE re-validates a non-empty alias against its OWN rule
 * (`validateCodexAccountAlias`) before the token write. Renderer authors only the
 * name string.
 */
export type AccountOAuthAliasMessage = {
  type: 'account.oauthAlias'
  requestId: string
  /** The user-typed alias; empty = skip (anonymous / account email). */
  alias: string
}

/** P4-15 — abandon the in-flight OAuth attempt (returns the surface to ready). */
export type AccountOAuthCancelMessage = {
  type: 'account.oauthCancel'
  requestId: string
}

export type AccountVerbMessage =
  | AccountSwitchMessage
  | AccountRenameMessage
  | AccountDeleteMessage
  | AccountLogoutMessage
  | AccountTouchAllMessage
  | AccountLoginMessage
  | AccountOAuthPasteCodeMessage
  | AccountOAuthAliasMessage
  | AccountOAuthCancelMessage

/* ------------------------------------------------------------------------- *
 * P4-13 — RemoteSettings verbs (app-owned inbound; sidecar-LOCAL schema)
 * ------------------------------------------------------------------------- *
 *
 * D3 (`decisions/PAIRED-DEVICES.md` §4) ruled RemoteSettings CUT to the real
 * surface: bridge toggle/status + read-only command-filter truth + a
 * direct-connect form. No paired-device identity/authz model. Like the P4-5
 * account verbs, these are app-owned vocabulary the engine's shared
 * `appClientMessageSchema` does NOT carry, validated by a sidecar-LOCAL Zod
 * schema and dispatched to the engine's OWN bridge/direct-connect primitives —
 * never a re-implementation.
 *
 *  - **`remoteSettings.bridgeToggle`** flips the engine's real
 *    `AppState.replBridgeEnabled` flag (`src/state/AppStateStore.ts:138`) —
 *    the SAME field `/remote-control` sets (`src/commands/bridge/bridge.tsx`)
 *    and `useReplBridge` (`src/hooks/useReplBridge.tsx`) watches. Enabling
 *    re-runs the real prerequisite gate (policy / disabled-reason / min-version
 *    / OAuth-presence) before flipping the flag, so the UI never claims
 *    "Publishing" over a bridge that cannot actually authenticate. It does NOT
 *    itself establish the live WS/poll connection — that effect loop is
 *    mounted only in the Ink REPL (`src/screens/REPL.tsx:4208`), not in this
 *    Electron sidecar; flagged as a follow-up in the P4-13 report (the
 *    `account.login` precedent for a verb that is real but partial).
 *  - **`remoteSettings.directConnect`** calls the engine's real
 *    `createDirectConnectSession` (`src/server/createDirectConnectSession.ts:26`)
 *    with the renderer-supplied `serverUrl` and the session's OWN cwd (never a
 *    renderer-authored cwd, HC1). It proves the target session is reachable;
 *    it does not re-point this Electron session's live transport at the
 *    remote server (that would touch the locked transport decision — flagged,
 *    not attempted).
 *  - **Secret-owner invariant untouched.** No verb carries or returns a token.
 *    `directConnect` never forwards an `authToken` (the cut-scope form has no
 *    such field).
 *  - **T5a-analog** — every verb carries a renderer-minted `requestId` echoed
 *    on the resulting `remoteSettings.result` frame.
 *  - **T7** — the existing inbound size/rate caps apply unchanged;
 *    `serverUrl` is length-bounded like every other renderer-controlled string.
 */
export const REMOTE_VERB_TYPES = [
  'remoteSettings.bridgeToggle',
  'remoteSettings.directConnect',
] as const

export type RemoteVerbType = (typeof REMOTE_VERB_TYPES)[number]

/** Enable/disable the Remote Control bridge (`replBridgeEnabled`). */
export type RemoteBridgeToggleMessage = {
  type: 'remoteSettings.bridgeToggle'
  requestId: string
  enable: boolean
}

/** Create a session on another cat-code server over the direct-connect primitive. */
export type RemoteDirectConnectMessage = {
  type: 'remoteSettings.directConnect'
  requestId: string
  serverUrl: string
}

export type RemoteVerbMessage =
  | RemoteBridgeToggleMessage
  | RemoteDirectConnectMessage

/**
 * P4-19 — the FIRST renderer→engine settings WRITE verb. App-owned vocabulary
 * (like the C2 / account / RemoteSettings verbs): validated by a sidecar-LOCAL
 * Zod schema + the closed `EDITABLE_SETTINGS` allowlist, then applied through the
 * engine's `SettingsUpdater`-under-lock form (`settings.ts:480`, the P3-5a/DR-2
 * single-writer fix). The renderer NAMES a key + a scalar value + an editable
 * source; the sidecar re-validates all three (key ∈ allowlist, value matches the
 * key's control type, source ∈ editable layers) and never trusts the frame. A
 * new provenance-carrying `settings.snapshot` is re-emitted when the write lands.
 *
 * **P4-41 — reset-to-default, additive under v1, NO `PROTOCOL_VERSION` bump.**
 * The verb gained no field and no new frame kind: `value` may now be `null`,
 * meaning REMOVE this key from this layer rather than write a value to it. Every
 * frame that was valid before is still valid and still means the same thing, so
 * no reader's existing field changes shape — the addition is one more admitted
 * value, in a direction that fails closed (a reader without the branch rejects
 * `null` at its value gate rather than mis-writing it). Why `null` and not a
 * reserved string: it is outside `EditableSettingValue` by type, rejected by
 * `validateEditableSettingValue` for all four control kinds, and not a legal
 * on-disk value for any of these keys (each is `.optional()`, never
 * `.nullable()`, in `SettingsSchema`) — so it cannot collide with a legitimate
 * user value the way an in-band sentinel can. See `settingsEditable.ts`
 * (`SettingsWriteValue`).
 */
export const SETTINGS_VERB_TYPES = ['settings.setValue'] as const

export type SettingsVerbType = (typeof SETTINGS_VERB_TYPES)[number]

/** Write one editable core setting to one editable layer. */
export type SettingsSetValueMessage = {
  type: 'settings.setValue'
  requestId: string
  /** One of the three editable layers (policy/flag are read-only, rejected). */
  source: EditableSettingSource
  /** A key in the closed `EDITABLE_SETTINGS` allowlist (re-checked at sidecar). */
  key: string
  /**
   * A non-secret scalar matching the key's control type, or `null` to REMOVE the
   * key from `source` (P4-41). Both are re-checked at the sidecar, which tells
   * them apart structurally — never by a reserved value.
   */
  value: SettingsWriteValue
}

export type SettingsVerbMessage = SettingsSetValueMessage

/**
 * Ask the sidecar to (re)compute this session's context breakdown, answered by a
 * `context-breakdown.snapshot` (there is no dedicated result frame — the snapshot
 * IS the answer, and it broadcasts, so every attached pane refreshes together).
 *
 * ON DEMAND because the analysis is genuinely expensive: `analyzeContextUsage`
 * fans out to ~10 `count_tokens` requests with a Haiku sampling fallback, and on
 * a `gpt-*` session `getAnthropicClient` re-derives the provider from the model
 * string, so those fail to the Codex path and bill the Anthropic fallback. Paying
 * that per turn, for a panel that may never be opened, is what this frame exists
 * to avoid — the terminal's `/context` is likewise user-initiated.
 *
 * Carries NO renderer-authored state beyond a correlation id: the analysis reads
 * only engine-side session state, so there is nothing here for the sidecar to
 * trust. Rate limiting is the generic inbound cap (T7) plus the sidecar's own
 * in-flight coalescing, so a renderer that spams this cannot multiply the work.
 */
export const CONTEXT_BREAKDOWN_VERB_TYPES = [
  'context-breakdown.request',
] as const

export type ContextBreakdownVerbType =
  (typeof CONTEXT_BREAKDOWN_VERB_TYPES)[number]

export type ContextBreakdownRequestMessage = {
  type: 'context-breakdown.request'
  requestId: string
}

export type ContextBreakdownVerbMessage = ContextBreakdownRequestMessage

/**
 * IDLE-PARK inbound frame (decisions/IDLE-PARK.md §2/§3). App-owned vocabulary
 * (NOT part of the engine's shared `appClientMessageSchema`); the sidecar
 * validates it with its own local schema and OWNS the park gate + latch. It is
 * originated ONLY by main's policy driver via `supervisor.send` — no preload
 * channel or `ipcMain` handler forwards it, so the renderer is structurally
 * unable to author it (the frame is on the sidecar's closed allowlist purely as
 * defence-in-depth). It carries NO renderer-authored state — just a `requestId`;
 * there is no ack/result frame, the sidecar's `PARKED_EXIT_CODE` self-exit is the
 * authoritative signal (host classifies the exit, §2). Additive under v1 — no
 * `PROTOCOL_VERSION` bump.
 */
export type AppParkMessage = {
  type: 'app.park'
  requestId: string
}

/**
 * Everything a client may send toward a sidecar: the engine's allowlisted
 * vocabulary plus the app-owned C2 frame, the P4-5 account verbs, the P4-13
 * RemoteSettings verbs, the P4-19 settings write verb, and the IDLE-PARK frame.
 */
export type SidecarClientMessage =
  | AppClientMessage
  | PermissionSetModeMessage
  | AskUserQuestionAnswerMessage
  | AccountVerbMessage
  | WorkspaceTrustMessage
  | RemoteVerbMessage
  | SettingsVerbMessage
  | AgentModeSetMessage
  | TaskControlVerbMessage
  | RunControlVerbMessage
  | SessionActionVerbMessage
  | ContextBreakdownVerbMessage
  | AppParkMessage

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
 *
 * **User-turn provenance (`SDKUserMessage.origin`).** Five of the engine's six
 * `MessageOrigin` kinds (`src/types/message.ts:10`) are engine-INJECTED turns
 * that nonetheless carry `role: 'user'` — `task-notification`, `coordinator`,
 * `channel`, `teammate`, `deferred-continuation`. Until this field existed the
 * discriminant never left the engine process, so the renderer could only sniff
 * message TEXT for one of them and rendered the other four as the operator's own
 * pink right-aligned bubble. `origin` now rides the raw `SDKUserMessage` on this
 * frame (engine side: `mappers.ts` `toSDKMessageOrigin`), and
 * `transcriptProjector.ts` reads it instead of re-implementing the engine's
 * provenance rules renderer-side (the hand-copied `isTaskNotificationText`
 * mirror it replaced was exactly that duplication).
 *
 * The decision that makes it safe (recorded here inline, the way the C2 account
 * verbs' reasoning is recorded above):
 *
 *  - **Additive under v1 — NO `PROTOCOL_VERSION` bump.** No frame changed shape:
 *    an optional field appeared on a message the frame already carried whole.
 *    A renderer that ignores `origin` behaves exactly as before, and an engine
 *    that predates it (a resumed transcript, an older sidecar) simply omits it —
 *    which is why absent must keep meaning "the operator typed this".
 *  - **Outbound-only.** No inbound frame kind, no preload channel, no new
 *    renderer vocabulary. The renderer cannot author or influence `origin`; the
 *    engine is its sole writer, so it is not an attack surface — it REMOVES the
 *    renderer's need to infer provenance from attacker-influenceable text.
 *  - **Secret-owner invariant untouched (SECURITY-MINIMUM §4).** The projection
 *    is NARROWED at the engine, not forwarded whole: `task-notification` keeps
 *    `status`/`summary`/`toolUseId`/`result`/`usage` and DROPS `taskId` +
 *    `outputFile` (internal bookkeeping with no display meaning — a UI that
 *    reprinted the raw banner put both on screen, the 2026-08-01 leak); every
 *    field kept is one the transcript actually renders, and `result`/`usage`
 *    already crossed inside the banner text this frame carries, so the widening
 *    adds no byte the renderer could not already read. `teammate` keeps only the sender
 *    handle (never the `TeammateMessageContract[]` payload), and `channel` DROPS
 *    `meta: Record<string, string>` — whose KEYS are authored by a third-party
 *    MCP channel server, so a key named `authorization`/`apiKey` would trip
 *    `secretGuard`'s key-name scan and cost the whole frame. That is the same
 *    keys-as-values trap `SettingsSnapshot.resolved` is shaped as an array to
 *    avoid. Every surviving field is a short enum or handle; `secretGuard` and
 *    `MAX_OUTBOUND_FRAME_BYTES` still apply to the frame unchanged.
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
  /**
   * Read-only display metadata derived by the sidecar with the engine's own
   * permission-rule parser (P4-34). Keeping the classification beside the
   * authoritative strings avoids teaching the renderer the rule grammar.
   */
  ruleMetadata: Array<{
    behavior: 'allow' | 'deny' | 'ask'
    source: string
    rule: string
    matchType: 'exact' | 'prefix' | 'wildcard'
  }>
  /** Engine policy truth; this is not P4-19's per-setting `managed` flag. */
  managedRulesOnly: boolean
  /** Whether the engine's permission classifier is currently available. */
  permissionClassifierEnabled: boolean
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

/* ------------------------------------------------------------------------- *
 * Settings read-seam (P4-3) — the read-only settings source/precedence model
 * ------------------------------------------------------------------------- */

/**
 * The five settings layers, ASCENDING precedence (later wins) —
 * `src/utils/settings/constants.ts:7-22` `SETTING_SOURCES`. Redeclared here as a
 * local string-literal union (the P0-3 isolation idiom — never a direct engine
 * import) so main/preload/renderer typecheck without the engine's Bun graph.
 * Structurally identical to the engine's `SettingSource`, so the sidecar assigns
 * across without a cast.
 */
export type SettingSourceId =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'flagSettings'
  | 'policySettings'

/**
 * Where the active policy (managed) layer resolves from —
 * `getPolicySettingsOrigin()` (settings.ts:376). null when nothing is managed.
 */
export type PolicySettingsOrigin =
  | 'remote'
  | 'plist'
  | 'hklm'
  | 'file'
  | 'hkcu'

/**
 * P4-3 — the read-only settings snapshot (C3 precedent: read-only outbound,
 * secretGuard-clean BY CONSTRUCTION). It carries the SOURCE / editable /
 * managed MODEL only — never a setting VALUE — so no credential-bearing value
 * (`env`, `apiKeyHelper`, …) ever serializes; the snapshot cannot leak a secret
 * and the outbound secret guard trivially passes. Panels (P4-12) render values
 * through their own controls; this seam only tells each field WHERE its value is
 * resolved from and whether it is editable or managed.
 *
 * Built at the sidecar ONCE at spawn, from the engine's non-resetting per-source
 * reader (`getSettingsForSource` over the enabled `SETTING_SOURCES`) — NOT
 * `getSettingsWithSources()`, which resets the engine's global settings cache.
 * Resolution is rooted at the sidecar's own cwd (P3-1), so the project/local
 * layers are the SESSION's, matching what the engine's `canUseTool` enforces.
 */
export type SettingsSnapshot = {
  /**
   * The enabled, non-empty layers in ASCENDING precedence (index 0 lowest).
   * `keys` are the top-level setting NAMES present at that layer — names only,
   * never values. `origin` is the layer's settings-file path (or a policy
   * descriptor), for the source-badge tooltip.
   */
  layers: Array<{ source: SettingSourceId; origin: string; keys: string[] }>
  /**
   * Per effective top-level key, the WINNING (highest-precedence) layer that set
   * it, plus its editable/managed status. An ARRAY, not a keyed record, so
   * setting names ride as string VALUES — never as object keys the outbound
   * secret guard would inspect (a key literally named `apiKey` could otherwise
   * block the frame). `managed` ⇒ the policy layer (locked); `editable === false`
   * also covers `flagSettings` (a session CLI override settings cannot rewrite,
   * though it is not "managed").
   */
  resolved: Array<{
    key: string
    source: SettingSourceId
    editable: boolean
    managed: boolean
  }>
  /** The active policy layer's origin, or null when nothing is managed. */
  policyOrigin: PolicySettingsOrigin | null
  /**
   * P4-19 — the current effective VALUE of each key in the closed
   * `EDITABLE_SETTINGS` allowlist that is set at some layer, so the value
   * editors can reflect real state (a key ABSENT here is unset everywhere → its
   * built-in default in `EDITABLE_SETTINGS` applies). Deliberately NOT the whole
   * settings object: every key here is a non-secret scalar (booleans / small
   * enums / one bounded int), so no credential rides this frame — `secretGuard`
   * still scans it as defense-in-depth. An ARRAY (the setting name rides as the
   * `key` string VALUE, never as an object key the secret guard would inspect),
   * carrying the winning (highest-precedence) layer's value.
   */
  editableValues: Array<{
    key: string
    value: EditableSettingValue
    source: SettingSourceId
  }>
  /**
   * P4-19 — the live option set for each `dynamic-enum` editable key (e.g.
   * `outputStyle`), captured ONCE at spawn from the engine's real registry
   * (`getAllOutputStyles`). The renderer's select renders these; the sidecar
   * membership-checks a write against them (the closed gate for a genuinely
   * dynamic option set). Bounded + non-secret by construction: only option
   * NAMES + short human descriptions ride here (no `env`, token, or credential
   * value), so `secretGuard` still scans it purely as defense-in-depth. Optional
   * + tolerant-read (`availableOptions ?? []`): a snapshot that predates the
   * field, or a spawn where the registry read failed, simply carries no options
   * and the affected select renders disabled rather than throwing.
   */
  availableOptions?: Array<{
    key: string
    options: Array<{ value: string; label: string; description?: string }>
  }>
  /**
   * CC-13 — the persisted `permissions.defaultMode` setting: the value plus the
   * layer it resolved from. ABSENT when the key is unset at every enabled layer,
   * in which case the engine chooses the session's opening mode itself
   * (`src/utils/permissions/permissionSetup.ts:758-796`) — so absent means "not
   * configured", never "unknown".
   *
   * It needs its own field because neither existing carrier can hold it:
   *  - `resolved` carries TOP-LEVEL key names only, so a nested key is invisible
   *    there (`permissions` appears; `permissions.defaultMode` never can);
   *  - `editableValues` is the P4-19 WRITE allowlist — `EDITABLE_SETTING_KEYS`
   *    is what gates the sidecar's write path — and a permission mode must stay
   *    READ-ONLY at this boundary. `permission.setMode` is session-scoped by
   *    construction and deliberately has no destination for `defaultMode`
   *    (decisions/PERMISSION-BOUNDARY.md §3, `sidecar/permissionDomain.ts:44-48`).
   *
   * Read-only outbound and non-secret by construction (a short mode enum + a
   * layer id), so `secretGuard` passes trivially. Optional + tolerant-read,
   * following the `availableOptions` precedent: a snapshot predating the field
   * simply carries none and the pane renders the unset state.
   */
  permissionDefaultMode?: { value: string; source: SettingSourceId }
}

// Compile-time guard: an editable source must be a real settings layer.
type _EditableSourceIsSettingSource = EditableSettingSource extends SettingSourceId
  ? true
  : never
const _editableSourceCheck: _EditableSourceIsSettingSource = true
void _editableSourceCheck

/**
 * P4-3 outbound frame. Emitted on attach (after `ready` + the C3
 * `permission.context`, before history replay), and RE-EMITTED after a P4-19
 * `settings.setValue` write lands (so the value editors and provenance badges
 * reflect the change without a restart). Writes never cross this READ frame —
 * they go through the app-owned `settings.setValue` verb, applied via the
 * engine's `SettingsUpdater`-under-lock form (P3-5a, `settings.ts:480`). The
 * re-read reflects the persisted file (source/precedence/editableValues);
 * whether a given key takes effect in the running engine mid-session without a
 * restart remains per-key engine behavior (the session settings cache,
 * `settings.ts:944`).
 */
export type SettingsSnapshotFrame = {
  kind: 'settings.snapshot'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  settings: SettingsSnapshot
}

/* ------------------------------------------------------------------------- *
 * Agent config read-seam (P4-7) — read-only definition snapshot
 * ------------------------------------------------------------------------- */

/**
 * Agent definition sources. This is a wider taxonomy than settings sources:
 * built-ins and plugin agents participate alongside settings-backed user/project/
 * local/flag/policy definitions (`AgentDefinition.source` in
 * `src/tools/AgentTool/loadAgentsDir.ts`).
 */
export type AgentConfigSourceId =
  | 'built-in'
  | 'plugin'
  | SettingSourceId

export type AgentConfigTools =
  | { mode: 'all' }
  | { mode: 'none' }
  | { mode: 'list'; names: string[] }

export type AgentConfigDefinition = {
  id: string
  agentType: string
  source: AgentConfigSourceId
  baseDir?: string
  filename?: string
  filePath?: string
  plugin?: string
  whenToUse: string
  tools: AgentConfigTools
  disallowedTools?: string[]
  skills?: string[]
  model?: string
  /** Provider is resolved by runtime model routing; it is not an agent definition field. */
  provider: 'runtime'
  effort?: string | number
  permissionMode?: string
  maxTurns?: number
  color?: string
  background: boolean
  memory?: string
  isolation?: string
  hasInitialPrompt: boolean
  hasHooks: boolean
  hasMcpServers: boolean
  mcpServerRefs: string[]
  inlineMcpServerNames: string[]
  requiredMcpServers: string[]
  missingMcpServers: string[]
  active: boolean
  overriddenBy?: AgentConfigSourceId
  available: boolean
  editable: boolean
  readOnlyReason?: string
  systemPrompt: {
    available: boolean
    withheldReason: 'secret-boundary'
  }
}

export type AgentConfigSnapshot = {
  definitions: AgentConfigDefinition[]
  failedFiles: Array<{ path: string; error: string }>
  availableMcpServers: string[]
}

/**
 * P4-7 outbound frame. Emitted on attach, read-only. The snapshot intentionally
 * excludes system-prompt bodies, hooks payloads, and inline MCP config objects:
 * those are real definition fields but may carry secrets or credential-adjacent
 * material, so the renderer receives presence/count/name metadata only.
 */
export type AgentConfigSnapshotFrame = {
  kind: 'agent-config.snapshot'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  agents: AgentConfigSnapshot
}

/* ------------------------------------------------------------------------- *
 * Goals + memory read-seams (P4-10) — read-only snapshots
 * ------------------------------------------------------------------------- */

export type ThreadGoalStatus =
  | 'active'
  | 'paused'
  | 'budget_limited'
  | 'complete'

export type ThreadGoalSnapshot = {
  threadId: string
  goalId: string
  objective: string
  status: ThreadGoalStatus
  tokenBudget?: number
  tokensUsed: number
  timeUsedSeconds: number
  createdAtMs: number
  updatedAtMs: number
  summary: string
}

export type ThreadGoalSnapshotFrame = {
  kind: 'thread-goal.snapshot'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  goal: ThreadGoalSnapshot | null
}

export type MemoryInstructionType =
  | 'Managed'
  | 'User'
  | 'Project'
  | 'Local'
  | 'AutoMem'
  | 'TeamMem'

export type AutoMemoryType = 'user' | 'feedback' | 'project' | 'reference'

export type MemoryInstructionFile = {
  path: string
  type: MemoryInstructionType
  parent?: string
  globs?: string[]
  contentDiffersFromDisk: boolean
}

export type AutoMemoryHeader = {
  filename: string
  filePath: string
  mtimeMs: number
  description: string | null
  type?: AutoMemoryType
}

/**
 * P4-34 — read-only metadata for one real agent definition that carries a
 * persistent memory directory. Additive to the existing `memory.snapshot`
 * read seam (the C3 precedent, `decisions/PERMISSION-BOUNDARY.md`).
 *
 * Per-agent memory is an engine feature, not a prototype invention:
 * `src/tools/AgentTool/agentMemory.ts:13` defines the scope and `:52`
 * `getAgentMemoryDir` resolves the directory; agent definitions declare it at
 * `src/tools/AgentTool/loadAgentsDir.ts` (`memory: z.enum([...]).optional()`).
 *
 * Directory path and file COUNT only — memory bodies never cross the boundary,
 * exactly as the auto-memory rows above withhold theirs.
 *
 * `fileCount: null` means the directory could not be read (a permission error on
 * a project- or local-scope dir under the session cwd, say). The row still ships
 * with its scope and path: an unreadable directory is a fact about ONE agent, and
 * must not cost the reader the rest of the page.
 */
export type AgentMemorySnapshot = {
  agentType: string
  scope: 'user' | 'project' | 'local'
  directory: string
  fileCount: number | null
}

export type MemorySnapshot = {
  autoMemoryEnabled: boolean
  autoMemoryDir: string
  autoMemoryEntrypoint: string
  instructionFiles: MemoryInstructionFile[]
  autoMemories: AutoMemoryHeader[]
  agentMemories: AgentMemorySnapshot[]
  notes: string[]
}

export type MemorySnapshotFrame = {
  kind: 'memory.snapshot'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  memory: MemorySnapshot
}

/* ------------------------------------------------------------------------- *
 * Context breakdown read-seam — per-category context occupancy
 * ------------------------------------------------------------------------- *
 *
 * What the terminal's `/context` visualizes, for the composer donut's popover
 * (the prototype's `ContextChip` stacked bar + legend, `Surfaces.jsx:517-537`).
 * Built by the engine's OWN `analyzeContextUsage`
 * (`src/utils/analyzeContext.ts:923`) over this session's real messages, tools,
 * agent definitions and permission context — never re-derived in the sidecar.
 *
 * OUTBOUND ONLY, and deliberately so. The obvious shape for "open the popover,
 * ask for a breakdown" is a request verb, but that would widen the inbound
 * vocabulary (SECURITY-MINIMUM §2 R2) to buy nothing: the analysis takes no
 * renderer input, so a push carries exactly the same information with no new
 * frame to validate. It rides the turn boundary, which is also the only moment
 * the numbers can change.
 *
 * Category `label` and `tokens` are the engine's own (`analyzeContext.ts:1039`
 * onward) and are passed through verbatim — the sidecar never renames a category
 * to match the prototype's cosmetic labels, because the engine's names are what
 * `/context` prints for the same session.
 */
export type ContextBreakdownCategory = {
  /** The engine's category name, verbatim (`ContextCategory.name`). */
  label: string
  tokens: number
  /**
   * The engine's theme colour key (`ContextCategory.color`, a `keyof Theme`).
   * Carried as an opaque string: the renderer owns the key → static Tailwind
   * class map, since terminal theme keys have no meaning in the DOM.
   */
  colorKey: string
  /**
   * Deferred categories (tool-search) are shown for visibility but do NOT count
   * toward usage (`analyzeContext.ts:1075-1092`), so they must be excluded from
   * any total the reader compares against the window.
   */
  deferred: boolean
}

export type ContextBreakdownSnapshot = {
  /**
   * OCCUPANCY only. The engine also appends `Free space` and, under auto-compact,
   * `Autocompact buffer` (`src/utils/analyzeContext.ts:1166,1183`); both describe
   * UNUSED window, and the sidecar strips them exactly as the engine's own
   * `/context` renderer does. A consumer may therefore treat every category here
   * as space the session is actually spending.
   */
  categories: ContextBreakdownCategory[]
  /**
   * `ContextData.totalTokens`. NOTE the basis: this is the API's fresh-input
   * count when one is available, and only falls back to the sum of the categories
   * otherwise (`analyzeContext.ts:1199-1204`). It is therefore NOT guaranteed to
   * equal `Σ categories[].tokens`, and `contextWindow - usedTokens` is NOT the
   * free space — read `freeTokens` for that.
   */
  usedTokens: number
  /**
   * The engine's own `Free space` category (`analyzeContext.ts:1181`), which
   * nets off both occupancy and the reserved compact buffer. Null when the
   * analysis produced no such category.
   */
  freeTokens: number | null
  /** `ContextData.maxTokens` — the engine-resolved window for `model`. */
  contextWindow: number
  /** The model the analysis ran against, so a stale snapshot is detectable. */
  model: string
}

export type ContextBreakdownSnapshotFrame = {
  kind: 'context-breakdown.snapshot'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  breakdown: ContextBreakdownSnapshot
}

/* ------------------------------------------------------------------------- *
 * Tasks read-seam (P4-9) — read-only background-task snapshot
 * ------------------------------------------------------------------------- *
 *
 * Mirrors `getAllTasks()` (`src/tasks.ts:22`) / `AppState.tasks`
 * (`src/state/AppStateStore.ts:164`) — the SAME live task records
 * `BackgroundTasksDialog.tsx` renders (`/tasks` command,
 * `src/commands/tasks/tasks.tsx`). Read-only: kill/stop/inspect verbs are
 * deferred (no new inbound vocabulary here) — see `tasksDomain.ts` header.
 */

export type TaskType =
  | 'local_bash'
  | 'local_agent'
  | 'remote_agent'
  | 'in_process_teammate'
  | 'local_workflow'
  | 'monitor_mcp'
  | 'dream'

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed'

export type TaskSnapshotItem = {
  id: string
  type: TaskType
  status: TaskStatus
  /** Per-type display text — command/description/title (`toListItem`, `BackgroundTasksDialog.tsx:496-555`). */
  label: string
  startTime: number
  endTime?: number
  totalPausedMs?: number
  /** local_bash only — 'monitor' renders description + a distinct pill (`guards.ts` `BashTaskKind`). */
  kind?: 'bash' | 'monitor'
  /** local_bash/local_agent — backgrounded vs foreground-running. */
  isBackgrounded?: boolean
  /** local_agent — handoff gate; 'blocked' is the real "needs input" state (not a fixture field). */
  handoffStatus?: 'done' | 'blocked'
  /** local_agent — last resume timestamp after a terminal-state resume. */
  resumedAt?: number
  /** in_process_teammate — plan-mode approval gate. */
  awaitingPlanApproval?: boolean
  /** in_process_teammate — user-requested shutdown in flight. */
  shutdownRequested?: boolean
  /** in_process_teammate — idle between turns while UI-retained. */
  isIdle?: boolean
  /** remote_agent — ultraplan flow flag + phase (`UltraplanPhase`, excludes 'running'). */
  isUltraplan?: boolean
  ultraplanPhase?: 'needs_input' | 'plan_ready'
  /** local_agent (agentName) / in_process_teammate (identity.agentName) — display handle. */
  agentName?: string
  /** local_agent only — subagent type for the P4-2 AgentIdentity type badge. */
  agentType?: string
}

/**
 * P4-31 — source-backed identity for a subagent transcript branch.
 *
 * Read-only display metadata projected from the SAME `local_agent` task state
 * the engine owns (`src/tasks/LocalAgentTask/LocalAgentTask.tsx:149-187`); no
 * renderer-authored identity and no filesystem path crosses the boundary.
 *
 * `toolUseId` is the join key, and BOTH sides of it are engine-minted, so the
 * join needs no new seam:
 *
 *  - On the message side, the spawning tool-use id is carried as
 *    `parentToolUseID` (`src/services/tools/toolExecution.ts:556`) and emitted
 *    onto every nested SDK message as `parent_tool_use_id`
 *    (`src/utils/queryHelpers.ts:135` assistant, `:145` user, `:194`
 *    tool_progress).
 *  - On the task side, it is the `toolUseId` passed to `createTaskStateBase`
 *    (`src/Task.ts:108-119`).
 *
 * `spawnedAt` is that same task record's `startTime` (`src/Task.ts:119`).
 */
export type TaskSubagentMetadata = {
  toolUseId: string
  agentId: string
  agentName: string | null
  agentType: string
  isSidechain: true
  spawnedAt: number
}

export type TasksSnapshot = {
  items: TaskSnapshotItem[]
  /** Includes foregrounded workers too; `items` remains display-filtered. */
  subagents?: TaskSubagentMetadata[]
  /** Task id currently foregrounded (viewed in the main pane); already excluded from `items`. */
  foregroundedTaskId?: string
}

export type TasksSnapshotFrame = {
  kind: 'tasks.snapshot'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  tasks: TasksSnapshot
}

/* ------------------------------------------------------------------------- *
 * Agent-mode / Orchestrator read-seam (P4-8, D2 `decisions/AGENT-CHROME.md`)
 * ------------------------------------------------------------------------- *
 *
 * The orchestrator surfaces the real worker roster/state. Per D2 §4 there are two
 * real engine feeds, joined at the sidecar trust boundary and served as ONE
 * redacted display snapshot (never a mock worker object — D2 C5):
 *   1. Session plane (D2 §4.2) — the engine's PERSISTED agent-mode state
 *      (`<transcript>.agent-mode-state.json`, `src/agent-mode/sessionState.ts:68`),
 *      read through the engine's OWN `readSessionStateWithContinuity` entry point
 *      (`sessionState.ts:691`) — objective, run phase, and continuity workers
 *      (prior-session `resumable`/`stale`) + synthesis lifecycle.
 *   2. Live plane — the `local_agent` workers the current session delegated via the
 *      Agent tool (`AppState.tasks`, the SAME store P4-9's tasks domain reads),
 *      carrying the real handoff gate: `handoffStatus:'blocked'` is the "waiting on
 *      orchestrator" state (`src/tasks/LocalAgentTask/LocalAgentTask.tsx:184`), not
 *      a fixture field — plus its `blockReason` and verification `verdict`.
 * Outbound-only, read-only, no new inbound vocabulary. secretGuard-clean by
 * construction: identity/role/status/description text only, never a token.
 */

/** Run phase mirrored from the engine's `AgentModeRunPhase` (`sessionState.ts:7`). */
export type AgentModeRunPhase =
  | 'planning'
  | 'awaiting_approval'
  | 'executing'
  | 'verifying'
  | 'completed'
  | 'blocked'
  | 'cancelled'

export type AgentModeWorkerItem = {
  /** Stable worker id — persisted `AgentModeWorkerSession.agentId`, else the live task id. */
  agentId: string
  /** Display handle (persisted `handle` / live task `agentName`); null when unnamed. */
  handle: string | null
  /** Role / subagent type (persisted `role` / live task `agentType`); null when unknown. */
  role: string | null
  /** Lifecycle status. Live task `pending` folds to `running` (in-flight). */
  status: 'running' | 'completed' | 'failed' | 'killed'
  /** Delegated task/prompt text (persisted `description` / live task `label`); null when absent. */
  description: string | null
  /** Persisted synthesis gate (result-ready / reviewed) — agent-mode session plane only. */
  synthesisStatus?: 'pending' | 'synthesized'
  /** `current` = this session; `prior` = a continuity worker from a prior session. */
  origin?: 'current' | 'prior'
  /** Persisted resumability (meaningful for `prior`-origin workers). */
  resumable?: boolean
  /**
   * Live `local_agent` handoff gate. `blocked` is the real "waiting on orchestrator"
   * state (orchestrator-owned, neutral) — the source of the `waiting` display state.
   */
  handoffStatus?: 'done' | 'blocked'
  /** Live `local_agent` block reason (only present when `handoffStatus === 'blocked'`). */
  blockReason?: string
  /** Live `local_agent` verification verdict, when the worker is a verifier. */
  verdict?: 'PASS' | 'FAIL' | 'PARTIAL'
  /** Live `local_agent` backgrounded flag. */
  isBackgrounded?: boolean
  /** Persisted agent output summary (agent-mode session plane), when present. */
  outputSummary?: string
}

export type AgentModeSnapshot = {
  /** Process-level agent-mode flag (`isAgentMode()`); false = a normal delegating session. */
  active: boolean
  /** Objective from the persisted agent-mode ledger; '' when none. */
  objective: string
  /** Derived run phase from the persisted state; 'planning' when none. */
  phase: AgentModeRunPhase
  /** Unified worker list: live `local_agent` workers ∪ persisted continuity workers. */
  workers: AgentModeWorkerItem[]
}

export type AgentModeSnapshotFrame = {
  kind: 'agent-mode.snapshot'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  agentMode: AgentModeSnapshot
}

/* ------------------------------------------------------------------------- *
 * Codex lease read-seam (P4-32b, L1 — `decisions/ORCHESTRATOR-IN-SESSION.md` §7
 * + §10 ruling 2026-07-30)
 * ------------------------------------------------------------------------- *
 *
 * "Which Codex account is each agent in this swarm leasing right now?" is real
 * engine state, owned by the lease manager
 * (`src/services/api/codexAccountLeaseManager.ts`). It is SESSION-scoped, which
 * is why it belongs beside the worker roster and not on the global Accounts page
 * (§7 L2 rejected).
 *
 * OUTBOUND ONLY. There is no lease write verb, no new inbound frame kind and no
 * new preload channel: assignment, failover and release stay engine-side
 * (`registerCodexLease`/`failoverCodexLease`/`releaseCodexLease`), and the
 * renderer only ever reads this projection.
 *
 * Redaction: the projection carries account IDENTIFIERS and the pool's redacted
 * alias, never credential material — the same policy `AccountStatus.id` /
 * `AccountStatus.alias` already established (`accountId` is an OpenAI account
 * UUID that `secretGuard` does not block; `accessToken`/`refreshToken`/
 * `vaultFilePath` never appear in this shape by construction). Engine-authored
 * reason text is length-capped at the sidecar.
 *
 * JOIN KEY (verified in source, not inferred): `LeaseOwnerRow.ownerId` is the
 * subagent's `agentId` for worker leases (`src/tools/AgentTool/AgentTool.tsx:1226`
 * async, `:1354` sync) and the literal `'main-thread'` for the main lease
 * (`src/query.ts:325`). A `local_agent` task's id IS that same agentId
 * (`createTaskStateBase(agentId, 'local_agent', …)`,
 * `src/tasks/LocalAgentTask/LocalAgentTask.tsx:618`), and the roster carries it as
 * `AgentModeWorkerItem.agentId` (`app/sidecar/agentModeDomain.ts:212`). So
 * `ownerId === AgentModeWorkerItem.agentId` needs no new field on either side.
 *
 * CUT (§10): the prototype's failover/rotation EVENT strip. The engine exposes
 * current lease/failover state (`failoverCount` + `lastFailureReason`), not an
 * event history, and no mock stands in for one.
 */

/** Lease lifecycle, mirrored from the engine's `CodexLeaseState` (`codexAccountLeaseManager.ts:22`). */
export type LeaseState = 'active' | 'released' | 'failed'

/** Subagent account strategy, mirrored from `CodexLeaseStrategy` (`codexAccountLeaseManager.ts:20`). */
export type LeaseStrategy = 'spread' | 'follow-main'

/** One owner→account lease row, projected from the engine's `CodexLease` (`codexAccountLeaseManager.ts:24-37`). */
export type LeaseOwnerRow = {
  leaseId: string
  /** `'main-thread'` for the main lease, else the subagent `agentId` (joins `AgentModeWorkerItem.agentId`). */
  ownerId: string
  ownerType: 'main' | 'subagent'
  /** Engine-authored label: `'Main thread'` or the delegated task description. */
  ownerLabel: string
  /** Account UUID — an identifier, NOT a secret (same policy as `AccountStatus.id`). */
  accountId: string
  /** The pool's redacted alias for that account, or null. Never an email, never a token. */
  accountAlias: string | null
  strategy: LeaseStrategy
  state: LeaseState
  /** Epoch ms; held-duration is derived at READ time in the renderer, never stored. */
  createdAt: number
  updatedAt: number
  failoverCount: number
  /** Engine `selectionReason`, length-capped at the sidecar. */
  selectionReason: string
  /** Engine `lastFailureReason` when a failover happened, length-capped at the sidecar. */
  lastFailureReason?: string
}

/**
 * Per-account rollup — the non-exclusivity proof (many agents may share one
 * account). Projected from `getCodexLeaseSnapshot().accounts`
 * (`codexAccountLeaseManager.ts:175-184`), which the ENGINE derives over its own
 * live lease map; the renderer never re-derives it.
 */
export type LeaseAccountRow = {
  accountId: string
  accountAlias: string | null
  leaseCount: number
  /** `ownerLabel`s holding a lease on this account. */
  holders: string[]
}

export type LeaseSnapshot = {
  /** This session's subagent strategy (`getCodexLeaseSnapshot().strategy`). */
  strategy: LeaseStrategy
  /** Main lease first, then the live worker leases. Empty when nothing holds one. */
  owners: LeaseOwnerRow[]
  /** Accounts currently carrying at least one lease. */
  accounts: LeaseAccountRow[]
}

/**
 * P4-32b outbound frame. Emitted on attach beside the other read-seam snapshots
 * and re-broadcast on the same app-state store change that re-broadcasts
 * `agent-mode.snapshot` (a worker spawn/finish is exactly when leases move).
 * Read-only: there is no lease verb.
 */
export type LeaseSnapshotFrame = {
  kind: 'lease.snapshot'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  leases: LeaseSnapshot
}

/* ------------------------------------------------------------------------- *
 * P4-8b — agent-mode WRITE verb (the in-session Orchestrator toggle's set)
 * ------------------------------------------------------------------------- *
 *
 * The WelcomeScreen's Orchestrator control was a read-only reflect of
 * `AgentModeSnapshot.active`; this verb makes the in-session (`variant:'session'`)
 * toggle ACTUALLY switch the addressed session's agent mode. Like the P4-5
 * account verbs, the P4-15 workspace-trust accept, and the P4-19 settings write,
 * it is app-owned inbound vocabulary the engine's shared `appClientMessageSchema`
 * does NOT carry — it is validated by a sidecar-LOCAL Zod schema at the trust
 * boundary and dispatched to the engine's OWN runtime mode switch
 * `matchSessionMode` (`src/agent-mode/agentMode.ts:102`), the SAME function the
 * `/agent` command uses. It sets/clears `CLAUDE_CODE_AGENT_MODE` in THIS session's
 * sidecar process only (N-process, LOCKED) and logs `tengu_agent_mode_switched`;
 * `isAgentMode()` is a live env read (`agentMode.ts:37`), so the NEXT turn's system
 * prompt (`src/utils/queryContext.ts:66`) runs in the new mode. NO engine respawn,
 * NO session-lifecycle change (`decisions/AGENT-MODE-TOGGLE.md`).
 *
 *  - The renderer authors ONLY the boolean intent; the sidecar calls the engine
 *    function and re-reads `isAgentMode()`. No path, no token crosses either way.
 *  - T5a-analog — the verb carries a `requestId` echoed on `agent-mode.set.result`.
 *  - T7 — the existing inbound size/rate caps apply unchanged.
 */
export const AGENT_MODE_VERB_TYPES = ['agent-mode.set'] as const

export type AgentModeVerbType = (typeof AGENT_MODE_VERB_TYPES)[number]

/** Set the addressed session's agent mode on/off (live env switch; no respawn). */
export type AgentModeSetMessage = {
  type: 'agent-mode.set'
  requestId: string
  active: boolean
}

/**
 * P4-8b outbound result echoing the verb's `requestId`, followed by an updated
 * `agent-mode.snapshot` (with the new `active`) when the switch changed the mode.
 */
export type AgentModeSetResultFrame = {
  kind: 'agent-mode.set.result'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  requestId: string
  ok: boolean
  /** Redacted, human-readable outcome; NEVER carries token material. */
  message: string
}

/* ------------------------------------------------------------------------- *
 * P4-8b — task/worker STOP verb (the deferred worker-control action)
 * ------------------------------------------------------------------------- *
 *
 * P4-8's orchestrator roster/detail/focus surfaces landed READ-ONLY; the
 * `WorkerDetail` Stop button (`decisions/AGENT-CHROME.md` §2 keep/adapt +
 * PARITY-LEDGER §20 row "`WorkerDetail` Stop button", and the TasksPage
 * `K → stop` deferral in PARITY-LEDGER §21) was DEFERRED as "needs an inbound
 * write verb". This is that verb. Like the P4-5 account verbs, the P4-8b
 * agent-mode set, the P4-15 workspace-trust accept, the P4-19 settings write,
 * and the P4-24c run-controls, it is app-owned inbound vocabulary the engine's
 * shared `appClientMessageSchema` does NOT carry — validated by a sidecar-LOCAL
 * Zod schema at the trust boundary and dispatched to the engine's OWN task-abort
 * machinery `stopTask` (`src/tasks/stopTask.ts:58` — the SAME function
 * `TaskStopTool` and the SDK `stop_task` control use). `stopTask` looks the task
 * up by id in THIS session's `AppState.tasks`, validates it is running, and calls
 * the per-type `Task.kill` (a `local_agent` worker → `killAsyncAgent`,
 * `LocalAgentTask.tsx:368` — aborts the worker + releases its Codex lease). A
 * `local_agent` worker is the primary case; the verb is generic over the task
 * types the `/tasks` surface shows, mirroring the real `stopTask`/`TaskStopTool`.
 *
 *  - The renderer authors ONLY the target `taskId` (the `TaskSnapshotItem.id`
 *    already on the wire, `tasksDomain.ts:71`); the sidecar re-resolves it against
 *    the LIVE store and stops only what exists there (T6-analog). An unknown /
 *    already-terminal task fails closed with `ok:false` — no side effect, no
 *    crash. No path, no engine object, no token crosses either way.
 *  - T5a-analog — the verb carries a `requestId` echoed on `task-control.result`.
 *  - T7 — the existing inbound size/rate caps apply unchanged.
 *  - No new snapshot frame: `stopTask`'s store mutation drives the existing
 *    `tasks.snapshot` / `agent-mode.snapshot` re-broadcasts (the store-subscription
 *    path, the SAME live path any engine-side kill takes — not a synthetic frame).
 */
export const TASK_CONTROL_VERB_TYPES = ['task.stop'] as const

export type TaskControlVerbType = (typeof TASK_CONTROL_VERB_TYPES)[number]

/** Stop/kill a running task in the addressed session (primary case: a worker). */
export type TaskStopMessage = {
  type: 'task.stop'
  requestId: string
  /** The target `AppState.tasks` key (a `TaskSnapshotItem.id` from the wire). */
  taskId: string
}

export type TaskControlVerbMessage = TaskStopMessage

/**
 * P4-8b outbound result echoing the verb's `requestId` (T5a-analog). The updated
 * `tasks.snapshot` / `agent-mode.snapshot` follow from the store subscription, not
 * from here. `ok:false` when the task was gone or already terminal (fail-closed).
 */
export type TaskControlResultFrame = {
  kind: 'task-control.result'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  requestId: string
  verb: TaskControlVerbType
  ok: boolean
  /** Redacted, human-readable outcome; NEVER carries token material. */
  message: string
}

/* ------------------------------------------------------------------------- *
 * P4-24c — composer run-controls WRITE verbs (Model / Reasoning / Fast)
 * ------------------------------------------------------------------------- *
 *
 * The composer's Model / Reasoning-effort / Fast faces (P4-24, read-only) become
 * interactive. Like the P4-5 account verbs, the P4-8b agent-mode set, the P4-15
 * workspace-trust accept, and the P4-19 settings write, these are app-owned
 * inbound vocabulary the engine's shared `appClientMessageSchema` does NOT carry
 * — each is validated by a sidecar-LOCAL Zod schema at the trust boundary and
 * dispatched to the engine's OWN per-session setters (`decisions/
 * COMPOSER-RUN-CONTROLS.md`), a LIVE per-session change with NO respawn:
 *
 *  - `model.set` → the `/model` write's session-scoped effect: `setSessionProvider`
 *    + `setMainLoopModelOverride` (`src/bootstrap/state.ts`) so `getMainLoopModel()`
 *    — the SAME resolver QueryEngine reads per turn (`QueryEngine.ts:283`) — returns
 *    the new model on the NEXT turn, plus the app-state store's `mainLoopModel` for
 *    display. N-process (LOCKED) scopes the global override to THIS session.
 *  - `effort.set` → the `/effort` write (`executeEffort`): persists the level via the
 *    engine's own `setEffortValue`/`toPersistableEffort` and updates `AppState.effortValue`,
 *    which QueryEngine reads per request (`query.ts:744`).
 *  - `fast.set` → the `/fast` toggle (`applyFastMode`): the engine's own fast-mode
 *    switch, gated on `isFastModeSupportedByModel`/`isFastModeAvailable`.
 *
 * Security posture (all preserved): the renderer authors ONLY a value/selection —
 * a model id from the sidecar-minted option list, an effort level string, or a
 * boolean — NEVER an engine object, a path (HC1), or a token. Every field is
 * re-validated at the sidecar (structural Zod + closed `checkStrictKeys`) and the
 * setter runs engine-side. T5a-analog — each verb carries a `requestId` echoed on
 * `run-control.result`. T7 — the existing inbound size/rate caps apply unchanged.
 */
export const RUN_CONTROL_VERB_TYPES = [
  'model.set',
  'effort.set',
  'fast.set',
] as const

export type RunControlVerbType = (typeof RUN_CONTROL_VERB_TYPES)[number]

/** Set this session's main-loop model (a value from `RunControlsSnapshot.model.options`). */
export type RunControlModelSetMessage = {
  type: 'model.set'
  requestId: string
  /** null restores the current provider's default model. */
  model: string | null
}

/** Set this session's reasoning-effort tier (a level string, or `auto`/`unset` to clear). */
export type RunControlEffortSetMessage = {
  type: 'effort.set'
  requestId: string
  effort: string
}

/** Toggle this session's fast mode on/off (engine-gated on model + availability). */
export type RunControlFastSetMessage = {
  type: 'fast.set'
  requestId: string
  active: boolean
}

export type RunControlVerbMessage =
  | RunControlModelSetMessage
  | RunControlEffortSetMessage
  | RunControlFastSetMessage

/**
 * P4-24c outbound result echoing the verb's `requestId`, followed by an updated
 * `run-controls.snapshot` when the change landed (T5a-analog).
 */
export type RunControlResultFrame = {
  kind: 'run-control.result'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  requestId: string
  verb: RunControlVerbType
  ok: boolean
  /** Redacted, human-readable outcome; NEVER carries token material. */
  message: string
}

/**
 * P4-24c — the composer run-controls read model: the live current model/effort/fast
 * PLUS the real selectable options + availability the pickers need, built at the
 * sidecar from the engine's OWN `getModelOptions()`/`getSupportedEffortLevels()`/
 * fast-mode helpers (never a renderer-invented list). Emitted on attach and
 * re-broadcast whenever the relevant app-state fields change (a `*.set` verb, or
 * any engine path that moves the model/effort/fast) — so the faces reflect LIVE in
 * the same session with no respawn. secretGuard-clean by construction (model ids /
 * effort levels / booleans only, never a token).
 */
export type RunControlProvider =
  | 'anthropic'
  | 'openai'
  | 'bedrock'
  | 'vertex'
  | 'foundry'

export type RunControlModelOption = {
  /** The value a `model.set` verb sends; null is provider-local Default. */
  value: string | null
  /** Friendly label from the engine's own `getModelOptions()` (e.g. "GPT-5.6 Sol", "Opus"). */
  label: string
  /** Resolved request route if this option is selected in the current session. */
  provider: RunControlProvider
}

export type RunControlsSnapshot = {
  model: {
    /**
     * The RESOLVED model this session runs (`getMainLoopModel()`); null if
     * resolution failed. This is a model ID, not a display string: the live
     * context gauge looks it up in a `result` frame's `modelUsage` map
     * (`contextUsage.ts`), so it must stay spelled the way the engine spells
     * it. {@link currentLabel} is what the composer face shows.
     */
    current: string | null
    /**
     * The display NAME for `current`, from the engine's OWN
     * `getMarketingNameForModel` (`src/utils/model/model.ts:726`) — the same
     * source the picker's `options[].label` derives from, so the face and the
     * row a user just clicked read alike.
     *
     * Resolved HERE rather than looked up in `options` by the renderer, because
     * a face built from `selected` cannot answer the two cases that matter
     * most: the provider-default row (whose label is "Default (recommended)",
     * not the model that actually runs) and a model set from settings or the
     * environment (which never reaches `selected` at all — that reads only
     * `getMainLoopModelOverride()`). Both would print something other than what
     * the session runs.
     *
     * null when the engine has no marketing name for it (a custom model, a
     * Foundry deployment id); the face then falls back to `current`.
     */
    currentLabel: string | null
    /**
     * The context window `current` runs with, resolved at the sidecar by the
     * engine's own `getContextWindowForModel` (`src/utils/context.ts:68`) —
     * the very function whose output the live gauge otherwise reads off a
     * `result` frame's `modelUsage[…].contextWindow` (`src/cost-tracker.ts:107`).
     *
     * It is the gauge's denominator in the two states no `result` frame can
     * cover: BEFORE the first turn, and right after a model switch, when the
     * newest `result` frame only knows the model that already ran. Without it
     * every model divided by the renderer's 200k default, which is wrong for
     * Claude 5 (1M), GPT-5.6 (372k), and every other gpt model (272k).
     *
     * Re-resolved on each snapshot, so it follows a model change live. null
     * when resolution failed; the renderer keeps its default window then.
     */
    contextWindow: number | null
    /**
     * The user-specified setting (`getMainLoopModelOverride()`) for option
     * highlighting; null = provider default. Already aligned to the matching
     * `options[].value` by the sidecar when the setting and the offered option
     * are two spellings of the same model (canonical id vs family alias), so
     * the renderer can highlight by plain string equality.
     */
    selected: string | null
    /** The authoritative provider route for the current session. */
    provider: RunControlProvider
    /** True once the first turn is accepted; provider-family changes are then unsafe. */
    providerSwitchLocked: boolean
    /** Real selectable models (`getModelOptions()`), including provider-local Default. */
    options: RunControlModelOption[]
  }
  effort: {
    /** The effort tier actually applied after env/session/default precedence, or null when omitted. */
    current: string | null
    /** The raw session selection (`AppState.effortValue`), or null when Auto is selected. */
    selected: string | null
    /** Whether the current model accepts a reasoning-effort knob (`modelSupportsEffort`). */
    supported: boolean
    /** The valid effort levels for the current model (`getSupportedEffortLevels`); empty when unsupported. */
    options: string[]
  }
  fast: {
    /** `AppState.fastMode`. */
    active: boolean
    /** `isFastModeSupportedByModel(currentModel)` — gates whether the ⚡ toggle is offered. */
    supportedByModel: boolean
    /** `isFastModeAvailable()` — the org/provider/runtime gate. */
    available: boolean
    /** `getFastModeUnavailableReason()` display string, or null when available. */
    unavailableReason: string | null
  }
  /**
   * P4-33 — the two token counts the composer's auto-compact warning glyph
   * compares the live context against. Additive display facts about the CURRENT
   * model, resolved at the sidecar by the engine's own
   * `calculateTokenWarningState` inputs (`src/services/compact/autoCompact.ts:246`).
   *
   * They ship from the engine because the renderer CANNOT re-derive either one.
   * The denominator is `getEffectiveContextWindowSize`
   * (`autoCompact.ts:40`), which is NOT the gauge's `contextWindow`: it
   * subtracts reserved summary tokens and honours a `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
   * cap. The auto-compact buffer is model-dependent too
   * (`getAutoCompactBufferTokens`, `autoCompact.ts:204`), not the flat 13k the
   * prototype hard-codes. Mirroring either in the renderer would print a
   * percentage that disagrees with the engine that actually compacts.
   */
  autoCompact: {
    /**
     * `isAutoCompactEnabled()` (`autoCompact.ts:288`) — env kill-switches plus
     * the user's `autoCompactEnabled` setting. Selects which sentence the glyph
     * shows, and (engine-side) which threshold the percentage runs against.
     */
    enabled: boolean
    /**
     * The engine's `threshold` (`autoCompact.ts:257-259`): the auto-compact
     * threshold when auto-compact is on, else the effective context window. The
     * DENOMINATOR of `percentLeft`, so the readout hits 0% at the compact point
     * rather than at the raw window. null when resolution failed.
     */
    threshold: number | null
    /**
     * `threshold - WARNING_THRESHOLD_BUFFER_TOKENS` (`autoCompact.ts:266`) — the
     * point at or above which the engine reports `isAboveWarningThreshold` and
     * the glyph appears. Below it the glyph renders nothing at all. null when
     * resolution failed, which keeps the glyph hidden.
     */
    warningThreshold: number | null
  }
}

/**
 * P4-24c outbound frame. Emitted on attach (after the other snapshots, before
 * history replay) and re-broadcast on any change to the session's model/effort/fast.
 */
export type RunControlsSnapshotFrame = {
  kind: 'run-controls.snapshot'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  runControls: RunControlsSnapshot
}

/* ------------------------------------------------------------------------- *
 * P4-6b — session-action WRITE verbs (Rename / Export / Branch)
 * ------------------------------------------------------------------------- *
 *
 * The Sessions `⋯` menu's three MUTATING verbs become interactive. Like the P4-5
 * account verbs, the P4-8b agent-mode set, the P4-15 workspace-trust accept, the
 * P4-19 settings write, and the P4-24c run-controls, these are app-owned inbound
 * vocabulary the engine's shared `appClientMessageSchema` does NOT carry — each is
 * validated by a sidecar-LOCAL Zod schema at the trust boundary + the closed
 * `checkStrictKeys` allowlist, then dispatched to the engine's OWN machinery for
 * THIS session (the sidecar is one process per session, N-process LOCKED):
 *
 *  - `session.rename` → `saveCustomTitle` (`src/utils/sessionStorage.ts:3009`),
 *    the SAME custom-title write the `/rename` command (`src/commands/rename/`)
 *    and VS Code use; a `custom-title` JSONL entry that readers prefer over an
 *    AI title (user rename always wins). On success the sidecar ALSO reuses the
 *    existing `session-title` outbound frame (→ `host.setTitle` → registry) so the
 *    sidebar/tab relabel live — no new registry seam.
 *  - `session.export` → the engine's OWN renderer `renderMessagesToPlainText`
 *    (`src/utils/exportRenderer.tsx:91`, TEXT-only — the engine has no md/json
 *    render path, so those variants are §0-deferred, not hand-rolled). The
 *    transcript is re-read from disk via `loadConversationForResume`
 *    (`src/utils/conversationRecovery.ts:469`, the SAME loader the sidecar's
 *    resume uses) → `Message[]`, rendered with the session's REAL `tools`
 *    (`getTools`, not `[]` — the P1-3 defect). The rendered text rides BACK on the
 *    result frame (`exportText`) and the renderer shows it in the Export dialog
 *    (P4-30) with Copy and Download actions. **Two sinks as of P4-35** (operator
 *    ruling 2026-07-30, `decisions/FILE-SINK.md`): the clipboard, and a file via
 *    the `saveTextToFile` control-plane channel — main's own `showSaveDialog` plus
 *    the write, behind an HC3 fixed sender, with main sanitizing the renderer's
 *    name SUGGESTION to a basename because HC1 forbids a renderer-authored path.
 *    Nothing about that changes THIS frame: the export result is unchanged, and the
 *    file sink is a main-owned capability that adds no wire vocabulary.
 *  - `session.branch` → the engine's OWN `createFork` (`src/commands/branch/branch.ts:61`,
 *    forks the whole conversation at HEAD — no from-message-N, so the menu label
 *    ADAPTS to "Branch from HEAD…"). It writes a real fork transcript on disk and
 *    the result carries its new engine session id. AUTO-OPENING the fork is
 *    §0-DEFERRED: a fork has no registry row/`appSessionId`, and the sidecar has
 *    no channel to the host control plane (`host.createSession` with
 *    `resumeEngineSessionId` is main-supplied only, HC1) — opening it needs
 *    net-new cross-plane plumbing that would touch the locked frame vocabulary.
 *
 * Security posture (all preserved): the renderer authors ONLY intent — a session
 * id + (rename) a title string. It NEVER authors an engine object, a path (HC1),
 * a permission rule (T6/T6b), or a token. Every field is re-validated at the
 * sidecar (structural Zod + closed `checkStrictKeys`) and the op runs engine-side.
 * T5a-analog — each verb carries a renderer-minted `requestId` echoed on
 * `session-action.result`. T7 — the existing inbound size/rate caps apply
 * unchanged; the outbound `exportText` rides the trusted-engine outbound path
 * (`secretGuard` scans it; `MAX_OUTBOUND_FRAME_BYTES` bounds it — an over-cap
 * transcript fails closed with an honest `ok:false`, never a silent drop).
 */
/*
 * P4-29 adds a FOURTH verb to the same closed set:
 *
 *  - `session.tag` → the engine's OWN `saveTag` (`src/utils/sessionStorage.ts:3257`),
 *    the SAME per-session tag write the `/tag` command uses
 *    (`src/commands/tag/tag.tsx:118` to set, `:141` with an empty string to
 *    remove). It appends a `{type:'tag'}` JSONL entry to THIS session's
 *    transcript, which is exactly where the sessions catalog reads `tag` back
 *    from — so the Sessions-page tag is a real engine write, not a renderer
 *    store. Correcting the record in `sessionActions.ts:33-37`, which called tag
 *    a §0 CUT "with NO local engine backing": archive/delete have none, tag
 *    always did; it was a missing SIDECAR verb (PARITY-LEDGER §16 `:1209`).
 *    The catalog is refreshed on a fixed cadence
 *    (`SESSIONS_CATALOG_REFRESH_INTERVAL_MS`), so the row's own `tag` field
 *    lags the write; the renderer echoes the CONFIRMED result at read time
 *    (`sessionsPageState.ts` `selectRowTag`) rather than mutating a stored row.
 */
export const SESSION_ACTION_VERB_TYPES = [
  'session.rename',
  'session.export',
  'session.branch',
  'session.tag',
] as const

export type SessionActionVerbType = (typeof SESSION_ACTION_VERB_TYPES)[number]

/** Rename this session (write a user `custom-title`; relabel sidebar/tab live). */
export type SessionRenameMessage = {
  type: 'session.rename'
  requestId: string
  title: string
}

/** Export this session's transcript to plain text (rendered engine-side). */
export type SessionExportMessage = {
  type: 'session.export'
  requestId: string
}

/** Fork the whole conversation at HEAD into a new engine session (real on disk). */
export type SessionBranchMessage = {
  type: 'session.branch'
  requestId: string
}

/**
 * P4-29 — set or clear THIS session's tag (`saveTag`). `tag` is the renderer's
 * ONLY authored field: a trimmed tag name, or the empty string to REMOVE, which
 * is the engine's own removal call (`src/commands/tag/tag.tsx:141`).
 */
export type SessionTagMessage = {
  type: 'session.tag'
  requestId: string
  tag: string
}

export type SessionActionVerbMessage =
  | SessionRenameMessage
  | SessionExportMessage
  | SessionBranchMessage
  | SessionTagMessage

/**
 * P4-6b outbound result echoing the verb's `requestId` (T5a-analog). ONE frame
 * for all three verbs, discriminated by `verb` (mirrors `run-control.result`):
 *  - `exportText` present iff `verb === 'export' && ok` — the engine-rendered
 *    plain-text transcript (trusted-engine outbound; secretGuard-scanned).
 *  - `branchEngineSessionId` present iff `verb === 'branch' && ok` — the new
 *    fork's engine session id (for the honest toast / a future open path).
 * `message` is a redacted, human-readable outcome; it NEVER carries a token.
 */
export type SessionActionResultFrame = {
  kind: 'session-action.result'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  requestId: string
  verb: 'rename' | 'export' | 'branch' | 'tag'
  ok: boolean
  message: string
  exportText?: string
  branchEngineSessionId?: string
}

/* ------------------------------------------------------------------------- *
 * Accounts read-seam (P4-5) — the CANONICAL domain read-seam recipe
 * ------------------------------------------------------------------------- *
 *
 * The Accounts domain surfaces the real Codex account pool (`codexAccountPool`).
 * It is the reference implementation every later W4 domain copies:
 *
 *  1. **Read-only OUTBOUND snapshot (C3 precedent).** The renderer receives a
 *     REDACTED status projection only — never a `PoolAccount` record. The pool's
 *     two secrets (`accessToken`, `refreshToken`) and its `vaultFilePath` /
 *     `idToken` NEVER appear on this shape by construction; `secretGuard` also
 *     blocks those key names on the outbound path as defence-in-depth, so the
 *     redaction is proven twice (projection omits them + guard would block them).
 *  2. **Built at the sidecar from the engine's OWN pool** (`getPoolStatus()`),
 *     not a re-read or a renderer reconstruction — the same live pool the engine
 *     request path consumes (`src/services/api/client.ts`). `getSnapshot()` is a
 *     pure, throw-free read (read-at-spawn discipline, like the settings seam).
 *  3. **Emitted on attach after the other snapshots, then re-broadcast** whenever
 *     the sidecar processes an account verb that mutated the pool (action-driven,
 *     NOT a poll). NOTE (source-wins drift from the P4-5 brief): the pool is a
 *     bare module singleton with NO reactive store/emitter
 *     (`codexAccountPool.ts` — no `subscribe`), so a live async-refresh push is
 *     not possible without the account-diagnostic sink. That sink
 *     (`accountDiagnostics.ts`, already secret-scrubbed) is the named reactive
 *     hook for P4-15 (reauth banner) + P4-17 (welcome table); wiring it is
 *     deferred to P4-15, which owns the reauth surface. v1 is thus attach +
 *     verb-driven re-emit, matching the settings seam's spawn-time posture.
 */

/** Redacted per-account status. NO token, NO vault path — see `secretGuard`. */
export type AccountStatus = {
  /**
   * The pool's `accountId` (an OpenAI account UUID) — an identifier, NOT a
   * secret (`secretGuard` does not block it); it is the addressing key the
   * renderer echoes back on a lifecycle verb. The sidecar always re-resolves it
   * against the live pool (T6) — it is never trusted as state.
   */
  id: string
  alias: string | null
  status: 'healthy' | 'dead' | 'capped' | 'quarantined'
  /** `PoolAccountStatusReason` (usage_cap/auth_dead/runtime_cap/…) or null. */
  statusReason: string | null
  /** Derived from the engine's `getCodexAccountAvailability().kind`. */
  availability: 'available' | 'warned' | 'blocked'
  /** Redacted human label from `describeCodexAccountAvailability` (never a token). */
  availabilityLabel: string
  /** True for the pool's persisted active account (the `activeIndex` account). */
  isDefault: boolean
  /**
   * True when the account has a vault profile on disk — the presence flag ONLY,
   * NEVER the path (`vaultFilePath` is a `secretGuard`-blocked key). Gates the
   * rename/delete affordances (config-only accounts cannot be renamed/deleted).
   */
  hasVaultProfile: boolean
  source: 'vault' | 'config'
  /** 5-hour window used-percent (0–100), or null when no fresh usage hint. */
  usagePrimary: number | null
  /** Weekly window used-percent (0–100), or null. */
  usageWeekly: number | null
  usageLimitReached: boolean
  /** wham/usage reset, Unix SECONDS (the pool's native unit), or null. */
  usageResetAt: number | null
  lastRefreshIso: string | null
  /** Normalized block reason (no token content by construction), or null. */
  lastError: string | null
  planType: string | null
  /**
   * Sidecar-derived: may this account be switched to right now? The authoritative
   * rule (`isCodexAccountSwitchable`: availability !== 'blocked') AND not already
   * the default. The renderer renders this; it never re-derives switchability.
   */
  switchable: boolean
}

/** Redacted Anthropic subscription account. Tokens and vault paths never cross IPC. */
export type AnthropicAccountStatus = {
  id: string
  alias: string | null
  email: string
  status: 'healthy' | 'dead'
  isDefault: boolean
  hasVaultProfile: boolean
  subscriptionType: string | null
}

export type AccountsSnapshot = {
  /** Redacted account rows, pool order (the pool's `activeIndex` account first-class via `isDefault`). */
  accounts: AccountStatus[]
  /** The persisted active account's id, or null when the pool is empty/uninitialized. */
  activeAccountId: string | null
  /** Healthy + not-usage-capped count (the "N of M ready" header stat). */
  readyCount: number
  /** Total pool size. */
  poolCount: number
  /** Whether the engine has completed pool initialization (`getPoolStatus().initialized`). */
  initialized: boolean
  /** Redacted Claude subscription accounts, in engine pool order. */
  anthropicAccounts: AnthropicAccountStatus[]
  /** The active Claude account UUID, or null. */
  anthropicActiveAccountId: string | null
  /** Healthy Claude account count. */
  anthropicReadyCount: number
  /** Total Claude subscription account count. */
  anthropicPoolCount: number
  /** Whether the Claude pool completed initialization. */
  anthropicInitialized: boolean
  /**
   * Whether the engine has any configured Anthropic route (subscription OAuth,
   * API key, Bedrock, Vertex, or Foundry). This contains no credential material.
   */
  anthropicRouteAvailable: boolean
  /** True only when the active first-party request credential is the Claude subscription pool. */
  anthropicSubscriptionActive?: boolean
}

/**
 * P4-5 outbound frame. Emitted on attach (after the other snapshots, before
 * history replay) and re-broadcast after a pool-mutating account verb. Read-only;
 * writes cross via the app-owned `account.*` verbs, never this frame.
 */
export type AccountsSnapshotFrame = {
  kind: 'accounts.snapshot'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  accounts: AccountsSnapshot
}

/** The outcome of one account verb (echoes the renderer-minted `requestId`, T5a-analog). */
export type AccountResultFrame = {
  kind: 'account.result'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  requestId: string
  verb: AccountVerbType
  ok: boolean
  /** Redacted, human-readable outcome; NEVER carries token material. */
  message: string
  /**
   * `account.touchAll` only — per-account refresh outcomes for the results list.
   * `alias` is the redacted label; `result` is the touch-all status class.
   */
  touchAllResults?: Array<{
    alias: string | null
    result: 'OK' | 'LOCKED' | 'FAILED'
  }>
}

/**
 * P4-15 — the live OAuth login progress states, surfaced to the renderer so the
 * first-run sign-in surface and the reauth banner can drive their sub-states off
 * the REAL engine flow (`ConsoleOAuthFlow.tsx:35-55` `OAuthStatus`), not a
 * scripted timer. Mirrors the engine states the renderer needs, dropping the
 * ones that are engine-internal (`creating_api_key`, `about_to_retry`).
 *
 * SECRET POSTURE (SECURITY-MINIMUM §4 — proven by `secretGuard` on every
 * outbound frame): this carries NON-secret state ONLY. `url` is the OAuth
 * AUTHORIZE url the user must SEE to paste-fall-back — it holds the public PKCE
 * `code_challenge` + one-time `state`, NEVER the `code_verifier` or any token
 * (`codex-client.ts:140` builds it; the verifier stays engine-side). `message`
 * is the redacted human error text. The tokens themselves never leave the
 * engine: they are captured inside the sidecar's OAuth controller and written by
 * the engine's own `saveCodexOAuthTokens`/vault path — the `waiting_for_alias`
 * and `success` states carry no token field at all.
 */
export type OAuthLoginProgress =
  /** Flow kicked off; browser opening, url not yet minted. */
  | { state: 'starting' }
  /** Browser handoff live; `url` is the engine-minted authorize url (paste fallback). */
  | { state: 'waiting_for_login'; url: string }
  /** Tokens captured engine-side; awaiting the optional account alias (new account). */
  | { state: 'waiting_for_alias' }
  /** Token written; the account appears on the next `accounts.snapshot`. */
  | { state: 'success' }
  /** The flow failed; `message` is the redacted engine error (retryable). */
  | { state: 'error'; message: string }

/**
 * P4-15 outbound frame — pushed as the engine OAuth flow advances (begun by the
 * `account.login` verb, driven by the paste-code/alias verbs). Broadcast to every
 * connection like a snapshot; carries non-secret state only (secretGuard-clean by
 * construction). NOT a snapshot: it is the transient flow progress, cleared when
 * the account lands (`accounts.snapshot` re-broadcast) or the attempt is cancelled.
 */
export type OAuthLoginProgressFrame = {
  kind: 'oauth.login.progress'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  progress: OAuthLoginProgress
}

/* ------------------------------------------------------------------------- *
 * Settings extensions read-seam (P4-12) — read-only config snapshots
 * ------------------------------------------------------------------------- *
 *
 * The MCP / Plugins / Skills / Hooks settings sub-panels. All four are
 * spawn-time reads of the engine's real config (like `settings.snapshot`, not a
 * live subscription), consolidated into ONE outbound frame because they are one
 * session's scope and all freeze at spawn. Each slice is independently nullable:
 * a failed read for one domain does not blank the others (the reader logs and
 * that slice arrives `null`).
 *
 * Secret posture (secretGuard-clean by construction): the snapshot carries
 * config METADATA only — no setting VALUES, no MCP `env`/`headers`, no hook
 * `command`/`prompt` BODIES beyond a display line, no plugin option values, no
 * skill prompt bodies. Proven in `extensionsDomain.test.ts`.
 *
 * Deliberate deferrals (P4-12 §0 flags — render truth, defer the rest):
 *  - **MCP live runtime is EMPTY in the desktop session today** (the
 *    `sessionController.ts` empty-mcpClients stub, flagged for an
 *    `app-runtime` extract, NOT a sidecar hand-wire — §8.1). So MCP entries are
 *    CONFIGURED servers only: connection status / tool+resource counts /
 *    reconnect+auth+enable+remove actions are unavailable until that runtime is
 *    wired, and are omitted here rather than mocked.
 *  - All WRITES (add/remove/enable-toggle/update/install) are deferred to the
 *    `SettingsUpdater`-under-lock write-seam (P3-5a/DR-2), a later session.
 *  - Plugin marketplace BROWSING is deferred (real domain exists — the
 *    `marketplaceManager` — but it refreshes remotes and its install path is a
 *    write; out of a read-only session's scope).
 *  - Hook last-run OUTCOME/timing is NOT persisted by the engine (a transient
 *    per-invocation `HookResult`, `src/utils/hooks.ts:338`); it is dropped here,
 *    not reconstructed/mocked.
 */

/** MCP transport, as configured (`McpServerConfig.type`, `src/services/mcp/types.ts`). */
export type McpConfigTransport =
  | 'stdio'
  | 'sse'
  | 'sse-ide'
  | 'ws'
  | 'ws-ide'
  | 'http'
  | 'sdk'
  | 'claudeai-proxy'

/**
 * The real MCP config scope (`ConfigScope`, `src/services/mcp/types.ts`). Wider
 * than the settings-source taxonomy — carried RAW so the panel can render the
 * true scope and flag the display collapse rather than pre-flatten it.
 */
export type McpConfigScope =
  | 'local'
  | 'user'
  | 'project'
  | 'dynamic'
  | 'enterprise'
  | 'claudeai'
  | 'managed'

/** One CONFIGURED MCP server (no live connection state — see the header deferral). */
export type McpConfigEntry = {
  name: string
  transport: McpConfigTransport
  scope: McpConfigScope
  /** Remote transports carry a url; stdio carries a command + arg count. */
  url?: string
  command?: string
  argCount?: number
  /** Set when the server is contributed by a plugin (`ScopedMcpServerConfig.pluginSource`). */
  pluginSource?: string
}

/** Per-plugin contribution counts, DERIVED from the plugin's component paths/records. */
export type PluginProvides = {
  commands: number
  agents: number
  skills: number
  hooks: number
  mcpServers: number
  lsp: number
}

/** One installed plugin (`LoadedPlugin`, `src/types/plugin.ts:48`). */
export type PluginEntry = {
  /** `plugin@marketplace`-style source string — the stable id. */
  id: string
  name: string
  version?: string
  /** The origin source string (`LoadedPlugin.source`, e.g. `x@builtin`/`x@inline`). */
  source: string
  enabled: boolean
  builtin: boolean
  provides: PluginProvides
  /** A correlated load error (`AppState.plugins.errors`), display string only. */
  error?: string
  /**
   * A STAGED auto-update awaiting restart (`getPendingUpdatesDetails`,
   * `installedPluginsManager.ts:656`) — the only real "newVersion" signal. This
   * is NOT an upstream "update available" check (that engine API does not exist).
   */
  pendingUpdate?: { oldVersion: string; newVersion: string }
}

/** A skill's config source (`PromptCommand.source`, `src/types/command.ts:32`). */
export type SkillConfigSource =
  | SettingSourceId
  | 'plugin'
  | 'mcp'
  | 'builtin'
  | 'bundled'

/** One skill (a `type:'prompt'` `Command`), metadata only — no prompt body. */
export type SkillEntry = {
  name: string
  source: SkillConfigSource
  context: 'inline' | 'fork'
  /** Sub-agent name for a `context:'fork'` skill. */
  agent?: string
  /** Providing plugin display name (`pluginInfo.pluginManifest.name`). */
  pluginName?: string
  disableModelInvocation: boolean
  userInvocable: boolean
  description: string
  whenToUse?: string
}

/** A hook's config source (`HookSource`, `src/utils/hooks/hooksSettings.ts:15`). */
export type HookConfigSource =
  | SettingSourceId
  | 'pluginHook'
  | 'sessionHook'
  | 'builtinHook'

/** Configured-hook type (`HookCommand` discriminant; `http` is the real "webhook"). */
export type HookConfigType =
  | 'command'
  | 'prompt'
  | 'http'
  | 'agent'
  | 'callback'
  | 'function'

/** One configured hook (`IndividualHookConfig`), metadata + a display line only. */
export type HookEntry = {
  /** Canonical hook event name (`HOOK_EVENTS`, `coreTypes.ts:25`). */
  event: string
  type: HookConfigType
  matcher?: string
  source: HookConfigSource
  pluginName?: string
  async: boolean
  /** `getHookDisplayText` output — the command / url / prompt line (no secrets). */
  displayLine: string
}

export type ExtensionsSnapshot = {
  /** CONFIGURED MCP servers (null if the config read failed). */
  mcp: McpConfigEntry[] | null
  /** Installed plugins (null if the plugin load failed). */
  plugins: PluginEntry[] | null
  /** Skills the session loaded, metadata only (null if unavailable). */
  skills: SkillEntry[] | null
  /** Configured hooks in canonical event order (null if the read failed). */
  hooks: HookEntry[] | null
}

/**
 * P4-12 outbound frame. Emitted on attach (after the agent-config snapshot,
 * before history replay). Read-only; writes go through the engine's own config
 * managers under the `SettingsUpdater`-under-lock write-seam, a later session.
 */
export type ExtensionsSnapshotFrame = {
  kind: 'extensions.snapshot'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  extensions: ExtensionsSnapshot
}

/* ------------------------------------------------------------------------- *
 * RemoteSettings read-seam (P4-13, D3 cut scope) — conforms to the P4-5 recipe
 * ------------------------------------------------------------------------- *
 *
 * Bridge status is read directly from the session's own `AppStateStore` (the
 * SAME store `permissionDomain.ts`/`goalDomain.ts` read; `replBridgeEnabled` /
 * `replBridgeError`, `src/state/AppStateStore.ts:138,157`) — read-at-call, not
 * a poll. The command-filter truth is derived from THIS session's real command
 * catalog (`getCommands(cwd)`, the same array the runtime parses slash commands
 * from) filtered through the engine's own `isBridgeSafeCommand`
 * (`src/commands.ts:697`) — never a copied array. Re-broadcast after a
 * mutating `remoteSettings.*` verb, matching the accounts seam's action-driven
 * re-emit (no reactive store to subscribe to on the bridge flag either).
 */

export type RemoteSettingsSnapshot = {
  bridge: {
    /** `AppState.replBridgeEnabled` — the real flag `/remote-control` sets. */
    enabled: boolean
    /** `AppState.replBridgeError`, or null. */
    error: string | null
    /** `isEnvLessBridgeEnabled()` branch — which bridge transport would be used. */
    transport: 'v1' | 'v2'
  }
  commandFilter: {
    /** `type === 'prompt'` commands from THIS session's real catalog — safe by type. */
    skillSafe: string[]
    /** `BRIDGE_SAFE_COMMANDS` members present in THIS session's real catalog. */
    optIn: string[]
    /** `type === 'local-jsx'` commands from THIS session's real catalog — always blocked. */
    blocked: string[]
  }
}

/**
 * P4-13 outbound frame. Emitted on attach (after the accounts snapshot, before
 * history replay) and re-broadcast after a mutating `remoteSettings.*` verb.
 */
export type RemoteSettingsSnapshotFrame = {
  kind: 'remoteSettings.snapshot'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  remoteSettings: RemoteSettingsSnapshot
}

/** The outcome of one RemoteSettings verb (echoes the renderer-minted `requestId`). */
export type RemoteSettingsResultFrame = {
  kind: 'remoteSettings.result'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  requestId: string
  verb: RemoteVerbType
  ok: boolean
  /** Human-readable outcome; NEVER carries token material. */
  message: string
  /** `remoteSettings.directConnect` only — the reachable target, no token. */
  directConnect?: {
    sessionId: string
    wsUrl: string
  }
}

/**
 * P4-19 — the outcome of one settings write verb (echoes the renderer-minted
 * `requestId`). On `ok`, an updated `settings.snapshot` follows. `message` is a
 * human-readable outcome (e.g. the validation error on a rejected value); it
 * NEVER carries a setting value or credential material.
 */
export type SettingsResultFrame = {
  kind: 'settings.result'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  requestId: string
  verb: SettingsVerbType
  ok: boolean
  message: string
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

/* ------------------------------------------------------------------------- *
 * Workspace-trust read-seam (P4-14) — read-only VIEW over the real trust store
 * ------------------------------------------------------------------------- *
 *
 * The Settings → Workspace section's "Additional trusted directories" list is
 * NOT duplicated here — it already crosses the wire on `PermissionContextSnapshot
 * .additionalWorkingDirectories` (C3, above) and the renderer selects it from
 * there (§10 — reuse the real entry point instead of re-plumbing the same
 * data). This frame carries only the two facts that seam does not: whether the
 * session's cwd is itself trusted, and the detected git remote. Read-only; the
 * Untrust/Trust mutate action is P4-15's session-create trust gate, not this
 * frame.
 */
export type WorkspaceTrustSnapshot = {
  /** `isPathTrusted(cwd)` (config.ts:790) for THIS session's cwd. */
  trusted: boolean
  /** `owner/repo` parsed from the git remote origin, or null (no remote / not a repo). */
  detectedRepo: string | null
  /**
   * The path an accept actually writes trust at — `getProjectPathForConfig()`
   * (`src/utils/config.ts:1626`), i.e. the canonical GIT ROOT of the session's
   * cwd, falling back to the cwd itself outside a repo. Null only when the
   * engine read failed (display degrades; it never affects `trusted`).
   *
   * Additive (2026-07-26) and load-bearing for INFORMED CONSENT, not cosmetics.
   * D4 (`docs/migration/decisions/STARTUP-GATES.md §1.1`) makes the desktop trust gate
   * per-session-CREATE, so it *presents* as per-folder — but the storage it
   * writes to is per-REPO: `saveCurrentProjectConfig` keys the write at
   * `getProjectPathForConfig()` (`config.ts:1675`) and `isPathTrusted` walks UP
   * from a directory (`config.ts:790-799`), so approving for
   * `repo/packages/foo` makes every sibling under `repo` read trusted — in the
   * desktop AND the shared terminal CLI config. That storage shape is upstream
   * Claude Code behavior and is deliberately NOT changed here (a second trust
   * model over one shared config file was considered and rejected); the
   * presentation mismatch is ours, so the gate must NAME this path.
   *
   * HC1: the renderer never derives or authors a path — it renders this field
   * verbatim, exactly like every other fact on this surface.
   */
  trustRoot: string | null
}

/**
 * P4-14 outbound frame. Emitted on attach (after the other snapshots, before
 * history replay), point-in-time — trust/repo do not change within a session's
 * lifetime (a workspace switch spawns a new sidecar at the new cwd).
 */
export type WorkspaceTrustSnapshotFrame = {
  kind: 'workspace-trust.snapshot'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  workspaceTrust: WorkspaceTrustSnapshot
}

/* ------------------------------------------------------------------------- *
 * P4-15 — workspace-trust WRITE verb (the session-create trust gate's accept)
 * ------------------------------------------------------------------------- *
 *
 * The D4 ruling (`docs/migration/decisions/STARTUP-GATES.md §1.1`) makes trust a per-session-
 * create gate: an untrusted session's `workspace-trust.snapshot` reports
 * `trusted:false`, the renderer shows the trust dialog, and ACCEPT persists trust
 * for that session's cwd. Like the P4-5 account verbs and the P4-19 settings
 * write, this is app-owned inbound vocabulary the engine's shared
 * `appClientMessageSchema` does NOT carry — it is validated by a sidecar-LOCAL
 * Zod schema at the trust boundary and dispatched to the engine's OWN trust
 * persistence (`saveCurrentProjectConfig` with `hasTrustDialogAccepted:true`,
 * `src/components/TrustDialog/TrustDialog.tsx:177,272`); the sidecar re-reads
 * `isPathTrusted(cwd)` and re-broadcasts the snapshot. Decline is NOT a verb —
 * it closes the session's tab in the renderer (Q1 TUI parity: no read-only).
 *
 *  - **HC1** — the renderer NEVER authors a path; the sidecar persists trust for
 *    its OWN spawn cwd, never a renderer-supplied directory. The verb carries no
 *    path, only a `requestId` for result correlation (T5a-analog).
 *  - **Secret-owner invariant untouched** — trust is a boolean in the engine's
 *    config store; no token crosses either direction.
 *  - **T7** — the existing inbound size/rate caps apply unchanged.
 */
export const WORKSPACE_TRUST_VERB_TYPES = ['workspace.trust'] as const

export type WorkspaceTrustVerbType = (typeof WORKSPACE_TRUST_VERB_TYPES)[number]

/** Accept trust for the addressed session's OWN cwd (persist + re-broadcast). */
export type WorkspaceTrustMessage = {
  type: 'workspace.trust'
  requestId: string
}

/**
 * P4-15 outbound result echoing the verb's `requestId`, followed by an updated
 * `workspace-trust.snapshot` (`trusted:true`) when the write changed the store.
 */
export type WorkspaceTrustResultFrame = {
  kind: 'workspace.trust.result'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  requestId: string
  ok: boolean
  /** Redacted, human-readable outcome; NEVER carries token material. */
  message: string
}

/* ------------------------------------------------------------------------- *
 * Diagnostics read-seam (P4-14) — read-only snapshot mirroring /doctor + /status
 * ------------------------------------------------------------------------- *
 *
 * Mirrors the TUI's `/doctor` + `/status` panes (`src/utils/status.tsx`,
 * `src/utils/doctorDiagnostic.ts`) with their Ink-coupled formatting stripped —
 * plain data only, rendered by the desktop's own presentation. Fields the
 * renderer can already derive from an EXISTING snapshot (setting sources from
 * `settings.snapshot`, active account from `accounts.snapshot`) are
 * deliberately NOT duplicated here (§10).
 */
export type DiagnosticsSnapshot = {
  /** `MACRO.VERSION` — the running build's version string. */
  version: string
  /** The engine's raw model override string (`--model`/setting), or null = default. */
  mainLoopModel: string | null
  /**
   * The RESOLVED model this session runs (`getMainLoopModel()`, `model.ts:136`) —
   * honours the user's model setting + provider default, so the composer can show
   * the real model even with no explicit override. null only if resolution failed.
   */
  mainLoopModelForSession: string | null
  /**
   * The session's reasoning-effort tier (`AppState.effortValue` → string), or null
   * when no explicit effort is set (the model runs at the provider default; NOT
   * fabricated into a label). A GPT/Codex-path concept.
   */
  reasoningEffort: string | null
  /** The fast-mode toggle (`AppState.fastMode`); false unless explicitly enabled. */
  fastMode: boolean
  /** Whether the Bash sandbox is enabled for this session (`SandboxManager.isSandboxingEnabled()`). */
  sandboxEnabled: boolean
  /**
   * The git branch of the session's own cwd, or null outside a repo / on a
   * detached HEAD. Read with the engine's own `getBranch()` — the SAME function
   * that stamps `gitBranch` onto every persisted message
   * (`src/utils/sessionStorage.ts:1464`), so this and the transcript catalog can
   * never disagree about what branch a session is on.
   *
   * It exists because the catalog's copy is unreadable in the one state that
   * needs it: `gitBranch` is only written when a MESSAGE is persisted, so the
   * empty-transcript launcher (`WelcomeScreen` session variant) always read
   * "none", in a repo or not. Additive + OUTBOUND-only (no new inbound
   * vocabulary). Spawn-frozen like the rest of this snapshot: a branch switched
   * while the empty state is open is not re-read.
   */
  gitBranch: string | null
  /** `checkInstall()` warnings — install-path/PATH/symlink issues. */
  installationWarnings: string[]
  /** `getDoctorDiagnostic()` health warnings + missing-update-permission note. */
  healthWarnings: string[]
  /** Oversized CLAUDE.md / auto-memory file warnings. */
  memoryWarnings: string[]
}

/**
 * P4-14 outbound frame. Emitted on attach (after the other snapshots, before
 * history replay), point-in-time — the doctor/install checks run once at spawn,
 * matching the settings seam's spawn-frozen posture (no live re-poll).
 */
export type DiagnosticsSnapshotFrame = {
  kind: 'diagnostics.snapshot'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  diagnostics: DiagnosticsSnapshot
}

/* ------------------------------------------------------------------------- *
 * Sessions catalog read-seam (P4-6a) — read-only cross-workspace history
 * ------------------------------------------------------------------------- *
 *
 * The Sessions page (`SessionsPage`) browses a catalog RICHER than the host
 * registry: the registry (`hostApi.ts` `SessionDescriptor`) knows only the
 * app's own live∪restorable rows (title/cwd/status/recency), while the engine's
 * on-disk transcript history (`src/utils/sessionStorage.ts` — `LogOption`,
 * `src/types/logs.ts:20`) carries the real per-session title, tag, git branch,
 * mode, agent setting, PR number and message count for EVERY session ever run
 * (TUI + desktop), across every workspace.
 *
 * This is the engine-history half of the catalog (the host plane is deliberately
 * engine-free — `registry.ts:19` — so it cannot enumerate transcripts). The
 * renderer MERGES it with the registry rows via a shared selector
 * (`sessionsCatalogState.ts` — reused by P4-17 Welcome recents, D5).
 *
 * Catalog owner (decision #4, `docs/migration/decisions/CATALOG-OWNERSHIP.md`):
 * a single main-supervised disposable worker enumerates this off any sidecar and
 * delivers it to the renderer as a `sessions-catalog` host event on a ~30 s timer
 * (`sessionsCatalogRunner.ts SESSIONS_CATALOG_REFRESH_INTERVAL_MS`), so a session
 * created after launch still appears (same freshness contract as the old
 * per-sidecar refresh). Read-only display metadata only — no message bodies, no
 * credentials — so it is `secretGuard`-clean by construction. It ALSO carries the
 * winning display title (custom-title > ai-title) so the catalog/sidebar can show
 * real session names instead of the cwd-basename fallback (the P4-6 title rider,
 * surface half; title GENERATION for fresh app sessions is deferred — see STATUS).
 */
export type SessionCatalogEntry = {
  /** The transcript session id (matches a live row's `engineSessionId`). */
  sessionId: string
  /** Session root (the transcript's project path). */
  cwd: string
  /**
   * Whether `cwd` is a currently-existing directory on disk (bug-sweep #1,
   * 2026-07-21). The catalog worker stats each distinct cwd ONCE per enumeration
   * (`sessionsCatalogDomain.ts` `annotateCwdExistence`). A history row whose
   * recorded workspace no longer exists is HIDDEN from the sidebar rail
   * (non-destructive — the transcript stays on disk and the row self-heals if the
   * dir returns) and is non-openable, instead of only failing `invalid_cwd` at
   * open time (`app/host/host.ts` HC1). Additive + OUTBOUND-only (no new inbound
   * vocabulary). Older cached entries lacking it default to `true` at the read
   * boundaries (assume-exists → never wrongly hide).
   */
  cwdExists: boolean
  /**
   * Winning DISPLAY title — a cascade, not a recorded name: recorded title >
   * summary > first prompt > cwd basename (`sessionsCatalogDomain.ts`
   * `resolveEntryTitle`, the B2 "never emit an unlabeled row" rule). null only
   * when nothing at all is available.
   */
  title: string | null
  /**
   * The title actually RECORDED IN THE TRANSCRIPT — `custom-title` (a user
   * rename) or, failing that, `ai-title` (`src/utils/sessionStorage.ts:5262`) —
   * else null when the session never earned one.
   *
   * Deliberately separate from `title` above: only a real recorded title may
   * outrank the host registry's own title (`sessionsCatalogState.ts` `pickTitle`,
   * the terminal-rename fix). Letting the display cascade do it would overwrite an
   * app-set title with first-prompt text the moment the `ai-title` entry scrolled
   * out of the bounded head/tail read windows (`sessionStorage.ts:3048-3052`).
   *
   * Additive + OUTBOUND-only (no new inbound vocabulary). Older cached entries
   * lacking it read as null at the parse boundaries → the registry title keeps
   * winning, i.e. exactly the pre-fix behavior.
   */
  transcriptTitle: string | null
  /** Transcript file mtime (recency sort + date buckets). */
  modifiedAtMs: number
  /** Session creation time. */
  createdAtMs: number
  /**
   * Non-sidechain message count. NOTE: the bounded catalog loader does NOT
   * populate this (it needs a full-chain per-session read — see
   * `sessionsCatalogDomain.ts`), so it is 0 on the bounded path; the "Most
   * active" sort + "N msgs" chip that consumed it were removed (§I.7).
   */
  messageCount: number
  /** git branch recorded on the session, else null. */
  gitBranch: string | null
  /** The single searchable tag on the session, else null. */
  tag: string | null
  /** Session mode (agent/coordinator/normal), else null. */
  mode: 'agent' | 'coordinator' | 'normal' | null
  /** The `--agents` setting string, else null. */
  agentSetting: string | null
  /** PR number + repository (owner/repo#N chip), else null. */
  prNumber: number | null
  prRepository: string | null
}

export type SessionsCatalogSnapshot = {
  entries: SessionCatalogEntry[]
  /** True when the enumeration hit `SESSIONS_CATALOG_LIMIT` (older rows dropped). */
  truncated: boolean
  /**
   * Wall-clock at which this enumeration STARTED — the recency half of the
   * title-precedence rule (`sessionsCatalogState.ts` `pickTitle`). A transcript
   * title may outrank the registry's title only when the snapshot was captured
   * AFTER the registry's `titleUpdatedAt` (`app/shared/hostApi.ts`), so a terminal
   * `/rename` — which writes the transcript only (`src/commands/rename/rename.ts:57`)
   * — surfaces within one refresh, while a desktop rename (which writes BOTH the
   * transcript and the registry) is never reverted by an older snapshot.
   *
   * Stamped at the START of enumeration, never the end: every transcript read then
   * happened at or after it, so "captured after the registry stamp" implies the
   * read really did see the newer title. 0 on a cache file or worker record
   * written before the field existed — unknown age ⇒ never overrides (fail safe).
   */
  capturedAtMs: number
}

/**
 * P4-6a outbound frame — SUPERSEDED by catalog owner decision #4
 * (`docs/migration/decisions/CATALOG-OWNERSHIP.md`) and NO LONGER EMITTED. The
 * sessions catalog is now enumerated by a single main-supervised worker off any
 * sidecar and delivered to the renderer as a `sessions-catalog` host event
 * (`hostApi.ts`), so no sidecar broadcasts this. Retained as additive wire
 * vocabulary (removing a `ServerFrame` variant is a breaking protocol change);
 * a future protocol version bump may drop it. Nothing on the wire produces or
 * consumes it today.
 */
export type SessionsCatalogSnapshotFrame = {
  kind: 'sessions.snapshot'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  catalog: SessionsCatalogSnapshot
}

/**
 * P4-6 title-rider — the GENERATION half, wired 2026-07-14. A ONE-SHOT outbound
 * frame emitted after a FRESH session's first turn completes, when the engine's
 * `generateSessionTitle` (Haiku — the SAME machinery the TUI uses,
 * `REPL.tsx:3032-3042`) resolves and the session had no title. Main taps it →
 * `host.setTitle` → durable registry → `descriptor.title` → the sidebar/tab
 * relabel from the cwd-basename fallback to the AI title. Display text only
 * (the shared `send` path's `secretGuard` still scans it; the host also
 * length-caps it). Never emitted for a resumed session or when a title already
 * exists. Main does NOT forward it to the renderer — the title reaches the UI
 * as a host descriptor update (HostEvent), the registry being the sidebar's
 * source of truth.
 */
export type SessionTitleFrame = {
  kind: 'session-title'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  title: string
}

/**
 * A single user-invocable slash command with the display metadata the composer
 * SlashCommandPicker renders. The engine's `system/init.slash_commands` field
 * carries NAMES ONLY (the locked SDK shape); `description`/`argumentHint` live on
 * the engine-side `Command` objects (`src/types/command.ts:182,191`) and were NOT
 * on the wire — so the P3-7 picker shipped name-only, flagged for exactly this
 * read-only catalog snapshot. Display metadata only, no capability.
 */
export type SlashCatalogEntry = {
  /** User-invocable command name, no leading slash (matches `slash_commands`). */
  name: string
  /** One-line description (`Command.description`). */
  description: string
  /** Gray arg hint shown after the name (`Command.argumentHint`, e.g. "<name>"); omitted when none. */
  argumentHint?: string
}

/**
 * Read-only outbound catalog snapshot (C3 precedent): the session's real
 * user-invocable slash commands WITH display metadata, built spawn-time from the
 * sidecar's `getCommands(cwd)` catalog (the SAME source that feeds
 * `slash_commands`). Sent on attach so the composer picker renders name +
 * argHint + description before the first turn. Spawn-frozen (the catalog does not
 * change during a session), so — unlike run-controls — NOT re-broadcast.
 * secretGuard-clean by construction (display strings only).
 */
export type SlashCatalogSnapshotFrame = {
  kind: 'slash-catalog.snapshot'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  commands: SlashCatalogEntry[]
}

export type ServerFrame =
  | ReadyFrame
  | SessionTitleFrame
  | EventFrame
  | PongFrame
  | ErrorFrame
  | LifecycleFrame
  | PermissionContextFrame
  | SettingsSnapshotFrame
  | AgentConfigSnapshotFrame
  | ThreadGoalSnapshotFrame
  | MemorySnapshotFrame
  | ContextBreakdownSnapshotFrame
  | TasksSnapshotFrame
  | AgentModeSnapshotFrame
  | LeaseSnapshotFrame
  | AgentModeSetResultFrame
  | TaskControlResultFrame
  | RunControlsSnapshotFrame
  | RunControlResultFrame
  | SessionActionResultFrame
  | AccountsSnapshotFrame
  | AccountResultFrame
  | OAuthLoginProgressFrame
  | WorkspaceTrustSnapshotFrame
  | WorkspaceTrustResultFrame
  | DiagnosticsSnapshotFrame
  | ExtensionsSnapshotFrame
  | RemoteSettingsSnapshotFrame
  | RemoteSettingsResultFrame
  | SessionsCatalogSnapshotFrame
  | SlashCatalogSnapshotFrame
  | SettingsResultFrame

/* ------------------------------------------------------------------------- *
 * Transcript cache — the at-rest "instant session open" artifact
 * (docs/migration/specs/2026-07-14-instant-session-open-design.md — M1). NOT a
 * wire frame: a per-session cache main persists on eviction and the renderer
 * fetches by id over the read-only `previewSession` control-plane method to
 * render a dead session's transcript instantly, before any sidecar spawn. The
 * codec (distill / write / read / delete) lives in `app/main/transcriptCache.ts`;
 * this is only the shared shape the preload/renderer reference. Additive — no
 * PROTOCOL_VERSION bump (it is not a `ServerFrame`, so the on-wire vocabulary is
 * unchanged). `frames` holds only the distill allowlist: message `event` frames
 * + the truncation-boundary error frame — never `ready`, permission, or any
 * operational snapshot, so cache hydration can reach nothing but transcript state.
 */
/**
 * What a session RAN ON, for a pane that has no engine to ask.
 *
 * A preview reads a cache, and the cache's frames are conversation only: the
 * engine's `toSDKMessages` conversion keeps assistant/user turns and drops the
 * telemetry (verified 2026-07-28 against real caches — 1,615 assistant, 889
 * user, 0 result, 0 `permissionMode`). These facts are therefore captured at
 * WRITE time, from the source that still has them, rather than re-derived from
 * frames that no longer carry them.
 *
 * Every field is nullable and independently so: a cache may record a model but
 * no effort (an Anthropic session has no effort record at all). Null means the
 * source did not say, and the surface renders nothing rather than a zero.
 *
 * Non-secret scalars only. No field here is credential-bearing, and
 * `scanForSecrets` still runs over the whole artifact as defence in depth.
 */
export type TranscriptRunFacts = {
  /** The newest model the transcript records. */
  model: string | null
  /** The newest permission mode. May be an engine-internal mode (`auto`). */
  permissionMode: string | null
  /** The newest reasoning effort actually sent. Codex/GPT sessions only. */
  effort: string | null
  /** Context tokens at the newest turn that reported usage. */
  usedTokens: number | null
  /**
   * The context window for `model`, RESOLVED at write time by the engine's
   * `getContextWindowForModel` rather than read: no transcript record states a
   * window (the live donut's comes off a `result` frame, which is never
   * persisted). Null when the transcript named no model, or the resolver was
   * unavailable, in which case the renderer falls back to its default window.
   */
  contextWindow: number | null
}

export type TranscriptCacheHeader = {
  appSessionId: SessionId
  /** The transcript key (two-id bridge). null only for a never-ready session. */
  engineSessionId: string | null
  protocolVersion: typeof PROTOCOL_VERSION
  /** Stamped for diagnostics; reads gate on protocolVersion + guardVersion. */
  appVersion: string
  /** Guard-drift fast-path (the real guard is a read-time `scanForSecrets` re-scan). */
  guardVersion: number
  writtenAt: number
  /**
   * Additive and OPTIONAL: caches written before this field existed stay valid
   * and simply say nothing. They are refreshed opportunistically rather than
   * discarded, so no transcript is ever destroyed to gain a display detail.
   */
  runFacts?: TranscriptRunFacts
  /**
   * Which generation of run-facts derivation wrote `runFacts`. Absent on a
   * cache written before this field existed.
   *
   * Backfill discovery refreshes a cache whose version is behind the current
   * one. Keying on PRESENCE of `runFacts` instead was a silent bug: when a new
   * fact was added, every existing cache already had a `runFacts` object, so it
   * counted as done and kept the new fact null forever (`contextWindow`, which
   * shipped null on 30 of 44 live caches before this existed).
   */
  runFactsVersion?: number
}

export type TranscriptCache = {
  header: TranscriptCacheHeader
  frames: ServerFrame[]
}

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
   * (never persisted). The sidecar conditionally allows classifier-backed
   * `auto` and trusted-launch `bypassPermissions`, rejecting either when its
   * engine-owned availability gate is closed.
   * The updated `permission.context` snapshot frame is the acknowledgement.
   */
  setPermissionMode(sessionId: SessionId, mode: PermissionSetModeMode): void
  /**
   * C5 (P4-20) — answer a pending `AskUserQuestion` request on the addressed
   * session. `requestId` is the engine-minted permission requestId (T5a); the
   * renderer authors ONLY option INDICES + the built-in "Other…" freeform text
   * (decisions/ASK-USER-QUESTION-ANSWER.md). The sidecar re-reads the gated
   * questions from the ENGINE, re-attaches its own option labels, and resolves
   * the request as an allow carrying the reconstructed answers. No renderer byte
   * becomes a question text or an option label. Decline is a `respondPermission`
   * deny, not a verb.
   */
  answerQuestions(
    sessionId: SessionId,
    requestId: string,
    answers: AskUserQuestionAnswer[],
  ): void
  /**
   * P4-5 — request an account lifecycle verb on the addressed session's sidecar.
   * The renderer NAMES a target (`accountId`/`alias`); the sidecar re-resolves it
   * against the live pool and validates aliases against the engine's own rule
   * (T6). No token ever crosses either way. The outcome arrives as an
   * `account.result` frame echoing `requestId`, followed by an updated
   * `accounts.snapshot` when the pool changed.
   */
  accountVerb(sessionId: SessionId, verb: AccountVerbMessage): void
  /**
   * P4-15 — accept trust for the addressed session's OWN cwd (the session-create
   * trust gate). The sidecar persists via the engine's `saveCurrentProjectConfig`
   * and re-broadcasts `workspace-trust.snapshot`; the outcome arrives as a
   * `workspace.trust.result` frame echoing `requestId`. HC1: no path crosses —
   * the sidecar trusts only its own spawn cwd. Decline is renderer-side (tab
   * close), not a verb.
   */
  workspaceTrustVerb(sessionId: SessionId, verb: WorkspaceTrustMessage): void
  /**
   * P4-8b — set the addressed session's agent mode on/off (the in-session
   * WelcomeScreen Orchestrator toggle). The renderer authors ONLY the boolean
   * intent; the sidecar calls the engine's own `matchSessionMode` (a live
   * `CLAUDE_CODE_AGENT_MODE` env switch in THIS session's process — no respawn,
   * no lifecycle change) and re-broadcasts `agent-mode.snapshot`. main mints the
   * `requestId`; the outcome arrives as an `agent-mode.set.result` frame.
   */
  setAgentMode(sessionId: SessionId, active: boolean): void
  /**
   * P4-8b — stop/kill a running task on the addressed session's sidecar (the
   * deferred worker-control action; primary case: an orchestrator `local_agent`
   * worker). The renderer authors ONLY the target `taskId` (a `TaskSnapshotItem.id`
   * already on the wire) + a `requestId`; the sidecar re-resolves it against the
   * LIVE `AppState.tasks` and dispatches the engine's OWN `stopTask` — no path, no
   * engine object, no token crosses. The outcome arrives as a `task-control.result`
   * frame echoing `requestId` (`ok:false` when the task was gone/terminal), and the
   * kill's store mutation drives the existing `tasks.snapshot` re-broadcast.
   */
  taskControlVerb(sessionId: SessionId, verb: TaskControlVerbMessage): void
  /**
   * P4-24c — set one composer run-control (model / reasoning effort / fast) on the
   * addressed session's sidecar. The renderer authors ONLY a value/selection (a
   * model id from the sidecar-minted option list, an effort level string, or a
   * boolean) + a `requestId` for correlation; the sidecar re-validates and runs the
   * engine's OWN per-session setter (a LIVE change, no respawn), then re-broadcasts
   * `run-controls.snapshot`. The outcome arrives as a `run-control.result` frame.
   * No engine object, no path, no token crosses.
   */
  runControlVerb(sessionId: SessionId, verb: RunControlVerbMessage): void
  /**
   * P4-6b — request a session-action verb (rename / export / branch) on the
   * addressed session's sidecar. The renderer authors ONLY intent (a title string
   * on rename; export/branch carry no params); the sidecar re-validates and runs
   * the engine's OWN saveCustomTitle / renderMessagesToPlainText / createFork. The
   * outcome arrives as a `session-action.result` frame echoing `requestId` — a
   * successful export carries the rendered text; a successful branch, the new
   * engine session id. No engine object, no path, no token crosses.
   */
  sessionActionVerb(sessionId: SessionId, verb: SessionActionVerbMessage): void
  /** Ask for a fresh context breakdown; answered by a `context-breakdown.snapshot`. */
  contextBreakdownVerb(
    sessionId: SessionId,
    verb: ContextBreakdownVerbMessage,
  ): void
  /**
   * P4-13 — request a RemoteSettings verb (bridge toggle or direct-connect) on
   * the addressed session's sidecar. The outcome arrives as a
   * `remoteSettings.result` frame echoing `requestId`, followed by an updated
   * `remoteSettings.snapshot` when the bridge flag changed.
   */
  remoteSettingsVerb(sessionId: SessionId, verb: RemoteVerbMessage): void
  /**
   * P4-19 — write one editable core setting on the addressed session's sidecar.
   * The renderer names a `{ source, key, value }`; the sidecar re-validates all
   * three against the closed `EDITABLE_SETTINGS` allowlist and applies the write
   * through the engine's `SettingsUpdater`-under-lock form. The outcome arrives
   * as a `settings.result` frame echoing `requestId`, followed by an updated
   * `settings.snapshot` when the write landed.
   */
  settingsVerb(sessionId: SessionId, verb: SettingsVerbMessage): void
  /** Liveness ping; resolves as a `pong` server frame. */
  ping(sessionId: SessionId, nonce: string): void
  /** Restart the addressed sidecar process while retaining renderer attachment. */
  restart(sessionId: SessionId): void
  /**
   * Subscribe to server frames. Main delivers them in batches (one `ServerFrame[]`
   * per IPC message, perf F3); a single live frame arrives as a one-element array.
   * Returns an unsubscribe function.
   */
  subscribe(listener: (frames: ServerFrame[]) => void): () => void
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
  pickDirectory(activeSessionId?: SessionId | null): Promise<string | null>
  /**
   * Create a fresh session rooted at the directory a prior `pickDirectory()`
   * token names. The renderer supplies a token + optional title — it CANNOT
   * author a cwd or a resume id (HC1/T8). To reopen a past session use
   * `restoreSession`, not this.
   */
  createSession(input: CreateSessionInput): Promise<HostResult<SessionDescriptor>>
  /** Restore a registry row's session by id (registry-mediated; HC2). */
  restoreSession(appSessionId: SessionId): Promise<HostResult<SessionDescriptor>>
  /**
   * Create a FRESH session in an existing workspace named by a REGISTRY id (#15).
   * The renderer passes only a representative session id already rooted at that
   * workspace; the host re-derives + re-validates the cwd from its OWN registry
   * (exactly like `restoreSession`) and spawns a new session there with NO resume.
   * The renderer never authors a cwd (HC1/T8) — this is the per-workspace "+".
   */
  createSessionInWorkspace(
    appSessionId: SessionId,
  ): Promise<HostResult<SessionDescriptor>>
  /**
   * Instant session open (M2) — fetch a dead session's cached transcript by id,
   * read-only, WITHOUT spawning a sidecar. Modeled exactly on `restoreSession`:
   * id-only, rate/size-guarded, fixed channel. Main validates the id against the
   * host's restorable roster (`host.canPreview`) BEFORE touching disk, then reads
   * the size-bounded, schema-validated, secret-re-scanned cache; a missing /
   * corrupt / non-restorable id resolves to `null` (the no-cache fallback). The
   * cache carries only transcript-bearing frames, so nothing but transcript state
   * is reachable from it. See the instant-session-open design (M2 + Security delta).
   */
  previewSession(appSessionId: SessionId): Promise<TranscriptCache | null>
  /** Graceful close; the row is kept restorable. */
  closeSession(appSessionId: SessionId): Promise<HostResult<void>>
  /** Snapshot of live ∪ restorable sessions. */
  listSessions(): Promise<SessionDescriptor[]>
  /**
   * F2 — the cold-launch sessions-catalog baseline: the global engine-history
   * enumeration a sidecar last persisted to disk, read WITHOUT a live session so
   * the Sessions page shows the operator's real terminal history at startup (when
   * every registry row is merely restorable and nobody has emitted a
   * `sessions.snapshot` frame yet). Read-only, id-less, HC3 fixed-sender — main
   * reads its own registry-dir cache, size-bounds + schema-validates it fail-
   * closed, and returns the parsed snapshot or `null` (missing / corrupt cache).
   * Any live `sessions.snapshot` supersedes this baseline in the renderer.
   */
  readSessionsCatalog(): Promise<SessionsCatalogSnapshot | null>
  /**
   * SESSIONS-UNIFICATION (operator ruling 2026-07-20) — open a terminal-created
   * session (a transcript with no desktop registry row) as a real desktop
   * session, by its ENGINE session id. The renderer authors NO cwd or path
   * (HC1): it passes only the engine id; main validates it (strict UUID shape),
   * resolves the cwd from the sidecar-written baseline cache (engine-derived,
   * never renderer-supplied), and spawns a resume through the SAME machinery
   * `restoreSession` uses. An id already open in the app returns that row
   * (switch, no re-spawn); an id absent from the cache or with an empty recorded
   * cwd fails closed with a typed error the renderer renders honestly. HC3 fixed
   * sender. This is the load-bearing half of the unified-sessions ruling — the
   * companion to `restoreSession` for sessions the app never tracked.
   */
  openHistorySession(
    engineSessionId: string,
  ): Promise<HostResult<SessionDescriptor>>
  /**
   * P4-35 (operator ruling 2026-07-30) — write text to a file the USER chooses.
   * The app's only file sink, and the mirror of `pickDirectory`: the renderer may
   * REQUEST main's native save dialog, never answer it. It supplies the text plus
   * a name SUGGESTION and cannot express a destination (HC1 — `SaveTextInput` has
   * no path field); main sanitizes the suggestion to a basename, asks the user,
   * writes, and returns whether a file was written. The chosen path never crosses
   * back. `ok: true, saved: false` is a dismissed dialog, not a failure.
   *
   * Bounded by `MAX_SAVE_TEXT_BYTES`, its own cap — see `limits.ts` for why this
   * channel does not ride `MAX_FRAME_BYTES` and why that cap is unchanged.
   */
  saveTextToFile(input: SaveTextInput): Promise<SaveTextResult>
  /**
   * Subscribe to the host's row-change stream (the session list is a projection
   * of this, never a poll loop). Returns an unsubscribe function.
   */
  subscribeHost(listener: (event: HostEvent) => void): () => void
  /**
   * DEV preload bundle only. One-way renderer→main debug-state report; stripped
   * from packaged preload builds, and main registers the receiver only under
   * CATCODE_DEBUG_STATE=1.
   */
  reportDebugShellState?: (snapshot: DebugRendererSnapshot) => void
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
