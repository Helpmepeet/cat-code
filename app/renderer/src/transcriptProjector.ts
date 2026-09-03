/**
 * Transcript projector — anti-corruption boundary LAYER 2 (PROGRAM-PLAN §5).
 *
 * Rows retain the authoritative transport session, producer message id, frame
 * id, and content-block index. The streaming producer emits one assistant
 * frame per stopped block, so siblings are grouped by `message.id` rather than
 * by assuming all blocks arrive in one frame.
 *
 * P2-0 coverage contract: `projectMessage` handles EVERY `SDKMessage` union
 * member (19 members / 15 top-level `type` discriminants,
 * `src/entrypoints/sdk/coreTypes.generated.ts:760`). Each variant is either
 * projected into a typed row or an explicit, documented no-op — never a crash,
 * never a silent drop. The `default` branch carries a compile-time `never`
 * tripwire (union growth breaks the build here) while staying a runtime no-op
 * (wire frames may outrun the pinned engine types). The exhaustive fixture in
 * `sdkMessageFixtures.ts` is the acceptance artifact asserting this contract.
 *
 * Layer discipline (§5): this file projects transcript rows ONLY. Session
 * control, permissions, accounts, and other domains read their own slices
 * (layer 3) and must not be fused in here.
 *
 * P2-2 tool-card correlation: a `tool-use` row's `status`/`result` are NEVER
 * stored — `selectTranscriptRows` derives them on every read from the
 * session's `toolResultsByUseId` map (keyed by `tool_use_id`), which
 * `foldToolResultBlocks` populates from BOTH `tool_result` blocks on `user`
 * frames (the client round-trip) and result blocks riding inline on a later
 * `assistant` frame (server-executed tools — `server_tool_use`/
 * `mcp_tool_use`/… never get a `user` reply). D2/C4 subagent nesting
 * (`decisions/AGENT-CHROME.md`) is a separate read-time transform,
 * `selectNestedTranscriptRows` — rows with a non-null `parentToolUseId`
 * never interleave at top level.
 *
 * P4-36 hidden tier: rows the engine keeps out of the default transcript
 * (`isSynthetic`) are STORED like any other row and filtered per read, so the
 * reveal control has real rows to show and revealing one restores it to its
 * arrival position. Same discipline as tool status: the tier lives in
 * `hiddenFrameIds`, never as a second copy of the transcript.
 */

import type { SDKMessage } from '@cat-code/engine/session-events'
import {
  HISTORY_REPLAY_TRUNCATION_REQUEST_ID,
  REPLAY_BUFFER_TRUNCATION_REQUEST_ID,
  type ServerFrame,
  type SessionId,
} from '../../shared/protocol.js'
import { isAppReadyFrame } from './connectionState.js'

type FrameRowSource = {
  /** Stable React/projector identity derived only from producer identifiers. */
  id: string
  sessionId: SessionId
  /** SDK frame UUID supplied by the producer. */
  frameId: string
  /**
   * P4-36 hidden tier. READ-TIME ONLY: `selectTranscriptRows` attaches this
   * when the caller asked for the revealed view, exactly the way tool-card
   * status is joined in (never stored, never mutated onto a row in `rows`).
   * Absent on every stored row AND on every row of the default view, so a
   * consumer that ignores it renders the transcript it always rendered.
   */
  isHidden?: true
}

type RowSource = FrameRowSource & {
  /** Shared API message id; falls back to the assistant frame UUID. */
  messageId: string
  /** Content-block index within the shared API message. */
  blockIndex: number
  /**
   * Subagent linkage. Non-null when the engine re-emits a child agent/skill
   * frame under its Task tool_use (`src/utils/queryHelpers.ts` progress path
   * sets `parent_tool_use_id`); top-level frames carry null. Preserved so
   * P2-2/D2 can group or hide subagent rows instead of silently interleaving
   * them with the main transcript. NB: only full frames arrive for subagents —
   * their stream deltas are dropped engine-side (S1 spec §1).
   */
  parentToolUseId: string | null
  /**
   * Engine-minted subagent identity carried by this nested transcript frame.
   * It is absent for ordinary main-session frames and is never read from the
   * live task snapshot. Restore replays it too: the sidecar reads each
   * subagent's own sidechain transcript and stamps the branch with its meta
   * sidecar's name (`app/sidecar/subagentHistory.ts`).
   */
  agentName?: string
  /**
   * The model that produced this frame (`SDKAssistantMessage.message.model`).
   * Carried for the same reason `agentName` is: a subagent's nested frames are
   * the only transcript-plane statement of what a RUNNING worker is running on,
   * and its own result does not exist yet. Absent on frames the engine sent
   * without one, and on every non-assistant row.
   */
  model?: string
}

export type AssistantTextRow = RowSource & {
  kind: 'assistant-text'
  role: 'assistant'
  content: string
  isStreaming?: true
}

/**
 * P2-2 tool-card family. `toolFamily` is a display-grouping derived from the
 * real `tool_use.name` (`src/tools/*Tool` directory names) — never invented
 * chrome, just a lookup over names the engine actually sends (see
 * `deriveToolFamily`). `status`/`result` are NEVER stored on this row: they
 * are attached at read time by `selectTranscriptRows` from the session's
 * `toolResultsByUseId` correlation map, keyed by `toolUseId` (S1/INVENTORY:
 * "status is not stored"). A row with no map entry yet renders `pending`.
 */
export type ToolUseRow = RowSource & {
  kind: 'tool-use'
  toolUseId: string
  toolName: string
  toolFamily: ToolFamily
  input: Record<string, unknown>
  status: ToolCardStatus
  result: ToolResultProjection | null
  /**
   * A RESUMED agent's finish, joined in at read time from
   * `agentCompletionsByToolUseId`. The ResumeAgent invocation is the resumed
   * worker's independent second card, so its later task-notification supplies
   * that card's result. Null for an original background launch: its card is a
   * past-tense launch record and its completion remains a later transcript row.
   */
  agentCompletion: AgentCompletionProjection | null
}

/**
 * The display-facing half of a task-notification, taken from STRUCTURED wire
 * fields (`SDKUserMessage.origin`) rather than parsed back out of the engine's
 * model-facing banner. `taskId`/`outputFile` are absent by construction: they
 * are not on the wire, so no display can leak them (bug, 2026-08-01).
 */
export type AgentCompletionProjection = {
  /** `completed` | `failed` | `killed` | …; null when the engine sent none. */
  status: string | null
  /** One-line outcome, e.g. `Agent @Ada completed`. */
  summary: string | null
  /** The agent's final message. Null when it finished with no output. */
  result: string | null
  usage: { totalTokens: number; toolUses: number; durationMs: number } | null
}

export type ToolFamily =
  | 'bash'
  | 'read'
  | 'write'
  | 'edit'
  | 'grep'
  | 'web'
  | 'mcp'
  | 'notebook'
  | 'lsp'
  | 'skill'
  | 'agent'
  /**
   * Tools that act on an agent that ALREADY exists as opposed to spawning one.
   * ResumeAgent is the exception: it is projected as `agent`
   * because the resumed run owns a second independent agent card. SendMessage
   * remains an agent-control acknowledgement.
   */
  | 'agent-control'
  | 'imagegen'
  | 'other'

export type ToolCardStatus = 'pending' | 'success' | 'error' | 'cancelled'

/**
 * One correlated `tool_result` content block (rides a `user` SDKMessage,
 * `queryHelpers.ts:203-218`). `diff` is populated when the block's companion
 * `tool_use_result` carries a recognized `structuredPatch: StructuredPatchHunk[]`
 * (`diff` npm package hunk shape) — either FileEditTool's top-level
 * `filePath`+`structuredPatch` (`FileEditTool/types.ts:71-73`) or FilePatchTool /
 * `Apply_patch`'s `files[]` envelope (`FilePatchTool/types.ts:138-172`). Narrowed
 * at runtime, never cast; anything else (Bash stdout, Read contents, …) surfaces
 * as plain `content` text with `diff: null`. Malformed/foreign shapes degrade to
 * `diff: null`, never crash.
 */
export type ToolResultProjection = {
  isError: boolean
  /** Engine-minted cancellation status, never inferred from tool output text. */
  isCancelled?: true
  content: string
  diff: ToolDiffProjection | null
  generatedImage?: {
    filePath: string
    model: string
    size: string
    outputFormat: 'png' | 'jpeg' | 'webp'
    bytes: number
    revisedPrompt?: string
    preview?: {
      mediaType: 'image/jpeg' | 'image/png' | 'image/webp'
      data: string
    }
  }
  /**
   * The Agent tool's own worker name, from the SAME structured `tool_use_result`
   * `diff` is narrowed out of (`AgentToolResult.agentName`,
   * `src/tools/AgentTool/agentToolUtils.ts:727`). Transcript plane: it is this
   * row's own result frame, so it replays from history like every other field
   * here, and no session-plane read is involved (`decisions/AGENT-CHROME.md` §4).
   *
   * OPTIONAL rather than nullable, unlike `diff`: any tool can produce a diff,
   * but only the Agent tool ever produces a name, so absence is the ordinary
   * case and every other family would otherwise have to declare it null.
   * Extracted from ANY tool result that carries a string `agentName`, not
   * gated to the Agent family — only the Agent card reads it, and gating would
   * mean teaching this narrowing about tool families it otherwise ignores.
   *
   * Absent while an agent is still RUNNING: the RESULT reaches the transcript
   * only at completion. A running worker is named from the `agent_name` its
   * nested frames carry instead (see `projectAssistantFrame`).
   */
  agentName?: string
  /**
   * Stable identity from the Agent tool's structured result
   * (`AgentToolResult.agentId`). ResumeAgent input carries the same value, so
   * the renderer can give the resumed run the original worker identity without
   * changing the wire contract or mutating the original card.
   */
  agentId?: string
  /**
   * The model the subagent actually ran on, from that same structured result
   * (`AgentToolResult.model`, `agentToolUtils.ts:734`). Transcript plane like
   * everything else here, so it replays from history; absent on results written
   * before the engine started recording it, and absent while the worker is still
   * running (a running worker is modelled from the `model` its nested assistant
   * frames carry instead — see `RowSource.model`).
   */
  agentModel?: string
  /**
   * The Codex account the subagent leased, from that same structured result
   * (`AgentToolResult.account`). Transcript plane, and it HAS to be: the lease
   * plane is per-process and `releaseCodexLease` deletes a worker's entry at its
   * terminal, so a live join answers null for every finished worker and for
   * every restored transcript. Absent for an Anthropic-path worker (no lease
   * exists), and on results persisted before the engine recorded it.
   *
   * For a BACKGROUND worker this is the account leased at dispatch: the launch
   * record's result is its acknowledgment, and a lease that later moves
   * (failover, repair, follow-main reassignment) cannot amend a row that has
   * already been written. A foreground worker's is read at its terminal and so
   * reflects any move.
   */
  agentAccount?: { accountId: string; accountAlias: string | null }
  /**
   * The finished Agent tool's own totals, from that same structured result
   * (`totalTokens` / `totalToolUseCount`, `agentToolUtils.ts:734-735`).
   *
   * This is the only usage a foreground worker reports. A resumed run gets its
   * own totals from its later task-notification completion instead. Counting
   * nested rows works live but not after a restore that landed outside the
   * replayed window, and never yields tokens at all.
   *
   * All-or-nothing, matching `AgentCompletionProjection['usage']`: a partial
   * object would render a stat line with holes in it.
   */
  agentUsage?: { totalTokens: number; toolUses: number }
  /**
   * Structured TaskOutput retrieval for a local agent. The display consumes the
   * clean `task.result` when present, falling back to `task.output`; it never
   * parses the model-facing XML/text payload.
   */
  taskOutput?: {
    taskId: string
    description: string
    output: string
  }
}

/**
 * `MultiDiffCard` (prototype) is not a distinct message type or a distinct
 * tool — `FileEditTool`'s own multi-edit input (`edits: EditInput[]`) can
 * still only ever produce ONE `structuredPatch` for the ONE file it edited
 * (`FileEditTool/types.ts` output schema has no per-file array). "Multiple
 * files changed in one turn" is normally multiple separate
 * `tool_use`/`tool_result` pairs, each its own single-file `ToolDiffProjection`.
 * The one result that CAN span many files is `Apply_patch`
 * (`FilePatchTool/types.ts` output `files[]`); this single-file projection names
 * ONE path, so `extractDiffProjection` projects that patch's PRIMARY file (the
 * rest still appear in the result `content`). `hunks.length > 1` models multiple
 * hunks returned for the ONE projected file (structuredPatch is already an array
 * of hunks); DiffView renders one hunk, MultiDiffCard switches between hunks the
 * same way the prototype's FileEditCard switches between files — same component,
 * adapted to the real one-file-many-hunks shape.
 */
export type ToolDiffProjection = {
  filePath: string
  hunks: ToolDiffHunk[]
}

export type ToolDiffHunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export type ThinkingRow = RowSource & {
  kind: 'thinking'
  content: string
  signature?: string
  reasoningKind?: string
  isStreaming?: true
}

export type RedactedThinkingRow = RowSource & {
  kind: 'redacted-thinking'
  data: string
}

export type UserTextRow = RowSource & {
  kind: 'user-text'
  role: 'user'
  content: string
  timestamp?: string
  isReplay: boolean
}

export type CommandEchoRow = RowSource & {
  kind: 'command-echo'
  commandName: string
  args: string | null
  content: string
  skillFormat: boolean
  timestamp?: string
  isReplay: boolean
}

export type UserImageSource =
  | { type: 'base64'; mediaType: string; data: string }
  | { type: 'url'; url: string }

export type UserImageRow = RowSource & {
  kind: 'user-image'
  source: UserImageSource
  timestamp?: string
  isReplay: boolean
}

/**
 * A task/agent-completion banner. The engine injects these as a USER-role turn
 * (`src/utils/taskNotification.ts` `formatTaskNotificationText`, enqueued by
 * `src/utils/messageQueueManager.ts` with a `task-notification` origin), so
 * without a provenance signal the projector would render the banner as a
 * right-aligned USER bubble, as if the operator had typed it (bug, 2026-07-21).
 *
 * Authoritative source is now `SDKUserMessage.origin` (protocol.ts `EventFrame`
 * §User-turn provenance) — `status` comes from `origin.status` rather than a
 * regex over the banner. The text check that remains is the LEGACY
 * `<task-notification>` XML envelope, which real stored transcripts written
 * before the origin field still carry; it is a frozen historical artifact, not a
 * mirror of live engine logic, so it cannot drift when the engine rewords.
 * Block-level (a `RowSource`) because it rides a single `user` content block.
 */
export type TaskNotificationRow = RowSource & {
  kind: 'task-notification'
  /** `origin.status` (completed|failed|killed|…), else the legacy `<status>` tag. */
  status: string | null
  /**
   * One-line outcome ONLY (`Agent @Ada completed`). The banner text this row
   * rides is model-facing — it carries the task id, the output-file path and
   * the tool-use id — and printing it verbatim put all three on the operator's
   * screen (bug, 2026-08-01; the row's own doc used to call that "preserved
   * verbatim so nothing is lost"). The terminal has never shown more than this
   * line either: `UserAgentNotificationMessage.tsx:46` renders `● {summary}`
   * and returns null without one.
   */
  summary: string | null
  /**
   * The related `tool_use` id, when the engine sent one. Ordinary background
   * launches keep this row visible in arrival order. A ResumeAgent completion
   * uses the id to populate that resumed run's independent card.
   */
  toolUseId: string | null
  timestamp?: string
  isReplay: boolean
}

/**
 * The other four engine-injected `role:'user'` turns (`MessageOrigin`,
 * `src/types/message.ts:10`): `coordinator`, `channel`, `teammate`, and
 * `deferred-continuation`. All four reach the app as ordinary user frames — the
 * live path is the mid-turn queue drain (`src/QueryEngine.ts` `queued_command`
 * yield), plus restored history (`toSDKMessages`) for a session the TUI wrote —
 * and every one of them used to render as the operator's own bubble.
 *
 * One row kind rather than four: the fix they need is identical (attribute the
 * turn to its real author, on the system side), and the per-kind difference is
 * only the label/glyph, which `injectedKind` carries. `label` is the sender when
 * the origin names one (channel server, teammate handle) and null otherwise.
 * `injectedKind` is a plain `string`, NOT the closed union: a newer engine may
 * send a kind this build has never heard of, and display degrades gracefully
 * rather than dropping the row (TranscriptView renders an unknown kind with a
 * neutral "Injected message" label).
 */
export type InjectedTurnRow = RowSource & {
  kind: 'injected-turn'
  /** The wire `origin.kind` verbatim; unknown values render a neutral fallback. */
  injectedKind: string
  /** Sender handle when the origin names one (`channel.server`, `teammate.from`). */
  label: string | null
  /** The turn's text, rendered system-side — never as a user bubble. */
  content: string
  timestamp?: string
  isReplay: boolean
}

export type SystemNoticeRow = FrameRowSource & {
  kind: 'system-notice'
  noticeType:
    | 'api_retry'
    | 'local_command_output'
    | 'account_diagnostic'
    | 'provider_error'
  content: string
}

/** Durable user-interruption provenance, rendered without its hidden body. */
export type TurnStoppedRow = FrameRowSource & {
  kind: 'turn-stopped'
}

export type ResultRow = FrameRowSource & {
  kind: 'result'
  subtype: string
  isError: boolean
  result?: string
  errors: string[]
  durationMs?: number
  totalCostUsd?: number
}

export type CompactBoundaryRow = FrameRowSource & {
  kind: 'compact-boundary'
  trigger: 'manual' | 'auto'
  preTokens: number
}

/** Typed degraded rows: the current SDK seam never emits these discriminants. */
export type SnipBoundaryRow = FrameRowSource & { kind: 'snip-boundary' }
export type TombstoneRow = FrameRowSource & { kind: 'tombstone' }

export type TranscriptRow =
  | AssistantTextRow
  | ToolUseRow
  | ThinkingRow
  | RedactedThinkingRow
  | UserTextRow
  | CommandEchoRow
  | UserImageRow
  | TaskNotificationRow
  | InjectedTurnRow
  | SystemNoticeRow
  | TurnStoppedRow
  | ResultRow
  | CompactBoundaryRow
  | SnipBoundaryRow
  | TombstoneRow

type StreamingTextBlock = {
  messageId: string
  blockIndex: number
  content: string
}

type StreamingThinkingBlock = {
  messageId: string
  blockIndex: number
  content: string
  reasoningKind?: string
}

