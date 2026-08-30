import { APIError } from '@anthropic-ai/sdk'
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
  createSystemAPIErrorMessage,
  createSystemTransportRecoveryMessage,
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

  test('a restored interruption retains its display-safe provenance', () => {
    const [sdk] = toSDKMessages([userMessage({ kind: 'interruption' })])
    expect(sdk).toMatchObject({ type: 'user', origin: { kind: 'interruption' } })
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

/**
 * A resumed or backfilled transcript reaches a reader through `toSDKMessages`,
 * and both retry subtypes returned `[]` here while the live path
 * (`src/QueryEngine.ts`) yielded them as `api_retry`. So every retry notice a
 * session showed vanished the moment it was reopened.
 */
describe('toSDKMessages carries retry notices', () => {
  test('a provider retry projects as the live api_retry frame', () => {
    const message = createSystemAPIErrorMessage(
      new APIError(429, undefined, 'Too Many Requests', new Headers()),
      519,
      1,
      5,
    )

    expect(toSDKMessages([message])).toEqual([
      {
        type: 'system',
        subtype: 'api_retry',
        attempt: 1,
        max_retries: 5,
        retry_delay_ms: 519,
        error_status: 429,
        error: {
          type: 'assistant_error',
          message: 'Rate limited. Retrying.',
          error: 'rate_limit',
        },
        session_id: expect.any(String),
        uuid: message.uuid,
      },
    ])
  })

  test('the same retry read back off disk projects the identical frame', () => {
    const live = createSystemAPIErrorMessage(
      new APIError(429, undefined, 'Too Many Requests', new Headers()),
      519.39,
      1,
      5,
    )
    const stored = JSON.parse(JSON.stringify(live))

    expect(toSDKMessages([live])).toHaveLength(1)
    expect(toSDKMessages([stored])).toEqual(toSDKMessages([live]))
  })

  test('a retry whose error did not survive the write still shows a notice', () => {
    // Transcripts on disk carry records whose `error` flattened to `{}`. The
    // classification degrades to `unknown`, but the notice must still carry
    // `error.message`: a bare code reaches a reader only through a legacy
    // fallback table.
    const stored = {
      type: 'system' as const,
      subtype: 'api_error',
      level: 'error' as const,
      error: {},
      retryInMs: 519.3911658844377,
      retryAttempt: 1,
      maxRetries: 5,
      timestamp: '2026-08-24T03:41:14.325Z',
      uuid: '6a675399-c249-482e-bd38-50f3a9d29d73',
    }

    expect(toSDKMessages([stored])).toMatchObject([
      {
        subtype: 'api_retry',
        attempt: 1,
        max_retries: 5,
        retry_delay_ms: 519.3911658844377,
        error_status: null,
        error: {
          type: 'assistant_error',
          message: 'The request failed. Retrying.',
          error: 'unknown',
        },
      },
    ])
  })

  test('a recovered transport interruption projects with its own words', () => {
    const message = createSystemTransportRecoveryMessage(
      'The connection dropped. Continuing.',
      2,
      3,
    )

    expect(toSDKMessages([message])).toEqual([
      {
        type: 'system',
        subtype: 'api_retry',
        attempt: 2,
        max_retries: 3,
        retry_delay_ms: 0,
        error_status: null,
        error: {
          type: 'assistant_error',
          message: 'The connection dropped. Continuing.',
          error: 'connection_error',
        },
        session_id: expect.any(String),
        uuid: message.uuid,
      },
    ])
  })

  test('a retry record missing its counters is dropped, never half-emitted', () => {
    const incomplete = {
      type: 'system' as const,
      subtype: 'api_error',
      uuid: '00000000-0000-4000-8000-0000000000r1',
      timestamp: '2026-08-24T03:41:14.325Z',
    }

    expect(toSDKMessages([incomplete])).toEqual([])
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
