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
}

export type ToolUseRow = RowSource & {
  kind: 'tool-use'
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
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

export type SessionInitRow = FrameRowSource & {
  kind: 'session-init'
  cwd: string
  model: string
  tools: string[]
  permissionMode: string
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
  | SessionInitRow
  | ResultRow
  | CompactBoundaryRow
  | SnipBoundaryRow
  | TombstoneRow

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
      return projectUserFrame(sessionId, state, message)

    case 'result':
      return projectResultFrame(sessionId, state, message)

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
      return appendFrameRows(state, frameId, [
        {
          id: frameRowId(sessionId, frameId, 'session-init'),
          sessionId,
          frameId,
          kind: 'session-init',
          cwd,
          model,
          tools,
          permissionMode,
        },
      ])
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
 *  - `thinking`, `redacted_thinking` → P2-1 rows. Codex thinking carries a
 *    non-standard `reasoning_kind: 'summary'|'raw'` at stream start and the
 *    stored block uses `reasoningKind`; both spellings are preserved by value.
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

    default:
      // P2-2 tool-card families / unknown or malformed blocks — documented
      // no-op (see function doc).
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