type TranscriptSessionState = {
  rows: TranscriptRow[]
  currentStreamMessageId: string | null
  currentStreamBlockIndex: number | null
  streamingTextBlocks: Record<string, StreamingTextBlock>
  streamingThinkingBlocks: Record<string, StreamingThinkingBlock>
  nextBlockIndexByMessageId: Record<string, number>
  seenFrameIds: Record<string, true>
  /**
   * P2-2 correlation map: `tool_use_id` → the correlated `tool_result`, once
   * its `user` frame arrives. Absence means pending/running. This is the ONLY
   * place tool status lives — never written onto a `ToolUseRow` in `rows`.
   */
  toolResultsByUseId: Record<string, ToolResultProjection>
  generatedImagePreviewsByUseId: Record<
    string,
    { mediaType: 'image/jpeg' | 'image/png' | 'image/webp'; data: string }
  >
  /** Completion facts keyed by the engine-minted tool-use id. */
  agentCompletionsByToolUseId: Record<string, AgentCompletionProjection>
  /**
   * P3-7 slash catalog: the user-invocable command names carried by the
   * `system/init` frame's `slash_commands` field (engine-side, built from the
   * session's real command list — `systemInit.ts:69`, already filtered to
   * `userInvocable !== false`). Session metadata, NOT a transcript row, so it
   * lives beside `toolResultsByUseId` and is read via `selectSlashCommands`.
   * Re-emitted on every turn's init frame, so it stays fresh; `[]` until the
   * first init frame arrives (or if the sidecar's catalog degraded to empty).
   */
  slashCommands: string[]
  /**
   * P4-36 hidden tier: frame ids whose rows the engine hides from the default
   * transcript (`isSynthetic` = `isMeta || isVisibleInTranscriptOnly`,
   * `src/utils/messages/mappers.ts:203`). Their rows are stored in `rows` in
   * arrival order like any other row, so revealing them puts each one back in
   * its real place instead of appending a second, re-ordered copy. Membership
   * is the only thing recorded here; whether it is SHOWN is decided per read
   * (`selectTranscriptRows(state, id, revealHidden)`), mirroring the engine's
   * own `shouldShowUserMessage(message, isTranscriptMode)`
   * (`src/utils/messages.ts:4823`). A frame lands here only when it actually
   * appended rows, so a non-empty map means the reveal control has something
   * to show.
   */
  hiddenFrameIds: Record<string, true>
  /**
   * This pane's history is INCOMPLETE: a retention boundary frame arrived, so
   * the rows below it are a tail rather than the whole session.
   *
   * Both producers mint the same idiom, one `kind:'error'` frame emitted before
   * the retained tail: main's frame ring on the reload path
   * (`REPLAY_BUFFER_TRUNCATION_REQUEST_ID`) and the sidecar's history replay on
   * the resume path (`HISTORY_REPLAY_TRUNCATION_REQUEST_ID`). Recorded as one
   * flag because the reader's question is the same either way, and because a
   * pane can legitimately carry both.
   *
   * A FLAG, not a row: rows are never rewritten after the fact, and there is no
   * frame the boundary could be appended after (it arrives BEFORE the rows it
   * describes). `selectNestedTranscriptRows` synthesizes the row at read time,
   * the same way the orphaned-agent placeholder is synthesized.
   */
  historyTruncated: boolean
  /**
   * Head-insertion cursor for the recovery batch currently arriving, or `null`
   * when nothing is being recovered — which is every ordinary frame's case and
   * the state a session is created in (B1,
   * decisions/HISTORY-LOAD-EARLIER.md).
   *
   * `appendFrameRows` reads THIS, not the frame, so the value must never be
   * left standing for a frame that is not recovered. `projectServerFrame`
   * therefore re-derives it from every event frame it projects: a frame
   * without `recovered` forces it back to `null`. That is what makes an
   * interrupted batch (the closing `history.loadEarlier.result` never arrives
   * because the connection dropped) harmless — the next ordinary frame closes
   * it, and it cannot corrupt a later batch.
   *
   * It counts UP through a batch because recovered frames arrive oldest-first:
   * inserting each at 0 would reverse them. It resets on the result frame, so
   * the next recovery — which reaches further back — stacks above this one.
   */
  recoveryInsertAt: number | null
  /**
   * A compaction is running in this session right now.
   *
   * The engine pushes `system/subtype:'status'` with `status:'compacting'` when
   * it starts and `null` when it finishes (`src/services/compact/compact.ts`),
   * re-emitting the live value every 30s as a transport keep-alive. A FLAG, not
   * a row: the only durable record of a compaction is the `compact_boundary`
   * frame that lands at the end, and rows are never rewritten after the fact.
   *
   * Cleared defensively by the boundary and by `result` as well as by an
   * explicit null, because an aborted turn can end without the engine reaching
   * the `finally` that clears it — a stuck flag would pin the activity verb to
   * "Compacting" for the rest of the session.
   */
  compacting: boolean
}

export type TranscriptState = {
  sessions: Record<SessionId, TranscriptSessionState>
}

function createTranscriptSessionState(): TranscriptSessionState {
  return {
    rows: [],
    currentStreamMessageId: null,
    currentStreamBlockIndex: null,
    streamingTextBlocks: {},
    streamingThinkingBlocks: {},
    nextBlockIndexByMessageId: {},
    seenFrameIds: {},
    toolResultsByUseId: {},
    generatedImagePreviewsByUseId: {},
    agentCompletionsByToolUseId: {},
    slashCommands: [],
    hiddenFrameIds: {},
    historyTruncated: false,
    recoveryInsertAt: null,
    compacting: false,
  }
}

export function createTranscriptState(): TranscriptState {
  return { sessions: {} }
}

/**
 * Empty one session's rows while keeping the session KNOWN to the projector.
 *
 * `projectServerFrame` creates session state from `ready` alone and drops any
 * `event` frame for a session it does not know, so forgetting a session mid-
 * stream is unrecoverable: nothing after it projects until another `ready`
 * arrives, and a resumed sidecar sends exactly one. The preview→live handover
 * needs the rows gone, not the session gone (2026-08-05: a handover landing in
 * a batch with no `ready` stranded a restored session, discarding its replayed
 * history AND every later live turn).
 */
export function resetTranscriptSession(
  state: TranscriptState,
  sessionId: SessionId,
): TranscriptState {
  if (!state.sessions[sessionId]) return state
  return {
    ...state,
    sessions: {
      ...state.sessions,
      [sessionId]: createTranscriptSessionState(),
    },
  }
}

export function removeTranscriptSession(
  state: TranscriptState,
  sessionId: SessionId,
): TranscriptState {
  if (!state.sessions[sessionId]) return state
  const sessions = { ...state.sessions }
  delete sessions[sessionId]
  return { ...state, sessions }
}

/**
 * Rows are stored as pure producer facts; tool status/result are joined in
 * HERE from the correlation map on every read, never mutated onto a stored
 * row. A `tool-use` row with no matching entry yet reads as `pending`.
 *
 * P4-36: the hidden tier is the SECOND read-time join. `revealHidden` is the
 * projector's `isTranscriptMode` (`shouldShowUserMessage`,
 * `src/utils/messages.ts:4823`): false drops the hidden rows, true keeps them
 * in place carrying `isHidden` so the view can dim them. A session with no
 * hidden frames skips both branches, so the overwhelmingly common transcript
 * pays nothing for the feature.
 */
export function selectTranscriptRows(
  state: TranscriptState,
  sessionId: SessionId | null,
  revealHidden = false,
): TranscriptRow[] {
  if (!sessionId) return []
  const session = state.sessions[sessionId]
  if (!session) return []
  const completions = session.agentCompletionsByToolUseId
  // P4-36 runs FIRST: the hidden tier decides which rows exist in this view.
  const hidden = session.hiddenFrameIds
  const visible =
    Object.keys(hidden).length === 0
      ? session.rows
      : revealHidden
        ? session.rows.map(row => (hidden[row.frameId] ? markHidden(row) : row))
        : session.rows.filter(row => !hidden[row.frameId])
  const resumedToolUseIds = new Set<string>()
  const agentIdentityById = new Map<
    string,
    { agentName?: string; agentUsage?: { totalTokens: number; toolUses: number } }
  >()
  for (const row of visible) {
    if (row.kind !== 'tool-use') continue
    if (row.toolName === 'ResumeAgent') resumedToolUseIds.add(row.toolUseId)
    const result = session.toolResultsByUseId[row.toolUseId]
    if (result?.agentId) {
      agentIdentityById.set(result.agentId, {
        ...(result.agentName === undefined ? {} : { agentName: result.agentName }),
        ...(result.agentUsage === undefined ? {} : { agentUsage: result.agentUsage }),
      })
    }
  }
  const projected = visible.flatMap((row): TranscriptRow[] => {
    if (row.kind === 'task-notification') {
      // A resumed run owns an independent card, including its result. Ordinary
      // background launches remain immutable launch records and their finish
      // stays here in arrival order.
      const merged = row.toolUseId !== null && resumedToolUseIds.has(row.toolUseId)
      return merged ? [] : [row]
    }
    if (row.kind !== 'tool-use') return [row]
    const storedResult = session.toolResultsByUseId[row.toolUseId] ?? null
    const resumedAgentId =
      row.toolName === 'ResumeAgent' && typeof row.input.agentId === 'string'
        ? row.input.agentId
        : null
    const resumedIdentity =
      resumedAgentId === null ? undefined : agentIdentityById.get(resumedAgentId)
    const result: ToolResultProjection | null =
      storedResult === null ||
      resumedIdentity === undefined ||
      resumedAgentId === null
        ? storedResult
        : {
            ...storedResult,
            ...resumedIdentity,
            agentId: resumedAgentId,
          }
    const status: ToolCardStatus = result
      ? result.isCancelled === true
        ? 'cancelled'
        : result.isError
          ? 'error'
          : 'success'
      : 'pending'
    const agentCompletion = resumedToolUseIds.has(row.toolUseId)
      ? (completions[row.toolUseId] ?? null)
      : null
    if (
      row.status === status &&
      row.result === result &&
      row.agentCompletion === agentCompletion
    ) {
      return [row]
    }
    return [{ ...row, status, result, agentCompletion }]
  })
  return projected
}

/** The read-time hidden-tier mark. Returns a COPY; the stored row is untouched. */
function markHidden(row: TranscriptRow): TranscriptRow {
  return { ...row, isHidden: true }
}

/**
 * P4-36 — does this session hold any hidden-tier rows? The reveal control only
 * exists when the answer is yes (`Chat.jsx:1200`
 * `messages.some(m => m.meta)`), so an ordinary session never grows a toggle
 * for an empty tier. Reads the membership map, not the rows, so it stays O(1)
 * in transcript length.
 */
export function selectHasHiddenRows(
  state: TranscriptState,
  sessionId: SessionId | null,
): boolean {
  const session = sessionId ? state.sessions[sessionId] : undefined
  if (!session) return false
  return Object.keys(session.hiddenFrameIds).length > 0
}

/**
 * P3-7 SlashCommandPicker source: the active session's user-invocable command
 * names, captured from the `system/init` frame's `slash_commands` field. `[]`
 * before the first init frame or when the sidecar's catalog degraded to empty.
 * Read-only projection — the picker only ever inserts `/name` text into the
 * composer; command parsing/execution stays engine-side (T2/§2 posture).
 */
export function selectSlashCommands(
  state: TranscriptState,
  sessionId: SessionId | null,
): string[] {
  const session = sessionId ? state.sessions[sessionId] : undefined
  return session?.slashCommands ?? []
}

/** Whether a compaction is running in this session (see `compacting`). */
export function selectIsCompacting(
  state: TranscriptState,
  sessionId: SessionId | null,
): boolean {
  const session = sessionId ? state.sessions[sessionId] : undefined
  return session?.compacting ?? false
}

/**
 * D2/C4: subagent frames (`parentToolUseId` non-null) must NEST under the
 * owning Agent tool card, never interleave at the transcript top level. This
 * arranges the flat, arrival-ordered `selectTranscriptRows` output into a
 * tree: top-level rows in arrival order, each carrying the child rows whose
 * `parentToolUseId` matches its own `toolUseId`. A child row whose parent is
 * absent from that set is neither dropped nor promoted: it
 * is gathered under a synthetic `OrphanedAgentRow`, so subagent traffic still
 * reads as subagent traffic when its card is gone.
 */
export type NestedTranscriptRow =
  /**
   * `stepsNotLoaded` sits on THIS arm alone, not on the whole union. Only an
   * agent tool-use row can ever carry it (`hasUnloadedSteps`), and declaring it
   * union-wide let prose rows, the boundary row and the orphan placeholder be
   * asked a question none of them can answer.
   */
  | (ToolUseRow & {
      children: NestedTranscriptRow[]
      /**
       * This Agent card's own steps are MISSING, not absent: the agent ran and
       * answered, and the transcript this pane holds is known to be incomplete.
       *
       * The mirror image of `OrphanedAgentRow`. That one is a surviving branch
       * whose card was dropped; this one is a surviving card whose branch was
       * dropped — a restored pane loads subagent branches only into whatever
       * room the main transcript left, so a long session comes back with its
       * Agent cards intact and empty (`app/sidecar/subagentHistory.ts`
       * `withRestoredSubagentHistory`;
       * `docs/migration/reviews/2026-08-19-transcript-message-visibility-ux-review.md`
       * finding 5). Nothing on the wire says so, and the card is otherwise
       * indistinguishable from an agent that ran and produced nothing.
       *
       * DERIVED at read time from `TranscriptSessionState.historyTruncated` plus
       * the session's own rows, like the boundary and orphan placeholders:
       * nothing is stored and no stored row is rewritten. Absent unless it is
       * true, so every card in a whole transcript keeps exactly the shape it had.
       */
      stepsNotLoaded?: true
    })
  | (Exclude<TranscriptRow, { kind: 'tool-use' }> & {
      children: NestedTranscriptRow[]
    })
  | (OrphanedAgentRow & { children: NestedTranscriptRow[] })
  | (HistoryBoundaryRow & { children: NestedTranscriptRow[] })

/**
 * The top of an INCOMPLETE transcript: everything before it is not loaded.
 *
 * One row, in the transcript itself, above the oldest surviving message — so
 * reaching it IS reaching the top of what this pane holds, and its ABSENCE is
 * the signal that a transcript is whole. It replaces three surfaces that each
 * told a different story: a red error line the reader could not dismiss, a
 * preview-only banner that withdrew itself the moment the pane went live, and
 * on the reload path nothing at all
 * (`docs/migration/reviews/2026-08-19-transcript-message-visibility-ux-review.md`
 * findings 1, 4 and 6).
 *
 * It carries no count. The number that survives is set by a byte budget and
 * differs per session and per path (`docs/reports/2026-08-19-transcript-retention-cap-measurement.md`
 * §5), and the one number this row could reach honestly on every path is no
 * number, so it states the fact and stops.
 *
 * Synthesized at READ TIME from `TranscriptSessionState.historyTruncated`, like
 * the orphaned-agent placeholder: nothing is stored and no stored row is
 * rewritten. Deliberately NOT a member of `TranscriptRow` — no frame mints one.
 */
export type HistoryBoundaryRow = FrameRowSource & {
  kind: 'history-boundary'
}

/**
 * A subagent's rows whose owning Agent card is NOT in the transcript, gathered
 * under one read-time placeholder that holds the position the card would have
 * held.
 *
 * TRUNCATION is why this exists. Both retention paths drop OLDEST first (the
 * main-process replay ring evicts oldest, `app/main/replayBuffer.ts`; a resume
 * replays a newest-first tail, `app/sidecar/sidecarServer.ts`) and an Agent
 * `tool_use` is always older than the children it spawned, so a boundary that
 * lands inside an agent run keeps the children and drops their parent. Those
 * children used to fall through to the TOP level, where the top-level renderers
 * ignore `agentName` and draw by kind alone: a subagent's own task prompt
 * became a `UserBubble` and its prose became the main assistant's reply
 * (`docs/migration/reviews/2026-08-19-transcript-message-visibility-ux-review.md`
 * §4, probe-confirmed). The transcript stated that the user and the assistant
 * said things neither of them said, which is worse than any placement problem
 * it was avoiding.
 *
 * Synthesized at READ TIME only, like the hidden-tier mark and the
 * interrupted-turn notice: nothing is stored and no stored row is rewritten.
 * Deliberately NOT a member of `TranscriptRow` — no frame can ever mint one,
 * and the stored vocabulary stays exactly what the seam produces.
 */
export type OrphanedAgentRow = FrameRowSource & {
  kind: 'orphaned-agent'
  /** The `tool_use` id these rows named as their parent, which is not present. */
  missingToolUseId: string
  /** Engine-minted worker identity, when the orphaned frames carried one. */
  agentName?: string
}

// Perf (2026-07-08, F3): the nested-row tree is a pure function of ONE session
// slice, and `projectServerFrame` replaces that slice object only when its rows
// actually change (`if (projected === session) return state`). So caching the
// result on the slice reference makes repeated reads (unrelated App re-renders —
// keystrokes, another session's frame) return an IDENTICAL array, which lets the
// `React.memo`'d TranscriptView/rows skip re-rendering. A new slice (real change)
// misses the cache and recomputes. WeakMap ⇒ evicts with the slice, no leak.
const nestedRowsCache = new WeakMap<TranscriptSessionState, NestedTranscriptRow[]>()
// P4-36: the revealed view is a DIFFERENT pure function of the same slice, so it
// needs its own cache line rather than a composite key — otherwise flipping the
// reveal control would serve the other view's array (and a shared key object
// would allocate on every read). Only ever populated for a session that has a
// hidden tier and a viewer who asked to see it.
const revealedNestedRowsCache = new WeakMap<
  TranscriptSessionState,
  NestedTranscriptRow[]
>()
const EMPTY_NESTED_ROWS: NestedTranscriptRow[] = []

/** One top-level placeholder to build: which parent is missing, and where. */
type OrphanSlot = {
  missingToolUseId: string
  /** Ordering anchor and cache key: the first surviving child of that parent. */
  firstRow: TranscriptRow
}

// A session slice changes for every streamed delta, but `selectTranscriptRows`
// preserves the source object for rows that did not change. Retain the nested
// wrapper for those rows too, provided their SUBTREE is identical.
// Weak keys keep this cross-slice cache bounded by the projector's row lifetime.
const nestedRowBySource = new WeakMap<TranscriptRow, NestedTranscriptRow>()
// Same discipline for the synthetic orphan placeholder, keyed on the FIRST row
// it gathers: it has no source row of its own, and rebuilding it on every slice
// would re-render a card holding a whole subagent run on every streamed delta.
const orphanedAgentRowByFirstRow = new WeakMap<TranscriptRow, NestedTranscriptRow>()
// The boundary row is one constant row per session, but it must keep object
// identity across slices or the memoized view re-renders it on every streamed
// delta. Keyed on the OLDEST surviving row, which is the row it sits above and
// the only thing about it that can change.
const historyBoundaryRowByFirstRow = new WeakMap<TranscriptRow, NestedTranscriptRow>()

