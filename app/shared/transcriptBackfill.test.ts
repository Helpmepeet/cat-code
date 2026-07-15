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
    }),
  ).not.toBeNull()
  expect(
    parseTranscriptBackfillResult({
      type: 'session',
      appSessionId: APP_ID,
      engineSessionId: ENGINE_ID,
      frames: [eventFrame(), boundary],
    }),
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
      }),
    ).toBeNull()
  }
})
