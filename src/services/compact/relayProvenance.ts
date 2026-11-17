import type { Message } from '../../types/message.js'
import { isRelayedOrigin } from '../../utils/messageOrigin.js'
import { queuedCommandOrigin } from '../../utils/taskNotification.js'
export { isRelayedOrigin } from '../../utils/messageOrigin.js'

/**
 * Whether a compact summary covering `messages` must be marked as containing
 * relayed input.
 *
 * A summary is one user-role message standing in for many, so per-message
 * attribution cannot survive the boundary — "some of this was relayed" is the
 * honest granularity. Structural provenance (`origin`) is dropped by
 * summarization, and the textual half (`<cross-session-message from="...">`) is
 * handed to a model whose prompt instructs it to restate what it summarizes as
 * "the user's explicit requests", so neither survives on its own.
 *
 * Already-marked summaries count, so the flag propagates across repeated
 * compaction of a conversation that has been compacted before.
 */
export function summarizedRelayedInput(
  messages: readonly Message[],
): true | undefined {
  for (const message of messages) {
    if (message.type === 'attachment' &&
      typeof message.attachment === 'object' && message.attachment !== null &&
      'type' in message.attachment && message.attachment.type === 'queued_command') {
      if (isRelayedOrigin(queuedCommandOrigin(message.attachment))) return true
    }
    if (message.type !== 'user') continue
    if (message.summarizedRelayedInput === true) return true
    if (isRelayedOrigin(message.origin)) return true
  }
  return undefined
}
