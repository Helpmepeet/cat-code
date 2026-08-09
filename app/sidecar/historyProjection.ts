import type {
  SDKMessage,
  SDKUserMessage,
} from '../../src/entrypoints/agentSdkTypes.js'
import type { Message } from '../../src/types/message.js'
import { isInternalNoResponseSentinel } from '../../src/utils/messages.js'
import { toSDKMessages } from '../../src/utils/messages/mappers.js'

/**
 * Project engine resume state into user-visible restored history.
 *
 * Internal no-response sentinels stay in engine state/transcript bookkeeping
 * but are not assistant-authored content. Explicit provenance plus the legacy
 * API-error shape keeps genuine assistant text with identical words visible.
 */
export function projectResumedHistory(messages: Message[]): SDKMessage[] {
  return toSDKMessages(
    messages.filter(
      message => !isInternalNoResponseSentinel(message),
    ),
  )
}

export function projectUndeliveredPrompts(
  prompts: readonly { uuid: string; content: string; timestamp: string }[],
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
 * engine projection. If the tail cannot be aligned, fail closed to the seed
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
  let prefixLength = -1
  for (
    let start = displayHistory.length - seedHistory.length;
    start >= 0;
    start--
  ) {
    if (
      seedHistory.every(
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