function sameReferences<T>(left: readonly T[], right: readonly T[]) {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

export function selectNestedTranscriptRows(
  state: TranscriptState,
  sessionId: SessionId | null,
  revealHidden = false,
): NestedTranscriptRow[] {
  const session = sessionId ? state.sessions[sessionId] : undefined
  if (!session) return EMPTY_NESTED_ROWS
  const cache = revealHidden ? revealedNestedRowsCache : nestedRowsCache
  const cached = cache.get(session)
  if (cached) return cached

  const rows = selectTranscriptRows(state, sessionId, revealHidden)
  // Only a pane whose history is known incomplete can hold an Agent card whose
  // branch was left behind, so a whole transcript never walks this and never
  // pays for it. Built from the session's OWN rows, not the filtered view: an
  // agent whose every child is hidden-tier traffic has its steps loaded, and
  // reading the filtered list here would call that card empty in the default
  // view and full in the revealed one.
  const parentsWithRows = session.historyTruncated
    ? collectReferencedParentIds(session.rows)
    : null
  const byToolUseId = new Map<string, TranscriptRow>()
  for (const row of rows) {
    if (row.kind === 'tool-use') byToolUseId.set(row.toolUseId, row)
  }

  const childrenByParentId = new Map<string, TranscriptRow[]>()
  const orphansByParentId = new Map<string, TranscriptRow[]>()
  // A top-level slot is either a real row or the placeholder standing in for one
  // missing parent, emitted where that parent's FIRST surviving child arrived.
  const topLevel: (TranscriptRow | OrphanSlot)[] = []
  for (const row of rows) {
    const parentId =
      'parentToolUseId' in row ? row.parentToolUseId : null
    if (!parentId) {
      topLevel.push(row)
      continue
    }
    if (byToolUseId.has(parentId)) {
      const siblings = childrenByParentId.get(parentId)
      if (siblings) siblings.push(row)
      else childrenByParentId.set(parentId, [row])
      continue
    }
    const orphans = orphansByParentId.get(parentId)
    if (orphans) orphans.push(row)
    else {
      orphansByParentId.set(parentId, [row])
      topLevel.push({ missingToolUseId: parentId, firstRow: row })
    }
  }

  const attachChildren = (row: TranscriptRow): NestedTranscriptRow => {
    if (parentsWithRows !== null && hasUnloadedSteps(row, parentsWithRows)) {
      return unloadedStepsRow(row)
    }
    const childRows =
      row.kind === 'tool-use' ? (childrenByParentId.get(row.toolUseId) ?? []) : []
    const cached = nestedRowBySource.get(row)
    // LEAF FAST PATH, and the reason the deep check below is affordable: nothing
    // can have changed beneath a row that has no children, so the overwhelming
    // majority of a transcript (every prose, thinking, user and childless tool
    // row) still returns in O(1) and allocates nothing. Only a row that owns
    // children pays to look down.
    if (cached && childRows.length === 0 && cached.children.length === 0) {
      return cached
    }

    const children = childRows.map(attachChildren)
    // Compared on the NESTED children, not the source rows. A grandchild
    // arriving under one of these children (an agent inside an agent) leaves
    // every direct child's SOURCE object identical, because
    // `selectTranscriptRows` preserves unchanged rows — so a source-level
    // comparison kept serving a subtree that was missing the new row until some
    // direct child happened to change for an unrelated reason.
    if (cached && sameReferences(cached.children, children)) return cached

    const nested = { ...row, children }
    nestedRowBySource.set(row, nested)
    return nested
  }

  const attachOrphans = (slot: OrphanSlot): NestedTranscriptRow => {
    const childRows = orphansByParentId.get(slot.missingToolUseId) ?? []
    // No leaf shortcut here: a group always holds at least the row that minted
    // it, and its rows can own children of their own.
    const children = childRows.map(attachChildren)
    const cached = orphanedAgentRowByFirstRow.get(slot.firstRow)
    if (cached && sameReferences(cached.children, children)) return cached

    // Identity is whatever the orphaned frames themselves carry. Nothing else
    // is invented: no status, no result, no usage — the card that held those
    // is precisely what is missing.
    let agentName: string | undefined
    for (const orphan of childRows) {
      if ('agentName' in orphan && orphan.agentName !== undefined) {
        agentName = orphan.agentName
        break
      }
    }
    const frameId = `orphaned-agent:${slot.missingToolUseId}`
    const nested: NestedTranscriptRow = {
      kind: 'orphaned-agent',
      id: frameRowId(slot.firstRow.sessionId, frameId, 'orphaned_agent'),
      sessionId: slot.firstRow.sessionId,
      frameId,
      missingToolUseId: slot.missingToolUseId,
      ...(agentName !== undefined ? { agentName } : {}),
      // P4-36: the wrapper is a fresh object, so it inherits nothing. A group
      // that is ENTIRELY hidden traffic must still read dimmed in the revealed
      // view, or the reveal control shows engine bookkeeping at full strength.
      // (Only reachable there: the default view filters hidden rows out before
      // nesting, so an all-hidden group never forms in it.)
      ...(childRows.every(child => child.isHidden === true)
        ? { isHidden: true as const }
        : {}),
      children,
    }
    orphanedAgentRowByFirstRow.set(slot.firstRow, nested)
    return nested
  }

  const result = topLevel.map(entry =>
    'missingToolUseId' in entry ? attachOrphans(entry) : attachChildren(entry),
  )
  // Above the oldest surviving row, so reaching it is reaching the top. Gated on
  // there BEING one: a pane with no rows draws the welcome/restore state, and a
  // lone hairline over an empty pane would replace it with a claim about
  // messages that are not on screen to be missing from.
  const oldestRow = rows[0]
  if (session.historyTruncated && oldestRow !== undefined) {
    result.unshift(historyBoundaryRow(oldestRow))
  }
  cache.set(session, result)
  return result
}

function collectReferencedParentIds(
  rows: readonly TranscriptRow[],
): Set<string> {
  const parents = new Set<string>()
  for (const row of rows) {
    const parentId = 'parentToolUseId' in row ? row.parentToolUseId : null
    if (parentId) parents.add(parentId)
  }
  return parents
}

/**
 * Does this row's agent have steps that were not loaded?
 *
 * Every clause is here to keep the answer from being YES about a healthy card,
 * which would put a lie on a card that is working:
 *
 *  - `toolFamily === 'agent'`, not ResumeAgent, not a background launch — the
 *    same three clauses `isAgentToolUseRow` uses. A background launch's
 *    `tool_result` is only an ack that the worker started and its steps never
 *    join this transcript at all, so it is childless BY DESIGN and would be the
 *    first false positive.
 *  - `status === 'success'` — the agent ran and ANSWERED. A refused, denied or
 *    interrupted agent resolves to an error result with nothing under it, which
 *    is the second false positive; a still-running one is `pending`.
 *  - no row in the session names this `tool_use` as its parent. A live run emits
 *    its prompt as the first child frame before the worker says anything
 *    (`src/tools/AgentTool/AgentTool.tsx:1345-1357`, then every later message at
 *    :1803-1817), so a foreground agent that reached `success` in THIS pane has
 *    at least one row pointing at it and can never reach this line.
 */
function hasUnloadedSteps(
  row: TranscriptRow,
  parentsWithRows: ReadonlySet<string>,
): row is ToolUseRow {
  return (
    row.kind === 'tool-use' &&
    row.toolFamily === 'agent' &&
    row.toolName !== 'ResumeAgent' &&
    row.input.run_in_background !== true &&
    row.status === 'success' &&
    !parentsWithRows.has(row.toolUseId)
  )
}

/**
 * Always a leaf: the row qualifies precisely because nothing points at it.
 *
 * Deliberately NOT written into `nestedRowBySource`. Whether the flag applies is
 * a fact about the SESSION (is its history complete?) rather than about the row,
 * so one source row can legitimately need both shapes over its lifetime, and a
 * shared cache line would hand back the wrong one. It costs nothing to skip:
 * a tool-use row that has resolved is rebuilt on every read anyway, because
 * `selectTranscriptRows` joins its status and result in from the correlation map.
 */
function unloadedStepsRow(row: ToolUseRow): NestedTranscriptRow {
  return { ...row, children: [], stepsNotLoaded: true }
}

const HISTORY_BOUNDARY_FRAME_ID = 'history-boundary'

/**
 * No `isHidden`, in either view: this describes the PANE, not a message, so the
 * reveal control has nothing to dim about it.
 */
function historyBoundaryRow(oldestRow: TranscriptRow): NestedTranscriptRow {
  const cached = historyBoundaryRowByFirstRow.get(oldestRow)
  if (cached) return cached
  const row: NestedTranscriptRow = {
    kind: 'history-boundary',
    id: frameRowId(
      oldestRow.sessionId,
      HISTORY_BOUNDARY_FRAME_ID,
      'history_boundary',
    ),
    sessionId: oldestRow.sessionId,
    frameId: HISTORY_BOUNDARY_FRAME_ID,
    children: [],
  }
  historyBoundaryRowByFirstRow.set(oldestRow, row)
  return row
}

/** A nested tool-use row (the shape an Agent card / DelegateGroup member carries). */
export type NestedToolUseRow = Extract<NestedTranscriptRow, { kind: 'tool-use' }>

/**
 * D2/§3/C3 DelegateGroup: parallel agent tool_use rows launched together render
 * as ONE grouped card, NOT as a new frame or message type. This models the read
 * output as a flat list of display items — either a single top-level row, or a
 * group of ≥2 sibling agent rows the orchestrator co-spawned. Grouping is a pure
 * read-time DERIVATION over already-correlated rows; nothing is stored, no wire
 * vocabulary is added (C3: "grouping stays a projector derivation, not a frame").
 */
export type TranscriptDisplayItem =
  | { kind: 'single'; row: NestedTranscriptRow }
  | {
      kind: 'agent-group'
      /** Stable React/derivation identity: `agent-group:<messageId>:<toolName>`. */
      id: string
      groupKey: string
      members: NestedToolUseRow[]
    }

/**
 * The "launched together" signal that DOES reach the seam. The engine groups
 * tool uses by `${message.id}:${tool_name}` and only when 2+ of a tool that
 * supports grouped rendering appear in the SAME API response
 * (`src/utils/groupToolUses.ts:49-52,76,91`); the ONLY such tool is AgentTool
 * (`src/components/messageActions.tsx:121`: "Only AgentTool has
 * renderGroupedToolUse"). Parallel agents ride ONE assistant message, so they
 * share `message.id` — preserved here as `ToolUseRow.messageId` — even though
 * the streaming producer emits one frame per stopped block. No other seam field
 * expresses "co-spawned", so this is the faithful key, not an invented signal.
 */
function agentDelegateGroupKey(row: NestedToolUseRow): string {
  return `${row.messageId}:${row.toolName}`
}

function isAgentToolUseRow(row: NestedTranscriptRow): row is NestedToolUseRow {
  return (
    row.kind === 'tool-use' &&
    row.toolFamily === 'agent' &&
    row.toolName !== 'ResumeAgent' &&
    row.input.run_in_background !== true
  )
}

const displayItemsCache = new WeakMap<
  readonly NestedTranscriptRow[],
  TranscriptDisplayItem[]
>()

/**
 * DERIVATION over TOP-LEVEL nested rows: coalesces sibling agent tool_use rows
 * that share a delegate group key (2+) into one `agent-group` item, emitting the
 * group at the position of its first member (matching the engine's second pass,
 * `groupToolUses.ts:119-160`). Everything else — including a lone agent row and
 * every non-agent row — passes through as a `single` item. Only top-level rows
 * are considered; subagent CHILD rows already nest under their owning card (C4)
 * and are never grouped as siblings. Pure and slice-stable (cached on the input
 * array reference, which `selectNestedTranscriptRows` keeps stable per slice), so
 * memoized consumers keep identity when nothing changed.
 */
export function groupAgentDelegates(
  rows: readonly NestedTranscriptRow[],
): TranscriptDisplayItem[] {
  const cached = displayItemsCache.get(rows)
  if (cached) return cached

  const membersByKey = new Map<string, NestedToolUseRow[]>()
  for (const row of rows) {
    if (!isAgentToolUseRow(row)) continue
    const key = agentDelegateGroupKey(row)
    const bucket = membersByKey.get(key)
    if (bucket) bucket.push(row)
    else membersByKey.set(key, [row])
  }

  const emitted = new Set<string>()
  const items: TranscriptDisplayItem[] = []
  for (const row of rows) {
    if (isAgentToolUseRow(row)) {
      const key = agentDelegateGroupKey(row)
      const members = membersByKey.get(key)
      if (members && members.length >= 2) {
        if (!emitted.has(key)) {
          emitted.add(key)
          items.push({
            kind: 'agent-group',
            id: `agent-group:${key}`,
            groupKey: key,
            members,
          })
        }
        continue
      }
    }
    items.push({ kind: 'single', row })
  }

  displayItemsCache.set(rows, items)
  return items
}

/**
 * Read-time transcript display list: the C4-nested top-level rows with parallel
 * agents coalesced into DelegateGroups. Session/transcript plane separation
 * holds — this reads ONLY the transcript slice (via `selectNestedTranscriptRows`),
 * never the session-plane agent-mode snapshot (D2 §4 keeps-honest rule).
 */
export function selectTranscriptDisplayItems(
  state: TranscriptState,
  sessionId: SessionId | null,
  revealHidden = false,
): TranscriptDisplayItem[] {
  return groupAgentDelegates(
    selectNestedTranscriptRows(state, sessionId, revealHidden),
  )
}

/**
 * One display item's stable identity: the row's own id, or the group's.
 *
 * Exported because it is no longer only a React key. Scroll anchoring on row
 * IDENTITY rather than row INDEX is what keeps a reading position correct once
 * the projector can INSERT at the head (B5, decisions/HISTORY-LOAD-EARLIER.md),
 * and the anchor and the key must be the same string or the two disagree about
 * which item is which.
 */
export function displayItemKey(item: TranscriptDisplayItem): string {
  return item.kind === 'single' ? item.row.id : item.id
}

/** Reducer over addressed server frames; unknown sessions are rejected. */
export function projectServerFrame(
  state: TranscriptState,
  frame: ServerFrame,
): TranscriptState {
  if (isAppReadyFrame(frame)) {
    const session = createTranscriptSessionState()
    return {
      ...state,
      sessions: {
        ...state.sessions,
        // Ready starts an attach sequence whose history replay replaces retained
        // newer rows after the sidecar's non-transcript snapshots.
        [frame.sessionId]: session,
      },
    }
  }

  if (frame.kind === 'transcript.reset') {
    return resetTranscriptSession(state, frame.sessionId)
  }

  if (frame.kind === 'error') {
    // The only error frames this store reads. Every other one is a live
    // failure the error line owns, and projecting it as transcript would put a
    // transient condition into permanent history.
    if (
      frame.requestId !== REPLAY_BUFFER_TRUNCATION_REQUEST_ID &&
      frame.requestId !== HISTORY_REPLAY_TRUNCATION_REQUEST_ID
    ) {
      return state
    }
    const session = state.sessions[frame.sessionId]
    // Unknown session: same rule as every other frame here. The boundary always
    // follows a `ready` on both producers, and inventing a session from an
    // error frame would resurrect one the pane just removed.
    if (!session) return state
    // Latches. A pane that received a boundary once cannot become complete by
    // receiving more frames; only a reset (the preview-to-live handover) clears
    // it, and the replay that follows re-states it if it is still true.
    if (session.historyTruncated) return state
    return {
      ...state,
      sessions: {
        ...state.sessions,
        [frame.sessionId]: { ...session, historyTruncated: true },
      },
    }
  }

  if (frame.kind === 'generated-image-preview') {
    const session = state.sessions[frame.sessionId]
    if (!session) return state
    const preview = { mediaType: frame.mediaType, data: frame.data }
    const result = session.toolResultsByUseId[frame.toolUseId]
    return {
      ...state,
      sessions: {
        ...state.sessions,
        [frame.sessionId]: {
          ...session,
          generatedImagePreviewsByUseId: {
            ...session.generatedImagePreviewsByUseId,
            [frame.toolUseId]: preview,
          },
          toolResultsByUseId: result?.generatedImage
            ? {
                ...session.toolResultsByUseId,
                [frame.toolUseId]: {
                  ...result,
                  generatedImage: { ...result.generatedImage, preview },
                },
              }
            : session.toolResultsByUseId,
        },
      },
    }
  }

  if (frame.kind === 'history.loadEarlier.result') {
    const session = state.sessions[frame.sessionId]
    if (!session) return state
    // B4: `complete` is the documented signal that the boundary row goes away
    // (protocol.ts), and the row is synthesized from this flag alone. Gated on
    // `ok` too because a refusal learned nothing: leaving the boundary standing
    // is the recoverable direction (press again), removing it is not.
    const complete = frame.ok === true && frame.complete === true
    // B1: this frame closes the batch. The next recovery reaches FURTHER back,
    // so it must start at the head again rather than continue beneath the rows
    // this one inserted.
    if (!complete && session.recoveryInsertAt === null) return state
    return {
      ...state,
      sessions: {
        ...state.sessions,
        [frame.sessionId]: {
          ...session,
          recoveryInsertAt: null,
          historyTruncated: complete ? false : session.historyTruncated,
        },
      },
    }
  }

  if (frame.kind !== 'event') return state
  const session = state.sessions[frame.sessionId]
  if (!session) return state
  if (frame.event.type !== 'message') return state

  // B1: the head-insertion cursor is derived from THIS frame, every time. An
  // ordinary frame always projects with it null and therefore cannot reach the
  // insertion branch in `appendFrameRows`/`upsertFrameRows` — including when it
  // follows a recovery batch whose closing result never arrived because the
  // connection dropped. A recovered frame continues the open batch, or opens
  // one at the head.
  const recoveryInsertAt =
    frame.recovered === true ? (session.recoveryInsertAt ?? 0) : null
  const source =
    recoveryInsertAt === session.recoveryInsertAt
      ? session
      : { ...session, recoveryInsertAt }

  const projected = projectMessage(frame.sessionId, source, frame.event.message)
  // Compared against what was HANDED to `projectMessage`: a frame that
  // projected nothing must stay a total no-op, and the cursor above is
  // re-derived on the next frame anyway.
  if (projected === source) return state
  return {
    ...state,
    sessions: { ...state.sessions, [frame.sessionId]: projected },
  }
}

/**
 * Replay-only projection transaction.
 *
 * `projectServerFrame` remains the authoritative single-frame reducer. This
 * transaction mirrors its ordered behavior in private per-session drafts, then
 * publishes each changed session once at delivery completion.
 */
export function projectServerFrames(
  state: TranscriptState,
  frames: readonly ServerFrame[],
): TranscriptState {
  if (frames.length === 0) return state

  const drafts = new Map<SessionId, BatchSessionDraft>()
  for (const frame of frames) {
    if (isAppReadyFrame(frame)) {
      drafts.set(frame.sessionId, createBatchReadyDraft(frame.sessionId))
      continue
    }
    if (frame.kind === 'transcript.reset') {
      const current = drafts.get(frame.sessionId)?.session ??
        state.sessions[frame.sessionId]
      if (!current) continue
      drafts.set(frame.sessionId, createBatchResetDraft(frame.sessionId, current))
      continue
    }
    const draft = getBatchSessionDraft(drafts, state, frame.sessionId)
    if (!draft) continue
    if (frame.kind === 'error') {
      if (
        (frame.requestId === REPLAY_BUFFER_TRUNCATION_REQUEST_ID ||
          frame.requestId === HISTORY_REPLAY_TRUNCATION_REQUEST_ID) &&
        !draft.session.historyTruncated
      ) {
        draft.session.historyTruncated = true
        draft.changed = true
      }
      continue
    }
    if (frame.kind === 'generated-image-preview') {
      projectBatchImagePreview(draft, frame)
      continue
    }
    if (frame.kind === 'history.loadEarlier.result') {
      const complete = frame.ok === true && frame.complete === true
      if (complete || draft.session.recoveryInsertAt !== null) {
        draft.session.recoveryInsertAt = null
        if (complete) draft.session.historyTruncated = false
        draft.changed = true
      }
      continue
    }
    if (frame.kind !== 'event' || frame.event.type !== 'message') continue

    const previousRecoveryInsertAt = draft.session.recoveryInsertAt
    const recoveryInsertAt =
      frame.recovered === true ? (draft.session.recoveryInsertAt ?? 0) : null
    if (
      projectBatchMessage(
        draft,
        frame.event.message,
        recoveryInsertAt,
      )
    ) {
      if (recoveryInsertAt === null) {
        draft.session.recoveryInsertAt = null
      } else if (draft.session.recoveryInsertAt === previousRecoveryInsertAt) {
        draft.session.recoveryInsertAt = recoveryInsertAt
      }
      draft.changed = true
    }
  }

  const changedDrafts = [...drafts.values()].filter(draft => draft.changed)
  if (changedDrafts.length === 0) return state
  const sessions = { ...state.sessions }
  for (const draft of changedDrafts) sessions[draft.sessionId] = draft.session
  return { ...state, sessions }
}

type BatchSessionDraft = {
  sessionId: SessionId
  session: TranscriptSessionState
  changed: boolean
  rowsOwned: boolean
  seenFrameIdsOwned: boolean
  streamingTextBlocksOwned: boolean
  streamingThinkingBlocksOwned: boolean
  nextBlockIndexByMessageIdOwned: boolean
  toolResultsByUseIdOwned: boolean
  generatedImagePreviewsOwned: boolean
  agentCompletionsOwned: boolean
  hiddenFrameIdsOwned: boolean
  slashCommandsOwned: boolean
  rowIndexes: Map<string, number> | null
}

function createBatchSessionDraft(
  sessionId: SessionId,
  session: TranscriptSessionState,
): BatchSessionDraft {
  return {
    sessionId,
    session: { ...session },
    changed: false,
    rowsOwned: false,
    seenFrameIdsOwned: false,
    streamingTextBlocksOwned: false,
    streamingThinkingBlocksOwned: false,
    nextBlockIndexByMessageIdOwned: false,
    toolResultsByUseIdOwned: false,
    generatedImagePreviewsOwned: false,
    agentCompletionsOwned: false,
    hiddenFrameIdsOwned: false,
    slashCommandsOwned: false,
    rowIndexes: null,
  }
}

function createBatchReadyDraft(sessionId: SessionId): BatchSessionDraft {
  const draft = createBatchSessionDraft(sessionId, createTranscriptSessionState())
  draft.changed = true
  draft.rowsOwned = true
  draft.seenFrameIdsOwned = true
  draft.streamingTextBlocksOwned = true
  draft.streamingThinkingBlocksOwned = true
  draft.nextBlockIndexByMessageIdOwned = true
  draft.toolResultsByUseIdOwned = true
  draft.generatedImagePreviewsOwned = true
  draft.agentCompletionsOwned = true
  draft.hiddenFrameIdsOwned = true
  draft.slashCommandsOwned = true
  return draft
}

function createBatchResetDraft(
  sessionId: SessionId,
  session: TranscriptSessionState,
): BatchSessionDraft {
  const reset = resetTranscriptSession(
    { sessions: { [sessionId]: session } },
    sessionId,
  )
  const draft = createBatchSessionDraft(sessionId, reset.sessions[sessionId]!)
  draft.changed = true
  draft.rowsOwned = true
  draft.seenFrameIdsOwned = true
  draft.streamingTextBlocksOwned = true
  draft.streamingThinkingBlocksOwned = true
  draft.nextBlockIndexByMessageIdOwned = true
  draft.toolResultsByUseIdOwned = true
  draft.generatedImagePreviewsOwned = true
  draft.agentCompletionsOwned = true
  draft.hiddenFrameIdsOwned = true
  draft.slashCommandsOwned = true
  return draft
}

function getBatchSessionDraft(
  drafts: Map<SessionId, BatchSessionDraft>,
  state: TranscriptState,
  sessionId: SessionId,
): BatchSessionDraft | null {
  const existing = drafts.get(sessionId)
  if (existing) return existing
  const session = state.sessions[sessionId]
  if (!session) return null
  const draft = createBatchSessionDraft(sessionId, session)
  drafts.set(sessionId, draft)
  return draft
}

function ensureBatchRows(draft: BatchSessionDraft): void {
  if (draft.rowsOwned) return
  draft.session.rows = [...draft.session.rows]
  draft.rowsOwned = true
}

function ensureBatchSeenFrameIds(draft: BatchSessionDraft): void {
  if (draft.seenFrameIdsOwned) return
  draft.session.seenFrameIds = { ...draft.session.seenFrameIds }
  draft.seenFrameIdsOwned = true
}

function ensureBatchStreamingBlocks(draft: BatchSessionDraft): void {
  if (draft.streamingTextBlocksOwned) return
  draft.session.streamingTextBlocks = { ...draft.session.streamingTextBlocks }
  draft.streamingTextBlocksOwned = true
}

function ensureBatchStreamingThinkingBlocks(draft: BatchSessionDraft): void {
  if (draft.streamingThinkingBlocksOwned) return
  draft.session.streamingThinkingBlocks = {
    ...draft.session.streamingThinkingBlocks,
  }
  draft.streamingThinkingBlocksOwned = true
}

function ensureBatchNextBlockIndexes(draft: BatchSessionDraft): void {
  if (draft.nextBlockIndexByMessageIdOwned) return
  draft.session.nextBlockIndexByMessageId = {
    ...draft.session.nextBlockIndexByMessageId,
  }
  draft.nextBlockIndexByMessageIdOwned = true
}

function ensureBatchToolResults(draft: BatchSessionDraft): void {
  if (draft.toolResultsByUseIdOwned) return
  draft.session.toolResultsByUseId = { ...draft.session.toolResultsByUseId }
  draft.toolResultsByUseIdOwned = true
}

function ensureBatchImagePreviews(draft: BatchSessionDraft): void {
  if (draft.generatedImagePreviewsOwned) return
  draft.session.generatedImagePreviewsByUseId = {
    ...draft.session.generatedImagePreviewsByUseId,
  }
  draft.generatedImagePreviewsOwned = true
}

function ensureBatchAgentCompletions(draft: BatchSessionDraft): void {
  if (draft.agentCompletionsOwned) return
  draft.session.agentCompletionsByToolUseId = {
    ...draft.session.agentCompletionsByToolUseId,
  }
  draft.agentCompletionsOwned = true
}

function ensureBatchHiddenFrameIds(draft: BatchSessionDraft): void {
  if (draft.hiddenFrameIdsOwned) return
  draft.session.hiddenFrameIds = { ...draft.session.hiddenFrameIds }
  draft.hiddenFrameIdsOwned = true
}

function batchRowIndexes(draft: BatchSessionDraft): Map<string, number> {
  if (draft.rowIndexes) return draft.rowIndexes
  const indexes = new Map<string, number>()
  for (let index = 0; index < draft.session.rows.length; index += 1) {
    indexes.set(draft.session.rows[index]!.id, index)
  }
  draft.rowIndexes = indexes
  return indexes
}

function markBatchFrameSeen(draft: BatchSessionDraft, frameId: string): void {
  ensureBatchSeenFrameIds(draft)
  draft.session.seenFrameIds[frameId] = true
}

function appendBatchRows(
  draft: BatchSessionDraft,
  frameId: string,
  rows: TranscriptRow[],
  recoveryInsertAt: number | null,
): boolean {
  if (draft.session.seenFrameIds[frameId] || rows.length === 0) return false
  ensureBatchRows(draft)
  markBatchFrameSeen(draft, frameId)
  const indexes = batchRowIndexes(draft)
  if (recoveryInsertAt === null) {
    const start = draft.session.rows.length
    draft.session.rows.push(...rows)
    for (let index = 0; index < rows.length; index += 1) {
      indexes.set(rows[index]!.id, start + index)
    }
    return true
  }
  draft.session.rows.splice(recoveryInsertAt, 0, ...rows)
  for (let index = recoveryInsertAt; index < draft.session.rows.length; index += 1) {
    indexes.set(draft.session.rows[index]!.id, index)
  }
  draft.session.recoveryInsertAt = recoveryInsertAt + rows.length
  return true
}

function upsertBatchRows(
  draft: BatchSessionDraft,
  rows: TranscriptRow[],
  recoveryInsertAt: number | null,
): number {
  if (rows.length === 0) return 0
  ensureBatchRows(draft)
  const indexes = batchRowIndexes(draft)
  const added: TranscriptRow[] = []
  for (const row of rows) {
    const index = indexes.get(row.id)
    if (index === undefined) added.push(row)
    else draft.session.rows[index] = row
  }
  if (added.length === 0) return 0
  if (recoveryInsertAt === null) {
    const start = draft.session.rows.length
    draft.session.rows.push(...added)
    for (let index = 0; index < added.length; index += 1) {
      indexes.set(added[index]!.id, start + index)
    }
    return added.length
  }
  draft.session.rows.splice(recoveryInsertAt, 0, ...added)
  for (let index = recoveryInsertAt; index < draft.session.rows.length; index += 1) {
    indexes.set(draft.session.rows[index]!.id, index)
  }
  draft.session.recoveryInsertAt = recoveryInsertAt + added.length
  return added.length
}

function upsertBatchStreamingRow(
  draft: BatchSessionDraft,
  replacement: AssistantTextRow | ThinkingRow,
): void {
  ensureBatchRows(draft)
  const indexes = batchRowIndexes(draft)
  const index = indexes.get(replacement.id)
  if (index === undefined) {
    indexes.set(replacement.id, draft.session.rows.length)
    draft.session.rows.push(replacement)
    return
  }
  const existing = draft.session.rows[index]
  if (existing && isMatchingStreamingRow(existing, replacement)) {
    draft.session.rows[index] = replacement
  }
}

function projectBatchImagePreview(
  draft: BatchSessionDraft,
  frame: Extract<ServerFrame, { kind: 'generated-image-preview' }>,
): void {
  ensureBatchImagePreviews(draft)
  const preview = { mediaType: frame.mediaType, data: frame.data }
  draft.session.generatedImagePreviewsByUseId[frame.toolUseId] = preview
  const result = draft.session.toolResultsByUseId[frame.toolUseId]
  if (result?.generatedImage) {
    ensureBatchToolResults(draft)
    draft.session.toolResultsByUseId[frame.toolUseId] = {
      ...result,
      generatedImage: { ...result.generatedImage, preview },
    }
  }
  draft.changed = true
}

function projectBatchMessage(
  draft: BatchSessionDraft,
  message: SDKMessage,
  recoveryInsertAt: number | null,
): boolean {
  switch (message.type) {
    case 'assistant':
      return projectBatchAssistant(draft, message, recoveryInsertAt)
    case 'stream_event':
      return projectBatchStreamEvent(draft, message)
    case 'user':
      return projectBatchUser(draft, message, recoveryInsertAt)
    case 'result':
      return projectBatchResult(draft, message, recoveryInsertAt)
    case 'system':
      return projectBatchSystem(draft, message, recoveryInsertAt)
    case 'tool_progress':
    case 'tool_use_summary':
    case 'status':
    case 'assistant_error':
    case 'permission_denial':
    case 'auth_status':
    case 'rate_limit_event':
    case 'prompt_suggestion':
    case 'streamlined_text':
    case 'streamlined_tool_use_summary':
      return false
    default: {
      const _exhaustive: never = message
      void _exhaustive
      return false
    }
  }
}

function foldBatchToolResultBlocks(
  draft: BatchSessionDraft,
  content: unknown[],
  toolUseResult?: unknown,
  toolResultStatus?: unknown,
): boolean {
  let changed = false
  for (const block of content) {
    if (
      !isRecord(block) ||
      typeof block.type !== 'string' ||
      !isToolResultBlockType(block.type)
    ) continue
    const toolUseId = nonEmptyString(block.tool_use_id)
    if (!toolUseId) continue
    const projection = projectToolResultBlock(
      block,
      toolUseResult,
      toolResultStatus === 'cancelled',
    )
    const preview = draft.session.generatedImagePreviewsByUseId[toolUseId]
    ensureBatchToolResults(draft)
    draft.session.toolResultsByUseId[toolUseId] =
      preview && projection.generatedImage
        ? {
            ...projection,
            generatedImage: { ...projection.generatedImage, preview },
          }
        : projection
    changed = true
  }
  return changed
}

function projectBatchAssistant(
  draft: BatchSessionDraft,
  message: Extract<SDKMessage, { type: 'assistant' }>,
  recoveryInsertAt: number | null,
): boolean {
  const body: unknown = message.message
  if (!isRecord(body) || !Array.isArray(body.content)) return false
  const frameId = nonEmptyString(message.uuid)
  if (frameId && draft.session.seenFrameIds[frameId]) return false

  let changed = foldBatchToolResultBlocks(draft, body.content)
  // The engine authors this text for the user, so it is surfaced as a notice
  // rather than dropped.
  if (typeof message.error === 'string') {
    const text = body.content
      .filter((block): block is { type: 'text'; text: string } =>
        isRecord(block) && block.type === 'text' && typeof block.text === 'string',
      )
      .map(block => block.text)
      .join('\n')
    if (text.length === 0) {
      if (frameId) markBatchFrameSeen(draft, frameId)
      return true
    }
    // Frame ids key both row identity and replay dedupe, so a constant would
    // collide: the first notice would mark the key seen and silently swallow
    // every later provider error. Derive one the way the block path does.
    const messageIdForNotice = nonEmptyString(body.id)
    const noticeFrameId =
      frameId ?? (messageIdForNotice && `${messageIdForNotice}:provider_error`)
    if (!noticeFrameId) return true
    return appendBatchSystemNotice(
      draft,
      noticeFrameId,
      'provider_error',
      text,
      recoveryInsertAt,
    ) || changed
  }
  const messageId = nonEmptyString(body.id) ?? frameId
  if (!messageId) return changed
  const fallbackIndex = draft.session.nextBlockIndexByMessageId[messageId] ?? 0
  const firstBlockIndex =
    draft.session.currentStreamMessageId === messageId &&
    draft.session.currentStreamBlockIndex !== null
      ? draft.session.currentStreamBlockIndex
      : fallbackIndex
  const blockIndexes = body.content.map((block, localIndex) =>
    streamingThinkingBlockIndex(
      messageId,
      block,
      draft.session.streamingThinkingBlocks,
    ) ?? (firstBlockIndex + localIndex),
  )
  const stableFrameId =
    frameId ?? `${messageId}:block-${blockIndexes[0] ?? firstBlockIndex}`
  const parentToolUseId = nonEmptyString(message.parent_tool_use_id)
  const agentName = normalizeAgentName(message.agent_name)
  const model = nonEmptyString(body.model)
  const rows = body.content.flatMap((block, localIndex) => {
    const row = projectAssistantContentBlock(block, {
      sessionId: draft.sessionId,
      messageId,
      frameId: stableFrameId,
      blockIndex: blockIndexes[localIndex]!,
      parentToolUseId,
      ...(agentName ? { agentName } : {}),
      ...(model !== null ? { model } : {}),
    })
    return row === null ? [] : [row]
  })
  for (const row of rows) {
    if (!('messageId' in row) || !('blockIndex' in row)) continue
    const key = streamBlockKey(row.messageId, row.blockIndex)
    if (draft.session.streamingTextBlocks[key]) {
      ensureBatchStreamingBlocks(draft)
      delete draft.session.streamingTextBlocks[key]
    }
    if (draft.session.streamingThinkingBlocks[key]) {
      ensureBatchStreamingThinkingBlocks(draft)
      delete draft.session.streamingThinkingBlocks[key]
    }
  }
  upsertBatchRows(draft, rows, recoveryInsertAt)
  ensureBatchNextBlockIndexes(draft)
  draft.session.nextBlockIndexByMessageId[messageId] = Math.max(
    fallbackIndex,
    ...blockIndexes.map(blockIndex => blockIndex + 1),
  )
  if (frameId) markBatchFrameSeen(draft, frameId)
  changed = true
  return changed
}

function projectBatchStreamEvent(
  draft: BatchSessionDraft,
  message: Extract<SDKMessage, { type: 'stream_event' }>,
): boolean {
  const event = isRecord(message.event) ? message.event : null
  if (!event || typeof event.type !== 'string') return false
  if (event.type === 'message_start') {
    const started = isRecord(event.message) ? event.message : null
    if (!started || typeof started.id !== 'string') return false
    draft.session.currentStreamMessageId = started.id
    draft.session.currentStreamBlockIndex = null
    return true
  }
  if (
    event.type === 'content_block_start' &&
    draft.session.currentStreamMessageId &&
    typeof event.index === 'number'
  ) {
    const key = streamBlockKey(draft.session.currentStreamMessageId, event.index)
    const block = isRecord(event.content_block) ? event.content_block : null
    draft.session.currentStreamBlockIndex = event.index
    if (block?.type === 'text') {
      if (!draft.session.streamingTextBlocks[key]) {
        ensureBatchStreamingBlocks(draft)
        draft.session.streamingTextBlocks[key] = {
          messageId: draft.session.currentStreamMessageId,
          blockIndex: event.index,
          content: '',
        }
      }
      return true
    }
    if (block?.type === 'thinking') {
      const reasoningKind =
        typeof block.reasoning_kind === 'string'
          ? block.reasoning_kind
          : typeof block.reasoningKind === 'string'
            ? block.reasoningKind
            : undefined
      const existing = draft.session.streamingThinkingBlocks[key]
      if (!existing || (existing.reasoningKind === undefined && reasoningKind)) {
        ensureBatchStreamingThinkingBlocks(draft)
        draft.session.streamingThinkingBlocks[key] = existing
          ? { ...existing, reasoningKind }
          : {
              messageId: draft.session.currentStreamMessageId,
              blockIndex: event.index,
              content: '',
              ...(reasoningKind ? { reasoningKind } : {}),
            }
      }
      return true
    }
    if (draft.session.streamingTextBlocks[key]) {
      ensureBatchStreamingBlocks(draft)
      delete draft.session.streamingTextBlocks[key]
    }
    return true
  }
  if (
    event.type === 'content_block_delta' &&
    draft.session.currentStreamMessageId &&
    typeof event.index === 'number'
  ) {
    const delta = isRecord(event.delta) ? event.delta : null
    const key = streamBlockKey(draft.session.currentStreamMessageId, event.index)
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      const existing = draft.session.streamingTextBlocks[key] ?? {
        messageId: draft.session.currentStreamMessageId,
        blockIndex: event.index,
        content: '',
      }
      const nextBlock = { ...existing, content: existing.content + delta.text }
      ensureBatchStreamingBlocks(draft)
      draft.session.streamingTextBlocks[key] = nextBlock
      draft.session.currentStreamBlockIndex = event.index
      upsertBatchStreamingRow(
        draft,
        createStreamingTextRow(draft.sessionId, nextBlock),
      )
      return true
    }
    if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      const existing = draft.session.streamingThinkingBlocks[key] ?? {
        messageId: draft.session.currentStreamMessageId,
        blockIndex: event.index,
        content: '',
      }
      const nextBlock = {
        ...existing,
        content: existing.content + delta.thinking,
      }
      ensureBatchStreamingThinkingBlocks(draft)
      draft.session.streamingThinkingBlocks[key] = nextBlock
      draft.session.currentStreamBlockIndex = event.index
      upsertBatchStreamingRow(
        draft,
        createStreamingThinkingRow(draft.sessionId, nextBlock),
      )
      return true
    }
    return false
  }
  if (event.type === 'message_stop') {
    draft.session.currentStreamMessageId = null
    draft.session.currentStreamBlockIndex = null
    return true
  }
  return false
}

