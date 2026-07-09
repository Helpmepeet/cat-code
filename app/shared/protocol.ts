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
import type { DebugRendererSnapshot } from './debugState.js'

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
] as const

export type AccountVerbType = (typeof ACCOUNT_VERB_TYPES)[number]

/** Switch the persisted active account new sessions seed from. Synchronous. */
export type AccountSwitchMessage = {
  type: 'account.switch'
  requestId: string
  accountId: string
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
}

export type AccountVerbMessage =
  | AccountSwitchMessage
  | AccountRenameMessage
  | AccountDeleteMessage
  | AccountLogoutMessage
  | AccountTouchAllMessage
  | AccountLoginMessage

/**
 * Everything a client may send toward a sidecar: the engine's allowlisted
 * vocabulary plus the app-owned C2 frame and the P4-5 account verbs.
 */
export type SidecarClientMessage =
  | AppClientMessage
  | PermissionSetModeMessage
  | AccountVerbMessage

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
}

/**
 * P4-3 outbound frame. Emitted on attach (after `ready` + the C3
 * `permission.context`, before history replay). Read-only; the renderer never
 * writes settings across this seam — writes go through the engine's
 * `SettingsUpdater`-under-lock form (P3-5a, `settings.ts:480`), a later decided
 * action. Live re-emit on change is deferred: general settings require a restart
 * in the engine today (the session settings cache, `settings.ts:944`), and
 * permission-rule mutations already flow via the C3 snapshot.
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
  notes: string[]
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

export type MemorySnapshot = {
  autoMemoryEnabled: boolean
  autoMemoryDir: string
  autoMemoryEntrypoint: string
  instructionFiles: MemoryInstructionFile[]
  autoMemories: AutoMemoryHeader[]
  notes: string[]
}

export type MemorySnapshotFrame = {
  kind: 'memory.snapshot'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  memory: MemorySnapshot
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

export type TasksSnapshot = {
  items: TaskSnapshotItem[]
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
  | SettingsSnapshotFrame
  | AgentConfigSnapshotFrame
  | ThreadGoalSnapshotFrame
  | MemorySnapshotFrame
  | TasksSnapshotFrame
  | AccountsSnapshotFrame
  | AccountResultFrame

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
  /**
   * P4-5 — request an account lifecycle verb on the addressed session's sidecar.
   * The renderer NAMES a target (`accountId`/`alias`); the sidecar re-resolves it
   * against the live pool and validates aliases against the engine's own rule
   * (T6). No token ever crosses either way. The outcome arrives as an
   * `account.result` frame echoing `requestId`, followed by an updated
   * `accounts.snapshot` when the pool changed.
   */
  accountVerb(sessionId: SessionId, verb: AccountVerbMessage): void
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
  /** Graceful close; the row is kept restorable. */
  closeSession(appSessionId: SessionId): Promise<HostResult<void>>
  /** Snapshot of live ∪ restorable sessions. */
  listSessions(): Promise<SessionDescriptor[]>
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
