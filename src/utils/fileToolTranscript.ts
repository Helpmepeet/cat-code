import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import {
  FILE_READ_TOOL_NAME,
  FILE_UNCHANGED_STUB,
} from '../tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/prompt.js'
import type { AssistantMessage, Message, UserMessage } from '../types/message.js'
import { expandPath } from './path.js'
import { positionToolExecutionEvidence } from './permissions/toolExecutionEvidence.js'

type ToolUseBlock = Extract<AssistantMessage['message']['content'][number], { type: 'tool_use' }>
type ToolResultBlock = Extract<Exclude<UserMessage['message']['content'], string>[number], { type: 'tool_result' }>

type ToolCall = {
  message: AssistantMessage
  index: number
  block: ToolUseBlock
}

type FileToolResult = {
  call: ToolCall
  message: UserMessage
  block: ToolResultBlock
  input: unknown
  data: unknown
}

const fileToolNames = new Set([
  FILE_READ_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
])

/** Replay file tool results in delivery order. Require an unambiguous call even
 * for legacy transcripts that predate the source assistant UUID. */
export function* successfulFileToolResults(
  messages: readonly Message[],
): Generator<FileToolResult> {
  const byAssistant = new Map<string, Map<string, ToolCall | null>>()
  const byLegacyId = new Map<string, ToolCall | null>()
  for (const [index, message] of messages.entries()) {
    if (message.type !== 'assistant' || !Array.isArray(message.message.content)) continue
    const siblings = byAssistant.get(message.uuid) ?? new Map<string, ToolCall | null>()
    for (const block of message.message.content) {
      if (block.type !== 'tool_use') continue
      const call = { message, index, block }
      siblings.set(block.id, siblings.has(block.id) ? null : call)
      byLegacyId.set(block.id, byLegacyId.has(block.id) ? null : call)
    }
    if (siblings.size) byAssistant.set(message.uuid, siblings)
  }

  const { byResult } = positionToolExecutionEvidence(messages)
  for (const [index, message] of messages.entries()) {
    if (
      message.type !== 'user' || message.toolResultStatus === 'cancelled' ||
      message.isMeta || message.isCompactSummary || message.origin !== undefined ||
      message.isVisibleInTranscriptOnly || !Array.isArray(message.message.content)
    ) continue
    const resultBlocks = message.message.content.filter(block => block.type === 'tool_result')
    for (const block of resultBlocks) {
      if (block.is_error === true) continue
      const id = block.tool_use_id
      const call = message.sourceToolAssistantUUID === undefined
        ? byLegacyId.get(id)
        : byAssistant.get(message.sourceToolAssistantUUID)?.get(id)
      if (!call || call.index >= index || !fileToolNames.has(call.block.name)) continue
      const evidence = byResult.get(message)
      const rawEvidence = message.toolExecutionEvidence
      // Malformed or unbound replacement evidence leaves the executed input unknown.
      const input = rawEvidence?.toolUseId === id && rawEvidence.finalInput !== undefined
        ? (evidence?.toolUseId === id ? evidence.finalInput : undefined)
        : call.block.input
      // The result object describes a single execution, never a merged batch.
      const data = resultBlocks.length === 1 ? message.toolUseResult : undefined
      yield { call, message, block, input, data }
    }
  }
}

type ReadResult = {
  type?: string
  file?: {
    filePath?: string
    startLine?: number
    numLines?: number
    totalLines?: number
    functionResolution?: unknown
  }
}

/** Only delivered file content can establish Read provenance. Native result
 * metadata can describe a different file or range than the requested input. */
export function deliveredRead(result: FileToolResult, cwd?: string) {
  const { call, message, block, input, data } = result
  if (
    call.block.name !== FILE_READ_TOOL_NAME || call.message.isVirtual ||
    call.message.codeMode || message.isVirtual || message.codeMode
  ) return undefined
  const content = block.content
  if (!content?.length) return undefined
  if (
    typeof content === 'string' && (
      content.startsWith(FILE_UNCHANGED_STUB) ||
      (content.startsWith('Requested path ') && content.includes(' was not found. No file was read.'))
    )
  ) return undefined

  const raw = data as ReadResult | undefined
  if (raw?.type === 'file_unchanged' || raw?.type === 'not_found') return undefined
  const rawText = raw?.type === 'text' ? raw.file : undefined
  const rangedView = typeof rawText?.startLine === 'number' && rawText.startLine > 1
  const truncated = rangedView || rawText?.functionResolution !== undefined ||
    (typeof rawText?.numLines === 'number' && typeof rawText.totalLines === 'number' &&
      rawText.numLines < rawText.totalLines) ||
    (typeof content === 'string' && content.includes('This is a partial view.'))

  const effective = input as {
    file_path?: unknown
    offset?: unknown
    limit?: unknown
    pages?: unknown
  } | undefined
  const effectivePath = typeof effective?.file_path === 'string' && effective.file_path
    ? effective.file_path : undefined
  const reportedPath = raw?.type === 'text' || raw?.type === 'notebook' || raw?.type === 'pdf' || raw?.type === 'parts'
    ? raw.file?.filePath : undefined
  const path = typeof reportedPath === 'string' && reportedPath ? reportedPath : effectivePath
  if (!path) return undefined

  const unbounded = effectivePath !== undefined && (effective?.offset === undefined || effective.offset === 1) &&
    effective?.limit === undefined && effective?.pages === undefined
  const completeText = typeof reportedPath === 'string' && reportedPath.length > 0 &&
    rawText?.startLine === 1 && typeof rawText.numLines === 'number' &&
    rawText.numLines >= 0 && rawText.numLines === rawText.totalLines
  return {
    path: expandPath(path, cwd), content, truncated,
    // PDF tool-result strings describe the file. Its bytes come from a
    // separate user message that may have been removed by compaction.
    complete: !truncated && (unbounded || completeText) && raw?.type !== 'pdf' && raw?.type !== 'parts',
    cacheableText: unbounded && (raw?.type === undefined || raw.type === 'text'),
  }
}