function projectBatchUser(
  draft: BatchSessionDraft,
  message: Extract<SDKMessage, { type: 'user' }>,
  recoveryInsertAt: number | null,
): boolean {
  const frameId = nonEmptyString(message.uuid)
  if (frameId && draft.session.seenFrameIds[frameId]) return false
  const body: unknown = message.message
  let changed =
    isRecord(body) && Array.isArray(body.content)
      ? foldBatchToolResultBlocks(
          draft,
          body.content,
          message.tool_use_result,
          message.tool_result_status,
        )
      : false
  if (!frameId || !isRecord(body)) return changed
  const rawContent = body.content
  const blocks: unknown[] =
    typeof rawContent === 'string'
      ? [{ type: 'text', text: rawContent }]
      : Array.isArray(rawContent)
        ? rawContent
        : []
  if (blocks.length === 0) return changed
  const messageId = nonEmptyString(body.id) ?? frameId
  const timestamp =
    message.timestamp === undefined ? undefined : nonEmptyString(message.timestamp)
  if (message.timestamp !== undefined && timestamp === null) return changed
  const parentToolUseId = nonEmptyString(message.parent_tool_use_id)
  const agentName = normalizeAgentName(message.agent_name)
  const origin = projectMessageOrigin(message.origin)
  if (origin?.kind === 'interruption') {
    return appendBatchRows(draft, frameId, [{
      id: frameRowId(draft.sessionId, frameId, 'turn_stopped'),
      sessionId: draft.sessionId,
      frameId,
      kind: 'turn-stopped',
    }], recoveryInsertAt) || changed
  }
  const rows = blocks.flatMap((block, blockIndex) => {
    const row = projectUserContentBlock(block, {
      sessionId: draft.sessionId,
      messageId,
      frameId,
      blockIndex,
      parentToolUseId,
      ...(agentName ? { agentName } : {}),
    }, {
      isReplay: message.isReplay === true,
      timestamp: timestamp ?? undefined,
      origin,
    })
    return row === null ? [] : [row]
  })
  if (rows.length === 0) {
    markBatchFrameSeen(draft, frameId)
    return true
  }
  if (origin?.kind === 'task-notification' &&
    origin.toolUseId !== null && origin.completion !== null) {
    ensureBatchAgentCompletions(draft)
    draft.session.agentCompletionsByToolUseId[origin.toolUseId] = origin.completion
  }
  const appended = appendBatchRows(draft, frameId, rows, recoveryInsertAt)
  if (message.isSynthetic === true && appended) {
    ensureBatchHiddenFrameIds(draft)
    draft.session.hiddenFrameIds[frameId] = true
  }
  return appended || changed
}

