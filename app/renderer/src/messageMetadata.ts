/**
 * P4-6b — MetadataInspector data core (`MetadataInspector.jsx`).
 *
 * PURE, cast-free selectors that derive per-message + per-session metadata from
 * data the renderer ALREADY holds for the active session — no new wire frame:
 *
 *  - **Per-message** fields are runtime-narrowed off the retained raw
 *    `SDKMessage[]` (`rawMessageLog.ts` — the same log the "Copy transcript for
 *    LLM" action reads). The transcript projector deliberately drops per-message
 *    usage/model (the S1 §4 trap), so this reads the raw log directly, narrowing
 *    every field the same tolerant way the projector does (`isRecord` + `typeof`,
 *    zero `as`). A malformed/partial message degrades to nulls, never throws.
 *  - **Per-session** fields come from existing read-seams the renderer already
 *    projects: `permission.context` (mode), `thread-goal.snapshot` (goal), and
 *    the merged catalog row (mode/tag). Nothing new crosses the boundary.
 *
 * Deliberately ABSENT (§0 deferrals — rendered as an honest "not available"
 * note by the drawer, NEVER mocked): worktree-session details, file-history
 * backups, and content-replacement records. None of those reach the renderer on
 * any current frame (the P4-6a catalog is body-less; there is no transcript-by-id
 * read seam), so the inspector shows only what is real for the open session.
 */

import type { SDKMessage } from '@cat-code/engine/sdk'
import type {
  TaskSubagentMetadata,
  ThreadGoalSnapshot,
} from '../../shared/protocol.js'
import type { RawMessageSessionLog } from './rawMessageLog.js'
import type { MergedSessionRow } from './sessionsCatalogState.js'

export type MetadataMessageRef = {
  uuid: string
  /** Message discriminant: assistant | user | system | result | … */
  role: string
  /** A short, tolerant preview of the message content (never throws). */
  preview: string
  index: number
}

export type MessageUsage = {
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
}

export type MessageMetadata = {
  uuid: string
  role: string
  subtype: string | null
  /** The shared-API message id (`message.message.id`), when present. */
  messageId: string | null
  model: string | null
  requestId: string | null
  timestamp: string | null
  parentToolUseId: string | null
  stopReason: string | null
  subagent: {
    agentName: string | null
    agentType: string
    agentId: string
    toolUseId: string
    isSidechain: boolean
    spawnedAt: number
  } | null
  /** result frames only. */
  totalCostUsd: number | null
  durationMs: number | null
  usage: MessageUsage | null
  /** system/compact_boundary frames only. */
  compaction: {
    trigger: string | null
    preTokens: number | null
    messagesSummarized: number | null
    preservedSegment: {
      headUuid: string
      tailUuid: string
    } | null
  } | null
}

/** Session-level metadata assembled from existing read-seams (no new frame). */
export type SessionMetadataView = {
  sessionId: string
  /** From the merged catalog row (null when the bounded loader did not populate it). */
  mode: MergedSessionRow['mode']
  /** From the `permission.context` snapshot. */
  permissionMode: string | null
  /** From the merged catalog row. */
  tag: string | null
  /** From the `thread-goal.snapshot` (P4-10). */
  threadGoal: ThreadGoalSnapshot | null
}

/**
 * The inspector's message list: every retained raw message that carries a uuid
 * and is a real turn message (stream_event deltas are excluded — they are
 * position/text fragments, not distinct messages). Newest last, matching arrival
 * order.
 */
export function selectMessageRefs(log: RawMessageSessionLog): MetadataMessageRef[] {
  const refs: MetadataMessageRef[] = []
  log.messages.forEach((message, index) => {
    const type = readString(message, 'type')
    if (type === null || type === 'stream_event') return
    const uuid = readString(message, 'uuid')
    if (uuid === null) return
    refs.push({ uuid, role: type, preview: derivePreview(message, type), index })
  })
  return refs
}

/** Per-message metadata for the raw message with this uuid, or null when absent. */
export function selectMessageMetadata(
  log: RawMessageSessionLog,
  uuid: string | null,
  subagents: readonly TaskSubagentMetadata[] = [],
): MessageMetadata | null {
  if (!uuid) return null
  const message = log.messages.find(m => readString(m, 'uuid') === uuid)
  if (!message) return null

  const type = readString(message, 'type') ?? 'unknown'
  const inner = readRecord(message, 'message')
  const parentToolUseId = readString(message, 'parent_tool_use_id')
  const subagent = parentToolUseId
    ? subagents.find(item => item.toolUseId === parentToolUseId) ?? null
    : null
  return {
    uuid,
    role: type,
    subtype: readString(message, 'subtype'),
    messageId: inner ? readString(inner, 'id') : null,
    model: readString(message, 'model') ?? (inner ? readString(inner, 'model') : null),
    requestId: readString(message, 'requestId'),
    timestamp: readString(message, 'timestamp'),
    parentToolUseId,
    stopReason: readString(message, 'stop_reason') ?? (inner ? readString(inner, 'stop_reason') : null),
    subagent,
    totalCostUsd: readNumber(message, 'total_cost_usd'),
    durationMs: readNumber(message, 'duration_ms'),
    usage: readUsage(message, inner),
    compaction: readCompaction(message),
  }
}

