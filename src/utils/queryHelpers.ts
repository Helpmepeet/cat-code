import { recordToolOutput } from '../app-runtime/toolActivity.js'
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import last from 'lodash-es/last.js'
import {
  getSessionId,
  isSessionPersistenceDisabled,
} from 'src/bootstrap/state.js'
import type { SDKAssistantErrorCode, SDKMessage } from 'src/entrypoints/agentSdkTypes.js'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import { runTools } from '../services/tools/toolOrchestration.js'
import { findToolByName, type Tool, type Tools } from '../Tool.js'
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/prompt.js'
import type { Message } from '../types/message.js'
import type { OrphanedPermission } from '../types/textInputTypes.js'
import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './envUtils.js'
import { isFsInaccessible } from './errors.js'
import { getFileModificationTime, stripLineNumberPrefix } from './file.js'
import { readFileSyncWithMetadata } from './fileRead.js'
import { deliveredRead, successfulFileToolResults } from './fileToolTranscript.js'
import {
  createFileStateCacheWithSizeLimit,
  type FileStateCache,
} from './fileStateCache.js'
import {
  isInternalNoResponseSentinel,
  isNotEmptyMessage,
  normalizeMessages,
} from './messages.js'
import { toSDKMessageOriginProp, toSDKCodeModeProps } from './messages/mappers.js'
import { expandPath } from './path.js'
import type {
  inputSchema as permissionToolInputSchema,
  outputSchema as permissionToolOutputSchema,
} from './permissions/PermissionPromptToolResultSchema.js'
import type { ProcessUserInputContext } from './processUserInput/processUserInput.js'
import { recordTranscript } from './sessionStorage.js'

export type PermissionPromptTool = Tool<
  ReturnType<typeof permissionToolInputSchema>,
  ReturnType<typeof permissionToolOutputSchema>
>

// Small cache size for ask operations which typically access few files
// during permission prompts or limited tool operations
const ASK_READ_FILE_STATE_CACHE_SIZE = 10

/**
 * Checks if the result should be considered successful based on the last message.
 * Returns true if:
 * - Last message is assistant with text/thinking content
 * - Last message is user with only tool_result blocks
 * - Last message is the user prompt but the API completed with end_turn
 *   (model chose to emit no content blocks)
 */
export function isResultSuccessful(
  message: Message | undefined,
  stopReason: string | null = null,
): message is Message {
  if (!message) return false

  if (message.type === 'assistant') {
    const lastContent = last(message.message.content)
    return (
      lastContent?.type === 'text' ||
      lastContent?.type === 'thinking' ||
      lastContent?.type === 'redacted_thinking'
    )
  }

  if (message.type === 'user') {
    // Check if all content blocks are tool_result type
    const content = message.message.content
    if (
      Array.isArray(content) &&
      content.length > 0 &&
      content.every(block => 'type' in block && block.type === 'tool_result')
    ) {
      return true
    }
  }

  // Carve-out: API completed (message_delta set stop_reason) but yielded
  // no assistant content — last(messages) is still this turn's prompt.
  // claude.ts:2026 recognizes end_turn-with-zero-content-blocks as
  // legitimate and passes through without throwing. Observed on
  // task_notification drain turns: model returns stop_reason=end_turn,
  // outputTokens=4, textContentLength=0 — it saw the subagent result
  // and decided nothing needed saying. Without this, QueryEngine emits
  // error_during_execution with errors[] = the entire process's
  // accumulated logError() buffer. Covers both string-content and
  // text-block-content user prompts, and any other non-passing shape.
  return stopReason === 'end_turn'
}

// Track last sent time for tool progress messages per tool use ID
// Keep only the last 100 entries to prevent unbounded growth
const MAX_TOOL_PROGRESS_TRACKING_ENTRIES = 100
const TOOL_PROGRESS_THROTTLE_MS = 30000
const toolProgressLastSentTime = new Map<string, number>()

/**
 * A subagent's friendly name is engine-minted at spawn. Preserve it on every
 * nested full frame so transcript consumers can display it without consulting
 * live task state. Restore intentionally does not recreate nested frames.
 */
