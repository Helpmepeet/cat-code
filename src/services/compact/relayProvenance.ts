import type { Message, MessageOrigin } from '../../types/message.js'

/**
 * True when a user-role turn was delivered on someone else's behalf rather than
 * typed by this session's user.
 *
 * The closed switch is deliberate: a new `MessageOrigin` kind must be classified
 * here, because the cost of guessing wrong is an unclassified relay reading as
 * the user's own authorization.
 */
export function isRelayedOrigin(origin: MessageOrigin | undefined): boolean {
  if (origin === undefined) return false
  switch (origin.kind) {
    case 'peer':
    case 'teammate':
    case 'task-notification':
    case 'coordinator':
    case 'channel':
      return true
    // The user's own keyboard, their cancellation marker, and the harness
    // re-delivering a job the user themselves queued.
    case 'human':
    case 'interruption':
    case 'deferred-continuation':
      return false
    default: {
      const _exhaustive: never = origin
      void _exhaustive
      // Unreachable while the switch is exhaustive; fail closed if it is not.
      return true
    }
  }
}

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
    if (message.type !== 'user') continue
    if (message.summarizedRelayedInput === true) return true
    if (isRelayedOrigin(message.origin)) return true
  }
  return undefined
}
