import { expect, test } from 'bun:test'
import type { ServerFrame } from '../../shared/protocol.js'
import {
  HISTORY_REPLAY_TRUNCATION_REQUEST_ID,
  REPLAY_BUFFER_TRUNCATION_REQUEST_ID,
} from '../../shared/protocol.js'
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
    protocolVersion: 2,
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
    protocolVersion: 2,
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
    protocolVersion: 2,
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
    protocolVersion: 2,
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
    protocolVersion: 2,
    sessionId: 'session-1',
    event: { type: 'abort.status', abort: { status: 'requested' } },
  })
  state = reduceServerFrame(state, {
    kind: 'error',
    protocolVersion: 2,
    sessionId: 'session-1',
    code: 'internal_error',
    message: 'turn failed',
    retryable: false,
  })

  const active = selectRawMessageLog(state, 'session-1')
  expect(active.messages).toEqual([])
  expect(active.error).toBe('turn failed')
})

test('transcript reset replaces the raw log so replay cannot dedupe discarded rows', () => {
  const sessionId = 'session-reset'
  const uuid = '11111111-1111-4111-8111-111111111111'
  const messageFrame = (content: string, replay = false): ServerFrame =>
    ({
      kind: 'event',
      protocolVersion: 2,
      sessionId,
      ...(replay ? { replay: true as const } : {}),
      event: {
        type: 'message',
        message: {
          type: 'user',
          uuid,
          session_id: 'engine-reset',
          parent_tool_use_id: null,
          message: { role: 'user', content },
        },
      },
    }) as ServerFrame
  let state = reduceServerFrame(createRawMessageLogState(), {
    kind: 'ready',
    protocolVersion: 2,
    sessionId,
    engineSessionId: 'engine-reset',
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
  state = reduceServerFrame(state, messageFrame('discarded'))
  state = reduceServerFrame(state, {
    kind: 'transcript.reset',
    protocolVersion: 2,
    sessionId,
  })
  state = reduceServerFrame(state, messageFrame('retained replay', true))

  const log = selectRawMessageLog(state, sessionId)
  expect(log.inputEnabled).toBe(true)
  expect(log.messages).toHaveLength(1)
  expect(log.messages[0]).toMatchObject({
    message: { content: 'retained replay' },
  })
  expect(log.truncated).toBe(false)
  expect(log.error).toBeNull()
})

test('retention notices never reach the live error line', () => {
  // They ride `kind:'error'` to reuse the channel, but retention is working as
  // designed and there is nothing to act on. The history-replay boundary remains
  // available to the preview/restore surface through the transcript cache.
  const ready: ServerFrame = {
    kind: 'ready',
    protocolVersion: 2,
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
    protocolVersion: 2,
    sessionId: 'session-1',
    // app/main/replayBuffer.ts:76, N = DEFAULT_MAX_BUFFERED_FRAMES (8,000).
    requestId: REPLAY_BUFFER_TRUNCATION_REQUEST_ID,
    code: 'internal_error',
    message: 'Only the 8000 most recent messages are shown.',
    retryable: false,
  })
  expect(selectRawMessageLog(suppressed, 'session-1').error).toBeNull()

  // The history-replay sibling is also omitted from this live error store.
  let restored = reduceServerFrame(createRawMessageLogState(), ready)
  restored = reduceServerFrame(restored, {
    kind: 'error',
    protocolVersion: 2,
    sessionId: 'session-1',
    requestId: HISTORY_REPLAY_TRUNCATION_REQUEST_ID,
    code: 'internal_error',
    message: 'Earlier restored history was omitted.',
    retryable: false,
  })
  expect(selectRawMessageLog(restored, 'session-1').error).toBeNull()

  // A real internal_error with no request id is untouched.
  let state = reduceServerFrame(createRawMessageLogState(), ready)
  state = reduceServerFrame(state, {
    kind: 'error',
    protocolVersion: 2,
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
    protocolVersion: 2,
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
    protocolVersion: 2,
    sessionId: 'session-2',
    event: {
      type: 'message',
      message: { type: 'result', subtype: 'success' },
    },
  })

  expect(Object.keys(state.sessions)).toEqual(['session-1'])
  expect(selectRawMessageLog(state, 'session-1').messages).toEqual([])
})

test('session removal releases the raw message log', () => {
  let state = reduceServerFrame(createRawMessageLogState(), {
    kind: 'ready',
    protocolVersion: 2,
    sessionId: 'removed',
    engineSessionId: 'engine-removed',
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
    protocolVersion: 2,
    sessionId: 'removed',
    event: { type: 'message', message: { type: 'result', subtype: 'success' } },
  })

  state = reduceServerFrame(state, {
    type: 'session-removed',
    sessionId: 'removed',
  })

  expect(state.sessions).toEqual({})
})

test('bounds raw retention by serialized UTF-8 bytes and exposes truncation', () => {
  let state = createRawMessageLogState()
  state = reduceServerFrame(state, {
    kind: 'ready',
    protocolVersion: 2,
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
      protocolVersion: 2,
      sessionId: 'session-1',
      event: { type: 'message', message: first },
    },
    { maxMessages: 10, maxBytes: secondBytes },
  )
  state = reduceServerFrameWithLimits(
    state,
    {
      kind: 'event',
      protocolVersion: 2,
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
    protocolVersion: 2,
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
      protocolVersion: 2,
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

  // A replayed message NOT already retained still lands (evicted pre-crash, or
  // the reload path where the store is fresh). What that does to ORDER on a log
  // that has already evicted is pinned by the two convergence tests below.
  state = reduceServerFrame(
    state,
    message('00000000-0000-4000-8000-0000000000bb', true),
  )
  expect(selectRawMessageLog(state, sessionId).messages).toHaveLength(2)

  // Live (non-replay) frames are never deduped — the raw view shows arrivals.
  state = reduceServerFrame(state, message('00000000-0000-4000-8000-0000000000bb'))
  expect(selectRawMessageLog(state, sessionId).messages).toHaveLength(3)
})

test('in-run restore of an EVICTED log converges on the correct chronological tail', () => {
  // The capped-log half of SF-1, and the reason it needs no guard. An evicted
  // uuid is not retained, so it passes the dedupe and re-appends BEHIND newer
  // rows; eviction then cuts from the front, which is momentarily the newer end.
  // That inversion is transient: replay arrives oldest-first, so the last frames
  // processed are the true newest ones and the window lands back on the right
  // tail. Pinned here because it is not obvious from reading the reducer, and
  // because `contextUsage.ts` scans this array backwards for the newest
  // `compact_boundary` — a PERSISTENT inversion would floor out every real
  // anchor and pin the gauge at 0%.
  const sessionId = 'session-capped'
  const frame = (uuid: string, replay?: true): ServerFrame =>
    ({
      kind: 'event',
      protocolVersion: 2,
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
            content: [{ type: 'text', text: uuid }],
          },
        },
      },
    }) as never
  const limits = { maxMessages: 2, maxBytes: 1024 * 1024 }
  const uuidOf = (message: unknown): unknown =>
    (message as { uuid?: unknown }).uuid

  let state = reduceServerFrame(createRawMessageLogState(), {
    kind: 'ready',
    protocolVersion: 2,
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
  for (const uuid of ['aaa', 'bbb', 'ccc']) {
    state = reduceServerFrameWithLimits(state, frame(uuid), limits)
  }
  const capped = selectRawMessageLog(state, sessionId)
  expect(capped.messages.map(uuidOf)).toEqual(['bbb', 'ccc'])
  expect(capped.truncated).toBe(true)

  // Crash → restore replays the FULL history, oldest first. 'aaa' was evicted,
  // so it is not deduped by uuid.
  for (const uuid of ['aaa', 'bbb', 'ccc']) {
    state = reduceServerFrameWithLimits(state, frame(uuid, true), limits)
  }

  const restored = selectRawMessageLog(state, sessionId)
  expect(restored.messages.map(uuidOf)).toEqual(['bbb', 'ccc'])
})

test('a replay cut short mid-burst is the one case that leaves the log inverted', () => {
  // The transient from the test above, frozen. Only reachable if the replay
  // stops partway (the connection drops mid-burst): 'aaa' has re-landed at the
  // end and the newer 'bbb' was evicted for it. The next completed replay
  // restores order, so this is bounded, not corruption — recorded so a future
  // reader knows the inversion was measured rather than assumed.
  const sessionId = 'session-partial'
  const frame = (uuid: string, replay?: true): ServerFrame =>
    ({
      kind: 'event',
      protocolVersion: 2,
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
            content: [{ type: 'text', text: uuid }],
          },
        },
      },
    }) as never
  const limits = { maxMessages: 2, maxBytes: 1024 * 1024 }
  const uuidOf = (message: unknown): unknown =>
    (message as { uuid?: unknown }).uuid

  let state = reduceServerFrame(createRawMessageLogState(), {
    kind: 'ready',
    protocolVersion: 2,
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
  for (const uuid of ['aaa', 'bbb', 'ccc']) {
    state = reduceServerFrameWithLimits(state, frame(uuid), limits)
  }
  state = reduceServerFrameWithLimits(state, frame('aaa', true), limits)

  expect(selectRawMessageLog(state, sessionId).messages.map(uuidOf)).toEqual([
    'ccc',
    'aaa',
  ])
})

test('the turn boundary moves inputEnabled and leaves the message log alone', () => {
  // The composer gate (`selectComposerGate`) reads BOTH this copy of
  // `inputEnabled` and `connectionState`'s. They must move together, or the
  // composer ends up half-enabled mid-turn.
  let state = reduceServerFrame(createRawMessageLogState(), {
    kind: 'ready',
    protocolVersion: 2,
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
      protocolVersion: 2,
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
      protocolVersion: 2,
      sessionId: 'ghost',
      event: { type: 'turn.status', activeTurn: true },
    } as unknown as ServerFrame),
  ).toBe(state)
})

