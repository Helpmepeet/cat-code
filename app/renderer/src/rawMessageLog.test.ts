import { expect, test } from 'bun:test'
import {
  createRawMessageLogState,
  reduceServerFrame,
  reduceServerFrameWithLimits,
  selectActiveRawMessageLog,
} from './rawMessageLog.js'

test('captures the ready session and appends every raw SDKMessage in arrival order', () => {
  let state = createRawMessageLogState()

  state = reduceServerFrame(state, {
    kind: 'ready',
    protocolVersion: 1,
    sessionId: 'session-1',
    engineSessionId: 'engine-session-1',
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

  const active = selectActiveRawMessageLog(state)
  expect(state.activeSessionId).toBe('session-1')
  expect(active.inputEnabled).toBe(true)
  expect(active.messages).toHaveLength(2)
  expect(active.messages.map(message => message.type)).toEqual([
    'stream_event',
    'stream_event',
  ])
})

test('records transport errors without adding non-message events to the raw log', () => {
  let state = createRawMessageLogState()

  state = reduceServerFrame(state, {
    kind: 'ready',
    protocolVersion: 1,
    sessionId: 'session-1',
    engineSessionId: 'engine-session-1',
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

  const active = selectActiveRawMessageLog(state)
  expect(active.messages).toEqual([])
  expect(active.error).toBe('turn failed')
})

test('keys logs by ready session and rejects frames for an unattached session', () => {
  let state = createRawMessageLogState()
  state = reduceServerFrame(state, {
    kind: 'ready',
    protocolVersion: 1,
    sessionId: 'session-1',
    engineSessionId: 'engine-session-1',
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
    sessionId: 'session-2',
    event: {
      type: 'message',
      message: { type: 'result', subtype: 'success' },
    },
  })

  expect(Object.keys(state.sessions)).toEqual(['session-1'])
  expect(selectActiveRawMessageLog(state).messages).toEqual([])
})

test('bounds raw retention by serialized UTF-8 bytes and exposes truncation', () => {
  let state = createRawMessageLogState()
  state = reduceServerFrame(state, {
    kind: 'ready',
    protocolVersion: 1,
    sessionId: 'session-1',
    engineSessionId: 'engine-session-1',
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

  const first = {
    type: 'result' as const,
    subtype: 'success' as const,
    result: '界'.repeat(20),
  }
  const second = {
    type: 'result' as const,
    subtype: 'success' as const,
    result: 'kept',
  }
  const secondBytes = Buffer.byteLength(JSON.stringify(second), 'utf8')
  state = reduceServerFrameWithLimits(
    state,
    {
      kind: 'event',
      protocolVersion: 1,
      sessionId: 'session-1',
      event: { type: 'message', message: first },
    },
    { maxMessages: 10, maxBytes: secondBytes },
  )
  state = reduceServerFrameWithLimits(
    state,
    {
      kind: 'event',
      protocolVersion: 1,
      sessionId: 'session-1',
      event: { type: 'message', message: second },
    },
    { maxMessages: 10, maxBytes: secondBytes },
  )

  const active = selectActiveRawMessageLog(state)
  expect(active.messages).toEqual([second])
  expect(active.retainedBytes).toBe(secondBytes)
  expect(active.truncated).toBe(true)
})
