/** A worker result carries run facts always; these fixtures exercise other
 * concerns, so they use the all-null value the boundary requires. */
const NO_RUN_FACTS = {
  model: null,
  permissionMode: null,
  effort: null,
  usedTokens: null,
  contextWindow: null,
}

import { expect, test } from 'bun:test'
import { join } from 'node:path'

import {
  PROTOCOL_VERSION,
  type ServerFrame,
} from './protocol.js'
import {
  TRANSCRIPT_BACKFILL_BOUNDARY_VERSION,
  parseTranscriptBackfillRequest,
  parseTranscriptBackfillResult,
  type TranscriptBackfillRequest,
  type TranscriptBackfillSessionResult,
} from './transcriptBackfill.js'

const APP_ID = '11111111-1111-4111-8111-111111111111'
const ENGINE_ID = '22222222-2222-4222-8222-222222222222'

function eventFrame(
  appSessionId = APP_ID,
  engineSessionId = ENGINE_ID,
): ServerFrame {
  return {
    kind: 'event',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: appSessionId,
    replay: true,
    event: {
      type: 'message',
      message: {
        type: 'user',
        session_id: engineSessionId,
        uuid: '44444444-4444-4444-8444-444444444444',
        parent_tool_use_id: null,
        message: { role: 'user', content: 'hello' },
      },
    } as never,
  }
}

function retryNoticeFrame(engineSessionId = ENGINE_ID): ServerFrame {
  return {
    kind: 'event',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: APP_ID,
    replay: true,
    event: {
      type: 'message',
      message: {
        type: 'system',
        subtype: 'api_retry',
        attempt: 1,
        max_retries: 2,
        retry_delay_ms: 0,
        error_status: null,
        error: {
          type: 'assistant_error',
          message: 'Connection interrupted. Continuing automatically.',
          error: 'connection_error',
        },
        session_id: engineSessionId,
        uuid: '55555555-5555-4555-8555-555555555555',
      },
    } as never,
  }
}

test('a retry notice validates, and a malformed one costs only itself the session', () => {
  // The worker emits these now. This gate rejecting one would not drop the row,
  // it would reject the whole session result and cost that session its cached
  // preview, so the variant has to be admitted here and shaped strictly.
  const valid: TranscriptBackfillSessionResult = {
    type: 'session',
    appSessionId: APP_ID,
    engineSessionId: ENGINE_ID,
    frames: [retryNoticeFrame(), eventFrame()],
    runFacts: NO_RUN_FACTS,
  }
  expect(parseTranscriptBackfillResult(valid)).toEqual(valid)

  const malformed = retryNoticeFrame() as unknown as {
    event: { message: Record<string, unknown> }
  }
  malformed.event.message.attempt = -1
  expect(
    parseTranscriptBackfillResult({
      ...valid,
      frames: [malformed as unknown as ServerFrame],
    }),
  ).toBeNull()
})

test('backfill request accepts only a bounded strict manifest with matching transcript basename', () => {
  const request: TranscriptBackfillRequest = {
    version: TRANSCRIPT_BACKFILL_BOUNDARY_VERSION,
    items: [
      {
        appSessionId: APP_ID,
        engineSessionId: ENGINE_ID,
        transcriptPath: join('/tmp', `${ENGINE_ID}.jsonl`),
      },
    ],
  }
  expect(parseTranscriptBackfillRequest(request)).toEqual(request)
  expect(parseTranscriptBackfillRequest({ ...request, extra: true })).toBeNull()
  expect(
    parseTranscriptBackfillRequest({
      ...request,
      items: [{ ...request.items[0], transcriptPath: '/tmp/wrong.jsonl' }],
    }),
  ).toBeNull()
})

test('backfill result rejects extra keys and cross-session/cross-engine frame forgery', () => {
  const valid: TranscriptBackfillSessionResult = {
    type: 'session',
    appSessionId: APP_ID,
    engineSessionId: ENGINE_ID,
    frames: [eventFrame()],
    runFacts: NO_RUN_FACTS,
  }
  expect(parseTranscriptBackfillResult(valid)).toEqual(valid)
  expect(parseTranscriptBackfillResult({ ...valid, token: 'secret' })).toBeNull()
  expect(
    parseTranscriptBackfillResult({
      ...valid,
      frames: [eventFrame('33333333-3333-4333-8333-333333333333')],
    }),
  ).toBeNull()
  expect(
    parseTranscriptBackfillResult({
      ...valid,
      frames: [
        eventFrame(APP_ID, '33333333-3333-4333-8333-333333333333'),
      ],
    }),
  ).toBeNull()
})

