import type { SDKMessage } from '@cat-code/engine/sdk'
import type { AppSessionEvent } from '@cat-code/engine/session-events'

export function messageFromEvent(
  event: Extract<AppSessionEvent, { type: 'message' }>,
): SDKMessage {
  return event.message
}

export function isMessageEvent(
  event: AppSessionEvent,
): event is Extract<AppSessionEvent, { type: 'message' }> {
  return event.type === 'message'
}
