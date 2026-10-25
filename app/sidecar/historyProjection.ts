import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type {
  SDKMessage,
  SDKUserMessage,
} from '../../src/entrypoints/agentSdkTypes.js'
import type { Message } from '../../src/types/message.js'
import {
  createUserMessage,
  isInternalNoResponseSentinel,
} from '../../src/utils/messages.js'
import { toSDKMessages } from '../../src/utils/messages/mappers.js'
import { queuedCommandOrigin } from '../../src/utils/taskNotification.js'
import type { UndeliveredPrompt } from './sessionResume.js'

/**
 * `AttachmentMessage.attachment` is `unknown` (src/types/message.ts), so the
 * shape is narrowed at read time rather than asserted. Mirrors the engine's own
 * `isQueuedCommandAttachment` (src/utils/taskNotification.ts), which is what
 * `queuedCommandOrigin` narrows with before reading provenance.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isHumanPrompt(content: unknown): content is string | ContentBlockParam[] {
  if (typeof content === 'string') return content.length > 0
  if (!Array.isArray(content) || content.length === 0) return false
  return content.every(block => {
    if (!isRecord(block)) return false
    if (block.type === 'text') return typeof block.text === 'string'
    if (block.type !== 'image' || !isRecord(block.source)) return false
    const source = block.source
    if (source.type === 'url') return typeof source.url === 'string'
    return (
      source.type === 'base64' &&
      typeof source.data === 'string' &&
      typeof source.media_type === 'string' &&
      ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(source.media_type)
    )
  })
}

/**
 * Busy turns persist drained input only as attachments, which the SDK mapper
 * drops. Rebuild human and peer display rows here without changing model state.
 * Internal notifications and meta prompts must remain model-only.
 */
function restoreQueuedMessageRow(message: Message): Message {
  if (message.type !== 'attachment') return message
  const attachment = message.attachment
  if (!isRecord(attachment) || attachment.type !== 'queued_command') {
    return message
  }
  // Same resolver the engine and QueryEngine use, so one drained command reads
  // as one provenance everywhere rather than three lookalike derivations.
  const origin = queuedCommandOrigin(attachment)
  if (origin?.kind === 'peer') {
    // Preserve the existing peer contract: peer sends carry strings, including
    // meta-marked task-notification commands, rather than composer blocks.
    if (typeof attachment.prompt !== 'string') return message
  } else if (
    (origin !== undefined && origin.kind !== 'human') ||
    (attachment.origin !== undefined && origin === undefined) ||
    attachment.isMeta ||
    (attachment.commandMode !== undefined && attachment.commandMode !== 'prompt') ||
    !isHumanPrompt(attachment.prompt)
  ) {
    return message
  }
  return createUserMessage({
    content: attachment.prompt,
    origin,
    // The live frame carries the queue uuid, so a restored row lands on the
    // same identity rather than a second one. Attachments written before the
    // uuid existed fall back to the attachment's own.
    uuid:
      typeof attachment.source_uuid === 'string' && attachment.source_uuid.length > 0
        ? attachment.source_uuid
        : message.uuid,
    ...(message.timestamp !== undefined ? { timestamp: message.timestamp } : {}),
  })
}

/**
 * Project engine resume state into user-visible restored history.
 *
 * Internal no-response sentinels stay in engine state/transcript bookkeeping
 * but are not assistant-authored content. Explicit provenance plus the legacy
 * API-error shape keeps genuine assistant text with identical words visible.
 */
export function projectResumedHistory(messages: Message[]): SDKMessage[] {
  // A saved user entry wins if a historical transcript contains both forms.
  // Only reconstructed rows are deduplicated; ordinary SDK mapping is intact.
  const userUuids = new Set(
    messages.filter(message => message.type === 'user').map(message => message.uuid),
  )
  return toSDKMessages(
    messages
      .filter(message => !isInternalNoResponseSentinel(message))
      .flatMap(message => {
        const restored = restoreQueuedMessageRow(message)
        if (restored === message) return [message]
        if (userUuids.has(restored.uuid)) return []
        userUuids.add(restored.uuid)
        return [restored]
      }),
  )
}

export function projectUndeliveredPrompts(
  prompts: readonly UndeliveredPrompt[],
  engineSessionId: string,
): SDKMessage[] {
  return prompts.map(prompt => ({
    type: 'user',
    message: { role: 'user', content: prompt.content },
    session_id: engineSessionId,
    parent_tool_use_id: null,
    uuid: prompt.uuid as SDKUserMessage['uuid'],
    timestamp: prompt.timestamp,
    isReplay: true,
  }))
}

/**
 * Append the exact model-seed tail to an archival display projection.
 *
 * The archival loader may cross compact boundaries, while the seed must stay
 * compacted. UUID alignment lets the visible tail remain byte-for-byte the
 * engine projection. Resume-generated synthetic prompts and recovered worker
 * notifications have no disk identity to align; they remain in the seed but do
 * not imply a missing archival prefix.
 * If the persisted tail cannot be aligned, fail closed to the seed
 * and mark the display as truncated instead of presenting divergent context.
 */
export function mergeDisplayHistoryWithSeed(
  displayMessages: Message[],
  seedHistory: SDKMessage[],
): { history: SDKMessage[]; truncated: boolean } {
  const displayHistory = projectResumedHistory(displayMessages)
  if (seedHistory.length === 0) {
    return {
      history: [],
      truncated: displayHistory.length > 0,
    }
  }
  const displayUuids = new Set(displayHistory.map(message => message.uuid))
  const persistedSeed = seedHistory.filter(message =>
    !(message.type === 'user' &&
      (message.isSynthetic || message.origin?.kind === 'task-notification') &&
      !displayUuids.has(message.uuid)),
  )
  if (persistedSeed.length === 0) {
    return { history: seedHistory, truncated: displayHistory.length > 0 }
  }
  let prefixLength = -1
  for (
    let start = displayHistory.length - persistedSeed.length;
    start >= 0;
    start--
  ) {
    if (
      persistedSeed.every(
        (message, index) => displayHistory[start + index]?.uuid === message.uuid,
      )
    ) {
      prefixLength = start
      break
    }
  }
  if (prefixLength < 0) return { history: seedHistory, truncated: true }
  return {
    history: [...displayHistory.slice(0, prefixLength), ...seedHistory],
    truncated: false,
  }
}