function progressAgentName(data: unknown): string | undefined {
  if (!data || typeof data !== 'object' || !('agentName' in data)) return undefined
  const name = data.agentName
  if (typeof name !== 'string') return undefined
  const normalized = name.trim().replace(/^@/, '').trim()
  return normalized || undefined
}

export function* normalizeMessage(message: Message): Generator<SDKMessage> {
  switch (message.type) {
    case 'assistant':
      if (isInternalNoResponseSentinel(message)) return
      for (const _ of normalizeMessages([message])) {
        // Skip empty messages (e.g., "(no content)") that shouldn't be output to SDK
        if (!isNotEmptyMessage(_)) {
          continue
        }
        yield {
          type: 'assistant',
          message: _.message,
          parent_tool_use_id: null,
          session_id: getSessionId(),
          uuid: _.uuid,
          error: _.error as SDKAssistantErrorCode | undefined,
          ...(message.isApiErrorMessage && message.discardedStreamMessageId && {
            discarded_stream_message_id: message.discardedStreamMessageId,
          }),
          ...toSDKCodeModeProps(message),
        }
      }
      return
    case 'progress':
      if (
        message.data.type === 'agent_progress' ||
        message.data.type === 'skill_progress'
      ) {
        const agentName = progressAgentName(message.data)
        for (const _ of normalizeMessages([message.data.message])) {
          switch (_.type) {
            case 'assistant':
              // Skip empty messages (e.g., "(no content)") that shouldn't be output to SDK
              if (!isNotEmptyMessage(_)) {
                break
              }
              yield {
                type: 'assistant',
                message: _.message,
                parent_tool_use_id: message.parentToolUseID,
                ...(agentName ? { agent_name: agentName } : {}),
                session_id: getSessionId(),
                uuid: _.uuid,
                error: _.error,
                ...toSDKCodeModeProps(_),
              }
              break
            case 'user':
              yield {
                type: 'user',
                message: _.message,
                parent_tool_use_id: message.parentToolUseID,
                ...(agentName ? { agent_name: agentName } : {}),
                session_id: getSessionId(),
                uuid: _.uuid,
                timestamp: _.timestamp,
                ...toSDKCodeModeProps(_),
                isSynthetic: _.isMeta || _.isVisibleInTranscriptOnly,
                tool_use_result: _.mcpMeta
                  ? { content: _.toolUseResult, ..._.mcpMeta }
                  : _.toolUseResult,
                ...(message.data.message.toolResultStatus !== undefined
                  ? { tool_result_status: message.data.message.toolResultStatus }
                  : {}),
                ...toSDKMessageOriginProp(message.data.message.origin),
              }
              break
          }
        }
      } else if (
        message.data.type === 'bash_progress' ||
        message.data.type === 'powershell_progress'
      ) {
        if (message.data.type === 'bash_progress') {
          recordToolOutput(message.parentToolUseID, message.data.fullOutput || message.data.output, message.data.totalLines, message.data.timeoutMs)
        }
        // Filter bash progress to send only one per minute
        // Only emit for Cat Code Remote for now
        if (
          !isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) &&
          !process.env.CLAUDE_CODE_CONTAINER_ID
        ) {
          break
        }

        // Use parentToolUseID as the key since toolUseID changes for each progress message
        const trackingKey = message.parentToolUseID
        const now = Date.now()
        const lastSent = toolProgressLastSentTime.get(trackingKey) || 0
        const timeSinceLastSent = now - lastSent

        // Send if at least 30 seconds have passed since last update
        if (timeSinceLastSent >= TOOL_PROGRESS_THROTTLE_MS) {
          // Remove oldest entry if we're at capacity (LRU eviction)
          if (
            toolProgressLastSentTime.size >= MAX_TOOL_PROGRESS_TRACKING_ENTRIES
          ) {
            const firstKey = toolProgressLastSentTime.keys().next().value
            if (firstKey !== undefined) {
              toolProgressLastSentTime.delete(firstKey)
            }
          }

          toolProgressLastSentTime.set(trackingKey, now)
          yield {
            type: 'tool_progress',
            tool_use_id: message.toolUseID,
            tool_name:
              message.data.type === 'bash_progress' ? 'Bash' : 'PowerShell',
            parent_tool_use_id: message.parentToolUseID,
            elapsed_time_seconds: message.data.elapsedTimeSeconds,
            task_id: message.data.taskId,
            session_id: getSessionId(),
            uuid: message.uuid,
          }
        }
      }
      break
    case 'user':
      for (const _ of normalizeMessages([message])) {
        yield {
          type: 'user',
          message: _.message,
          parent_tool_use_id: null,
          session_id: getSessionId(),
          uuid: _.uuid,
          timestamp: _.timestamp,
          ...toSDKCodeModeProps(message),
          isSynthetic: _.isMeta || _.isVisibleInTranscriptOnly,
          tool_use_result: _.mcpMeta
            ? { content: _.toolUseResult, ..._.mcpMeta }
            : _.toolUseResult,
          ...(message.toolResultStatus !== undefined
            ? { tool_result_status: message.toolResultStatus }
            : {}),
          ...toSDKMessageOriginProp(message.origin),
        }
      }
      return
    default:
    // yield nothing
  }
}

