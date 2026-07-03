import { expect, test } from 'bun:test'
import {
  createRawMessageLogState,
  reduceServerFrame,
} from './rawMessageLog.js'

test('captures the ready session and appends every raw SDKMessage in arrival order', () => {
  let state = createRawMessageLogState()

  state = reduceServerFrame(state, {
    kind: 'ready',
    protocolVersion: 1,
    sessionId: 'session-1',
    payload: {
      type: 'app.ready',
      protocolVersion: 1,
      inputEnabled: true,
      activeTurn: false,
      abort: { status: 'idle' },
      goalSnapshot: null,
      pendingPermissionRequests: [],
    },
  })
  state = reduceServerFrame(state, {
    kind: 'event',
    protocolVersion: 1,
    sessionId: 'session-1',
    event: {
      type: 'message',
      message: {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hel' },
        },
        parent_tool_use_id: null,
        session_id: 'session-1',
        uuid: '00000000-0000-4000-8000-000000000001',
      },
    },
  })
  state = reduceServerFrame(state, {
    kind: 'event',
    protocolVersion: 1,
    sessionId: 'session-1',
    event: {
      type: 'message',
      message: {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'lo' },
        },
        parent_tool_use_id: null,
        session_id: 'session-1',
        uuid: '00000000-0000-4000-8000-000000000002',
      },
    },
  })

  expect(state.sessionId).toBe('session-1')
  expect(state.inputEnabled).toBe(true)
  expect(state.messages).toHaveLength(2)
  expect(state.messages.map(message => message.type)).toEqual([
    'stream_event',
    'stream_event',
  ])
})

test('records transport errors without adding non-message events to the raw log', () => {
  let state = createRawMessageLogState()

  state = reduceServerFrame(state, {
    kind: 'event',
    protocolVersion: 1,
    sessionId: 'session-1',
    event: { type: 'abort.status', abort: { status: 'requested' } },
  })
  state = reduceServerFrame(state, {
    kind: 'error',
    protocolVersion: 1,
    sessionId: 'session-1',
    code: 'internal_error',
    message: 'turn failed',
    retryable: false,
  })

  expect(state.messages).toEqual([])
  expect(state.error).toBe('turn failed')
})