test('only the existing visible history-truncation error may precede replay events', () => {
  const boundary: ServerFrame = {
    kind: 'error',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: APP_ID,
    requestId: 'catcode.history-truncated',
    code: 'internal_error',
    message: 'truncated',
    retryable: false,
  }
  expect(
    parseTranscriptBackfillResult({
      type: 'session',
      appSessionId: APP_ID,
      engineSessionId: ENGINE_ID,
      frames: [boundary, eventFrame()],
      runFacts: NO_RUN_FACTS,
    }),
  ).not.toBeNull()
  expect(
    parseTranscriptBackfillResult({
      type: 'session',
      appSessionId: APP_ID,
      engineSessionId: ENGINE_ID,
      frames: [eventFrame(), boundary],
      runFacts: NO_RUN_FACTS,
    }),
  ).toBeNull()
})

/**
 * Regression (2026-07-28): a tool-search `tool_reference` block nested in a
 * `tool_result` was not in the allowlist, so any session that ever ran a tool
 * search failed validation. Because main terminates the run on a record it
 * cannot parse, ONE such block abandoned every session queued behind it: 30 of
 * 32 caches never got their run facts. Shape is the engine's own guard,
 * `src/utils/toolSearch.ts:493`, and it appears only nested (:569).
 */
test('a tool_reference nested in tool_result validates, and a malformed one does not', () => {
  const frame = eventFrame() as Extract<ServerFrame, { kind: 'event' }>
  const withReference = (reference: unknown) => ({
    type: 'session',
    appSessionId: APP_ID,
    engineSessionId: ENGINE_ID,
    frames: [
      {
        ...frame,
        event: {
          type: 'message',
          message: {
            type: 'user',
            session_id: ENGINE_ID,
            uuid: '44444444-4444-4444-8444-444444444444',
            parent_tool_use_id: null,
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'call_Yz5gQlAzBAS44hNRgoW1sVP2',
                  content: [reference],
                },
              ],
            },
          },
        },
      },
    ],
    runFacts: NO_RUN_FACTS,
  })

  expect(
    parseTranscriptBackfillResult(
      withReference({ type: 'tool_reference', tool_name: 'TodoWrite' }),
    ),
  ).not.toBeNull()
  // Still fail-closed: the type being known does not exempt it from validation.
  expect(
    parseTranscriptBackfillResult(withReference({ type: 'tool_reference' })),
  ).toBeNull()
  expect(
    parseTranscriptBackfillResult(
      withReference({ type: 'tool_reference', tool_name: 42 }),
    ),
  ).toBeNull()
})

test('backfill result rejects discriminant-only and unsupported SDK messages', () => {
  for (const message of [
    { type: 'user', session_id: ENGINE_ID },
    {
      type: 'assistant',
      session_id: ENGINE_ID,
      uuid: '44444444-4444-4444-8444-444444444444',
      parent_tool_use_id: null,
      message: { role: 'assistant' },
    },
    {
      type: 'result',
      session_id: ENGINE_ID,
      uuid: '44444444-4444-4444-8444-444444444444',
    },
    {
      type: 'assistant',
      session_id: ENGINE_ID,
      uuid: '44444444-4444-4444-8444-444444444444',
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [null] },
    },
    {
      type: 'user',
      session_id: ENGINE_ID,
      uuid: '44444444-4444-4444-8444-444444444444',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'future_unknown_block' }] },
    },
    {
      type: 'user',
      session_id: ENGINE_ID,
      uuid: '44444444-4444-4444-8444-444444444444',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [{ type: 'image', source: { type: 'bogus' } }],
      },
    },
    {
      type: 'assistant',
      session_id: ENGINE_ID,
      uuid: '44444444-4444-4444-8444-444444444444',
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        content: [
          {
            type: 'web_search_tool_result',
            tool_use_id: 'tool-1',
            content: [{}],
          },
        ],
      },
    },
  ]) {
    const frame = eventFrame() as Extract<ServerFrame, { kind: 'event' }>
    expect(
      parseTranscriptBackfillResult({
        type: 'session',
        appSessionId: APP_ID,
        engineSessionId: ENGINE_ID,
        frames: [{ ...frame, event: { type: 'message', message } }],
        runFacts: NO_RUN_FACTS,
      }),
    ).toBeNull()
  }
})
