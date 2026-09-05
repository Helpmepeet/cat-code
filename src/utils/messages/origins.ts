import type { MessageOrigin } from '../../types/message.js'

/**
 * Two questions the engine asks about a user-role turn's provenance, answered
 * in one place so a new `MessageOrigin` kind cannot inherit an answer by
 * default. Both switches carry a closed-union tripwire, the same discipline
 * `toSDKMessageOrigin` (./mappers.ts) uses on the SDK projection.
 *
 * The rule they encode is the one `SDKMessageOriginSchema` already documents:
 * an absent origin means "typed by the operator" (that is also every emitter
 * predating the field), and any present non-`human` kind means the engine
 * injected this turn.
 */

/**
 * True only for a turn the local operator authored, so it can be offered as an
 * edit, branch or rewind target.
 *
 * This is the inverse of how the question used to be asked. `MessageSelector`
 * named the origins it REJECTED, which meant every kind added afterwards was
 * accepted by default: `peer` shipped without being added to that list, and
 * `/rewind` in a resumed desktop peer session listed another session's message
 * as one of the operator's own prompts.
 */
export function isOperatorAuthoredOrigin(
  origin: MessageOrigin | undefined,
): boolean {
  if (origin === undefined) return true
  switch (origin.kind) {
    case 'human':
      return true
    // An interruption is a cancellation marker, not a prompt; the rest are
    // turns some other author (an agent, a channel user, a named peer session,
    // the engine itself) put into this conversation.
    case 'interruption':
    case 'task-notification':
    case 'coordinator':
    case 'channel':
    case 'teammate':
    case 'deferred-continuation':
    case 'peer':
      return false
    default: {
      // Closed-union tripwire: a new MessageOrigin must decide here whether the
      // operator may edit, branch from, or rewind to it. Failing closed at
      // runtime keeps an unbuilt kind out of those targets either way.
      const _exhaustive: never = origin
      void _exhaustive
      return false
    }
  }
}

/**
 * True for a user-role turn that carries an instruction someone meant this
 * session to act on, whoever wrote it. False only where the message body is
 * engine OUTPUT wearing a user role: a finished agent's notification banner, a
 * teammate's relayed payload.
 *
 * Kept separate from `isOperatorAuthoredOrigin` because the acknowledgement
 * path stamps provenance onto the replayed frame on purpose, so an injected
 * turn still has to reach a display — labelled, never attributed to the
 * operator.
 */
export function isReplayableOrigin(
  origin: MessageOrigin | undefined,
): boolean {
  if (origin === undefined) return true
  switch (origin.kind) {
    case 'task-notification':
    case 'teammate':
      return false
    case 'human':
    case 'interruption':
    case 'coordinator':
    case 'channel':
    case 'deferred-continuation':
    case 'peer':
      return true
    default: {
      // Closed-union tripwire: a new MessageOrigin must decide here whether its
      // body is an instruction or engine output.
      const _exhaustive: never = origin
      void _exhaustive
      return false
    }
  }
}
