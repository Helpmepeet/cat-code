import type { APIError } from '@anthropic-ai/sdk'
import type { BetaContentBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { randomUUID, type UUID } from 'crypto'
import { getSessionId } from 'src/bootstrap/state.js'
import {
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from 'src/constants/xml.js'
import { categorizeRetryableAPIError } from 'src/services/api/errors.js'
import type {
  SDKAssistantErrorCode,
  SDKAssistantMessage,
  SDKCompactBoundaryMessage,
  SDKMessage,
  SDKMessageOrigin,
  SDKRateLimitInfo,
} from 'src/entrypoints/agentSdkTypes.js'
import type { ClaudeAILimits } from 'src/services/claudeAiLimits.js'
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from 'src/tools/ExitPlanModeTool/constants.js'
import type {
  AssistantMessage,
  CompactMetadata,
  Message,
  MessageOrigin,
  SystemMessage,
} from 'src/types/message.js'
import type { DeepImmutable } from 'src/types/utils.js'
import stripAnsi from 'strip-ansi'
import {
  createAssistantMessage,
  isInternalNoResponseSentinel,
} from '../messages.js'
import { getPlan } from '../plans.js'

export function toInternalMessages(
  messages: readonly DeepImmutable<SDKMessage>[],
): Message[] {
  return messages.flatMap(message => {
    switch (message.type) {
      case 'assistant':
        return [
          {
            type: 'assistant',
            message: message.message,
            uuid: message.uuid,
            requestId: undefined,
            timestamp: new Date().toISOString(),
          } as Message,
        ]
      case 'user':
        return [
          {
            type: 'user',
            message: message.message,
            uuid: message.uuid ?? randomUUID(),
            timestamp: message.timestamp ?? new Date().toISOString(),
            isMeta: message.isSynthetic,
          } as Message,
        ]
      case 'system':
        // Handle compact boundary messages
        if (message.subtype === 'compact_boundary') {
          const compactMsg = message
          return [
            {
              type: 'system',
              content: 'Conversation compacted',
              level: 'info',
              subtype: 'compact_boundary',
              compactMetadata: fromSDKCompactMetadata(
                compactMsg.compact_metadata,
              ),
              uuid: message.uuid,
              timestamp: new Date().toISOString(),
            },
          ]
        }
        return []
      default:
        return []
    }
  })
}

/**
 * Curated copy for a retry notice, keyed by the closed error classification.
 *
 * The retry frame's `error` field accepts either a bare code or an object
 * carrying a message. Only the object form reaches a reader: the desktop
 * projector requires `error.message`, so every code-only retry notice this
 * engine has emitted was silently dropped on the way to the transcript.
 * Emitting the object form is what makes a retry visible at all, and the copy
 * has to be written for a person, since the code itself is an internal name
 * nobody should be shown.
 *
 * TWIN: `RETRY_NOTICE_COPY_BY_CODE` in `app/renderer/src/transcriptProjector.ts`
 * maps the same codes for transcripts recorded before this form existed. The
 * renderer cannot import engine modules, so the duplication is forced; keep the
 * two in step or a replayed transcript reads differently from a live one.
 */
const RETRY_NOTICE_COPY: Record<SDKAssistantErrorCode, string> = {
  rate_limit: 'Rate limited. Retrying.',
  authentication_failed: 'Sign-in problem. Retrying.',
  billing_error: 'Billing problem. Retrying.',
  invalid_request: 'The request was rejected. Retrying.',
  server_error: 'The service returned an error. Retrying.',
  max_output_tokens: 'The response was cut off. Retrying.',
  unknown: 'The request failed. Retrying.',
}

export function toSDKRetryError(code: SDKAssistantErrorCode): {
  type: 'assistant_error'
  message: string
  error: string
} {
  return {
    type: 'assistant_error',
    message: RETRY_NOTICE_COPY[code],
    error: code,
  }
}

/**
 * Fields the two retry-notice builders attach that `SystemMessage` does not
 * declare (`createSystemAPIErrorMessage`,
 * `createSystemTransportRecoveryMessage` in `../messages.ts`). A resumed
 * transcript delivers them as replayed JSON, where `error` has already
 * flattened to a plain object, so they are read by value rather than trusted.
 */
type RetryNoticeFields = {
  retryAttempt?: unknown
  maxRetries?: unknown
  retryInMs?: unknown
  error?: APIError
  attempt?: unknown
  maxAttempts?: unknown
}

function readRetryNoticeFields(message: SystemMessage): RetryNoticeFields {
  return message as RetryNoticeFields
}

function retryNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

type SDKCompactMetadata = SDKCompactBoundaryMessage['compact_metadata']

export function toSDKCompactMetadata(
  meta: CompactMetadata,
): SDKCompactMetadata {
  const seg = meta.preservedSegment
  return {
    trigger: meta.trigger,
    pre_tokens: meta.preTokens,
    ...(meta.messagesSummarized !== undefined && {
      messages_summarized: meta.messagesSummarized,
    }),
    ...(seg && {
      preserved_segment: {
        head_uuid: seg.headUuid,
        anchor_uuid: seg.anchorUuid,
        tail_uuid: seg.tailUuid,
      },
    }),
  }
}

/**
 * Shared SDK→internal compact_metadata converter.
 */
export function fromSDKCompactMetadata(
  meta: SDKCompactMetadata,
): CompactMetadata {
  const seg = meta.preserved_segment
  return {
    trigger: meta.trigger,
    preTokens: meta.pre_tokens,
    ...(seg && {
      preservedSegment: {
        headUuid: seg.head_uuid,
        anchorUuid: seg.anchor_uuid,
        tailUuid: seg.tail_uuid,
      },
    }),
  }
}

/**
 * Project the internal `MessageOrigin` onto the SDK's display-safe
 * `SDKMessageOrigin` (see `SDKMessageOriginSchema` for why each member is
 * narrowed). This is the ONLY place the internal union crosses to the SDK
 * surface, so out-of-process consumers never hand-copy the engine's provenance
 * rules — and the closed-union tripwire below forces a new `MessageOrigin` kind
 * to decide, here, whether it is attributable to the operator.
 */
export function toSDKMessageOrigin(
  origin: MessageOrigin,
): SDKMessageOrigin | undefined {
  switch (origin.kind) {
    case 'human':
      return { kind: 'human' }
    case 'interruption':
      return { kind: 'interruption' }
    case 'task-notification':
      return {
        kind: 'task-notification',
        ...(origin.status !== undefined && { status: origin.status }),
        ...(origin.summary !== undefined && { summary: origin.summary }),
        // Carried so a display can render the finished agent from STRUCTURED
        // fields and fold it into the spawning agent's card, rather than
        // reprinting `formatTaskNotificationText`'s model-facing banner (which
        // puts the task id, output path and tool-use id on screen).
        // `taskId`/`outputFile` stay engine-side: no display meaning.
        ...(origin.toolUseId !== undefined && { toolUseId: origin.toolUseId }),
        ...(origin.result !== undefined && { result: origin.result }),
        ...(origin.usage !== undefined && { usage: origin.usage }),
      }
    case 'coordinator':
      return { kind: 'coordinator' }
    case 'channel':
      return {
        kind: 'channel',
        server: origin.server,
        ...(origin.user !== undefined && { user: origin.user }),
      }
    case 'teammate': {
      const from = origin.messages[0]?.from
      return { kind: 'teammate', ...(from !== undefined && { from }) }
    }
    case 'deferred-continuation':
      return { kind: 'deferred-continuation' }
    case 'peer':
      return { kind: 'peer', name: origin.name }
    default: {
      // Closed-union tripwire: a new MessageOrigin must decide its SDK-facing
      // projection here rather than silently vanishing from the wire and being
      // rendered as the operator's own message.
      const _exhaustive: never = origin
      void _exhaustive
      // Unreachable while the tripwire compiles (converter and union are the
      // same build). Omitting is the pre-field behaviour, never a false claim.
      return undefined
    }
  }
}

/**
 * Spread helper for the three SDK user-frame emitters (here plus QueryEngine's
 * ack and drained-command yields): attach `origin` when there is one, and stay
 * byte-identical to the pre-field frame when there is not.
 */
export function toSDKMessageOriginProp(
  origin: MessageOrigin | undefined,
): { origin?: SDKMessageOrigin } {
  if (origin === undefined) return {}
  const projected = toSDKMessageOrigin(origin)
  return projected === undefined ? {} : { origin: projected }
}

export function toSDKMessages(messages: Message[]): SDKMessage[] {
  return messages.flatMap((message): SDKMessage[] => {
    switch (message.type) {
      case 'assistant':
        if (isInternalNoResponseSentinel(message)) return []
        return [
          {
            type: 'assistant',
            message: normalizeAssistantMessageForSDK(message),
            session_id: getSessionId(),
            parent_tool_use_id: null,
            uuid: message.uuid,
            error: message.error,
          },
        ]
      case 'user':
        return [
          {
            type: 'user',
            message: message.message,
            session_id: getSessionId(),
            parent_tool_use_id: null,
            uuid: message.uuid,
            timestamp: message.timestamp,
            isSynthetic: message.isMeta || message.isVisibleInTranscriptOnly,
            // Structured tool output (not the string content sent to the
            // model — the full Output object). Rides the protobuf catchall
            // so web viewers can read things like BriefTool's file_uuid
            // without it polluting model context.
            ...(message.toolUseResult !== undefined
              ? { tool_use_result: message.toolUseResult }
              : {}),
            ...(message.toolResultStatus !== undefined
              ? { tool_result_status: message.toolResultStatus }
              : {}),
            // Provenance for restored transcripts: a resumed session's stored
            // messages carry `origin`, and dropping it here is what made an
            // engine-injected turn replay as the operator's own message.
            ...toSDKMessageOriginProp(message.origin),
          },
        ]
      case 'system':
        if (message.subtype === 'compact_boundary' && message.compactMetadata) {
          return [
            {
              type: 'system',
              subtype: 'compact_boundary' as const,
              session_id: getSessionId(),
              uuid: message.uuid,
              compact_metadata: toSDKCompactMetadata(message.compactMetadata),
            },
          ]
        }
        // Both retry subtypes leave the engine as one `api_retry` frame
        // (QueryEngine's live yields). Emitting them here too is what makes a
        // resumed or backfilled transcript show the retries the live one
        // showed; a frame that differs from the live one would read as a
        // different event, so the field mapping is kept identical.
        if (message.subtype === 'api_error') {
          const fields = readRetryNoticeFields(message)
          const attempt = retryNumber(fields.retryAttempt)
          const maxRetries = retryNumber(fields.maxRetries)
          const retryInMs = retryNumber(fields.retryInMs)
          if (
            attempt === undefined ||
            maxRetries === undefined ||
            retryInMs === undefined ||
            fields.error === undefined
          ) {
            return []
          }
          return [
            {
              type: 'system',
              subtype: 'api_retry' as const,
              attempt,
              max_retries: maxRetries,
              retry_delay_ms: retryInMs,
              error_status: fields.error.status ?? null,
              error: toSDKRetryError(categorizeRetryableAPIError(fields.error)),
              session_id: getSessionId(),
              uuid: message.uuid,
            },
          ]
        }
        if (message.subtype === 'transport_recovery') {
          const fields = readRetryNoticeFields(message)
          const attempt = retryNumber(fields.attempt)
          const maxAttempts = retryNumber(fields.maxAttempts)
          if (
            attempt === undefined ||
            maxAttempts === undefined ||
            message.content === undefined
          ) {
            return []
          }
          return [
            {
              type: 'system',
              subtype: 'api_retry' as const,
              attempt,
              max_retries: maxAttempts,
              retry_delay_ms: 0,
              error_status: null,
              error: {
                type: 'assistant_error' as const,
                message: message.content,
                error: 'connection_error',
              },
              session_id: getSessionId(),
              uuid: message.uuid,
            },
          ]
        }
        // Only convert local_command messages that contain actual command
        // output (stdout/stderr). The same subtype is also used for command
        // input metadata (e.g. <command-name>...</command-name>) which must
        // not leak to the RC web UI.
        if (
          message.subtype === 'local_command' &&
          (message.content.includes(`<${LOCAL_COMMAND_STDOUT_TAG}>`) ||
            message.content.includes(`<${LOCAL_COMMAND_STDERR_TAG}>`))
        ) {
          return [
            localCommandOutputToSDKAssistantMessage(
              message.content,
              message.uuid,
            ),
          ]
        }
        return []
      default:
        return []
    }
  })
}

/**
 * Converts local command output (e.g. /voice, /cost) to a well-formed
 * SDKAssistantMessage so downstream consumers (mobile apps, session-ingress
 * v1alpha→v1beta converter) can parse it without schema changes.
 *
 * Emitted as assistant instead of the dedicated SDKLocalCommandOutputMessage
 * because the system/local_command_output subtype is unknown to:
 *   - mobile-apps Android SdkMessageTypes.kt (no local_command_output handler)
 *   - api-go session-ingress convertSystemEvent (only init/compact_boundary)
 * See: https://anthropic.sentry.io/issues/7266299248/ (Android)
 *
 * Strips ANSI (e.g. chalk.dim() in /cost) then unwraps the XML wrapper tags.
 */
export function localCommandOutputToSDKAssistantMessage(
  rawContent: string,
  uuid: UUID,
): SDKAssistantMessage {
  const cleanContent = stripAnsi(rawContent)
    .replace(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/, '$1')
    .replace(/<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/, '$1')
    .trim()
  // createAssistantMessage builds a complete APIAssistantMessage with id, type,
  // model: SYNTHETIC_MODEL, role, stop_reason, usage — all fields required by
  // downstream deserializers like Android's SdkAssistantMessage.
  const synthetic = createAssistantMessage({ content: cleanContent })
  return {
    type: 'assistant',
    message: synthetic.message,
    parent_tool_use_id: null,
    session_id: getSessionId(),
    uuid,
  }
}

/**
 * Maps internal ClaudeAILimits to the SDK-facing SDKRateLimitInfo type,
 * stripping internal-only fields like unifiedRateLimitFallbackAvailable.
 */
export function toSDKRateLimitInfo(
  limits: ClaudeAILimits | undefined,
): SDKRateLimitInfo | undefined {
  if (!limits) {
    return undefined
  }
  return {
    status: limits.status,
    ...(limits.resetsAt !== undefined && { resetsAt: limits.resetsAt }),
    ...(limits.rateLimitType !== undefined && {
      rateLimitType: limits.rateLimitType,
    }),
    ...(limits.utilization !== undefined && {
      utilization: limits.utilization,
    }),
    ...(limits.overageStatus !== undefined && {
      overageStatus: limits.overageStatus,
    }),
    ...(limits.overageResetsAt !== undefined && {
      overageResetsAt: limits.overageResetsAt,
    }),
    ...(limits.overageDisabledReason !== undefined && {
      overageDisabledReason: limits.overageDisabledReason,
    }),
    ...(limits.isUsingOverage !== undefined && {
      isUsingOverage: limits.isUsingOverage,
    }),
    ...(limits.surpassedThreshold !== undefined && {
      surpassedThreshold: limits.surpassedThreshold,
    }),
  }
}

/**
 * Normalizes tool inputs in assistant message content for SDK consumption.
 * Specifically injects plan content into ExitPlanModeV2 tool inputs since
 * the V2 tool reads plan from file instead of input, but SDK users expect
 * tool_input.plan to exist.
 */
function normalizeAssistantMessageForSDK(
  message: AssistantMessage,
): AssistantMessage['message'] {
  const content = message.message.content
  if (!Array.isArray(content)) {
    return message.message
  }

  const normalizedContent = content.map((block): BetaContentBlock => {
    if (block.type !== 'tool_use') {
      return block
    }

    if (block.name === EXIT_PLAN_MODE_V2_TOOL_NAME) {
      const plan = getPlan()
      if (plan) {
        return {
          ...block,
          input: { ...(block.input as Record<string, unknown>), plan },
        }
      }
    }

    return block
  })

  return {
    ...message.message,
    content: normalizedContent,
  }
}