/** Assemble the session-level view from the read-seams the renderer already has. */
export function buildSessionMetadataView(input: {
  sessionId: string
  row: MergedSessionRow | null
  permissionMode: string | null
  threadGoal: ThreadGoalSnapshot | null
}): SessionMetadataView {
  return {
    sessionId: input.sessionId,
    mode: input.row?.mode ?? null,
    permissionMode: input.permissionMode,
    tag: input.row?.tag ?? null,
    threadGoal: input.threadGoal,
  }
}

/* ----------------------------- narrowing ------------------------------ */

function derivePreview(message: SDKMessage, type: string): string {
  const inner = readRecord(message, 'message')
  const content = inner ? inner.content : undefined
  if (typeof content === 'string') return clip(content)
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block)) continue
      if (block.type === 'text' && typeof block.text === 'string') return clip(block.text)
      if (block.type === 'tool_use' && typeof block.name === 'string') return `→ ${block.name}`
      if (typeof block.type === 'string' && block.type.endsWith('tool_result')) return '↩ tool result'
    }
  }
  const subtype = readString(message, 'subtype')
  return subtype ? `${type} · ${subtype}` : type
}

function readUsage(
  message: SDKMessage,
  inner: Record<string, unknown> | null,
): MessageUsage | null {
  const usage =
    readRecord(message, 'usage') ?? (inner ? readRecordOf(inner, 'usage') : null)
  if (!usage) return null
  const inputTokens = numberOrNull(usage.input_tokens ?? usage.inputTokens)
  const outputTokens = numberOrNull(usage.output_tokens ?? usage.outputTokens)
  const totalTokens = numberOrNull(usage.total_tokens ?? usage.totalTokens)
  if (inputTokens === null && outputTokens === null && totalTokens === null) return null
  return { inputTokens, outputTokens, totalTokens }
}

/**
 * P4-31 — both extra fields are REAL engine data the SDK boundary used to drop,
 * not new inventions. Each is genuinely optional upstream, so `null` here means
 * "the engine did not record it", never "we could not be bothered":
 *
 *  - `messages_summarized` is set by the partial-compact path only
 *    (`src/services/compact/compact.ts:1065`); full compact
 *    (`compact.ts:627-631`) and session-memory compact
 *    (`sessionMemoryCompact.ts:457-461`) leave it undefined even though the
 *    count is in scope at both. See the P4-31 §0 flag.
 *  - `preserved_segment` is bolted on after the fact by
 *    `annotateBoundaryWithPreservedSegment` (`compact.ts:352-370`) and is
 *    correctly absent when compaction summarized everything
 *    (`src/entrypoints/sdk/coreSchemas.ts:1600-1602`) — the prototype makes the
 *    row conditional for the same reason (`MetadataInspector.jsx:181`).
 */
function readCompaction(
  message: SDKMessage,
): MessageMetadata['compaction'] {
  const meta = readRecord(message, 'compact_metadata')
  if (!meta) return null
  const preserved = readRecordOf(meta, 'preserved_segment')
  return {
    trigger: typeof meta.trigger === 'string' ? meta.trigger : null,
    preTokens: numberOrNull(meta.pre_tokens),
    messagesSummarized: numberOrNull(meta.messages_summarized),
    preservedSegment: preserved
      ? readPreservedSegment(preserved)
      : null,
  }
}

function readPreservedSegment(
  preserved: Record<string, unknown>,
): { headUuid: string; tailUuid: string } | null {
  const headUuid = stringOrNull(preserved.head_uuid)
  const tailUuid = stringOrNull(preserved.tail_uuid)
  return headUuid && tailUuid ? { headUuid, tailUuid } : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRecord(
  message: unknown,
  key: string,
): Record<string, unknown> | null {
  if (!isRecord(message)) return null
  const value = message[key]
  return isRecord(value) ? value : null
}

function readRecordOf(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = obj[key]
  return isRecord(value) ? value : null
}

function readString(message: unknown, key: string): string | null {
  if (!isRecord(message)) return null
  const value = message[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readNumber(message: unknown, key: string): number | null {
  if (!isRecord(message)) return null
  return numberOrNull(message[key])
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function clip(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  return trimmed.length > 90 ? `${trimmed.slice(0, 90)}…` : trimmed
}