export async function* handleOrphanedPermission(
  orphanedPermission: OrphanedPermission,
  tools: Tools,
  mutableMessages: Message[],
  processUserInputContext: ProcessUserInputContext,
): AsyncGenerator<SDKMessage, void, unknown> {
  const persistSession = !isSessionPersistenceDisabled()
  const { permissionResult, assistantMessage } = orphanedPermission
  const { toolUseID } = permissionResult

  if (!toolUseID) {
    return
  }

  const content = assistantMessage.message.content
  let toolUseBlock: ToolUseBlock | undefined
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'tool_use' && block.id === toolUseID) {
        toolUseBlock = block as ToolUseBlock
        break
      }
    }
  }

  if (!toolUseBlock) {
    return
  }

  const toolName = toolUseBlock.name
  const toolInput = toolUseBlock.input

  const toolDefinition = findToolByName(tools, toolName)
  if (!toolDefinition) {
    return
  }

  // Create ToolUseBlock with the updated input if permission was allowed
  let finalInput = toolInput
  if (permissionResult.behavior === 'allow') {
    if (permissionResult.updatedInput !== undefined) {
      finalInput = permissionResult.updatedInput
    } else {
      logForDebugging(
        `Orphaned permission for ${toolName}: updatedInput is undefined, falling back to original tool input`,
        { level: 'warn' },
      )
    }
  }
  const finalToolUseBlock: ToolUseBlock = {
    ...toolUseBlock,
    input: finalInput,
  }

  const canUseTool: CanUseToolFn = async () => ({
    ...permissionResult,
    decisionReason: {
      type: 'mode',
      mode: 'default' as const,
    },
  })

  // Add the assistant message with tool_use to messages BEFORE executing
  // so the conversation history is complete (tool_use -> tool_result).
  //
  // On CCR resume, mutableMessages is seeded from the transcript and may already
  // contain this tool_use. Pushing again would make normalizeMessagesForAPI merge
  // same-ID assistants (concatenating content) and produce a duplicate tool_use
  // ID, which the API rejects with "tool_use ids must be unique".
  //
  // Check for the specific tool_use_id rather than message.id: streaming yields
  // each content block as a separate AssistantMessage sharing one message.id, so
  // a [text, tool_use] response lands as two entries. filterUnresolvedToolUses may
  // strip the tool_use entry but keep the text one; an id-based check would then
  // wrongly skip the push while runTools below still executes, orphaning the result.
  const alreadyPresent = mutableMessages.some(
    m =>
      m.type === 'assistant' &&
      Array.isArray(m.message.content) &&
      m.message.content.some(
        b => b.type === 'tool_use' && 'id' in b && b.id === toolUseID,
      ),
  )
  if (!alreadyPresent) {
    mutableMessages.push(assistantMessage)
    if (persistSession) {
      await recordTranscript(mutableMessages)
    }
  }

  const sdkAssistantMessage: SDKMessage = {
    ...assistantMessage,
    session_id: getSessionId(),
    parent_tool_use_id: null,
  } as SDKMessage
  yield sdkAssistantMessage

  // Execute the tool - errors are handled internally by runToolUse
  for await (const update of runTools(
    [finalToolUseBlock],
    [assistantMessage],
    canUseTool,
    processUserInputContext,
  )) {
    if (update.message) {
      mutableMessages.push(update.message)
      if (persistSession) {
        await recordTranscript(mutableMessages)
      }

      const sdkMessage: SDKMessage = {
        ...update.message,
        session_id: getSessionId(),
        parent_tool_use_id: null,
      } as SDKMessage

      yield sdkMessage
    }
  }
}

