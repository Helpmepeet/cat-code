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
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  NO_RESPONSE_REQUESTED,
} from '../messages.js'

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

  test('task-notification keeps the display fields and DROPS the internals', () => {
    // A display that reprints `formatTaskNotificationText`'s banner puts the
    // task id and the output path on the user's screen (leak, 2026-08-01). The
    // fix is structured fields, so what crosses is exactly what a UI renders:
    // the outcome, the agent's answer, its accounting, and the join key back to
    // the spawning tool_use. `taskId`/`outputFile` have no display meaning and
    // stay engine-side.
    const projected = toSDKMessageOrigin({
      kind: 'task-notification',
      status: 'completed',
      summary: 'refactored the parser',
      result: 'a very long agent result',
      usage: { totalTokens: 1000, toolUses: 3, durationMs: 42 },
      toolUseId: 'toolu_agent_1',
      taskId: 'ae916c961d15ead2f',
      outputFile: '/private/tmp/tasks/ae916c961d15ead2f.output',
      worktreePath: '/repo/.worktrees/x',
    })
    expect(projected).toEqual({
      kind: 'task-notification',
      status: 'completed',
      summary: 'refactored the parser',
      result: 'a very long agent result',
      usage: { totalTokens: 1000, toolUses: 3, durationMs: 42 },
      toolUseId: 'toolu_agent_1',
    })
    const serialized = JSON.stringify(projected)
    expect(serialized).not.toContain('ae916c961d15ead2f')
    expect(serialized).not.toContain('/private/tmp/tasks')
    expect(serialized).not.toContain('.worktrees')
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

describe('toSDKMessages hides internal no-response sentinels', () => {
  test('drops current and legacy silent API fallback records', () => {
    const current = createAssistantAPIErrorMessage({
      content: NO_RESPONSE_REQUESTED,
    })
    const legacy = {
      ...current,
      isInternalNoResponseSentinel: undefined,
    }

    expect(toSDKMessages([current])).toEqual([])
    expect(toSDKMessages([legacy])).toEqual([])
  })

  test('keeps genuine assistant-authored text with the same words', () => {
    const genuine = createAssistantMessage({ content: NO_RESPONSE_REQUESTED })

    expect(JSON.stringify(toSDKMessages([genuine]))).toContain(
      NO_RESPONSE_REQUESTED,
    )
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