function finalizeBatchStreamingTurn(draft: BatchSessionDraft): boolean {
  const hasStreamingRows = draft.session.rows.some(
    isStreamingProjectionRow,
  )
  const hasStreamingState =
    draft.session.currentStreamMessageId !== null ||
    draft.session.currentStreamBlockIndex !== null ||
    Object.keys(draft.session.streamingTextBlocks).length > 0 ||
    Object.keys(draft.session.streamingThinkingBlocks).length > 0
  if (!hasStreamingRows && !hasStreamingState) return false
  if (hasStreamingRows) {
    ensureBatchRows(draft)
    for (let index = 0; index < draft.session.rows.length; index += 1) {
      const row = draft.session.rows[index]!
      if (isStreamingProjectionRow(row)) {
        const { isStreaming: _streaming, ...finalized } = row
        void _streaming
        draft.session.rows[index] = finalized
      }
    }
  }
  draft.session.currentStreamMessageId = null
  draft.session.currentStreamBlockIndex = null
  ensureBatchStreamingBlocks(draft)
  draft.session.streamingTextBlocks = {}
  ensureBatchStreamingThinkingBlocks(draft)
  draft.session.streamingThinkingBlocks = {}
  return true
}

function projectBatchResult(
  draft: BatchSessionDraft,
  message: Extract<SDKMessage, { type: 'result' }>,
  recoveryInsertAt: number | null,
): boolean {
  let changed = finalizeBatchStreamingTurn(draft)
  if (draft.session.compacting) {
    draft.session.compacting = false
    changed = true
  }
  const frameId = nonEmptyString(message.uuid)
  const subtype = nonEmptyString(message.subtype)
  if (!frameId || !subtype || typeof message.is_error !== 'boolean') return changed
  if (draft.session.seenFrameIds[frameId]) return changed
  const result = optionalString(message.result)
  const errors = optionalStringArray(message.errors)
  const durationMs = optionalNumber(message.duration_ms)
  const totalCostUsd = optionalNumber(message.total_cost_usd)
  if (result === null || errors === null || durationMs === null || totalCostUsd === null) {
    return changed
  }
  if (
    subtype === 'interrupted' &&
    draft.session.rows.some(row => row.kind === 'turn-stopped')
  ) {
    markBatchFrameSeen(draft, frameId)
    return true
  }
  return appendBatchRows(draft, frameId, [{
    id: frameRowId(draft.sessionId, frameId, 'result'),
    sessionId: draft.sessionId,
    frameId,
    kind: 'result',
    subtype,
    isError: message.is_error,
    ...(result === undefined ? {} : { result }),
    errors: errors ?? [],
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(totalCostUsd === undefined ? {} : { totalCostUsd }),
  }], recoveryInsertAt) || changed
}

function projectBatchSystem(
  draft: BatchSessionDraft,
  message: Extract<SDKMessage, { type: 'system' }>,
  recoveryInsertAt: number | null,
): boolean {
  const frameId = nonEmptyString(message.uuid)
  if (!frameId || draft.session.seenFrameIds[frameId]) return false
  switch (message.subtype) {
    case 'init': {
      const cwd = nonEmptyString(message.cwd)
      const model = nonEmptyString(message.model)
      const tools = stringArray(message.tools)
      const permissionMode = nonEmptyString(message.permissionMode)
      if (!cwd || !model || !tools || !permissionMode) return false
      markBatchFrameSeen(draft, frameId)
      draft.session.slashCommands = stringArray(message.slash_commands) ?? []
      draft.slashCommandsOwned = true
      return true
    }
    case 'status':
      if (draft.session.compacting === (message.status === 'compacting')) return false
      draft.session.compacting = message.status === 'compacting'
      return true
    case 'compact_boundary': {
      const metadata = message.compact_metadata
      if (
        !isRecord(metadata) ||
        (metadata.trigger !== 'manual' && metadata.trigger !== 'auto') ||
        typeof metadata.pre_tokens !== 'number'
      ) return false
      // Same rule as the single-frame path: a recovered boundary is history
      // replay, not the live compaction finishing.
      if (recoveryInsertAt === null) draft.session.compacting = false
      return appendBatchRows(draft, frameId, [{
        id: frameRowId(draft.sessionId, frameId, 'compact-boundary'),
        sessionId: draft.sessionId,
        frameId,
        kind: 'compact-boundary',
        trigger: metadata.trigger,
        preTokens: metadata.pre_tokens,
      }], recoveryInsertAt)
    }
    case 'api_retry': {
      const text = retryNoticeText(message.error)
      return text === null
        ? false
        : appendBatchSystemNotice(draft, frameId, 'api_retry', text, recoveryInsertAt)
    }
    case 'local_command_output':
      return typeof message.content === 'string'
        ? appendBatchSystemNotice(draft, frameId, 'local_command_output', message.content, recoveryInsertAt)
        : false
    case 'cat_code_account_diagnostic':
      return typeof message.user_message === 'string'
        ? appendBatchSystemNotice(draft, frameId, 'account_diagnostic', message.user_message, recoveryInsertAt)
        : false
    default:
      return false
  }
}

function appendBatchSystemNotice(
  draft: BatchSessionDraft,
  frameId: string,
  noticeType: SystemNoticeRow['noticeType'],
  content: string,
  recoveryInsertAt: number | null,
): boolean {
  return appendBatchRows(draft, frameId, [{
    id: frameRowId(draft.sessionId, frameId, noticeType),
    sessionId: draft.sessionId,
    frameId,
    kind: 'system-notice',
    noticeType,
    content,
  }], recoveryInsertAt)
}

/**
 * Full-union dispatch (P2-0). Two variants project today (`assistant` rows,
 * `stream_event` position tracking); every other variant is an explicit,
 * documented no-op returning `state` unchanged (reference-equal — the fixture
 * tests assert that). Variants = switch cases to extend: later sessions turn a
 * documented no-op into a projection by replacing its `return state`.
 */
function projectMessage(
  sessionId: SessionId,
  state: TranscriptSessionState,
  message: SDKMessage,
): TranscriptSessionState {
  switch (message.type) {
    case 'assistant':
      return projectAssistantFrame(sessionId, state, message)

    case 'stream_event':
      // Droppable garnish (S1 spec §3): deltas may project live preview rows,
      // but full assistant frames and the result boundary remain authoritative.
      return projectStreamEvent(sessionId, state, message)

    case 'user':
      // User frames may carry both visible P2-1 content and P2-2 tool_result
      // blocks; `projectUserFrame` folds correlation itself, AFTER its dedupe
      // check, so a replayed frame stays a total no-op (same ordering as the
      // assistant path).
      return projectUserFrame(sessionId, state, message)

    case 'result':
      // Result is the only turn-end marker: prune orphan previews before
      // projecting the authoritative P2-1 boundary row. A turn cannot end with
      // a compaction still running, and an aborted one never reaches the
      // engine's own clear, so the turn boundary is the backstop.
      return projectResultFrame(
        sessionId,
        clearCompacting(finalizeStreamingTurn(state)),
        message,
      )

    case 'system':
      return projectSystemFrame(sessionId, state, message)

    case 'tool_progress':
      // P2-2 scope: live activity on the correlated tool card
      // (engine-throttled, `src/utils/queryHelpers.ts` tool_progress yield).
      return state

    case 'tool_use_summary':
      // P2-2 scope: summary chip over `preceding_tool_use_ids` correlation
      // (`src/QueryEngine.ts` tool_use_summary yield).
      return state

    case 'status':
      // Type-only at this seam: no `type:'status'` mint site exists in src/
      // (the runtime schema models status as system/subtype:'status'
      // instead — see sdkMessageFixtures.ts header). Tolerated no-op.
      return state

    case 'assistant_error':
      // Never minted as a top-level message in src/ — the populated shape is
      // the `error` FIELD on assistant/api_retry frames, which P2-1's
      // ApiErrorRow reads. Tolerated no-op if it ever arrives top-level.
      return state

    case 'permission_denial':
      // Type-only member (no mint site in src/). The live permission flow is
      // the control channel (`permission.requested`/`permission.resolved`
      // AppSessionEvents) — P2-4 domain state, NOT the transcript projector
      // (§5 layer-3 separation). Denial summaries also arrive on
      // `result.permission_denials`.
      return state

    case 'auth_status':
      // Minted only on the SDK stdout path (`src/cli/print.ts`), never at the
      // in-proc app seam today. W4 Accounts domain if that changes.
      return state

    case 'rate_limit_event':
      // SDK stdout path only (`src/cli/print.ts`). INVENTORY W3 marks a
      // standalone RateLimitRow stale — folded into API-error/notice
      // handling (P2-1) if the seam ever emits it.
      return state

    case 'prompt_suggestion':
      // SDK stdout path only (`src/cli/print.ts`, promptSuggestions opt-in).
      // Composer surface (Phase 4), not a transcript row.
      return state

    case 'streamlined_text':
    case 'streamlined_tool_use_summary':
      // Streamlined-mode transform applied only by `src/cli/print.ts`
      // (`src/utils/streamlinedTransform.ts`); replaces assistant frames on
      // that path. The app seam receives the originals, so no mapping here.
      return state

    default: {
      // Compile-time exhaustiveness tripwire: if the SDKMessage union grows a
      // member, this assignment errors until it gets an explicit case above.
      const _exhaustive: never = message
      void _exhaustive
      // Runtime tolerance: wire frames may outrun the pinned engine types
      // (schema drift). An unknown variant is a no-op, never a crash.
      return state
    }
  }
}

function projectAssistantFrame(
  sessionId: SessionId,
  state: TranscriptSessionState,
  message: Extract<SDKMessage, { type: 'assistant' }>,
): TranscriptSessionState {
  // The type claims `message.message.content` exists, but that claim is about
  // a process on the far side of a socket — harden before dereferencing.
  const body: unknown = message.message
  if (!isRecord(body) || !Array.isArray(body.content)) return state

  const frameId =
    typeof message.uuid === 'string' && message.uuid.length > 0
      ? message.uuid
      : null
  // Dedupe BEFORE folding results: a replayed duplicate frame must be a
  // total no-op, including its result-correlation side effect.
  if (frameId && state.seenFrameIds[frameId]) return state

  // Server-executed tool families (server_tool_use, mcp_tool_use, web_fetch,
  // code execution, …) can carry their OWN result block in the SAME
  // assistant message's content array — there is no client round-trip, so no
  // separate `user` tool_result frame ever arrives for them
  // (`src/utils/messages.ts:1306-1328` documents the engine treating an
  // unresolved one as orphaned/errored, confirming results ride inline).
  // Fold any such result blocks into the correlation map alongside the
  // `user`-frame path so both shapes resolve the same ToolCard.
  state = foldToolResultBlocks(state, body.content)

  // The engine authors this text for the user, so it is surfaced as a notice
  // rather than dropped.
  if (typeof message.error === 'string') {
    const text = body.content
      .filter((block): block is { type: 'text'; text: string } =>
        isRecord(block) && block.type === 'text' && typeof block.text === 'string',
      )
      .map(block => block.text)
      .join('\n')
    if (text.length === 0) {
      return {
        ...state,
        seenFrameIds: frameId
          ? { ...state.seenFrameIds, [frameId]: true }
          : state.seenFrameIds,
      }
    }
    // Frame ids key both row identity and replay dedupe, so a constant would
    // collide: the first notice would mark the key seen and silently swallow
    // every later provider error. Derive one the way the block path does.
    const messageIdForNotice = nonEmptyString(body.id)
    const noticeFrameId =
      frameId ?? (messageIdForNotice && `${messageIdForNotice}:provider_error`)
    if (!noticeFrameId) return state
    return appendSystemNotice(
      state,
      sessionId,
      noticeFrameId,
      'provider_error',
      text,
    )
  }

  const messageId =
    typeof body.id === 'string' && body.id.length > 0 ? body.id : frameId
  if (!messageId) return state

  const parentToolUseId =
    typeof message.parent_tool_use_id === 'string' &&
    message.parent_tool_use_id.length > 0
      ? message.parent_tool_use_id
      : null
  const agentName = normalizeAgentName(message.agent_name)
  const model = nonEmptyString(body.model)

  const fallbackIndex = state.nextBlockIndexByMessageId[messageId] ?? 0
  const firstBlockIndex =
    state.currentStreamMessageId === messageId &&
    state.currentStreamBlockIndex !== null
      ? state.currentStreamBlockIndex
      : fallbackIndex
  const blockIndexes = body.content.map((block, localIndex) =>
    streamingThinkingBlockIndex(
      messageId,
      block,
      state.streamingThinkingBlocks,
    ) ?? (firstBlockIndex + localIndex),
  )
  const stableFrameId =
    frameId ?? `${messageId}:block-${blockIndexes[0] ?? firstBlockIndex}`
  const rows = body.content.flatMap((block, localIndex) => {
    const blockIndex = blockIndexes[localIndex]!
    const row = projectAssistantContentBlock(block, {
      sessionId,
      messageId,
      frameId: stableFrameId,
      blockIndex,
      parentToolUseId,
      ...(agentName ? { agentName } : {}),
      ...(model !== null ? { model } : {}),
    })
    return row === null ? [] : [row]
  })
  const nextBlockIndex = Math.max(
    fallbackIndex,
    ...blockIndexes.map(blockIndex => blockIndex + 1),
  )
  const nextStreamingTextBlocks = { ...state.streamingTextBlocks }
  const nextStreamingThinkingBlocks = { ...state.streamingThinkingBlocks }
  for (const row of rows) {
    if ('messageId' in row && 'blockIndex' in row) {
      const key = streamBlockKey(row.messageId, row.blockIndex)
      delete nextStreamingTextBlocks[key]
      delete nextStreamingThinkingBlocks[key]
    }
  }
  const streamingTextBlocks =
    Object.keys(nextStreamingTextBlocks).length ===
    Object.keys(state.streamingTextBlocks).length
      ? state.streamingTextBlocks
      : nextStreamingTextBlocks
  const streamingThinkingBlocks =
    Object.keys(nextStreamingThinkingBlocks).length ===
    Object.keys(state.streamingThinkingBlocks).length
      ? state.streamingThinkingBlocks
      : nextStreamingThinkingBlocks

  const placed = upsertFrameRows(state, rows)

  return {
    ...state,
    rows: placed.rows,
    recoveryInsertAt: placed.recoveryInsertAt,
    streamingTextBlocks,
    streamingThinkingBlocks,
    nextBlockIndexByMessageId: {
      ...state.nextBlockIndexByMessageId,
      [messageId]: nextBlockIndex,
    },
    seenFrameIds: frameId
      ? { ...state.seenFrameIds, [frameId]: true }
      : state.seenFrameIds,
  }
}

function projectUserFrame(
  sessionId: SessionId,
  state: TranscriptSessionState,
  message: Extract<SDKMessage, { type: 'user' }>,
): TranscriptSessionState {
  const frameId = nonEmptyString(message.uuid)
  // Dedupe BEFORE folding results, exactly as the assistant path does (:705): a
  // replayed duplicate frame must be a total no-op, including its
  // result-correlation side effect. Re-folding mints a fresh
  // ToolResultProjection per id, which makes every read clone its tool-use rows
  // and drops the nested-row/display-item caches — a whole-transcript
  // re-render for a frame that changed nothing.
  if (frameId && state.seenFrameIds[frameId]) return state
  // Fold correlation next, ahead of every early return below: a tool_result-only
  // frame projects no visible row, and `isSynthetic` is `isMeta ||
  // isVisibleInTranscriptOnly` on a mapper that attaches `tool_use_result` to
  // that same frame (`src/utils/messages/mappers.ts:200-206`), so neither shape
  // may lose its result.
  state = correlateToolResults(state, message)

  // P4-36 — the hidden tier is RETAINED, not discarded. This used to be
  // `if (message.isSynthetic === true) return state`, which threw the row away
  // and left the reveal control with nothing to reveal. The frame now walks the
  // SAME projection path as any other user frame and its rows land in `rows` in
  // arrival order; only `hiddenFrameIds` records the tier, and every read
  // decides whether to show it. Nothing moved above `correlateToolResults`, so
  // the ordering that comment protects is unchanged: dedupe still gates the
  // fold, the fold still runs before any early return, and a hidden frame that
  // appends rows now ALSO marks `seenFrameIds` (via `appendFrameRows`), so its
  // replay is a total no-op instead of re-folding a correlation it already did.
  const isHidden = message.isSynthetic === true

  const body: unknown = message.message
  if (!frameId || !isRecord(body)) return state

  const rawContent = body.content
  const blocks: unknown[] =
    typeof rawContent === 'string'
      ? [{ type: 'text', text: rawContent }]
      : Array.isArray(rawContent)
        ? rawContent
        : []
  if (blocks.length === 0) return state

  const messageId = nonEmptyString(body.id) ?? frameId
  const parentToolUseId = nonEmptyString(message.parent_tool_use_id)
  const agentName = normalizeAgentName(message.agent_name)
  const timestamp =
    message.timestamp === undefined
      ? undefined
      : nonEmptyString(message.timestamp)
  if (message.timestamp !== undefined && timestamp === null) return state

  // Message-level provenance: `origin` describes the whole turn, so every text
  // block in it is attributed the same way (image blocks stay image rows).
  const origin = projectMessageOrigin(message.origin)
  if (origin?.kind === 'interruption') {
    // The body is model-facing interruption protocol, not operator prose. Its
    // explicit, persisted origin is the durable display fact for live and replay.
    return appendFrameRows(state, frameId, [
      {
        id: frameRowId(sessionId, frameId, 'turn_stopped'),
        sessionId,
        frameId,
        kind: 'turn-stopped',
      },
    ])
  }

  const rows = blocks.flatMap((block, blockIndex) => {
    const row = projectUserContentBlock(block, {
      sessionId,
      messageId,
      frameId,
      blockIndex,
      parentToolUseId,
      ...(agentName ? { agentName } : {}),
    }, {
      isReplay: message.isReplay === true,
      timestamp: timestamp ?? undefined,
      origin,
    })
    return row === null ? [] : [row]
  })
  // Tool-result-only frames still changed correlation state above. Mark them
  // seen even though they add no visible row, otherwise replay re-folds the
  // same result and invalidates every transcript read cache.
  if (rows.length === 0) {
    return {
      ...state,
      seenFrameIds: { ...state.seenFrameIds, [frameId]: true },
    }
  }
  const withCompletion = recordAgentCompletion(state, origin)
  const appended = appendFrameRows(withCompletion, frameId, rows)
  // Identity is compared against what was HANDED to `appendFrameRows`, not the
  // original `state`: `recordAgentCompletion` may already have returned a new
  // object, so comparing to `state` would read a no-op append as a real one.
  if (!isHidden || appended === withCompletion) return appended
  return {
    ...appended,
    hiddenFrameIds: { ...appended.hiddenFrameIds, [frameId]: true },
  }
}

