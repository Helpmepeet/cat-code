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
function isRecord(value: unknown): value is {
  type?: unknown
  prompt?: unknown
  source_uuid?: unknown
} {
  return typeof value === 'object' && value !== null
}

/**
 * Rebuild the transcript row of a peer message a BUSY session received.
 *
 * A busy recipient's running turn drains the message itself and folds it into a
 * `queued_command` attachment, which is the ONLY thing that persists: the
 * engine writes no user entry for it, and `toSDKMessages` maps user, assistant
 * and system and drops everything else. So the row a live window showed had
 * nothing behind it after a reload. Everything needed is on the attachment
 * (the delivered text, the peer origin, and the queue uuid the live frame used),
 * so the row is rebuilt from it here, identical to the one the live session
 * broadcast and to the one an idle recipient persists as a real user entry.
 *
 * Peer only, deliberately: worker results and coordinator hand-offs are the
 * other queued_command origins, and the transcript has never shown them.
 */
function restorePeerMessageRow(message: Message): Message {
  if (message.type !== 'attachment') return message
  const attachment = message.attachment
  if (!isRecord(attachment) || attachment.type !== 'queued_command') {
    return message
  }
  // Same resolver the engine and QueryEngine use, so one drained command reads
  // as one provenance everywhere rather than three lookalike derivations.
  const origin = queuedCommandOrigin(attachment)
  if (origin?.kind !== 'peer') return message
  // A peer message is enqueued as a string; a block array would be someone
  // else's shape, so leave it as the attachment it is rather than guess.
  if (typeof attachment.prompt !== 'string') return message
  return createUserMessage({
    content: attachment.prompt,
    origin,
    // The live frame carries the queue uuid, so a restored row lands on the
    // same identity rather than a second one. Attachments written before the
    // uuid existed fall back to the attachment's own.
    uuid:
      typeof attachment.source_uuid === 'string'
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
  return toSDKMessages(
    messages
      .filter(message => !isInternalNoResponseSentinel(message))
      .map(restorePeerMessageRow),
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
