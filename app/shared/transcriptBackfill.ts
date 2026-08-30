/**
 * Private main↔backfill-worker boundary for PL-B. This is NOT a renderer or
 * sidecar socket protocol: Electron main starts one short-lived, serialized
 * engine-graph worker after first paint and remains the sole cache writer.
 *
 * Both ends runtime-validate this boundary. Limits keep a corrupt/compromised
 * child from growing main's buffers without bound, and the result vocabulary is
 * deliberately transcript-only (message events plus the visible truncation
 * boundary already allowed in TranscriptCache).
 */

import { isAbsolute, basename } from 'node:path'

import {
  HISTORY_REPLAY_TRUNCATION_REQUEST_ID,
  PROTOCOL_VERSION,
  type ServerFrame,
  type SessionId,
  type TranscriptRunFacts,
} from './protocol.js'
import {
  MAX_HISTORY_REPLAY_BYTES,
  MAX_HISTORY_REPLAY_FRAMES,
} from './limits.js'

export const TRANSCRIPT_BACKFILL_BOUNDARY_VERSION = 1
export const MAX_TRANSCRIPT_BACKFILL_SESSIONS = 32
export const MAX_TRANSCRIPT_BACKFILL_INPUT_BYTES = 256 * 1024
export const MAX_TRANSCRIPT_BACKFILL_RECORD_BYTES =
  MAX_HISTORY_REPLAY_BYTES + 256 * 1024

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type TranscriptBackfillItem = {
  appSessionId: SessionId
  engineSessionId: string
  transcriptPath: string
}

export type TranscriptBackfillRequest = {
  version: typeof TRANSCRIPT_BACKFILL_BOUNDARY_VERSION
  items: TranscriptBackfillItem[]
}

export type TranscriptBackfillSessionResult = {
  type: 'session'
  appSessionId: SessionId
  engineSessionId: string
  frames: ServerFrame[]
  /**
   * What the session ran on, read from the raw transcript BEFORE the engine's
   * `toSDKMessages` conversion drops it. Always present on the wire (with null
   * fields when the transcript is silent) so a missing key is a malformed
   * record rather than an ambiguous absence.
   */
  runFacts: TranscriptRunFacts
}

export type TranscriptBackfillFailureResult = {
  type: 'failure'
  appSessionId: SessionId
  engineSessionId: string
  reason: 'missing' | 'invalid' | 'session_mismatch' | 'internal'
}

export type TranscriptBackfillDoneResult = {
  type: 'done'
  attempted: number
}

export type TranscriptBackfillResult =
  | TranscriptBackfillSessionResult
  | TranscriptBackfillFailureResult
  | TranscriptBackfillDoneResult

export function parseTranscriptBackfillRequest(
  value: unknown,
): TranscriptBackfillRequest | null {
  if (!hasExactKeys(value, ['version', 'items'])) return null
  if (value.version !== TRANSCRIPT_BACKFILL_BOUNDARY_VERSION) return null
  if (
    !Array.isArray(value.items) ||
    value.items.length > MAX_TRANSCRIPT_BACKFILL_SESSIONS
  ) {
    return null
  }
  const items: TranscriptBackfillItem[] = []
  const seen = new Set<string>()
  for (const item of value.items) {
    if (!hasExactKeys(item, ['appSessionId', 'engineSessionId', 'transcriptPath'])) {
      return null
    }
    if (
      !isUuid(item.appSessionId) ||
      !isUuid(item.engineSessionId) ||
      typeof item.transcriptPath !== 'string' ||
      item.transcriptPath.length === 0 ||
      item.transcriptPath.length > 4096 ||
      !isAbsolute(item.transcriptPath) ||
      basename(item.transcriptPath) !== `${item.engineSessionId}.jsonl` ||
      seen.has(item.appSessionId)
    ) {
      return null
    }
    seen.add(item.appSessionId)
    items.push({
      appSessionId: item.appSessionId,
      engineSessionId: item.engineSessionId,
      transcriptPath: item.transcriptPath,
    })
  }
  return { version: TRANSCRIPT_BACKFILL_BOUNDARY_VERSION, items }
}

