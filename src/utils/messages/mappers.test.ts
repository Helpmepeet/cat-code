import { describe, expect, test } from 'bun:test'
import type {
  CompactMetadata,
  MessageOrigin,
  UserMessage,
} from '../../types/message.js'
import {
  toSDKCompactMetadata,
  toSDKMessageOrigin,
  toSDKMessages,
} from './mappers.js'

/**
 * `MessageOrigin` (src/types/message.ts:10) has six kinds; five are engine
 * INJECTED turns that still carry `role: 'user'`. Until this projection existed
 * the discriminant never left the engine process, so every out-of-process
 * consumer rendered those five as the operator's own message.
 */
describe('toSDKMessageOrigin', () => {
  test('projects every kind, and never loses the discriminant', () => {
    expect(toSDKMessageOrigin({ kind: 'human' })).toEqual({ kind: 'human' })
    expect(toSDKMessageOrigin({ kind: 'coordinator' })).toEqual({
      kind: 'coordinator',
    })
    expect(
      toSDKMessageOrigin({
        kind: 'deferred-continuation',
        jobId: 'job-1',
        attemptUuid: 'attempt-1',
      }),
    ).toEqual({ kind: 'deferred-continuation' })
  })

  test('task-notification keeps only status + summary', () => {
    const projected = toSDKMessageOrigin({
      kind: 'task-notification',
      status: 'completed',
      summary: 'refactored the parser',
      // Free text + accounting the banner content already carries — deliberately
      // NOT forwarded (it would only double the frame).
      result: 'a very long agent result',
      usage: { totalTokens: 1000, toolUses: 3, durationMs: 42 },
      worktreePath: '/repo/.worktrees/x',
    })
    expect(projected).toEqual({
      kind: 'task-notification',
      status: 'completed',
      summary: 'refactored the parser',
    })
  })

  test('channel keeps server/user and DROPS meta (third-party-authored keys)', () => {
    // `meta`'s KEYS come from an external MCP channel server. A key named
    // `authorization`/`apiKey` would trip the desktop's key-name secretGuard and
    // cost the whole outbound frame, so the projection never carries it.
    const projected = toSDKMessageOrigin({
      kind: 'channel',
      server: 'slack',
      user: 'dana',
      meta: { authorization: 'Bearer hunter2', apiKey: 'sk-live-abc' },
    })
    expect(projected).toEqual({ kind: 'channel', server: 'slack', user: 'dana' })
    expect(JSON.stringify(projected)).not.toContain('hunter2')
    expect(JSON.stringify(projected)).not.toContain('sk-live-abc')
  })

  test('teammate keeps the sender handle only, not the message payload', () => {
    const projected = toSDKMessageOrigin({
      kind: 'teammate',
      messages: [
        { kind: 'teammate', from: 'scout', text: 'the full teammate payload' },
      ],
    })
    expect(projected).toEqual({ kind: 'teammate', from: 'scout' })
    expect(JSON.stringify(projected)).not.toContain('the full teammate payload')
  })

  test('a teammate origin with no messages still projects its kind', () => {
    expect(toSDKMessageOrigin({ kind: 'teammate', messages: [] })).toEqual({
      kind: 'teammate',
    })
  })
})

describe('toSDKMessages carries provenance', () => {
  function userMessage(origin?: MessageOrigin): UserMessage {
    return {
      type: 'user',
      uuid: '00000000-0000-4000-8000-0000000000m1',
      timestamp: '2026-07-26T00:00:00.000Z',
      message: { role: 'user', content: 'hello' },
      ...(origin === undefined ? {} : { origin }),
    }
  }

  test('a restored injected turn keeps its origin across the mapper', () => {
    // History replay (`app/sidecar/index.ts` → toSDKMessages) is how a session
    // the TUI wrote reaches the desktop. Dropping origin here is what made an
    // engine-injected turn replay as the operator's own message.
    const [sdk] = toSDKMessages([userMessage({ kind: 'coordinator' })])
    expect(sdk).toMatchObject({ type: 'user', origin: { kind: 'coordinator' } })
  })

  test('an operator turn carries no origin key at all (byte-identical to pre-field)', () => {
    const [sdk] = toSDKMessages([userMessage()])
    expect(sdk).not.toHaveProperty('origin')
  })
})

describe('toSDKCompactMetadata', () => {
  test('keeps the real summarized count and preserved segment on the SDK boundary', () => {
    const compact: CompactMetadata = {
      trigger: 'auto',
      preTokens: 178400,
      messagesSummarized: 34,
      preservedSegment: {
        headUuid: 'head-1',
        anchorUuid: 'anchor-1',
        tailUuid: 'tail-1',
      },
    }
    expect(toSDKCompactMetadata(compact)).toEqual({
      trigger: 'auto',
      pre_tokens: 178400,
      messages_summarized: 34,
      preserved_segment: {
        head_uuid: 'head-1',
        anchor_uuid: 'anchor-1',
        tail_uuid: 'tail-1',
      },
    })
  })
})
