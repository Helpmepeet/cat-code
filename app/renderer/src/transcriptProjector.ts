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
 */

import type { SDKMessage } from '@cat-code/engine/session-events'
import type {
  ServerFrame,
  SessionId,
} from '../../shared/protocol.js'
import { isAppReadyFrame } from './connectionState.js'

type FrameRowSource = {
  /** Stable React/projector identity derived only from producer identifiers. */
  id: string
  sessionId: SessionId
  /** SDK frame UUID supplied by the producer. */
  frameId: string
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
  | 'imagegen'
  | 'other'

export type ToolCardStatus = 'pending' | 'success' | 'error'

/**
 * One correlated `tool_result` content block (rides a `user` SDKMessage,
 * `queryHelpers.ts:203-218`). `diff` is populated only when the block's
 * companion `tool_use_result` carries a FileEditTool-shaped
 * `structuredPatch: StructuredPatchHunk[]` (`FileEditTool/types.ts:71-73`,
 * `diff` npm package hunk shape) — narrowed at runtime, never cast; anything
 * else (Bash stdout, Read contents, …) surfaces as plain `content` text with
 * `diff: null`. Malformed/foreign shapes degrade to `diff: null`, never crash.
 */
export type ToolResultProjection = {
  isError: boolean
  content: string
  diff: ToolDiffProjection | null
}

/**
 * `MultiDiffCard` (prototype) is not a distinct message type or a distinct
 * tool — `FileEditTool`'s own multi-edit input (`edits: EditInput[]`) can
 * still only ever produce ONE `structuredPatch` for the ONE file it edited
 * (`FileEditTool/types.ts` output schema has no per-file array). "Multiple
 * files changed in one turn" is multiple separate `tool_use`/`tool_result`
 * pairs, each its own single-file `ToolDiffProjection` — there is no seam
 * shape for a single result spanning many files. `files.length > 1` here
 * models multiple hunks returned for the ONE edited file (structuredPatch is
 * already an array of hunks); DiffView renders one hunk, MultiDiffCard
 * switches between hunks the same way the prototype's FileEditCard switches
 * between files — same component, adapted to the real one-file-many-hunks
 * shape instead of an invented many-files shape.
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

export type SystemNoticeRow = FrameRowSource & {
  kind: 'system-notice'
  noticeType: 'api_retry' | 'local_command_output' | 'account_diagnostic'
  content: string
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
  | SystemNoticeRow
  | ResultRow
  | CompactBoundaryRow
  | SnipBoundaryRow
  | TombstoneRow

type StreamingTextBlock = {
  messageId: string
  blockIndex: number
  content: string
}

type TranscriptSessionState = {
  rows: TranscriptRow[]
  currentStreamMessageId: string | null
  currentStreamBlockIndex: number | null
  streamingTextBlocks: Record<string, StreamingTextBlock>
  nextBlockIndexByMessageId: Record<string, number>
  seenFrameIds: Record<string, true>
  /**
   * P2-2 correlation map: `tool_use_id` → the correlated `tool_result`, once
   * its `user` frame arrives. Absence means pending/running. This is the ONLY
   * place tool status lives — never written onto a `ToolUseRow` in `rows`.
   */
  toolResultsByUseId: Record<string, ToolResultProjection>
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
    nextBlockIndexByMessageId: {},
    seenFrameIds: {},
    toolResultsByUseId: {},
    slashCommands: [],
  }
}

export function createTranscriptState(): TranscriptState {
  return { sessions: {} }
}

/**
 * Rows are stored as pure producer facts; tool status/result are joined in
 * HERE from the correlation map on every read, never mutated onto a stored
 * row. A `tool-use` row with no matching entry yet reads as `pending`.
 */