export function parseTranscriptBackfillResult(
  value: unknown,
): TranscriptBackfillResult | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null
  if (value.type === 'done') {
    if (!hasExactKeys(value, ['type', 'attempted'])) return null
    if (
      typeof value.attempted !== 'number' ||
      !Number.isInteger(value.attempted) ||
      value.attempted < 0 ||
      value.attempted > MAX_TRANSCRIPT_BACKFILL_SESSIONS
    ) {
      return null
    }
    return { type: 'done', attempted: value.attempted }
  }
  if (value.type === 'failure') {
    if (
      !hasExactKeys(value, [
        'type',
        'appSessionId',
        'engineSessionId',
        'reason',
      ]) ||
      !isUuid(value.appSessionId) ||
      !isUuid(value.engineSessionId) ||
      !['missing', 'invalid', 'session_mismatch', 'internal'].includes(
        String(value.reason),
      )
    ) {
      return null
    }
    return {
      type: 'failure',
      appSessionId: value.appSessionId,
      engineSessionId: value.engineSessionId,
      reason: value.reason as TranscriptBackfillFailureResult['reason'],
    }
  }
  if (value.type !== 'session') return null
  if (
    !hasExactKeys(value, [
      'type',
      'appSessionId',
      'engineSessionId',
      'frames',
      'runFacts',
    ]) ||
    !isUuid(value.appSessionId) ||
    !isUuid(value.engineSessionId) ||
    !Array.isArray(value.frames) ||
    value.frames.length > MAX_HISTORY_REPLAY_FRAMES + 1
  ) {
    return null
  }
  const frames: ServerFrame[] = []
  for (let i = 0; i < value.frames.length; i++) {
    const frame = parseTranscriptFrame(
      value.frames[i],
      value.appSessionId,
      value.engineSessionId,
      i === 0,
    )
    if (!frame) return null
    frames.push(frame)
  }
  const runFacts = parseTranscriptRunFacts(value.runFacts)
  if (!runFacts) return null
  return {
    type: 'session',
    appSessionId: value.appSessionId,
    engineSessionId: value.engineSessionId,
    frames,
    runFacts,
  }
}

/**
 * Validate the run facts at the boundary like everything else crossing it: a
 * child process is untrusted, so each field must be a string/number or an
 * explicit null, with no extra keys. Strings are length-bounded because they
 * are rendered; numbers must be finite and non-negative because they become a
 * percentage.
 */
export function parseTranscriptRunFacts(
  value: unknown,
): TranscriptRunFacts | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'model',
      'permissionMode',
      'effort',
      'usedTokens',
      'contextWindow',
    ])
  ) {
    return null
  }
  const model = parseFactString(value.model)
  const permissionMode = parseFactString(value.permissionMode)
  const effort = parseFactString(value.effort)
  const usedTokens = parseFactNumber(value.usedTokens)
  const contextWindow = parseFactNumber(value.contextWindow)
  if (
    model === undefined ||
    permissionMode === undefined ||
    effort === undefined ||
    usedTokens === undefined ||
    contextWindow === undefined
  ) {
    return null
  }
  return { model, permissionMode, effort, usedTokens, contextWindow }
}

/** `undefined` = invalid (reject the record); `null` = the source said nothing. */
function parseFactString(value: unknown): string | null | undefined {
  if (value === null) return null
  if (typeof value !== 'string') return undefined
  if (value.length === 0 || value.length > MAX_RUN_FACT_CHARS) return undefined
  return value
}

function parseFactNumber(value: unknown): number | null | undefined {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (value < 0) return undefined
  return value
}

/** Bounded because these render in the composer rail. */
const MAX_RUN_FACT_CHARS = 128

