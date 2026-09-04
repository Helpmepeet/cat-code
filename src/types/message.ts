import type { BetaContentBlock, BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type {
  ContentBlock,
  ContentBlockParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import type { UUID } from 'crypto'
import type { TeammateMessageContract } from '../utils/teammateMessage.js'

export type MessageOrigin =
  | { kind: 'human' }
  /** A user-initiated cancellation marker, kept for transcript replay. */
  | { kind: 'interruption' }
  | {
      kind: 'task-notification'
      summary?: string
      status?: 'completed' | 'failed' | 'killed' | 'running' | 'pending'
      taskId?: string
      taskType?: string
      outputFile?: string
      toolUseId?: string
      result?: string
      usage?: {
        totalTokens: number
        toolUses: number
        durationMs: number
      }
      worktreePath?: string
      worktreeBranch?: string
    }
  | { kind: 'coordinator' }
  | {
      kind: 'channel'
      server: string
      user?: string
      meta?: Record<string, string>
    }
  | { kind: 'teammate'; messages: TeammateMessageContract[] }
  | {
      kind: 'deferred-continuation'
      jobId: string
      attemptUuid: string
    }
  /**
   * A message delivered from another named session. `appSessionId` is the
   * sender's app-side address, carried as a plain string: the engine never
   * depends on `app/`.
   *
   * `creationPrompt` marks the one message that is the recipient's first and
   * only input, the instruction it was created with. Absent means an ordinary
   * mid-turn peer message, which is the fail-closed direction: that framing
   * deprioritizes the message against work in progress.
   */
  | {
      kind: 'peer'
      name: string
      appSessionId: string
      creationPrompt?: true
    }

export type DeferredTerminalFailureV1 = {
  version: 1
  provider: 'openai'
  code:
    | 'quota_exhausted'
    | 'account_recovery'
    | 'transient_network'
    | 'ambiguous_rate_limit'
  observedAt: number
}

export type PartialCompactDirection = 'from' | 'up_to'

export type SystemMessageLevel = 'info' | 'warning' | 'error'

export type UserMessage = {
  type: 'user'
  uuid: UUID | string
  timestamp: string
  message: {
    role: 'user'
    content: string | ContentBlockParam[]
  }
  isMeta?: true
  isVisibleInTranscriptOnly?: true
  isVirtual?: true
  isCompactSummary?: true
  summarizeMetadata?: {
    messagesSummarized: number
    userContext?: string
    direction?: PartialCompactDirection
  }
  toolUseResult?: unknown
  /**
   * Terminal state for a tool result that is deliberately not a tool failure.
   * This survives transcript persistence and lets displays distinguish a user
   * cancellation from a failed invocation without parsing its model-facing body.
   */
  toolResultStatus?: 'cancelled'
  mcpMeta?: {
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
  imagePasteIds?: number[]
  sourceToolAssistantUUID?: UUID
  permissionMode?: string
  origin?: MessageOrigin
  planContent?: string
}

export type AssistantMessage<TContentBlock = BetaContentBlock | ContentBlock | ContentBlockParam> = {
  type: 'assistant'
  uuid: UUID | string
  timestamp?: string
  /**
   * Internal no-response marker. Kept in model context/transcript bookkeeping,
   * never rendered as assistant-authored transcript content.
   */
  isInternalNoResponseSentinel?: true
  advisorModel?: string
  /** Provider-message-scoped raw reasoning availability, preserved across normalization. */
  hasRawReasoning?: boolean
  requestId?: string | null
  message: {
    id?: string
    model?: string
    role?: 'assistant'
    content: TContentBlock[]
    usage?: BetaUsage
    stop_reason?: string | null
    stop_sequence?: string | null
  }
  isApiErrorMessage?: boolean
  apiError?: unknown
  error?: unknown
  errorDetails?: unknown
  deferredTerminalFailure?: DeferredTerminalFailureV1
}

export type AttachmentMessage = {
  type: 'attachment'
  uuid: UUID | string
  timestamp?: string
  attachment: unknown
}

export type ProgressMessage<TData = unknown> = {
  type: 'progress'
  uuid: UUID | string
  timestamp?: string
  subtype?: string
  content?: string
  data?: TData
}

export type SystemMessage = {
  type: 'system'
  uuid: UUID | string
  timestamp?: string
  subtype: string
  level?: SystemMessageLevel
  content?: string
  data?: unknown
  toolUseID?: string
  compactMetadata?: CompactMetadata
}

export type SystemAPIErrorMessage = SystemMessage & {
  subtype: 'api_error'
}

/**
 * A transport failure the engine recovered from inside the same turn: the
 * request was not replayed, the partial response was kept, and the turn
 * continued over a different path. Surfaced through the SDK's existing retry
 * vocabulary rather than a frame of its own.
 */
export type SystemTransportRecoveryMessage = SystemMessage & {
  subtype: 'transport_recovery'
  content: string
  attempt: number
  maxAttempts: number
}

export type SystemInformationalMessage = SystemMessage & {
  subtype: 'informational'
}

export type SystemLocalCommandMessage = SystemMessage & {
  subtype: 'local_command'
  content: string
}

export type SystemCompactBoundaryMessage = SystemMessage & {
  subtype: 'compact_boundary'
}

export type SystemMicrocompactBoundaryMessage = SystemMessage & {
  subtype: 'microcompact_boundary'
}

export type SystemStopHookSummaryMessage = SystemMessage & {
  subtype: 'stop_hook_summary'
}

export type SystemBridgeStatusMessage = SystemMessage & {
  subtype: 'bridge_status'
}

export type SystemTurnDurationMessage = SystemMessage & {
  subtype: 'turn_duration'
}

export type SystemThinkingMessage = SystemMessage & {
  subtype: 'thinking'
}

export type SystemMemorySavedMessage = SystemMessage & {
  subtype: 'memory_saved'
}

export type SystemPermissionRetryMessage = SystemMessage & {
  subtype: 'permission_retry'
}

export type SystemScheduledTaskFireMessage = SystemMessage & {
  subtype: 'scheduled_task_fire'
}

export type SystemAwaySummaryMessage = SystemMessage & {
  subtype: 'away_summary'
}

export type SystemApiMetricsMessage = SystemMessage & {
  subtype: 'api_metrics'
}

export type SystemAgentsKilledMessage = SystemMessage & {
  subtype: 'agents_killed'
}

export type SystemFileSnapshotMessage = SystemMessage & {
  subtype: 'file_snapshot'
}

export type MessageContentBlock = {
  type: string
  name?: string
  tool_use_id?: string
  id?: string
  input?: Record<string, unknown> | string
  is_error?: boolean
  [key: string]: unknown
}

export type GroupedToolUseMessage = {
  type: 'grouped_tool_use'
  uuid: UUID | string
  timestamp?: string
  toolName: string
  messages: AssistantMessage[]
  results: NormalizedUserMessage[]
  displayMessage: AssistantMessage
  messageId?: string
  toolUses?: unknown[]
  message?: { content?: MessageContentBlock[] | string }
}

export type CollapsedReadSearchGroup = {
  type: 'collapsed_read_search'
  uuid: UUID | string
  timestamp?: string
  messages: CollapsibleMessage[]
  displayMessage: NormalizedAssistantMessage | NormalizedUserMessage
  searchCount: number
  readCount: number
  listCount: number
  replCount: number
  memorySearchCount: number
  memoryReadCount: number
  memoryWriteCount: number
  readFilePaths: string[]
  searchArgs?: string[]
  latestDisplayHint?: string
  mcpCallCount?: number
  mcpServerNames?: string[]
  bashCount?: number
  gitOpBashCount?: number
  commits?: unknown[]
  pushes?: unknown[]
  branches?: unknown[]
  prs?: unknown[]
  hookTotalMs?: number
  hookCount?: number
  hookInfos?: StopHookInfo[]
  relevantMemories?: unknown[]
  teamMemorySearchCount?: number
  teamMemoryReadCount?: number
  teamMemoryWriteCount?: number
  message?: { content?: MessageContentBlock[] | string }
}

export type TombstoneMessage = {
  type: 'tombstone'
  uuid: UUID | string
  timestamp?: string
}

export type ToolUseSummaryMessage = SystemMessage & {
  subtype: 'tool_use_summary'
}

export type HookResultMessage = SystemMessage & {
  subtype: 'hook_result'
}

export type CollapsibleMessage =
  | GroupedToolUseMessage
  | CollapsedReadSearchGroup

export type CompactMetadata = {
  messagesSummarized?: number
  userContext?: string
  direction?: PartialCompactDirection
  trigger?: 'manual' | 'auto'
  preTokens?: number
  preservedSegment?: {
    headUuid: string
    anchorUuid: string
    tailUuid: string
  }
  /**
   * Explicit membership for the preserved suffix. Additive: `preservedSegment`
   * is still written for transcripts read by the head/tail walk, and boundaries
   * written before this field existed carry only that.
   *
   * `durableUuids` names preserved messages that reach the transcript, in chain
   * order, and is what resume relinks against. `liveUuids` is the in-process
   * superset including messages `isLoggableMessage` drops (progress, silent
   * hook successes);
   * it is NOT crash durable and must never be treated as recoverable state.
   */
  preservedMessages?: {
    anchorUuid: string
    durableUuids: string[]
    liveUuids?: string[]
  }
}

export type RequestStartEvent = {
  type: 'request_start'
  [key: string]: unknown
}

export type StreamEvent = {
  type: string
  [key: string]: unknown
}

export type StopHookInfo = {
  [key: string]: unknown
}

export type NormalizedUserMessage = UserMessage
export type NormalizedAssistantMessage<TContentBlock = BetaContentBlock | ContentBlock | ContentBlockParam> = AssistantMessage<TContentBlock>
export type NormalizedMessage =
  | UserMessage
  | AssistantMessage
  | AttachmentMessage
  | SystemMessage
  | GroupedToolUseMessage
  | CollapsedReadSearchGroup
  | ProgressMessage
  | TombstoneMessage

export type RenderableMessage = Exclude<NormalizedMessage, ProgressMessage>

export type Message = NormalizedMessage

export type UserToolResultMessage = UserMessage & {
  message: {
    role: 'user'
    content: ToolResultBlockParam[]
  }
}
