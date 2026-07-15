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