function parseTranscriptFrame(
  value: unknown,
  appSessionId: string,
  engineSessionId: string,
  first: boolean,
): ServerFrame | null {
  if (!isRecord(value) || value.protocolVersion !== PROTOCOL_VERSION) return null
  if (value.sessionId !== appSessionId) return null
  if (value.kind === 'error') {
    if (!first) return null
    if (
      !hasExactKeys(value, [
        'kind',
        'protocolVersion',
        'sessionId',
        'requestId',
        'code',
        'message',
        'retryable',
      ]) ||
      value.requestId !== HISTORY_REPLAY_TRUNCATION_REQUEST_ID ||
      value.code !== 'internal_error' ||
      typeof value.message !== 'string' ||
      value.message.length > 1024 ||
      value.retryable !== false
    ) {
      return null
    }
    return value as unknown as ServerFrame
  }
  if (value.kind !== 'event') return null
  if (
    !hasExactKeys(value, [
      'kind',
      'protocolVersion',
      'sessionId',
      'replay',
      'event',
    ]) ||
    value.replay !== true ||
    !hasExactKeys(value.event, ['type', 'message']) ||
    value.event.type !== 'message' ||
    !isBackfillSdkMessage(value.event.message, engineSessionId)
  ) {
    return null
  }
  return value as unknown as ServerFrame
}

/**
 * The worker's `toSDKMessages` path emits user, assistant, compact boundary and
 * retry-notice history records. Validate the required shape of those variants on
 * main's side of the private boundary; a compromised or drifted worker cannot
 * persist a discriminant-only object that the renderer silently drops.
 *
 * Adding a variant here is not optional bookkeeping: `parseTranscriptBackfillResult`
 * rejects the WHOLE session result on one unvalidatable frame, so a variant the
 * worker emits and this does not admit costs that session its entire cached
 * preview, not just the row.
 */
function isBackfillSdkMessage(
  value: unknown,
  engineSessionId: string,
): boolean {
  if (
    !isRecord(value) ||
    value.session_id !== engineSessionId ||
    typeof value.uuid !== 'string' ||
    value.uuid.length === 0 ||
    value.uuid.length > 256
  ) {
    return false
  }

  if (value.type === 'assistant') {
    return (
      isRecord(value.message) &&
      value.message.role === 'assistant' &&
      Array.isArray(value.message.content) &&
      value.message.content.every(isBackfillContentBlock) &&
      isNullableString(value.parent_tool_use_id)
    )
  }

  if (value.type === 'user') {
    if (
      !isRecord(value.message) ||
      value.message.role !== 'user' ||
      !isNullableString(value.parent_tool_use_id)
    ) {
      return false
    }
    const content = value.message.content
    return (
      typeof content === 'string' ||
      (Array.isArray(content) && content.every(isBackfillContentBlock))
    )
  }

  if (value.type === 'system' && value.subtype === 'api_retry') {
    const error = value.error
    return (
      isFiniteCount(value.attempt) &&
      isFiniteCount(value.max_retries) &&
      isFiniteCount(value.retry_delay_ms) &&
      (value.error_status === null ||
        (typeof value.error_status === 'number' &&
          Number.isFinite(value.error_status))) &&
      (typeof error === 'string' ||
        (isRecord(error) && typeof error.message === 'string'))
    )
  }

  if (value.type === 'system' && value.subtype === 'compact_boundary') {
    if (!isRecord(value.compact_metadata)) return false
    const trigger = value.compact_metadata.trigger
    const preTokens = value.compact_metadata.pre_tokens
    const messagesSummarized = value.compact_metadata.messages_summarized
    if (
      (trigger !== 'manual' && trigger !== 'auto') ||
      typeof preTokens !== 'number' ||
      !Number.isFinite(preTokens) ||
      preTokens < 0 ||
      (messagesSummarized !== undefined &&
        (typeof messagesSummarized !== 'number' ||
          !Number.isInteger(messagesSummarized) ||
          messagesSummarized < 0))
    ) {
      return false
    }
    const preserved = value.compact_metadata.preserved_segment
    return (
      preserved === undefined ||
      (isRecord(preserved) &&
        typeof preserved.head_uuid === 'string' &&
        typeof preserved.anchor_uuid === 'string' &&
        typeof preserved.tail_uuid === 'string')
    )
  }

  return false
}

function isFiniteCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

const BACKFILL_CONTENT_BLOCK_TYPES = new Set([
  'text',
  'thinking',
  'redacted_thinking',
  'tool_use',
  'server_tool_use',
  'image',
  'document',
  'search_result',
  'tool_result',
  'web_search_tool_result',
  'web_fetch_tool_result',
  'code_execution_tool_result',
  'bash_code_execution_tool_result',
  'text_editor_code_execution_tool_result',
  'tool_search_tool_result',
  // Tool-search discovery block. It appears ONLY nested inside `tool_result`
  // content (`src/utils/toolSearch.ts:569`), never at the top level, and its
  // guard there is `{ type: 'tool_reference'; tool_name: string }` (:493).
  // Omitting it made every session that ever ran a tool search unvalidatable.
  'tool_reference',
  'container_upload',
])

/** Current Anthropic history block vocabulary emitted by `toSDKMessages`. */
function isBackfillContentBlock(value: unknown): boolean {
  if (
    !isRecord(value) ||
    typeof value.type !== 'string' ||
    !BACKFILL_CONTENT_BLOCK_TYPES.has(value.type)
  ) {
    return false
  }
  switch (value.type) {
    case 'text':
      return typeof value.text === 'string'
    case 'thinking':
      return (
        typeof value.thinking === 'string' && typeof value.signature === 'string'
      )
    case 'redacted_thinking':
      return typeof value.data === 'string'
    case 'tool_use':
    case 'server_tool_use':
      return (
        typeof value.id === 'string' &&
        typeof value.name === 'string' &&
        value.input !== undefined
      )
    case 'image':
      return isBackfillImageSource(value.source)
    case 'document':
      return isBackfillDocumentSource(value.source)
    case 'search_result':
      return (
        typeof value.source === 'string' &&
        typeof value.title === 'string' &&
        Array.isArray(value.content) &&
        value.content.every(
          block =>
            isRecord(block) &&
            block.type === 'text' &&
            typeof block.text === 'string',
        )
      )
    case 'tool_result':
      return (
        typeof value.tool_use_id === 'string' &&
        (value.content === undefined ||
          typeof value.content === 'string' ||
          (Array.isArray(value.content) &&
            value.content.every(isBackfillContentBlock)))
      )
    case 'tool_reference':
      return typeof value.tool_name === 'string'
    case 'container_upload':
      return typeof value.file_id === 'string'
    case 'web_search_tool_result':
      return (
        typeof value.tool_use_id === 'string' &&
        (isToolResultError(value.content, 'web_search_tool_result_error') ||
          (Array.isArray(value.content) &&
            value.content.every(
              item =>
                isRecord(item) &&
                item.type === 'web_search_result' &&
                typeof item.url === 'string' &&
                typeof item.title === 'string' &&
                typeof item.encrypted_content === 'string',
            )))
      )
    case 'web_fetch_tool_result':
      return (
        typeof value.tool_use_id === 'string' &&
        (isToolResultError(value.content, 'web_fetch_tool_result_error') ||
          (isRecord(value.content) &&
            value.content.type === 'web_fetch_result' &&
            typeof value.content.url === 'string' &&
            isRecord(value.content.content) &&
            value.content.content.type === 'document' &&
            isBackfillDocumentSource(value.content.content.source)))
      )
    case 'code_execution_tool_result':
      return (
        typeof value.tool_use_id === 'string' &&
        (isToolResultError(value.content, 'code_execution_tool_result_error') ||
          isCodeExecutionResult(value.content, 'code_execution_result') ||
          isCodeExecutionResult(value.content, 'encrypted_code_execution_result'))
      )
    case 'bash_code_execution_tool_result':
      return (
        typeof value.tool_use_id === 'string' &&
        (isToolResultError(
          value.content,
          'bash_code_execution_tool_result_error',
        ) || isCodeExecutionResult(value.content, 'bash_code_execution_result'))
      )
    case 'text_editor_code_execution_tool_result':
      return (
        typeof value.tool_use_id === 'string' &&
        isTextEditorResult(value.content)
      )
    case 'tool_search_tool_result':
      return (
        typeof value.tool_use_id === 'string' &&
        (isToolResultError(value.content, 'tool_search_tool_result_error') ||
          (isRecord(value.content) &&
            value.content.type === 'tool_search_tool_search_result' &&
            Array.isArray(value.content.tool_references) &&
            value.content.tool_references.every(
              item =>
                isRecord(item) &&
                item.type === 'tool_reference' &&
                typeof item.tool_name === 'string',
          )))
      )
  }
  return false
}