/**
 * Retain structured completion facts by `tool_use_id`. Original background
 * launch cards do not consume them; ResumeAgent uses them to populate the
 * resumed run's independent result card. A duplicate id is overwritten by the
 * later turn (the engine notifies once per task, guarded by the `notified` flag
 * at `src/tasks/LocalAgentTask/LocalAgentTask.tsx:307`).
 */
function recordAgentCompletion(
  state: TranscriptSessionState,
  origin: InjectedOrigin | null,
): TranscriptSessionState {
  if (origin === null || origin.kind !== 'task-notification') return state
  const { toolUseId, completion } = origin
  if (toolUseId === null || completion === null) return state
  return {
    ...state,
    agentCompletionsByToolUseId: {
      ...state.agentCompletionsByToolUseId,
      [toolUseId]: completion,
    },
  }
}

function projectResultFrame(
  sessionId: SessionId,
  state: TranscriptSessionState,
  message: Extract<SDKMessage, { type: 'result' }>,
): TranscriptSessionState {
  const frameId = nonEmptyString(message.uuid)
  const subtype = nonEmptyString(message.subtype)
  if (!frameId || !subtype || typeof message.is_error !== 'boolean') return state
  if (state.seenFrameIds[frameId]) return state

  const result = optionalString(message.result)
  const errors = optionalStringArray(message.errors)
  const durationMs = optionalNumber(message.duration_ms)
  const totalCostUsd = optionalNumber(message.total_cost_usd)
  if (
    result === null ||
    errors === null ||
    durationMs === null ||
    totalCostUsd === null
  ) {
    return state
  }

  // A current engine writes an origin-tagged interruption user frame before its
  // result. That durable marker is the one transcript seam; the result is a
  // live lifecycle byproduct and would otherwise duplicate it. Legacy emitters
  // without the origin retain their existing interrupted result seam.
  if (
    subtype === 'interrupted' &&
    state.rows.some(row => row.kind === 'turn-stopped')
  ) {
    return {
      ...state,
      seenFrameIds: { ...state.seenFrameIds, [frameId]: true },
    }
  }

  const row: ResultRow = {
    id: frameRowId(sessionId, frameId, 'result'),
    sessionId,
    frameId,
    kind: 'result',
    subtype,
    isError: message.is_error,
    ...(result === undefined ? {} : { result }),
    errors: errors ?? [],
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(totalCostUsd === undefined ? {} : { totalCostUsd }),
  }
  return appendFrameRows(state, frameId, [row])
}

function projectSystemFrame(
  sessionId: SessionId,
  state: TranscriptSessionState,
  message: Extract<SDKMessage, { type: 'system' }>,
): TranscriptSessionState {
  const frameId = nonEmptyString(message.uuid)
  if (!frameId || state.seenFrameIds[frameId]) return state

  switch (message.subtype) {
    case 'init': {
      const cwd = nonEmptyString(message.cwd)
      const model = nonEmptyString(message.model)
      const tools = stringArray(message.tools)
      const permissionMode = nonEmptyString(message.permissionMode)
      if (!cwd || !model || !tools || !permissionMode) return state
      // P4-23 (operator, 2026-07-09): the visible ✦ "Session started" banner row
      // was removed — Claude/ChatGPT show no such banner. The `case 'init'` still
      // runs and STILL captures the P3-7 slash-command catalog (this frame does
      // double duty); it just emits NO transcript row now.
      //
      // The slash catalog rides the SAME init frame (no new wire vocabulary):
      // `slash_commands` is the user-invocable command names the sidecar's real
      // catalog produced (P3-7). Tolerate its absence — a session whose sidecar
      // catalog degraded to `[]` still captures a valid (empty) catalog.
      const slashCommands = stringArray(message.slash_commands) ?? []
      // Mark the frame seen so a replayed init is idempotent (the row list is no
      // longer written, so `appendFrameRows` is not the dedupe path anymore), and
      // store the catalog as session metadata read by the SlashCommandPicker.
      return {
        ...state,
        seenFrameIds: { ...state.seenFrameIds, [frameId]: true },
        slashCommands,
      }
    }

    case 'status':
      // The engine's compaction signal. Not a row: `compact_boundary` is the
      // durable record, and this only says a summarization call is in flight.
      // Returns the SAME state object when nothing moved, so the 30s keep-alive
      // re-emits do not bust the row-slice caches downstream.
      return setCompacting(state, message.status === 'compacting')

    case 'compact_boundary': {
      const metadata = message.compact_metadata
      if (
        !isRecord(metadata) ||
        (metadata.trigger !== 'manual' && metadata.trigger !== 'auto') ||
        typeof metadata.pre_tokens !== 'number'
      ) {
        return state
      }
      // A recovered boundary is history replay, not the live compaction
      // finishing: only clear `compacting` for a live frame (`recoveryInsertAt`
      // non-null here means this frame is recovered, see `appendFrameRows`).
      const nextState =
        state.recoveryInsertAt === null ? clearCompacting(state) : state
      return appendFrameRows(nextState, frameId, [
        {
          id: frameRowId(sessionId, frameId, 'compact-boundary'),
          sessionId,
          frameId,
          kind: 'compact-boundary',
          trigger: metadata.trigger,
          preTokens: metadata.pre_tokens,
        },
      ])
    }

    case 'api_retry': {
      const text = retryNoticeText(message.error)
      if (text === null) return state
      return appendSystemNotice(state, sessionId, frameId, 'api_retry', text)
    }

    case 'local_command_output':
      return typeof message.content === 'string'
        ? appendSystemNotice(
            state,
            sessionId,
            frameId,
            'local_command_output',
            message.content,
          )
        : state

    case 'cat_code_account_diagnostic':
      return typeof message.user_message === 'string'
        ? appendSystemNotice(
            state,
            sessionId,
            frameId,
            'account_diagnostic',
            message.user_message,
          )
        : state

    default:
      return state
  }
}

function setCompacting(
  state: TranscriptSessionState,
  compacting: boolean,
): TranscriptSessionState {
  return state.compacting === compacting ? state : { ...state, compacting }
}

function clearCompacting(
  state: TranscriptSessionState,
): TranscriptSessionState {
  return setCompacting(state, false)
}

function appendSystemNotice(
  state: TranscriptSessionState,
  sessionId: SessionId,
  frameId: string,
  noticeType: SystemNoticeRow['noticeType'],
  content: string,
): TranscriptSessionState {
  return appendFrameRows(state, frameId, [
    {
      id: frameRowId(sessionId, frameId, noticeType),
      sessionId,
      frameId,
      kind: 'system-notice',
      noticeType,
      content,
    },
  ])
}

function appendFrameRows(
  state: TranscriptSessionState,
  frameId: string,
  rows: TranscriptRow[],
): TranscriptSessionState {
  if (state.seenFrameIds[frameId] || rows.length === 0) return state
  // B1: the ONE branch a recovered frame takes. Every frame in the app reaches
  // this function, so the condition is a session field that only a `recovered`
  // event frame can leave non-null (`projectServerFrame` re-derives it per
  // frame and forces it back to null for anything else). An ordinary frame
  // therefore cannot reach the insertion, and the append below is untouched.
  if (state.recoveryInsertAt !== null) {
    return insertFrameRows(state, state.recoveryInsertAt, frameId, rows)
  }
  return {
    ...state,
    rows: [...state.rows, ...rows],
    seenFrameIds: { ...state.seenFrameIds, [frameId]: true },
  }
}

/**
 * Place one recovered frame's rows ABOVE the conversation they precede (B1).
 *
 * Nothing existing is rewritten: the rows on either side of the cut are the
 * same objects in the same order, so the read-time caches keyed on a row (the
 * nested-row wrapper, the orphan group) still hit for every one of them. Only
 * the session slice is new, which is exactly what the WeakMap caches keyed on
 * the SLICE (`nestedRowsCache` / `revealedNestedRowsCache`) need in order to
 * recompute — and recomputing is required here, because the boundary row is
 * synthesized above `rows[0]` and `rows[0]` has just changed.
 *
 * The cursor advances by what was inserted, so the next frame of the same
 * batch lands after this one and the batch keeps its own oldest-first order.
 */
function insertFrameRows(
  state: TranscriptSessionState,
  at: number,
  frameId: string,
  rows: TranscriptRow[],
): TranscriptSessionState {
  return {
    ...state,
    rows: [...state.rows.slice(0, at), ...rows, ...state.rows.slice(at)],
    recoveryInsertAt: at + rows.length,
    seenFrameIds: { ...state.seenFrameIds, [frameId]: true },
  }
}

/**
 * P2-2 correlation entry point for the `user` frame path (S1/queryHelpers.ts
 * §203-218: `tool_result` content blocks ride `user` messages, `content` is
 * `string | ContentBlockParam[]` — a plain string prompt has nothing to
 * correlate). `tool_use_result` (the companion raw engine output, read
 * alongside the block for FileEditTool diff extraction) rides the SAME `user`
 * SDKMessage the content block is on, per `queryHelpers.ts:213-215`.
 */
function correlateToolResults(
  state: TranscriptSessionState,
  message: Extract<SDKMessage, { type: 'user' }>,
): TranscriptSessionState {
  const body: unknown = message.message
  if (!isRecord(body) || !Array.isArray(body.content)) return state
  return foldToolResultBlocks(
    state,
    body.content,
    message.tool_use_result,
    message.tool_result_status,
  )
}

/**
 * Scans a content-block array for any `*_tool_result` shape and folds each
 * into `toolResultsByUseId`, keyed by its own `tool_use_id` — the single
 * correlation mechanism for BOTH client tool round-trips (`tool_result` on a
 * `user` frame) and server-executed tools whose result rides inline on the
 * SAME assistant message as their `*_tool_use` block (no-op if none found).
 * `toolUseResult` (the companion diff/output payload) is a SINGLE field
 * shared across every matching block found — safe because the engine mints
 * one `user` message per individual tool result, even for parallel tool
 * calls: `query.ts:1439-1455` (`for await (const update of toolUpdates) {
 * yield update.message }`) yields ONE message per completed tool, and the
 * error/interrupt path (`query.ts:133-159`
 * `yieldMissingToolResultBlocks`) does the same — never a batch of several
 * `tool_result` blocks sharing one `toolUseResult`. Re-delivery of an
 * already-correlated id is idempotent (last-write, and in practice the
 * engine sends each result once) — folding is cheap and never mutates a
 * `ToolUseRow`, only this map.
 */
function foldToolResultBlocks(
  state: TranscriptSessionState,
  content: unknown[],
  toolUseResult?: unknown,
  toolResultStatus?: unknown,
): TranscriptSessionState {
  let next: Record<string, ToolResultProjection> | null = null
  for (const block of content) {
    if (!isRecord(block) || typeof block.type !== 'string') continue
    if (!isToolResultBlockType(block.type)) continue
    const toolUseId = block.tool_use_id
    if (typeof toolUseId !== 'string' || toolUseId.length === 0) continue

    const projection = projectToolResultBlock(
      block,
      toolUseResult,
      toolResultStatus === 'cancelled',
    )
    const preview = state.generatedImagePreviewsByUseId[toolUseId]
    const projected =
      preview && projection.generatedImage
        ? {
            ...projection,
            generatedImage: { ...projection.generatedImage, preview },
          }
        : projection
    next = { ...(next ?? state.toolResultsByUseId), [toolUseId]: projected }
  }
  return next ? { ...state, toolResultsByUseId: next } : state
}

/**
 * Every real result-block discriminant the engine's own consumers switch on
 * (`src/utils/messages.ts:2760-2766` normalize path,
 * `src/utils/messages.ts:3136-3146` streaming block-start list) — one per
 * P2-2 tool-card family that has server-side execution. Client tools (Bash,
 * Read, Edit, Grep, …) use the single generic `tool_result` type regardless
 * of family; family for THOSE is derived from the paired `tool_use.name`
 * (`deriveToolFamily`), not from the result block's own type.
 */
function isToolResultBlockType(blockType: string): boolean {
  switch (blockType) {
    case 'tool_result':
    case 'web_search_tool_result':
    case 'web_fetch_tool_result':
    case 'code_execution_tool_result':
    case 'bash_code_execution_tool_result':
    case 'text_editor_code_execution_tool_result':
    case 'tool_search_tool_result':
    case 'mcp_tool_result':
      return true
    default:
      return false
  }
}

/**
 * Narrows one result block into the row-facing projection. `is_error` reads
 * straight off the block (`src/utils/queryHelpers.ts:478`:
 * `content.is_error !== true` is the engine's own read of this exact field).
 * `content` best-effort-flattens to display text without inventing formatting
 * the engine doesn't already produce; `diff` is populated only when
 * `toolUseResult` narrows to a FileEditTool-shaped structuredPatch.
 */
function projectToolResultBlock(
  block: Record<string, unknown>,
  toolUseResult: unknown,
  isCancelled: boolean,
): ToolResultProjection {
  const agentName = extractAgentName(toolUseResult)
  const agentId = extractAgentId(toolUseResult)
  const agentModel = extractAgentModel(toolUseResult)
  const agentAccount = extractAgentAccount(toolUseResult)
  const agentUsage = extractAgentUsage(toolUseResult)
  const taskOutput = extractTaskOutput(toolUseResult)
  return {
    isError: block.is_error === true,
    ...(isCancelled ? { isCancelled: true as const } : {}),
    content: flattenToolResultContent(block.content),
    diff: extractDiffProjection(toolUseResult),
    ...extractGeneratedImageProjection(toolUseResult),
    ...(agentName !== null ? { agentName } : {}),
    ...(agentId !== null ? { agentId } : {}),
    ...(agentModel !== null ? { agentModel } : {}),
    ...(agentAccount !== null ? { agentAccount } : {}),
    ...(agentUsage !== null ? { agentUsage } : {}),
    ...(taskOutput !== null ? { taskOutput } : {}),
  }
}

function extractGeneratedImageProjection(
  toolUseResult: unknown,
): Pick<ToolResultProjection, 'generatedImage'> | Record<string, never> {
  if (!isRecord(toolUseResult)) return {}
  const { filePath, model, size, outputFormat, bytes, revisedPrompt } =
    toolUseResult
  if (
    typeof filePath !== 'string' ||
    typeof model !== 'string' ||
    typeof size !== 'string' ||
    (outputFormat !== 'png' &&
      outputFormat !== 'jpeg' &&
      outputFormat !== 'webp') ||
    typeof bytes !== 'number' ||
    !Number.isFinite(bytes) ||
    (revisedPrompt !== undefined && typeof revisedPrompt !== 'string')
  ) {
    return {}
  }
  return {
    generatedImage: {
      filePath,
      model,
      size,
      outputFormat,
      bytes,
      ...(revisedPrompt === undefined ? {} : { revisedPrompt }),
    },
  }
}

/**
 * A finished Agent tool's own totals. Both numbers or neither, and a
 * non-finite value reads as no usage rather than rendering as `NaN tokens`.
 * `totalTokens` is NOT rejected at zero here: zero is a real persisted value
 * whose meaning ("no usage was reported") belongs to the card that decides
 * whether to print it, not to this narrowing.
 */
function extractAgentUsage(
  toolUseResult: unknown,
): { totalTokens: number; toolUses: number } | null {
  if (!isRecord(toolUseResult)) return null
  const { totalTokens, totalToolUseCount } = toolUseResult
  if (
    typeof totalTokens !== 'number' ||
    typeof totalToolUseCount !== 'number' ||
    !Number.isFinite(totalTokens) ||
    !Number.isFinite(totalToolUseCount)
  ) {
    return null
  }
  return { totalTokens, toolUses: totalToolUseCount }
}

/**
 * The worker name off a finished Agent tool's structured result. Read from the
 * STRUCTURED field, never parsed back out of the result text: the same result
 * also spells the name into model-facing continuation prose ("agentName: Ada",
 * `AgentTool.tsx` `mapToolResultToToolResultBlockParam`), and reconstructing
 * display identity from a banner is the mistake `AgentCompletionProjection`
 * already documents avoiding.
 */
function extractAgentName(toolUseResult: unknown): string | null {
  if (!isRecord(toolUseResult)) return null
  return normalizeAgentName(toolUseResult.agentName)
}

function extractAgentId(toolUseResult: unknown): string | null {
  if (!isRecord(toolUseResult)) return null
  return nonEmptyString(toolUseResult.agentId)
}

/**
 * The model a finished subagent actually ran on
 * (`AgentToolResult.model = resolvedAgentModel`,
 * `src/tools/AgentTool/agentToolUtils.ts:734`; optional in the schema at `:384`
 * because older persisted sessions predate it).
 *
 * GATED on a sibling `agentId`, unlike `agentName` — `model` is a generic key
 * that other structured results already carry (ImageGen's own result names its
 * model, see `extractGeneratedImageProjection` right above), and an ungated read
 * would print the image model on an agent card. `agentId` is present on every
 * AgentToolResult and on nothing else, so it is the shape check.
 */
function extractAgentModel(toolUseResult: unknown): string | null {
  if (!isRecord(toolUseResult)) return null
  if (nonEmptyString(toolUseResult.agentId) === null) return null
  return nonEmptyString(toolUseResult.model)
}

/**
 * Gated on `agentId` like `extractAgentModel`, then narrowed field by field: a
 * foreign tool result carrying some other `account` shape yields null rather
 * than a half-populated object the card would render with a hole in it.
 */
