import { expect, test } from 'bun:test'
import type { ServerFrame } from '../../shared/protocol.js'
import { HISTORY_REPLAY_TRUNCATION_REQUEST_ID } from '../../shared/protocol.js'
import {
  createRawMessageLogState,
  reduceServerFrame,
  reduceServerFrameWithLimits,
  selectRawMessageLog,
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

  const active = selectRawMessageLog(state, 'session-1')
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

  const active = selectRawMessageLog(state, 'session-1')
  expect(active.messages).toEqual([])
  expect(active.error).toBe('turn failed')
})

test('the replay-buffer retention notice never reaches the error line', () => {
  // It rides `kind:'error'` to reuse the channel, but retention is working as
  // designed and there is nothing to act on. Shown, it pinned an undismissable
  // red line above the composer for the rest of the session, because nothing
  // ever clears `error`. Its history-replay sibling is deliberately still shown:
  // the preview/restore surface owns that message.
  const ready: ServerFrame = {
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
  }
  let suppressed = reduceServerFrame(createRawMessageLogState(), ready)
  suppressed = reduceServerFrame(suppressed, {
    kind: 'error',
    protocolVersion: 1,
    sessionId: 'session-1',
    // app/main/replayBuffer.ts:76, N = DEFAULT_MAX_BUFFERED_FRAMES (8,000).
    requestId: 'catcode.replay-truncated',
    code: 'internal_error',
    message: 'Only the 8000 most recent messages are shown.',
    retryable: false,
  })
  expect(selectRawMessageLog(suppressed, 'session-1').error).toBeNull()

  // The history-replay sibling still surfaces — a different surface owns it.
  let restored = reduceServerFrame(createRawMessageLogState(), ready)
  restored = reduceServerFrame(restored, {
    kind: 'error',
    protocolVersion: 1,
    sessionId: 'session-1',
    requestId: HISTORY_REPLAY_TRUNCATION_REQUEST_ID,
    code: 'internal_error',
    message: 'Earlier restored history was omitted.',
    retryable: false,
  })
  expect(selectRawMessageLog(restored, 'session-1').error).toBe(
    'Earlier restored history was omitted.',
  )

  // A real internal_error with no request id is untouched.
  let state = reduceServerFrame(createRawMessageLogState(), ready)
  state = reduceServerFrame(state, {
    kind: 'error',
    protocolVersion: 1,
    sessionId: 'session-1',
    code: 'internal_error',
    message: 'turn failed',
    retryable: false,
  })
  expect(selectRawMessageLog(state, 'session-1').error).toBe('turn failed')
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
  expect(selectRawMessageLog(state, 'session-1').messages).toEqual([])
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

  const active = selectRawMessageLog(state, 'session-1')
  expect(active.messages).toEqual([second])
  expect(active.retainedBytes).toBe(secondBytes)
  expect(active.truncated).toBe(true)
})

test('in-run restore: raw message log does not duplicate replayed history (SF-1)', () => {
  // Same appSessionId, store never torn down, replay carries the same uuids
  // (F1/F2 same-source). The transcript projector dedupes; the raw log must
  // too — pre-fix this appended the whole history again (2 ≠ 1).
  const sessionId = 'session-restore'
  const ready = (): ServerFrame => ({
    kind: 'ready',
    protocolVersion: 1,
    sessionId,
    engineSessionId: 'engine-1',
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
  const message = (uuid: string, replay?: true) =>
    ({
      kind: 'event',
      protocolVersion: 1,
      sessionId,
      ...(replay ? { replay: true as const } : {}),
      event: {
        type: 'message',
        message: {
          type: 'assistant',
          uuid,
          session_id: 'engine-1',
          parent_tool_use_id: null,
          message: {
            id: `msg_${uuid}`,
            role: 'assistant',
            content: [{ type: 'text', text: 'pineapple' }],
          },
        },
      },
    }) as never

  let state = createRawMessageLogState()
  state = reduceServerFrame(state, ready())
  state = reduceServerFrame(state, message('00000000-0000-4000-8000-0000000000aa'))
  // Crash → restore reuses the appSessionId; the resumed sidecar replays.
  state = reduceServerFrame(state, ready())
  state = reduceServerFrame(
    state,
    message('00000000-0000-4000-8000-0000000000aa', true),
  )
  expect(selectRawMessageLog(state, sessionId).messages).toHaveLength(1)

  // A replayed message NOT already retained (e.g. evicted pre-crash, or the
  // reload path where the store is fresh) still lands.
  state = reduceServerFrame(
    state,
    message('00000000-0000-4000-8000-0000000000bb', true),
  )
  expect(selectRawMessageLog(state, sessionId).messages).toHaveLength(2)

  // Live (non-replay) frames are never deduped — the raw view shows arrivals.
  state = reduceServerFrame(state, message('00000000-0000-4000-8000-0000000000bb'))
  expect(selectRawMessageLog(state, sessionId).messages).toHaveLength(3)
})

test('the turn boundary moves inputEnabled and leaves the message log alone', () => {
  // The composer gate (`selectComposerGate`) reads BOTH this copy of
  // `inputEnabled` and `connectionState`'s. They must move together, or the
  // composer ends up half-enabled mid-turn.
  let state = reduceServerFrame(createRawMessageLogState(), {
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

  const turnStatus = (activeTurn: boolean) =>
    ({
      kind: 'event',
      protocolVersion: 1,
      sessionId: 'session-1',
      event: { type: 'turn.status', activeTurn },
    }) as unknown as ServerFrame

  state = reduceServerFrame(state, turnStatus(true))
  expect(selectRawMessageLog(state, 'session-1').inputEnabled).toBe(false)
  // A turn boundary is not a message: the raw debug view must not gain a row.
  expect(selectRawMessageLog(state, 'session-1').messages).toEqual([])

  state = reduceServerFrame(state, turnStatus(false))
  expect(selectRawMessageLog(state, 'session-1').inputEnabled).toBe(true)
  expect(selectRawMessageLog(state, 'session-1').messages).toEqual([])
})

test('a turn frame before the ready frame is a no-op', () => {
  const state = createRawMessageLogState()
  expect(
    reduceServerFrame(state, {
      kind: 'event',
      protocolVersion: 1,
      sessionId: 'ghost',
      event: { type: 'turn.status', activeTurn: true },
    } as unknown as ServerFrame),
  ).toBe(state)
})