// Create a function to extract read files from messages
export function extractReadFilesFromMessages(
  messages: readonly Message[],
  cwd: string,
  maxSize: number = ASK_READ_FILE_STATE_CACHE_SIZE,
): FileStateCache {
  const cache = createFileStateCacheWithSizeLimit(maxSize)

  for (const result of successfulFileToolResults(messages)) {
    const read = deliveredRead(result, cwd)
    if (read?.cacheableText && typeof read.content === 'string' && result.message.timestamp) {
      const fileContent = read.content
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
        .split('\n')
        .map(stripLineNumberPrefix)
        .join('\n')
        .trim()
      cache.set(read.path, {
        content: fileContent,
        timestamp: new Date(result.message.timestamp).getTime(),
        offset: 1,
        limit: undefined,
        isWriteAuthorizedRead: true,
        ...(read.truncated ? { isTruncatedView: true } : {}),
      })
      continue
    }

    // Mutation results refresh disk state without granting Read provenance.
    const { name } = result.call.block
    if (name !== FILE_WRITE_TOOL_NAME && name !== FILE_EDIT_TOOL_NAME) continue
    const input = result.input as { file_path?: string; content?: string } | undefined
    const data = result.data as { filePath?: string; content?: string } | undefined
    const path = data?.filePath ?? input?.file_path
    if (typeof path !== 'string' || !path) continue
    const filePath = expandPath(path, cwd)
    if (name === FILE_WRITE_TOOL_NAME) {
      const content = data?.content ?? input?.content
      if (typeof content !== 'string' || !result.message.timestamp) continue
      cache.set(filePath, {
        content,
        timestamp: new Date(result.message.timestamp).getTime(),
        offset: undefined,
        limit: undefined,
      })
    } else {
      // Edit records contain only a snippet. Read disk with its actual mtime
      // so the next turn's getChangedFiles check compares the right version.
      try {
        const { content } = readFileSyncWithMetadata(filePath)
        cache.set(filePath, {
          content,
          timestamp: getFileModificationTime(filePath),
          offset: undefined,
          limit: undefined,
        })
      } catch (error: unknown) {
        if (!isFsInaccessible(error)) throw error
      }
    }
  }

  return cache
}

/**
 * Extract the top-level CLI tools used in BashTool calls from message history.
 * Returns a deduplicated set of command names (e.g. 'vercel', 'aws', 'git').
 */
export function extractBashToolsFromMessages(messages: Message[]): Set<string> {
  const tools = new Set<string>()
  for (const message of messages) {
    if (
      message.type === 'assistant' &&
      Array.isArray(message.message.content)
    ) {
      for (const content of message.message.content) {
        if (content.type === 'tool_use' && content.name === BASH_TOOL_NAME) {
          const { input } = content
          if (
            typeof input !== 'object' ||
            input === null ||
            !('command' in input)
          )
            continue
          const cmd = extractCliName(
            typeof input.command === 'string' ? input.command : undefined,
          )
          if (cmd) {
            tools.add(cmd)
          }
        }
      }
    }
  }
  return tools
}

const STRIPPED_COMMANDS = new Set(['sudo'])

/**
 * Extract the actual CLI name from a bash command string, skipping
 * env var assignments (e.g. `FOO=bar vercel` → `vercel`) and prefixes
 * in STRIPPED_COMMANDS.
 */
function extractCliName(command: string | undefined): string | undefined {
  if (!command) return undefined
  const tokens = command.trim().split(/\s+/)
  for (const token of tokens) {
    if (/^[A-Za-z_]\w*=/.test(token)) continue
    if (STRIPPED_COMMANDS.has(token)) continue
    return token
  }
  return undefined
}