function extractAgentAccount(
  toolUseResult: unknown,
): ToolResultProjection['agentAccount'] | null {
  if (!isRecord(toolUseResult)) return null
  if (nonEmptyString(toolUseResult.agentId) === null) return null
  const account = toolUseResult.account
  if (!isRecord(account)) return null
  const accountId = nonEmptyString(account.accountId)
  if (accountId === null) return null
  const alias = nonEmptyString(account.accountAlias)
  return { accountId, accountAlias: alias }
}

function extractTaskOutput(
  toolUseResult: unknown,
): ToolResultProjection['taskOutput'] | null {
  if (!isRecord(toolUseResult) || toolUseResult.retrieval_status !== 'success') {
    return null
  }
  const task = toolUseResult.task
  if (!isRecord(task) || task.task_type !== 'local_agent') return null
  const taskId = nonEmptyString(task.task_id)
  const description = nonEmptyString(task.description)
  const output = nonEmptyString(task.result) ?? nonEmptyString(task.output)
  if (taskId === null || description === null || output === null) return null
  return { taskId, description, output }
}

/** Canonical display form for names from both live frames and result objects. */
function normalizeAgentName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/^@/, '').trim()
  return normalized.length === 0 ? null : normalized
}

function flattenToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap(part => {
      if (!isRecord(part)) return []
      if (part.type === 'text' && typeof part.text === 'string') {
        return [part.text]
      }
      return []
    })
    .join('\n')
}

/**
 * `toolUseResult` is `unknown` on the wire — "Matches tool's `Output` type"
 * (`coreTypes.generated.ts:308` comment) — so every field is runtime-narrowed,
 * zero casts. Two owned diff-producing output shapes are recognized:
 *  - FileEditTool (`src/tools/FileEditTool/types.ts:63-80`): top-level
 *    `filePath: string` + `structuredPatch: StructuredPatchHunk[]`.
 *  - FilePatchTool / `Apply_patch` (`src/tools/FilePatchTool/types.ts:138-172`,
 *    emitted `FilePatchTool.tsx:453-464`): a multi-file envelope
 *    `files: Array<{ path: string; structuredPatch: StructuredPatchHunk[] }>`.
 *    The single-file `ToolDiffProjection` names ONE path, so the PRIMARY (first
 *    file yielding hunks) is projected; further files in the same patch are not
 *    shown here (the result `content` still enumerates every touched path).
 * Anything else (Bash output, Read contents, a foreign/future tool shape)
 * yields `null` — a degraded ToolCard with plain `content` text, never a crash
 * or a guess.
 */
function extractDiffProjection(
  toolUseResult: unknown,
): ToolDiffProjection | null {
  if (!isRecord(toolUseResult)) return null

  // FileEditTool: single-file, top-level `filePath` + `structuredPatch`.
  const { filePath, structuredPatch, files } = toolUseResult
  if (typeof filePath === 'string' && filePath.length > 0) {
    const hunks = narrowStructuredPatch(structuredPatch)
    return hunks.length === 0 ? null : { filePath, hunks }
  }

  // FilePatchTool / apply_patch: multi-file `files[]` envelope. Project the
  // first file that yields hunks (matches how a single Edit diff is shown).
  if (Array.isArray(files)) {
    for (const file of files) {
      if (!isRecord(file)) continue
      const { path, structuredPatch: filePatch } = file
      if (typeof path !== 'string' || path.length === 0) continue
      const hunks = narrowStructuredPatch(filePatch)
      if (hunks.length > 0) return { filePath: path, hunks }
    }
  }

  return null
}

/** Runtime-narrow a `diff`-package `StructuredPatchHunk[]` (zero casts); a
 * malformed/foreign element is dropped, an all-invalid array yields `[]`. */
function narrowStructuredPatch(structuredPatch: unknown): ToolDiffHunk[] {
  if (!Array.isArray(structuredPatch)) return []
  return structuredPatch.flatMap(hunk => {
    if (!isRecord(hunk)) return []
    const { oldStart, oldLines, newStart, newLines, lines } = hunk
    if (
      typeof oldStart !== 'number' ||
      typeof oldLines !== 'number' ||
      typeof newStart !== 'number' ||
      typeof newLines !== 'number' ||
      !Array.isArray(lines) ||
      !lines.every(line => typeof line === 'string')
    ) {
      return []
    }
    return [{ oldStart, oldLines, newStart, newLines, lines }]
  })
}

/**
 * Display-grouping derived ONLY from the real, wire-verified `name` string
 * each tool invocation carries — never invented chrome. Two distinct name
 * vocabularies feed this, both real:
 *  - CLIENT tool_use.name: a `*_TOOL_NAME` constant grepped from
 *    `src/tools/*Tool/` (`FileEditTool/constants.ts:2` `'Edit'`,
 *    `BashTool/toolName.ts:2` `'Bash'`, `AgentTool/constants.ts:1,3`
 *    `'Agent'`/legacy `'Task'`, `FilePatchTool/constants.ts:1`
 *    `'Apply_patch'`, …).
 *  - SERVER-EXECUTED server_tool_use.name: the Anthropic SDK's closed
 *    literal union (`node_modules/@anthropic-ai/sdk` `ServerToolUseBlock`:
 *    `'web_search' | 'web_fetch' | 'code_execution' |
 *    'bash_code_execution' | 'text_editor_code_execution' |
 *    'tool_search_tool_regex' | 'tool_search_tool_bm25'`) — a DIFFERENT
 *    vocabulary from the client tool names above, not a guess.
 * MCP tool names are dynamic (`mcp__<server>__<tool>`, no fixed constant);
 * anything else unrecognized (a future built-in or server tool) is
 * `'other'` — a real family, not a crash.
 */
function deriveToolFamily(toolName: string): ToolFamily {
  switch (toolName) {
    case 'Bash':
    case 'PowerShell':
    case 'bash_code_execution':
      return 'bash'
    case 'Read':
      return 'read'
    case 'Write':
      return 'write'
    case 'Edit':
    case 'Apply_patch':
    case 'text_editor_code_execution':
      return 'edit'
    case 'Grep':
    case 'Glob':
    case 'tool_search_tool_regex':
    case 'tool_search_tool_bm25':
      return 'grep'
    case 'WebFetch':
    case 'WebSearch':
    case 'web_search':
    case 'web_fetch':
      return 'web'
    case 'NotebookEdit':
      return 'notebook'
    case 'LSP':
      return 'lsp'
    case 'Skill':
    case 'ToolSearch':
      return 'skill'
    case 'Agent':
    case 'Task':
    case 'ResumeAgent':
      return 'agent'
    // `SEND_MESSAGE_TOOL_NAME` (`src/tools/SendMessageTool/constants.ts:1`).
    case 'SendMessage':
      return 'agent-control'
    case 'GenerateImage':
      return 'imagegen'
    default:
      // `code_execution` (generic sandbox, no single-family fit) plus any
      // future/unrecognized name fall through to 'other'.
      if (toolName.startsWith('mcp__')) return 'mcp'
      return 'other'
  }
}

/**
 * Grouping-position tracker over the six nested stream event types (S1 spec
 * §2: message_start / content_block_start / content_block_delta /
 * content_block_stop / message_delta / message_stop). Only the three that
 * carry grouping position or text/thinking deltas are read; the rest are
 * documented no-ops here. Per-message stop_reason/usage (message_delta) is
 * read from the stream/result layer — never projected from assistant frames
 * (S1 §4 trap).
 * Unknown event types (e.g. citations_delta, connector_text_delta, future
 * additions) fall through as tolerated no-ops.
 */
function projectStreamEvent(
  sessionId: SessionId,
  state: TranscriptSessionState,
  message: Extract<SDKMessage, { type: 'stream_event' }>,
): TranscriptSessionState {
  const event = isRecord(message.event) ? message.event : null
  if (!event || typeof event.type !== 'string') return state

  if (event.type === 'message_start') {
    const startedMessage = isRecord(event.message) ? event.message : null
    if (!startedMessage || typeof startedMessage.id !== 'string') return state
    return {
      ...state,
      currentStreamMessageId: startedMessage.id,
      currentStreamBlockIndex: null,
    }
  }

  if (
    event.type === 'content_block_start' &&
    state.currentStreamMessageId &&
    typeof event.index === 'number'
  ) {
    const key = streamBlockKey(state.currentStreamMessageId, event.index)
    const contentBlock = isRecord(event.content_block)
      ? event.content_block
      : null
    if (contentBlock?.type === 'text') {
      const existing = state.streamingTextBlocks[key]
      return {
        ...state,
        currentStreamBlockIndex: event.index,
        streamingTextBlocks: existing
          ? state.streamingTextBlocks
          : {
              ...state.streamingTextBlocks,
              [key]: {
                messageId: state.currentStreamMessageId,
                blockIndex: event.index,
                content: '',
              },
            },
      }
    }
    if (contentBlock?.type === 'thinking') {
      const reasoningKind =
        typeof contentBlock.reasoning_kind === 'string'
          ? contentBlock.reasoning_kind
          : typeof contentBlock.reasoningKind === 'string'
            ? contentBlock.reasoningKind
            : undefined
      const existing = state.streamingThinkingBlocks[key]
      const nextBlock =
        existing && (existing.reasoningKind !== undefined || !reasoningKind)
          ? existing
          : {
              ...(existing ?? {
                messageId: state.currentStreamMessageId,
                blockIndex: event.index,
                content: '',
              }),
              ...(reasoningKind ? { reasoningKind } : {}),
            }
      return {
        ...state,
        currentStreamBlockIndex: event.index,
        streamingThinkingBlocks:
          nextBlock === existing
            ? state.streamingThinkingBlocks
            : { ...state.streamingThinkingBlocks, [key]: nextBlock },
      }
    }
    if (state.streamingTextBlocks[key]) {
      const nextStreamingTextBlocks = { ...state.streamingTextBlocks }
      delete nextStreamingTextBlocks[key]
      return {
        ...state,
        currentStreamBlockIndex: event.index,
        streamingTextBlocks: nextStreamingTextBlocks,
      }
    }
    return { ...state, currentStreamBlockIndex: event.index }
  }

  if (
    event.type === 'content_block_delta' &&
    state.currentStreamMessageId &&
    typeof event.index === 'number'
  ) {
    const delta = isRecord(event.delta) ? event.delta : null
    const key = streamBlockKey(state.currentStreamMessageId, event.index)
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      const existing = state.streamingTextBlocks[key] ?? {
        messageId: state.currentStreamMessageId,
        blockIndex: event.index,
        content: '',
      }
      const nextBlock = {
        ...existing,
        content: existing.content + delta.text,
      }
      const row = createStreamingTextRow(sessionId, nextBlock)
      return {
        ...state,
        currentStreamBlockIndex: event.index,
        streamingTextBlocks: {
          ...state.streamingTextBlocks,
          [key]: nextBlock,
        },
        rows: upsertStreamingRows(state.rows, [row]),
      }
    }
    if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      const existing = state.streamingThinkingBlocks[key] ?? {
        messageId: state.currentStreamMessageId,
        blockIndex: event.index,
        content: '',
      }
      const nextBlock = {
        ...existing,
        content: existing.content + delta.thinking,
      }
      const row = createStreamingThinkingRow(sessionId, nextBlock)
      return {
        ...state,
        currentStreamBlockIndex: event.index,
        streamingThinkingBlocks: {
          ...state.streamingThinkingBlocks,
          [key]: nextBlock,
        },
        rows: upsertStreamingRows(state.rows, [row]),
      }
    }
    return state
  }

  if (event.type === 'message_stop') {
    return {
      ...state,
      currentStreamMessageId: null,
      currentStreamBlockIndex: null,
    }
  }

  return state
}

function createStreamingTextRow(
  sessionId: SessionId,
  block: StreamingTextBlock,
): AssistantTextRow {
  const source = {
    sessionId,
    messageId: block.messageId,
    frameId: `${block.messageId}:stream:${block.blockIndex}`,
    blockIndex: block.blockIndex,
    parentToolUseId: null,
  }
  return {
    ...source,
    id: rowId(source, 'text'),
    kind: 'assistant-text',
    role: 'assistant',
    content: block.content,
    isStreaming: true,
  }
}

function createStreamingThinkingRow(
  sessionId: SessionId,
  block: StreamingThinkingBlock,
): ThinkingRow {
  const source = {
    sessionId,
    messageId: block.messageId,
    frameId: `${block.messageId}:stream:${block.blockIndex}`,
    blockIndex: block.blockIndex,
    parentToolUseId: null,
  }
  return {
    ...source,
    id: rowId(source, 'thinking'),
    kind: 'thinking',
    content: block.content,
    ...(block.reasoningKind ? { reasoningKind: block.reasoningKind } : {}),
    isStreaming: true,
  }
}

function finalizeStreamingTurn(
  state: TranscriptSessionState,
): TranscriptSessionState {
  const hasStreamingRows = state.rows.some(
    isStreamingProjectionRow,
  )
  const hasStreamingState =
    state.currentStreamMessageId !== null ||
    state.currentStreamBlockIndex !== null ||
    Object.keys(state.streamingTextBlocks).length > 0 ||
    Object.keys(state.streamingThinkingBlocks).length > 0
  if (!hasStreamingRows && !hasStreamingState) return state

  // A terminal result can arrive before a stopped assistant block's full frame.
  // Keep its finalized projected content rather than deleting the only
  // assistant response the transcript received.
  const rows = state.rows.map(row =>
    isStreamingProjectionRow(row)
      ? (() => {
          const { isStreaming: _streaming, ...finalized } = row
          void _streaming
          return finalized
        })()
      : row,
  )
  return {
    ...state,
    rows,
    currentStreamMessageId: null,
    currentStreamBlockIndex: null,
    streamingTextBlocks: {},
    streamingThinkingBlocks: {},
  }
}

function upsertRows(
  rows: TranscriptRow[],
  replacements: TranscriptRow[],
): TranscriptRow[] {
  if (replacements.length === 0) return rows
  const upserted = upsertExistingRows(rows, replacements)
  for (const row of upserted.added) upserted.rows.push(row)
  return upserted.rows
}

/**
 * Split one frame's rows into the ones that REPLACE a row already in the list
 * (streaming finalization: same id, so it keeps its position) and the ones that
 * are new to it. Shared by both placements below so the two can never disagree
 * about which is which.
 */
function upsertExistingRows(
  rows: TranscriptRow[],
  replacements: TranscriptRow[],
): { rows: TranscriptRow[]; added: TranscriptRow[] } {
  const byId = new Map(replacements.map(row => [row.id, row]))
  const nextRows = rows.map(row => byId.get(row.id) ?? row)
  const existingIds = new Set(rows.map(row => row.id))
  return {
    rows: nextRows,
    added: replacements.filter(row => !existingIds.has(row.id)),
  }
}

/**
 * Where the assistant path's rows go, which is the same question
 * `appendFrameRows` answers for every other path (B1,
 * decisions/HISTORY-LOAD-EARLIER.md). Kept separate because this path upserts:
 * a row whose id is already present is a finalized stream and must stay where
 * it stands, on both placements.
 */
function upsertFrameRows(
  state: TranscriptSessionState,
  replacements: TranscriptRow[],
): { rows: TranscriptRow[]; recoveryInsertAt: number | null } {
  if (replacements.length === 0) {
    return { rows: state.rows, recoveryInsertAt: state.recoveryInsertAt }
  }
  // B1: the same single branch `appendFrameRows` carries, on the same
  // condition. Only a `recovered` event frame can leave the cursor non-null, so
  // an ordinary assistant frame still lands on the plain upsert below.
  if (state.recoveryInsertAt !== null) {
    const upserted = upsertExistingRows(state.rows, replacements)
    upserted.rows.splice(state.recoveryInsertAt, 0, ...upserted.added)
    return {
      rows: upserted.rows,
      recoveryInsertAt: state.recoveryInsertAt + upserted.added.length,
    }
  }
  return { rows: upsertRows(state.rows, replacements), recoveryInsertAt: null }
}

function upsertStreamingRows(
  rows: TranscriptRow[],
  replacements: (AssistantTextRow | ThinkingRow)[],
): TranscriptRow[] {
  if (replacements.length === 0) return rows
  const byId = new Map(replacements.map(row => [row.id, row]))
  const nextRows = rows.map(row => {
    const replacement = byId.get(row.id)
    if (replacement && isMatchingStreamingRow(row, replacement)) {
      return replacement
    }
    return row
  })
  const existingIds = new Set(rows.map(row => row.id))
  for (const row of replacements) {
    if (!existingIds.has(row.id)) nextRows.push(row)
  }
  return nextRows
}

function isStreamingProjectionRow(
  row: TranscriptRow,
): row is AssistantTextRow | ThinkingRow {
  return (
    (row.kind === 'assistant-text' || row.kind === 'thinking') &&
    row.isStreaming === true
  )
}

function isMatchingStreamingRow(
  row: TranscriptRow,
  replacement: AssistantTextRow | ThinkingRow,
): boolean {
  return (
    row.id === replacement.id &&
    isStreamingProjectionRow(row) &&
    row.kind === replacement.kind
  )
}

function streamBlockKey(messageId: string, blockIndex: number): string {
  return `${messageId}:${blockIndex}`
}

/**
 * The engine publishes the completed assistant block before the corresponding
 * content_block_stop. When Codex has both raw and summary reasoning open, the
 * most recent stream index belongs to raw even as summary closes next. The
 * remaining live block is the unambiguous source of the completed row's index.
 */
function streamingThinkingBlockIndex(
  messageId: string,
  block: unknown,
  streamingBlocks: Record<string, StreamingThinkingBlock>,
): number | null {
  if (!isRecord(block) || block.type !== 'thinking') return null
  const reasoningKind =
    typeof block.reasoningKind === 'string'
      ? block.reasoningKind
      : typeof block.reasoning_kind === 'string'
        ? block.reasoning_kind
        : undefined
  const matches = Object.values(streamingBlocks).filter(
    streamingBlock =>
      streamingBlock.messageId === messageId &&
      streamingBlock.reasoningKind === reasoningKind,
  )
  return matches.length === 1 ? matches[0]!.blockIndex : null
}

/**
 * A retry frame carries `error` as either an object with display copy or a
 * bare classification code. Only the object form was ever rendered, so a
 * replayed transcript from before the engine emitted objects would silently
 * lose its retry notices. Codes map to the same copy the engine writes rather
 * than being printed: the code is an internal name, not something to show.
 *
 * TWIN: `RETRY_NOTICE_COPY` in `src/utils/messages/mappers.ts` is the engine's
 * copy of this table, compile-enforced exhaustive over `SDKAssistantErrorCode`.
 * This one cannot import it across the trust boundary; keep them in step.
 */
const RETRY_NOTICE_COPY_BY_CODE: Record<string, string> = {
  rate_limit: 'Rate limited. Retrying.',
  authentication_failed: 'Sign-in problem. Retrying.',
  billing_error: 'Billing problem. Retrying.',
  invalid_request: 'The request was rejected. Retrying.',
  server_error: 'The service returned an error. Retrying.',
  max_output_tokens: 'The response was cut off. Retrying.',
  unknown: 'The request failed. Retrying.',
}