/* Slash-command replay identity (bug, 2026-08-08). This store dedupes replayed
 * frames by uuid independently of the transcript projector, so the producer fix
 * (src/utils/processUserInput/processSlashCommand.tsx `case 'local'` carrying
 * the submitted uuid onto the persisted breadcrumb) has to hold here too. */

function slashMessageFrame(
  content: string,
  uuid: string,
  replay?: true,
): ServerFrame {
  return {
    kind: 'event',
    protocolVersion: 2,
    sessionId: 'session-1',
    ...(replay ? { replay: true } : {}),
    event: {
      type: 'message',
      message: {
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
        session_id: 'engine-session-1',
        uuid,
      },
    },
  } as ServerFrame
}

test('a replayed slash breadcrumb sharing the submit uuid is not logged twice', () => {
  const uuid = '00000000-0000-4000-8000-0000000009f1'
  let state = createRawMessageLogState()
  state = reduceServerFrame(state, {
    kind: 'ready',
    protocolVersion: 2,
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
  // Live echo, then the resumed sidecar's persisted breadcrumb for the same
  // submission. Different CONTENT, same identity.
  state = reduceServerFrame(state, slashMessageFrame('/compact', uuid))
  state = reduceServerFrame(
    state,
    slashMessageFrame(
      '<command-name>/compact</command-name>\n' +
        '<command-message>compact</command-message>\n' +
        '<command-args></command-args>',
      uuid,
      true,
    ),
  )

  const log = selectRawMessageLog(state, 'session-1')
  const held = log.messages.filter(
    message =>
      typeof message === 'object' &&
      message !== null &&
      (message as { uuid?: string }).uuid === uuid,
  )
  expect(held).toHaveLength(1)
})
