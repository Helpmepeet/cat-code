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
 */

import type { SDKMessage } from '@cat-code/engine/session-events'
import type {
  ServerFrame,
  SessionId,
} from '../../shared/protocol.js'
import { isAppReadyFrame } from './connectionState.js'

type RowSource = {
  /** Stable React/projector identity derived only from producer identifiers. */
  id: string
  sessionId: SessionId
  /** Shared API message id; falls back to the assistant frame UUID. */
  messageId: string
  /** SDK assistant-frame UUID, when supplied by the producer. */
  frameId: string
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
}

export type ToolUseRow = RowSource & {
  kind: 'tool-use'
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
}

export type TranscriptRow = AssistantTextRow | ToolUseRow

type TranscriptSessionState = {
  rows: TranscriptRow[]
  currentStreamMessageId: string | null
  currentStreamBlockIndex: number | null
  nextBlockIndexByMessageId: Record<string, number>
  seenFrameIds: Record<string, true>
}

export type TranscriptState = {
  activeSessionId: SessionId | null
  sessions: Record<SessionId, TranscriptSessionState>
}

function createTranscriptSessionState(): TranscriptSessionState {
  return {
    rows: [],
    currentStreamMessageId: null,
    currentStreamBlockIndex: null,
    nextBlockIndexByMessageId: {},
    seenFrameIds: {},
  }
}

export function createTranscriptState(): TranscriptState {
  return { activeSessionId: null, sessions: {} }
}

export function selectTranscriptRows(
  state: TranscriptState,
  sessionId: SessionId | null = state.activeSessionId,
): TranscriptRow[] {
  return sessionId ? (state.sessions[sessionId]?.rows ?? []) : []
}

/** Reducer over addressed server frames; unknown sessions are rejected. */
export function projectServerFrame(
  state: TranscriptState,
  frame: ServerFrame,
): TranscriptState {
  if (isAppReadyFrame(frame)) {
    return {
      activeSessionId: frame.sessionId,
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
      // Droppable garnish (S1 spec §3): only grouping position is tracked;
      // delta accumulation/live preview is P2-3 scope.
      return trackStreamPosition(state, message)

    case 'user':
      // P2-1 scope (user prompt/image rows) + P2-2 scope (`tool_result`
      // blocks ride user frames and correlate to tool_use by id). No row yet.
      return state

    case 'result':
      // The ONLY turn-end marker (S1 spec §3). P2-1 owns the boundary
      // ResultRow; turn totals (usage/modelUsage/total_cost_usd) are read
      // HERE and from message_delta — never off assistant frames (S1 §4
      // stop_reason/usage trap). No transcript row yet.
      return state

    case 'system':
      // Covers SDKSystemMessage + SDKCompactBoundaryMessage +
      // SDKAccountDiagnosticMessage (same discriminant). P2-1 scope:
      // init → SessionInitRow, compact/microcompact boundary rows,
      // hook_*/task_* progress rows, local_command_output/api_retry/
      // account-diagnostic notices. No row yet.
      return state

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
  if (frameId && state.seenFrameIds[frameId]) return state

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

  return {
    ...state,
    rows: rows.length === 0 ? state.rows : [...state.rows, ...rows],
    nextBlockIndexByMessageId: {
      ...state.nextBlockIndexByMessageId,
      [messageId]: nextBlockIndex,
    },
    seenFrameIds: frameId
      ? { ...state.seenFrameIds, [frameId]: true }
      : state.seenFrameIds,
  }
}

/**
 * Grouping-position tracker over the six nested stream event types (S1 spec
 * §2: message_start / content_block_start / content_block_delta /
 * content_block_stop / message_delta / message_stop). Only the three that
 * carry grouping position are read; the rest are documented no-ops here:
 * delta accumulation and live previews are P2-3 scope, and per-message
 * stop_reason/usage (message_delta) is read by P2-3 activity state — never
 * projected from assistant frames (S1 §4 trap). Unknown event types (e.g.
 * citations_delta, connector_text_delta, future additions) fall through as
 * tolerated no-ops.
 */
function trackStreamPosition(
  state: TranscriptSessionState,
  message: SDKMessage,
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
    return { ...state, currentStreamBlockIndex: event.index }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Content blocks are typed `unknown[]` on the wire
 * (`coreTypes.generated.ts:96`), so discriminants are read at runtime with
 * zero casts. Explicit block dispositions (P2-0):
 *  - `text`, `tool_use` → rows (below).
 *  - `thinking`, `redacted_thinking` → no row yet; P2-1 owns
 *    ThinkingBlock/RedactedThinkingBlock (W3 ⚓8). Codex thinking carries a
 *    non-standard `reasoning_kind: 'summary'|'raw'` the P2-1 row must keep.
 *  - default → no row: the engine's own pass-through families
 *    (`server_tool_use`, `web_search_tool_result`,
 *    `code_execution_tool_result`, `mcp_tool_use`, `mcp_tool_result`,
 *    `container_upload`, `web_fetch_tool_result`,
 *    `bash_code_execution_tool_result`,
 *    `text_editor_code_execution_tool_result`, `tool_search_tool_result`,
 *    `compaction` — the `src/utils/messages.ts` block-start list) are P2-2
 *    tool-card scope; malformed or future block shapes are tolerated the
 *    same way. Never a crash, never a partial row.
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
      if (typeof block.id !== 'string' || typeof block.name !== 'string') {
        return null
      }
      return {
        ...source,
        id: rowId(source, block.id),
        kind: 'tool-use',
        toolUseId: block.id,
        toolName: block.name,
        input: isRecord(block.input) ? block.input : {},
      }

    case 'thinking':
    case 'redacted_thinking':
      // P2-1 scope — documented no-op (see function doc).
      return null

    default:
      // P2-2 tool-card families / unknown or malformed blocks — documented
      // no-op (see function doc).
      return null
  }
}

function rowId(source: Omit<RowSource, 'id'>, blockId: string): string {
  return `${source.sessionId}:${source.messageId}:${source.blockIndex}:${blockId}`
}