function retryNoticeText(error: unknown): string | null {
  if (isRecord(error) && typeof error.message === 'string') {
    return error.message
  }
  if (typeof error === 'string') {
    return RETRY_NOTICE_COPY_BY_CODE[error] ?? RETRY_NOTICE_COPY_BY_CODE.unknown!
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Content blocks are typed `unknown[]` on the wire
 * (`coreTypes.generated.ts:96`), so discriminants are read at runtime with
 * zero casts. Explicit block dispositions:
 *  - `text` → AssistantTextRow.
 *  - `tool_use`, `server_tool_use`, `mcp_tool_use` → ToolCard rows; server
 *    tool results may ride a later assistant frame and are folded separately.
 *  - `thinking`, `redacted_thinking` → P2-1 rows. Codex thinking carries a
 *    non-standard `reasoning_kind: 'summary'|'raw'` at stream start and the
 *    stored block uses `reasoningKind`; both spellings are preserved by value.
 *  - `*_tool_result` block types (`web_search_tool_result`,
 *    `code_execution_tool_result`, `mcp_tool_result`, `web_fetch_tool_result`,
 *    `bash_code_execution_tool_result`, `text_editor_code_execution_tool_result`,
 *    `tool_search_tool_result`) → no row of their own; they are RESULTS, not
 *    invocations, and are folded into the correlation map by
 *    `foldToolResultBlocks`, never rendered as a standalone row.
 *  - `container_upload`, `compaction` → no row: neither is a tool invocation
 *    or result; out of P2-2 scope.
 *  - malformed or future/unknown block shapes → tolerated no-op, never a
 *    crash, never a partial row.
 */
function projectAssistantContentBlock(
  block: unknown,
  source: Omit<RowSource, 'id'>,
): TranscriptRow | null {
  if (!isRecord(block) || typeof block.type !== 'string') return null

  switch (block.type) {
    case 'text':
      if (typeof block.text !== 'string') return null
      return {
        ...source,
        id: rowId(source, 'text'),
        kind: 'assistant-text',
        role: 'assistant',
        content: block.text,
      }

    case 'tool_use':
    case 'server_tool_use':
    case 'mcp_tool_use':
      if (typeof block.id !== 'string' || typeof block.name !== 'string') {
        return null
      }
      return {
        ...source,
        id: rowId(source, block.id),
        kind: 'tool-use',
        toolUseId: block.id,
        toolName: block.name,
        toolFamily: deriveToolFamily(block.name),
        input: isRecord(block.input) ? block.input : {},
        // Correlation-derived, never authored here (S1/INVENTORY: status is
        // not stored). selectTranscriptRows attaches the real value on read;
        // these are the pre-correlation defaults for a row that was just
        // minted this tick, before any read has happened yet.
        status: 'pending',
        result: null,
        agentCompletion: null,
      }

    case 'thinking': {
      if (typeof block.thinking !== 'string') return null
      const signature = optionalString(block.signature)
      const snakeReasoningKind = optionalString(block.reasoning_kind)
      const camelReasoningKind = optionalString(block.reasoningKind)
      if (
        signature === null ||
        snakeReasoningKind === null ||
        camelReasoningKind === null
      ) {
        return null
      }
      return {
        ...source,
        id: rowId(source, 'thinking'),
        kind: 'thinking',
        content: block.thinking,
        ...(signature === undefined ? {} : { signature }),
        ...(camelReasoningKind === undefined &&
        snakeReasoningKind === undefined
          ? {}
          : { reasoningKind: camelReasoningKind ?? snakeReasoningKind }),
      }
    }

    case 'redacted_thinking':
      if (typeof block.data !== 'string') return null
      return {
        ...source,
        id: rowId(source, 'redacted-thinking'),
        kind: 'redacted-thinking',
        data: block.data,
      }

    case 'web_search_tool_result':
    case 'code_execution_tool_result':
    case 'mcp_tool_result':
    case 'web_fetch_tool_result':
    case 'bash_code_execution_tool_result':
    case 'text_editor_code_execution_tool_result':
    case 'tool_search_tool_result':
      // Results, not invocations — folded by foldToolResultBlocks, not rowed.
      return null

    default:
      // `container_upload`/`compaction`/unknown or malformed blocks —
      // documented no-op (see function doc).
      return null
  }
}

function projectUserContentBlock(
  block: unknown,
  source: Omit<RowSource, 'id'>,
  metadata: {
    timestamp?: string
    isReplay: boolean
    origin: InjectedOrigin | null
  },
):
  | UserTextRow
  | CommandEchoRow
  | UserImageRow
  | TaskNotificationRow
  | InjectedTurnRow
  | SystemNoticeRow
  | null {
  if (!isRecord(block) || typeof block.type !== 'string') return null
  const { origin, ...rowMetadata } = metadata

  if (block.type === 'text') {
    if (typeof block.text !== 'string') return null
    // Provenance outranks every text heuristic below: an injected turn may
    // legitimately contain a `<command-message>` or any other marker, and the
    // operator must never be shown as its author.
    if (origin && origin.kind === 'task-notification') {
      return {
        ...source,
        ...rowMetadata,
        id: rowId(source, 'task-notification'),
        kind: 'task-notification',
        status: origin.status,
        summary: origin.completion?.summary ?? null,
        toolUseId: origin.toolUseId,
      }
    }
    if (origin) {
      return {
        ...source,
        ...rowMetadata,
        id: rowId(source, 'injected-turn'),
        kind: 'injected-turn',
        injectedKind: origin.kind,
        label: origin.label,
        content: block.text,
      }
    }
    // Ordered ahead of the command-echo heuristic exactly as the terminal
    // orders them (UserTextMessage.tsx:69-81 sits above its `<command-message>`
    // check): this one is an anchored `startsWith`, so it cannot capture a turn
    // that merely mentions the tag, while command output that happens to quote
    // `<command-message>` must not be re-read as an operator command.
    const commandOutput = parseCommandOutput(block.text)
    if (commandOutput !== null) {
      const notice = stripCompactionEcho(commandOutput)
      if (notice === null) return null
      return {
        id: rowId(source, 'local-command-output'),
        sessionId: source.sessionId,
        frameId: source.frameId,
        kind: 'system-notice',
        noticeType: 'local_command_output',
        content: notice,
      }
    }
    const command = parseCommandEcho(block.text)
    if (command === false) return null
    if (command) {
      return {
        ...source,
        ...rowMetadata,
        id: rowId(source, 'command-echo'),
        kind: 'command-echo',
        ...command,
      }
    }
    if (isLegacyTaskNotificationBanner(block.text)) {
      // A pre-`origin` stored transcript: the legacy XML envelope is the only
      // provenance those frames ever carry (see TaskNotificationRow doc).
      return {
        ...source,
        ...rowMetadata,
        id: rowId(source, 'task-notification'),
        kind: 'task-notification',
        status: parseLegacyTaskNotificationStatus(block.text),
        // The envelope's own `<summary>`, not the envelope. These transcripts
        // predate `origin`, so they carry no join key and always stay a row.
        summary: nonEmptyString(extractXmlTag(block.text, 'summary')?.trim()),
        toolUseId: null,
      }
    }
    return {
      ...source,
      ...rowMetadata,
      id: rowId(source, 'user-text'),
      kind: 'user-text',
      role: 'user',
      content: block.text,
    }
  }

  if (block.type === 'image') {
    const imageSource = projectUserImageSource(block.source)
    if (!imageSource) return null
    return {
      ...source,
      ...metadata,
      id: rowId(source, 'user-image'),
      kind: 'user-image',
      source: imageSource,
    }
  }

  // tool_result is P2-2 correlation scope; future blocks are tolerated.
  return null
}

function projectUserImageSource(source: unknown): UserImageSource | null {
  if (!isRecord(source)) return null
  if (source.type === 'base64') {
    return typeof source.media_type === 'string' &&
      typeof source.data === 'string'
      ? {
          type: 'base64',
          mediaType: source.media_type,
          data: source.data,
        }
      : null
  }
  if (source.type === 'url') {
    return typeof source.url === 'string'
      ? { type: 'url', url: source.url }
      : null
  }
  return null
}

function parseCommandEcho(
  text: string,
):
  | {
      commandName: string
      args: string | null
      content: string
      skillFormat: boolean
    }
  | false
  | null {
  const commandOpen = '<command-message>'
  if (!text.includes(commandOpen)) return null
  const commandName = extractXmlTag(text, 'command-message')?.trim()
  if (!commandName) return false
  const args = extractXmlTag(text, 'command-args')?.trim() || null
  const skillFormat = extractXmlTag(text, 'skill-format') === 'true'
  return {
    commandName,
    args,
    content: skillFormat
      ? `Skill(${commandName})`
      : `/${[commandName, args].filter(Boolean).join(' ')}`,
    skillFormat,
  }
}

/**
 * The engine persists a command's RESULT as a plain `type:'user'` message whose
 * entire content is the raw wrapper: local slash commands at
 * `src/utils/processUserInput/processSlashCommand.tsx:625`, bash-mode (`!`)
 * commands at `src/utils/processUserInput/processBashCommand.tsx:109,125,132`.
 * It is command output, not something the operator typed, and the terminal has
 * always special-cased both shapes at render time
 * (`src/components/messages/UserTextMessage.tsx:69-81` →
 * `UserBashOutputMessage.tsx` / `UserLocalCommandOutputMessage.tsx:22-41`).
 * Without the same branch the app showed it as the operator's own right-aligned
 * bubble, tags and ANSI bytes included (bug, 2026-07-29; bash added 2026-07-29).
 *
 * NOT `<bash-input>`: that IS the operator's typed command, and the terminal
 * deliberately routes it elsewhere via `includes` rather than `startsWith`
 * (`UserTextMessage.tsx:102` → `UserBashInputMessage`). It needs an input-style
 * row, which is an open design question, so it is excluded here on purpose.
 *
 * `startsWith` rather than `includes`, matching the engine predicate: only a
 * message that IS the wrapper qualifies, never one that quotes it.
 *
 * Returns the tag-free, ANSI-free payload, or null when this is not that shape.
 */
function parseCommandOutput(text: string): string | null {
  if (!COMMAND_OUTPUT_TAGS.some(tag => text.startsWith(`<${tag}`))) {
    return null
  }
  const payloads = COMMAND_OUTPUT_TAGS.map(tag => {
    const payload = extractXmlTag(text, tag)
    if (payload === null || tag !== 'bash-stdout') return payload
    // Large `!` output nests a SECOND wrapper inside the stdout payload
    // (`src/utils/processUserInput/processBashCommand.tsx:106` keeps
    // `buildLargeToolResultMessage`'s `<persisted-output>` unescaped on
    // purpose). Same fallback semantics as the terminal's
    // `extractTag(rawStdout, 'persisted-output') ?? rawStdout`
    // (`src/components/messages/UserBashOutputMessage.tsx:14-18`): absent inner
    // tag leaves the payload untouched. Scoped to bash exactly as the terminal
    // scopes it, since `UserLocalCommandOutputMessage.tsx:22-23` does no such
    // unwrapping.
    return extractXmlTag(payload, 'persisted-output') ?? payload
  })
    .map(payload => stripAnsiSequences(payload ?? '').trim())
    .filter(payload => payload.length > 0)
  return payloads.length === 0 ? COMMAND_OUTPUT_NO_CONTENT : payloads.join('\n')
}

/**
 * `/compact`'s own stdout, minus the part that is only true in a terminal.
 *
 * The engine prints `Compacted (ctrl+o to see full summary)`
 * (`src/commands/compact/compact.ts` `buildDisplayText`), where the shortcut
 * comes from the TUI keymap. This app has neither that binding nor a
 * full-summary view, so the line advertises an affordance that does not exist,
 * and the sentence it introduces is already the compaction seam's job.
 *
 * Only that preamble is dropped. A PreCompact/PostCompact hook's
 * `userDisplayMessage` is joined onto the same string and is real output, so
 * whatever follows survives as an ordinary notice; a row is dropped only when
 * nothing but the preamble was there. The shortcut is matched as "a
 * parenthesised group on the first line" rather than the literal `ctrl+o`,
 * because `getShortcutDisplay` reports the user's own binding.
 */
export function stripCompactionEcho(content: string): string | null {
  const match = /^Compacted(?:[ \t]+\([^)\n]*\))?[ \t]*(?:\n|$)/.exec(content)
  if (match === null) return content
  const rest = content.slice(match[0].length).trim()
  return rest.length === 0 ? null : rest
}

/**
 * Both engine wrapper families, in the order their payloads are joined. The
 * bash pair is listed first to mirror the terminal's own branch order
 * (`UserTextMessage.tsx:69-81`); the two families are mutually exclusive under
 * the anchored `startsWith` above, so the order only fixes stdout-before-stderr
 * within a family.
 */
const COMMAND_OUTPUT_TAGS = [
  'bash-stdout',
  'bash-stderr',
  'local-command-stdout',
  'local-command-stderr',
]

/**
 * Both payloads empty: the terminal shows `NO_CONTENT_MESSAGE`
 * (`UserLocalCommandOutputMessage.tsx:24-34`, `src/constants/messages.ts:1`).
 * Copied rather than imported so the renderer bundle stays engine-free. Applied
 * to bash output too, where the terminal instead renders an empty
 * `BashToolResultMessage` (`UserBashOutputMessage.tsx:14-18`): a notice row with
 * no text at all would read as a rendering fault, so the placeholder is reused.
 */
const COMMAND_OUTPUT_NO_CONTENT = '(no content)'

/**
 * CSI escape sequences (`ESC [ … final`), which is what real transcripts carry:
 * slash-command results are built with chalk, and the engine's own `stripAnsi`
 * passes (`src/QueryEngine.ts:673`, `src/utils/messages/mappers.ts:266`) do NOT
 * cover `toSDKMessages`' `case 'user'` (mappers.ts:191-213), so the raw bytes
 * reach the app on the resume path.
 */
const ANSI_ESCAPE_SEQUENCE = /\u001B\[[0-9;:?]*[\u0020-\u002F]*[\u0040-\u007E]/g

function stripAnsiSequences(text: string): string {
  return text.replace(ANSI_ESCAPE_SEQUENCE, '')
}

function extractXmlTag(text: string, tag: string): string | null {
  const startToken = `<${tag}>`
  const endToken = `</${tag}>`
  const start = text.indexOf(startToken)
  if (start < 0) return null
  const contentStart = start + startToken.length
  const end = text.indexOf(endToken, contentStart)
  return end < 0 ? null : text.slice(contentStart, end)
}

const LEGACY_TASK_NOTIFICATION_TAG = '<task-notification>'

/**
 * True for the LEGACY `<task-notification>` XML envelope. Kept because real
 * stored transcripts written before `SDKUserMessage.origin` existed carry no
 * provenance at all, and this envelope is the only marker they have. It is a
 * frozen historical format — unlike the structured-banner check it replaced (a
 * hand-copy of `isTaskNotificationText`, `src/utils/taskNotification.ts:105`),
 * it cannot silently drift when the engine rewords its banner, because no live
 * emitter produces it any more (`parseTaskNotificationDetails` calls it
 * "compatibility-only", taskNotification.ts:119).
 */
function isLegacyTaskNotificationBanner(text: string): boolean {
  return text.trim().startsWith(LEGACY_TASK_NOTIFICATION_TAG)
}

/** The legacy envelope's `<status>` tag; null when absent. */
function parseLegacyTaskNotificationStatus(text: string): string | null {
  return /<status>([\s\S]*?)<\/status>/.exec(text)?.[1]?.trim() || null
}

/**
 * The renderer-side narrowing of `SDKUserMessage.origin` (protocol.ts
 * `EventFrame` §User-turn provenance): the row-relevant facts only, with
 * `kind` kept as a plain string so a kind minted by a newer engine still
 * produces an injected row instead of falling back to a user bubble.
 */
type InjectedOrigin = {
  kind: string
  /** Sender handle when the origin names one; null otherwise. */
  label: string | null
  /** `task-notification` status; null for every other kind. */
  status: string | null
  /** `task-notification` display fields; null for every other kind. */
  completion: AgentCompletionProjection | null
  /** `task-notification` join key back to the spawning agent card. */
  toolUseId: string | null
}

/**
 * Narrow an unknown `origin` off the wire. Returns null for absent, malformed,
 * or explicitly `human` provenance — all three mean "render as the operator's
 * own turn", which is also the correct reading for every frame that predates
 * the field. Runtime-narrowed with no casts: the claim arrives from the far
 * side of a socket, so nothing is trusted structurally.
 */
function projectMessageOrigin(value: unknown): InjectedOrigin | null {
  if (!isRecord(value)) return null
  const kind = nonEmptyString(value.kind)
  if (!kind || kind === 'human') return null
  const server = nonEmptyString(value.server)
  const user = nonEmptyString(value.user)
  const from = nonEmptyString(value.from)
  const name = nonEmptyString(value.name)
  const label =
    kind === 'channel'
      ? server === null
        ? null
        : user === null
          ? server
          : `${server} · ${user}`
      : kind === 'teammate'
        ? from
        : kind === 'peer'
          ? // The sending peer's NAME, the only sender fact the SDK projection
            // carries (`SDKMessageOrigin`'s `peer` member is `{ kind, name }` —
            // `appSessionId` is deliberately engine-side only). Without a label
            // the row would name no sender at all, which is the whole point of
            // an incoming peer message.
            name
          : null
  const isTaskNotification = kind === 'task-notification'
  const status = isTaskNotification ? nonEmptyString(value.status) : null
  return {
    kind,
    label,
    status,
    toolUseId: isTaskNotification ? nonEmptyString(value.toolUseId) : null,
    completion: isTaskNotification
      ? {
          status,
          summary: nonEmptyString(value.summary),
          result: nonEmptyString(value.result),
          usage: projectAgentCompletionUsage(value.usage),
        }
      : null,
  }
}

/**
 * The three numbers off the wire, all-or-nothing: a partial `usage` object
 * would render as a stat line with holes in it, so anything that is not three
 * finite numbers reads as "no usage" instead. Runtime-narrowed, no casts — the
 * claim comes from the far side of a socket.
 */
function projectAgentCompletionUsage(
  value: unknown,
): { totalTokens: number; toolUses: number; durationMs: number } | null {
  if (!isRecord(value)) return null
  const { totalTokens, toolUses, durationMs } = value
  if (
    typeof totalTokens !== 'number' ||
    typeof toolUses !== 'number' ||
    typeof durationMs !== 'number' ||
    !Number.isFinite(totalTokens) ||
    !Number.isFinite(toolUses) ||
    !Number.isFinite(durationMs)
  ) {
    return null
  }
  return { totalTokens, toolUses, durationMs }
}

function rowId(source: Omit<RowSource, 'id'>, blockId: string): string {
  return `${source.sessionId}:${source.messageId}:${source.blockIndex}:${blockId}`
}

function frameRowId(
  sessionId: SessionId,
  frameId: string,
  rowKind: string,
): string {
  return `${sessionId}:${frameId}:${rowKind}`
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function optionalString(value: unknown): string | null | undefined {
  return value === undefined
    ? undefined
    : typeof value === 'string'
      ? value
      : null
}

function optionalNumber(value: unknown): number | null | undefined {
  return value === undefined
    ? undefined
    : typeof value === 'number'
      ? value
      : null
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? value
    : null
}

function optionalStringArray(value: unknown): string[] | null | undefined {
  return value === undefined ? undefined : stringArray(value)
}
