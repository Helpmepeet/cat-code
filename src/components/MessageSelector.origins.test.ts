import { describe, expect, test } from 'bun:test'
import type { MessageOrigin } from '../types/message.js'
import { createUserMessage } from '../utils/messages.js'
import {
  replayableUserMessagesFilter,
  selectableUserMessagesFilter,
} from './MessageSelector.js'

/**
 * `selectableUserMessagesFilter` decides what `/rewind`, `/branch`, the message
 * selector and the desktop's session actions will accept as an edit or rewind
 * target. Anything it accepts is treated as a prompt the operator typed.
 *
 * It used to name the origins it rejected (`teammate`, `task-notification`), so
 * every kind added afterwards was accepted by default — `peer` shipped that way
 * and `/rewind` listed another session's message as one of the operator's own.
 * These cases pin the inverse rule instead: only an absent origin (every emitter
 * predating the field) or `human` is operator-authored.
 */

/** Every member of `MessageOrigin`, so a new kind fails to compile here too. */
const ORIGINS: Record<MessageOrigin['kind'], MessageOrigin> = {
  human: { kind: 'human' },
  interruption: { kind: 'interruption' },
  'task-notification': { kind: 'task-notification' },
  coordinator: { kind: 'coordinator' },
  channel: { kind: 'channel', server: 'slack' },
  teammate: { kind: 'teammate', messages: [] },
  'deferred-continuation': {
    kind: 'deferred-continuation',
    jobId: 'job-1',
    attemptUuid: 'attempt-1',
  },
  peer: { kind: 'peer', name: 'Amber', appSessionId: 'app-session-1' },
}

function userMessageWithOrigin(origin?: MessageOrigin) {
  return createUserMessage({
    content: 'please rewrite the migration notes',
    ...(origin !== undefined && { origin }),
  })
}

describe('selectableUserMessagesFilter', () => {
  test('accepts a message the operator typed', () => {
    expect(selectableUserMessagesFilter(userMessageWithOrigin())).toBe(true)
    expect(
      selectableUserMessagesFilter(userMessageWithOrigin(ORIGINS.human)),
    ).toBe(true)
  })

  test('rejects every engine-injected origin, including peer', () => {
    const injected = Object.entries(ORIGINS).filter(
      ([kind]) => kind !== 'human',
    )
    for (const [kind, origin] of injected) {
      expect([
        kind,
        selectableUserMessagesFilter(userMessageWithOrigin(origin)),
      ]).toEqual([kind, false])
    }
  })

  test('rejects a peer turn carrying the cross-session wrapper text', () => {
    const relayed = createUserMessage({
      content:
        '<cross-session-message from="Amber">rewrite the migration notes</cross-session-message>',
      origin: ORIGINS.peer,
    })
    expect(selectableUserMessagesFilter(relayed)).toBe(false)
  })
})

describe('replayableUserMessagesFilter', () => {
  /**
   * The acknowledgement path stamps provenance onto the replayed frame on
   * purpose (`QueryEngine.ts`, `toSDKMessageOriginProp`), so an injected turn
   * still has to reach a UI — labelled, not attributed to the operator. Only
   * the two origins whose body is engine OUTPUT rather than an instruction are
   * withheld.
   */
  test('still replays injected instruction turns', () => {
    for (const kind of [
      'human',
      'coordinator',
      'channel',
      'deferred-continuation',
      'peer',
    ] as const) {
      expect([
        kind,
        replayableUserMessagesFilter(userMessageWithOrigin(ORIGINS[kind])),
      ]).toEqual([kind, true])
    }
    expect(replayableUserMessagesFilter(userMessageWithOrigin())).toBe(true)
  })

  test('withholds engine output turns', () => {
    for (const kind of ['teammate', 'task-notification'] as const) {
      expect([
        kind,
        replayableUserMessagesFilter(userMessageWithOrigin(ORIGINS[kind])),
      ]).toEqual([kind, false])
    }
  })
})