function isToolResultError(value: unknown, type: string): boolean {
  return (
    isRecord(value) &&
    value.type === type &&
    typeof value.error_code === 'string'
  )
}

function isCodeExecutionResult(value: unknown, type: string): boolean {
  if (
    !isRecord(value) ||
    value.type !== type ||
    !Array.isArray(value.content) ||
    typeof value.return_code !== 'number' ||
    typeof value.stderr !== 'string'
  ) {
    return false
  }
  if (
    type !== 'encrypted_code_execution_result' &&
    typeof value.stdout !== 'string'
  ) {
    return false
  }
  if (
    type === 'encrypted_code_execution_result' &&
    typeof value.encrypted_stdout !== 'string'
  ) {
    return false
  }
  const outputType =
    type === 'bash_code_execution_result'
      ? 'bash_code_execution_output'
      : 'code_execution_output'
  return value.content.every(
    item =>
      isRecord(item) &&
      item.type === outputType &&
      typeof item.file_id === 'string',
  )
}

function isTextEditorResult(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'text_editor_code_execution_tool_result_error') {
    return typeof value.error_code === 'string'
  }
  if (value.type === 'text_editor_code_execution_view_result') {
    return (
      typeof value.content === 'string' &&
      ['text', 'image', 'pdf'].includes(String(value.file_type))
    )
  }
  if (value.type === 'text_editor_code_execution_create_result') {
    return typeof value.is_file_update === 'boolean'
  }
  if (value.type === 'text_editor_code_execution_str_replace_result') {
    return (
      value.lines === undefined ||
      value.lines === null ||
      (Array.isArray(value.lines) &&
        value.lines.every(line => typeof line === 'string'))
    )
  }
  return false
}

function isBackfillImageSource(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.type === 'url') return typeof value.url === 'string'
  return (
    value.type === 'base64' &&
    typeof value.data === 'string' &&
    ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(
      String(value.media_type),
    )
  )
}

function isBackfillDocumentSource(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.type === 'url') return typeof value.url === 'string'
  if (value.type === 'base64') {
    return (
      value.media_type === 'application/pdf' && typeof value.data === 'string'
    )
  }
  if (value.type === 'text') {
    return value.media_type === 'text/plain' && typeof value.data === 'string'
  }
  if (value.type === 'content') {
    return (
      typeof value.content === 'string' ||
      (Array.isArray(value.content) &&
        value.content.every(
          block =>
            (isRecord(block) &&
              block.type === 'text' &&
              typeof block.text === 'string') ||
            (isRecord(block) &&
              block.type === 'image' &&
              isBackfillImageSource(block.source)),
        ))
    )
  }
  return false
}

function isNullableString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string'
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, i) => key === wanted[i])
}