export function selectTranscriptRows(
  state: TranscriptState,
  sessionId: SessionId | null,
): TranscriptRow[] {
  const session = sessionId ? state.sessions[sessionId] : undefined
  if (!session) return []
  return session.rows.map(row => {
    if (row.kind !== 'tool-use') return row
    const result = session.toolResultsByUseId[row.toolUseId] ?? null
    const status: ToolCardStatus = result
      ? result.isError
        ? 'error'
        : 'success'
      : 'pending'
    if (row.status === status && row.result === result) return row
    return { ...row, status, result }
  })
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

/**
 * D2/C4: subagent frames (`parentToolUseId` non-null) must NEST under the
 * owning Agent tool card, never interleave at the transcript top level. This
 * arranges the flat, arrival-ordered `selectTranscriptRows` output into a
 * tree: top-level rows in arrival order, each carrying the child rows whose
 * `parentToolUseId` matches its own `toolUseId`. A child row whose parent
 * never arrived (or isn't a tool-use row) surfaces at top level rather than
 * being silently dropped — degraded placement, not data loss.
 */
export type NestedTranscriptRow = TranscriptRow & {
  children: NestedTranscriptRow[]
}

// Perf (2026-07-08, F3): the nested-row tree is a pure function of ONE session
// slice, and `projectServerFrame` replaces that slice object only when its rows
// actually change (`if (projected === session) return state`). So caching the
// result on the slice reference makes repeated reads (unrelated App re-renders —
// keystrokes, another session's frame) return an IDENTICAL array, which lets the
// `React.memo`'d TranscriptView/rows skip re-rendering. A new slice (real change)
// misses the cache and recomputes. WeakMap ⇒ evicts with the slice, no leak.
const nestedRowsCache = new WeakMap<TranscriptSessionState, NestedTranscriptRow[]>()
const EMPTY_NESTED_ROWS: NestedTranscriptRow[] = []

export function selectNestedTranscriptRows(
  state: TranscriptState,
  sessionId: SessionId | null,
): NestedTranscriptRow[] {
  const session = sessionId ? state.sessions[sessionId] : undefined
  if (!session) return EMPTY_NESTED_ROWS
  const cached = nestedRowsCache.get(session)
  if (cached) return cached

  const rows = selectTranscriptRows(state, sessionId)
  const byToolUseId = new Map<string, TranscriptRow>()
  for (const row of rows) {
    if (row.kind === 'tool-use') byToolUseId.set(row.toolUseId, row)
  }

  const childrenByParentId = new Map<string, TranscriptRow[]>()
  const topLevel: TranscriptRow[] = []
  for (const row of rows) {
    const parentId =
      'parentToolUseId' in row ? row.parentToolUseId : null
    if (parentId && byToolUseId.has(parentId)) {
      const siblings = childrenByParentId.get(parentId)
      if (siblings) siblings.push(row)
      else childrenByParentId.set(parentId, [row])
    } else {
      topLevel.push(row)
    }
  }

  const attachChildren = (row: TranscriptRow): NestedTranscriptRow => ({
    ...row,
    children: (
      row.kind === 'tool-use' ? (childrenByParentId.get(row.toolUseId) ?? []) : []
    ).map(attachChildren),
  })
  const result = topLevel.map(attachChildren)
  nestedRowsCache.set(session, result)
  return result
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
  return row.kind === 'tool-use' && row.toolFamily === 'agent'
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
): TranscriptDisplayItem[] {
  return groupAgentDelegates(selectNestedTranscriptRows(state, sessionId))
}

/** Reducer over addressed server frames; unknown sessions are rejected. */
export function projectServerFrame(
  state: TranscriptState,
  frame: ServerFrame,
): TranscriptState {
  if (isAppReadyFrame(frame)) {
    return {
      ...state,
      sessions: {
        ...state.sessions,
        [frame.sessionId]:
          state.sessions[frame.sessionId] ?? createTranscriptSessionState(),
      },
    }
  }

  if (frame.kind !== 'event') return state
  const session = state.sessions[frame.sessionId]
  if (!session) return state
  if (frame.event.type !== 'message') return state

  const projected = projectMessage(frame.sessionId, session, frame.event.message)
  if (projected === session) return state
  return {
    ...state,
    sessions: { ...state.sessions, [frame.sessionId]: projected },
  }
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
      // blocks. Fold correlation first, then project visible user rows.
      return projectUserFrame(
        sessionId,
        correlateToolResults(state, message),
        message,
      )

    case 'result':
      // Result is the only turn-end marker: prune orphan previews before
      // projecting the authoritative P2-1 boundary row.
      return projectResultFrame(
        sessionId,
        finalizeStreamingTurn(state),
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

  const messageId =
    typeof body.id === 'string' && body.id.length > 0 ? body.id : frameId
  if (!messageId) return state

  const parentToolUseId =
    typeof message.parent_tool_use_id === 'string' &&
    message.parent_tool_use_id.length > 0
      ? message.parent_tool_use_id
      : null

  // NB: `message.error` (SDKAssistantMessageError) may ride this frame with
  // empty content — P2-1's ApiErrorRow scope; blocks below still project.

  const fallbackIndex = state.nextBlockIndexByMessageId[messageId] ?? 0
  const firstBlockIndex =
    state.currentStreamMessageId === messageId &&
    state.currentStreamBlockIndex !== null
      ? state.currentStreamBlockIndex
      : fallbackIndex
  const stableFrameId = frameId ?? `${messageId}:block-${firstBlockIndex}`
  const rows = body.content.flatMap((block, localIndex) => {
    const blockIndex = firstBlockIndex + localIndex
    const row = projectAssistantContentBlock(block, {
      sessionId,
      messageId,
      frameId: stableFrameId,
      blockIndex,
      parentToolUseId,
    })
    return row === null ? [] : [row]
  })
  const nextBlockIndex = Math.max(
    fallbackIndex,
    firstBlockIndex + body.content.length,
  )
  const nextStreamingTextBlocks = { ...state.streamingTextBlocks }
  for (const row of rows) {
    if ('messageId' in row && 'blockIndex' in row) {
      delete nextStreamingTextBlocks[
        streamBlockKey(row.messageId, row.blockIndex)
      ]
    }
  }
  const streamingTextBlocks =
    Object.keys(nextStreamingTextBlocks).length ===
    Object.keys(state.streamingTextBlocks).length
      ? state.streamingTextBlocks
      : nextStreamingTextBlocks

  return {
    ...state,
    rows: rows.length === 0 ? state.rows : upsertRows(state.rows, rows),
    streamingTextBlocks,
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
  if (message.isSynthetic === true) return state

  const frameId = nonEmptyString(message.uuid)
  const body: unknown = message.message
  if (!frameId || !isRecord(body)) return state
  if (state.seenFrameIds[frameId]) return state

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
  const timestamp =
    message.timestamp === undefined
      ? undefined
      : nonEmptyString(message.timestamp)
  if (message.timestamp !== undefined && timestamp === null) return state

  const rows = blocks.flatMap((block, blockIndex) => {
    const row = projectUserContentBlock(block, {
      sessionId,
      messageId,
      frameId,
      blockIndex,
      parentToolUseId,
    }, {
      isReplay: message.isReplay === true,
      timestamp: timestamp ?? undefined,
    })
    return row === null ? [] : [row]
  })
  if (rows.length === 0) return state
  return appendFrameRows(state, frameId, rows)
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

    case 'compact_boundary': {
      const metadata = message.compact_metadata
      if (
        !isRecord(metadata) ||
        (metadata.trigger !== 'manual' && metadata.trigger !== 'auto') ||
        typeof metadata.pre_tokens !== 'number'
      ) {
        return state
      }
      return appendFrameRows(state, frameId, [
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
      const error = message.error
      if (!isRecord(error) || typeof error.message !== 'string') return state
      return appendSystemNotice(
        state,
        sessionId,
        frameId,
        'api_retry',
        error.message,
      )
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
  return {
    ...state,
    rows: [...state.rows, ...rows],
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
  return foldToolResultBlocks(state, body.content, message.tool_use_result)
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
): TranscriptSessionState {
  let next: Record<string, ToolResultProjection> | null = null
  for (const block of content) {
    if (!isRecord(block) || typeof block.type !== 'string') continue
    if (!isToolResultBlockType(block.type)) continue
    const toolUseId = block.tool_use_id
    if (typeof toolUseId !== 'string' || toolUseId.length === 0) continue

    const projection = projectToolResultBlock(block, toolUseResult)
    next = { ...(next ?? state.toolResultsByUseId), [toolUseId]: projection }
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
): ToolResultProjection {
  return {
    isError: block.is_error === true,
    content: flattenToolResultContent(block.content),
    diff: extractDiffProjection(toolUseResult),
  }
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
 * zero casts. Only FileEditTool's output shape
 * (`src/tools/FileEditTool/types.ts:63-80`: `filePath: string`,
 * `structuredPatch: StructuredPatchHunk[]`) is recognized; anything else
 * (Bash output, Read contents, a foreign/future tool shape) yields `null` —
 * a degraded ToolCard with plain `content` text, never a crash or a guess.
 */
function extractDiffProjection(
  toolUseResult: unknown,
): ToolDiffProjection | null {
  if (!isRecord(toolUseResult)) return null
  const { filePath, structuredPatch } = toolUseResult
  if (typeof filePath !== 'string' || filePath.length === 0) return null
  if (!Array.isArray(structuredPatch)) return null

  const hunks = structuredPatch.flatMap(hunk => {
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
  return hunks.length === 0 ? null : { filePath, hunks }
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
      return 'agent'
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
 * carry grouping position or text deltas are read; the rest are documented
 * no-ops here. Per-message stop_reason/usage (message_delta) is read from the
 * stream/result layer — never projected from assistant frames (S1 §4 trap).
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
      return {
        ...state,
        currentStreamBlockIndex: event.index,
        streamingTextBlocks: {
          ...state.streamingTextBlocks,
          [key]: {
            messageId: state.currentStreamMessageId,
            blockIndex: event.index,
            content: '',
          },
        },
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
    if (delta?.type !== 'text_delta' || typeof delta.text !== 'string') {
      return state
    }
    const key = streamBlockKey(state.currentStreamMessageId, event.index)
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

function finalizeStreamingTurn(
  state: TranscriptSessionState,
): TranscriptSessionState {
  const hasStreamingRows = state.rows.some(
    row => row.kind === 'assistant-text' && row.isStreaming === true,
  )
  const hasStreamingState =
    state.currentStreamMessageId !== null ||
    state.currentStreamBlockIndex !== null ||
    Object.keys(state.streamingTextBlocks).length > 0
  if (!hasStreamingRows && !hasStreamingState) return state

  const rows = state.rows.filter(
    row => row.kind !== 'assistant-text' || row.isStreaming !== true,
  )
  return {
    ...state,
    rows,
    currentStreamMessageId: null,
    currentStreamBlockIndex: null,
    streamingTextBlocks: {},
  }
}

function upsertRows(
  rows: TranscriptRow[],
  replacements: TranscriptRow[],
): TranscriptRow[] {
  if (replacements.length === 0) return rows
  const byId = new Map(replacements.map(row => [row.id, row]))
  const nextRows = rows.map(row => byId.get(row.id) ?? row)
  const existingIds = new Set(rows.map(row => row.id))
  for (const row of replacements) {
    if (!existingIds.has(row.id)) nextRows.push(row)
  }
  return nextRows
}

function upsertStreamingRows(
  rows: TranscriptRow[],
  replacements: AssistantTextRow[],
): TranscriptRow[] {
  if (replacements.length === 0) return rows
  const byId = new Map(replacements.map(row => [row.id, row]))
  const nextRows = rows.map(row => {
    const replacement = byId.get(row.id)
    if (
      replacement &&
      row.kind === 'assistant-text' &&
      row.isStreaming === true
    ) {
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

function streamBlockKey(messageId: string, blockIndex: number): string {
  return `${messageId}:${blockIndex}`
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
  metadata: { timestamp?: string; isReplay: boolean },
): UserTextRow | CommandEchoRow | UserImageRow | null {
  if (!isRecord(block) || typeof block.type !== 'string') return null

  if (block.type === 'text') {
    if (typeof block.text !== 'string') return null
    const command = parseCommandEcho(block.text)
    if (command === false) return null
    if (command) {
      return {
        ...source,
        ...metadata,
        id: rowId(source, 'command-echo'),
        kind: 'command-echo',
        ...command,
      }
    }
    return {
      ...source,
      ...metadata,
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

function extractXmlTag(text: string, tag: string): string | null {
  const startToken = `<${tag}>`
  const endToken = `</${tag}>`
  const start = text.indexOf(startToken)
  if (start < 0) return null
  const contentStart = start + startToken.length
  const end = text.indexOf(endToken, contentStart)
  return end < 0 ? null : text.slice(contentStart, end)
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
