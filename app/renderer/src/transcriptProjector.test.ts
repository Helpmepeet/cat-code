import { expect, test } from 'bun:test'
import type { SDKMessage } from '@cat-code/engine/session-events'
import type { ServerFrame, SessionId } from '../../shared/protocol.js'
import {
  createQueuedPromptsState,
  reduceQueuedPromptsState,
  selectQueuedPrompts,
} from './queuedPromptsState.js'
import {
  createTranscriptState,
  groupAgentDelegates,
  projectServerFrame,
  projectServerFrames,
  selectHasHiddenRows,
  selectIsCompacting,
  selectNestedTranscriptRows,
  selectSlashCommands,
  selectTranscriptDisplayItems,
  selectTranscriptRows,
  stripCompactionEcho,
  type NestedTranscriptRow,
} from './transcriptProjector.js'
import { reduceLiveTranscriptState } from './previewTranscriptState.js'
import { FrameReplayBuffer } from '../../main/replayBuffer.js'
import {
  AGENT_WITH_NESTED_SUBAGENT_TURN,
  allSdkMessageSamples,
  DRIFT_WIRE_SAMPLE_JSON,
  PARALLEL_AGENTS_TURN,
  S1_CONCURRENT_REASONING_TURN,
  S1_STREAMING_REASONING_TURN,
  S1_STREAMING_TEXT_TURN,
  SDK_MESSAGE_FIXTURE,
} from './sdkMessageFixtures.js'

function ready(sessionId: string, turnInterrupted = false) {
  return {
    kind: 'ready' as const,
    protocolVersion: 1 as const,
    sessionId,
    engineSessionId: `engine-${sessionId}`,
    ...(turnInterrupted ? { turnInterrupted: true } : {}),
    payload: {
      type: 'app.ready' as const,
      protocolVersion: 1 as const,
      inputEnabled: true,
      activeTurn: false,
      abort: { status: 'idle' as const },
      goalSnapshot: null,
      pendingPermissionRequests: [],
    },
  }
}

function messageFrame(
  sessionId: string,
  message: SDKMessage,
) {
  return {
    kind: 'event' as const,
    protocolVersion: 1 as const,
    sessionId,
    event: { type: 'message' as const, message },
  }
}

test('transcript reset discards projected rows before retained replay', () => {
  const sessionId = 'session-reset'
  const discarded = messageFrame(sessionId, {
    type: 'user',
    uuid: '11111111-1111-4111-8111-111111111111',
    session_id: 'engine-reset',
    parent_tool_use_id: null,
    message: { role: 'user', content: 'discarded' },
  })
  const retained = messageFrame(sessionId, {
    type: 'user',
    uuid: '22222222-2222-4222-8222-222222222222',
    session_id: 'engine-reset',
    parent_tool_use_id: null,
    message: { role: 'user', content: 'retained' },
  })
  const reset: ServerFrame = {
    kind: 'transcript.reset',
    protocolVersion: 1,
    sessionId,
  }

  let single = projectServerFrame(createTranscriptState(), ready(sessionId))
  single = projectServerFrame(single, discarded)
  single = projectServerFrame(single, reset)
  single = projectServerFrame(single, retained)

  const batch = projectServerFrames(
    createTranscriptState(),
    [ready(sessionId), discarded, reset, retained],
  )
  expect(
    selectTranscriptRows(single, sessionId)
      .filter(row => row.kind === 'user-text')
      .map(row => row.content),
  ).toEqual(['retained'])
  expect(selectTranscriptRows(batch, sessionId)).toEqual(
    selectTranscriptRows(single, sessionId),
  )
})

test('does not derive a durable interruption row from app-ready state', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1', true))
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'user',
      message: { role: 'user', content: 'accepted before close' },
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-000000000902',
      isReplay: true,
    }),
  )

  expect(selectTranscriptRows(state, 'session-1')).toMatchObject([
    {
      kind: 'user-text',
      frameId: '00000000-0000-4000-8000-000000000902',
      content: 'accepted before close',
    },
  ])

  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'user',
      message: { role: 'user', content: 'continue now' },
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-000000000903',
    }),
  )
  expect(selectTranscriptRows(state, 'session-1')).toMatchObject([
    {
      kind: 'user-text',
      content: 'accepted before close',
    },
    {
      kind: 'user-text',
      content: 'continue now',
    },
  ])
})

test('projects one durable stopped seam without interruption protocol text', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  const play = (message: SDKMessage) => {
    state = projectServerFrame(state, messageFrame('session-1', message))
  }

  play({
    type: 'user',
    message: {
      role: 'user',
      content: '<interruption-protocol body that must not render>',
    },
    parent_tool_use_id: null,
    uuid: '00000000-0000-4000-8000-000000000904',
    origin: { kind: 'interruption' },
  })
  play({
    type: 'result',
    subtype: 'interrupted',
    duration_ms: 10,
    duration_api_ms: 8,
    is_error: false,
    num_turns: 1,
    stop_reason: 'interrupted',
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
    permission_denials: [],
    session_id: 'engine-session-1',
    uuid: '00000000-0000-4000-8000-000000000905',
  })

  expect(selectTranscriptRows(state, 'session-1')).toEqual([
    expect.objectContaining({ kind: 'turn-stopped' }),
  ])
})

test('marks a persisted cancelled tool result separately from a failure', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  const play = (message: SDKMessage) => {
    state = projectServerFrame(state, messageFrame('session-1', message))
  }
  play({
    type: 'assistant',
    message: {
      id: 'msg-tool-stopped',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu-stopped', name: 'Bash', input: {} }],
    },
    parent_tool_use_id: null,
    session_id: 'engine-session-1',
    uuid: '00000000-0000-4000-8000-000000000906',
  })
  play({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu-stopped',
          is_error: true,
          content: 'Interrupted by user',
        },
      ],
    },
    parent_tool_use_id: null,
    tool_result_status: 'cancelled',
    uuid: '00000000-0000-4000-8000-000000000907',
  })

  expect(selectTranscriptRows(state, 'session-1')).toEqual([
    expect.objectContaining({
      kind: 'tool-use',
      status: 'cancelled',
      result: expect.objectContaining({ isCancelled: true, isError: true }),
    }),
  ])
})

test('suppresses typed provider error text before the curated result seam', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  const play = (message: SDKMessage) => {
    state = projectServerFrame(state, messageFrame('session-1', message))
  }
  play({
    type: 'assistant',
    error: 'authentication_failed',
    message: {
      id: 'msg-auth',
      role: 'assistant',
      content: [{ type: 'text', text: 'OAuth access token has been revoked' }],
    },
    parent_tool_use_id: null,
    session_id: 'engine-session-1',
    uuid: '00000000-0000-4000-8000-000000000908',
  })
  play({
    type: 'result',
    subtype: 'error_auth_required',
    duration_ms: 10,
    duration_api_ms: 8,
    is_error: true,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
    permission_denials: [],
    errors: [],
    session_id: 'engine-session-1',
    uuid: '00000000-0000-4000-8000-000000000909',
  })

  expect(selectTranscriptRows(state, 'session-1')).toEqual([
    expect.objectContaining({ kind: 'result', subtype: 'error_auth_required' }),
  ])
})

test('preserves real per-block producer identity, grouping, and order', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: { id: 'msg_shared_1' },
      },
      uuid: '00000000-0000-4000-8000-000000000000',
    }),
  )

  const blocks = [
    {
      start: { type: 'text', text: '' },
      assistant: { type: 'text', text: "I'll read both files." },
      uuid: '00000000-0000-4000-8000-000000000001',
    },
    {
      start: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} },
      assistant: {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'Read',
        input: { file_path: '/a' },
      },
      uuid: '00000000-0000-4000-8000-000000000002',
    },
    {
      start: { type: 'tool_use', id: 'toolu_2', name: 'Read', input: {} },
      assistant: {
        type: 'tool_use',
        id: 'toolu_2',
        name: 'Read',
        input: { file_path: '/b' },
      },
      uuid: '00000000-0000-4000-8000-000000000003',
    },
  ]

  for (const [index, block] of blocks.entries()) {
    state = projectServerFrame(
      state,
      messageFrame('session-1', {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index,
          content_block: block.start,
        },
        uuid: `00000000-0000-4000-8000-10000000000${index}`,
      }),
    )
    state = projectServerFrame(
      state,
      messageFrame('session-1', {
        type: 'assistant',
        message: {
          id: 'msg_shared_1',
          role: 'assistant',
          content: [block.assistant],
        },
        parent_tool_use_id: null,
        session_id: 'engine-session-1',
        uuid: block.uuid,
      }),
    )
    state = projectServerFrame(
      state,
      messageFrame('session-1', {
        type: 'stream_event',
        event: { type: 'content_block_stop', index },
        uuid: `00000000-0000-4000-8000-20000000000${index}`,
      }),
    )
  }

  const rows = selectTranscriptRows(state, 'session-1')
  expect(rows).toHaveLength(3)
  const contentRows = rows.filter(row => 'messageId' in row)
  expect(contentRows.map(row => row.messageId)).toEqual([
    'msg_shared_1',
    'msg_shared_1',
    'msg_shared_1',
  ])
  expect(contentRows.map(row => row.blockIndex)).toEqual([0, 1, 2])
  expect(new Set(rows.map(row => row.id)).size).toBe(3)
  expect(rows.filter(row => row.kind === 'tool-use').map(row => row.toolUseId)).toEqual([
    'toolu_1',
    'toolu_2',
  ])
})

test('uses deterministic per-frame fallback identity without stream events', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'fallback' }],
      },
      uuid: '00000000-0000-4000-8000-000000000010',
    }),
  )

  expect(selectTranscriptRows(state, 'session-1')[0]).toMatchObject({
    messageId: '00000000-0000-4000-8000-000000000010',
    frameId: '00000000-0000-4000-8000-000000000010',
    blockIndex: 0,
  })
})

test('accumulates text deltas into an in-progress assistant row and reconciles to the full frame', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  const play = (message: SDKMessage) => {
    state = projectServerFrame(state, messageFrame('session-1', message))
  }

  play({
    type: 'stream_event',
    event: { type: 'message_start', message: { id: 'msg-streaming-text' } },
    uuid: '00000000-0000-4000-8000-000000000020',
  })
  play({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: 'duplicated start must be ignored' },
    },
    uuid: '00000000-0000-4000-8000-000000000021',
  })
  play({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hello' },
    },
    uuid: '00000000-0000-4000-8000-000000000022',
  })
  play({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: ', world' },
    },
    uuid: '00000000-0000-4000-8000-000000000023',
  })

  expect(selectTranscriptRows(state, 'session-1')).toEqual([
    {
      id: 'session-1:msg-streaming-text:0:text',
      sessionId: 'session-1',
      messageId: 'msg-streaming-text',
      frameId: 'msg-streaming-text:stream:0',
      blockIndex: 0,
      parentToolUseId: null,
      kind: 'assistant-text',
      role: 'assistant',
      content: 'Hello, world',
      isStreaming: true,
    },
  ])

  play({
    type: 'assistant',
    message: {
      id: 'msg-streaming-text',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello, world.' }],
      stop_reason: null,
    },
    parent_tool_use_id: null,
    session_id: 'engine-session-1',
    uuid: '00000000-0000-4000-8000-000000000024',
  })

  expect(selectTranscriptRows(state, 'session-1')).toEqual([
    {
      id: 'session-1:msg-streaming-text:0:text',
      sessionId: 'session-1',
      messageId: 'msg-streaming-text',
      frameId: '00000000-0000-4000-8000-000000000024',
      blockIndex: 0,
      parentToolUseId: null,
      kind: 'assistant-text',
      role: 'assistant',
      content: 'Hello, world.',
    },
  ])
})

test('projects thinking deltas immediately and reconciles their stable identity before block stop', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  const frames = S1_STREAMING_REASONING_TURN.messages
  const play = (message: SDKMessage) => {
    state = projectServerFrame(state, messageFrame('session-1', message))
  }

  play(frames[0]!)
  play(frames[1]!)
  play(frames[2]!)
  const streaming = selectTranscriptRows(state, 'session-1')
  expect(streaming).toEqual([
    expect.objectContaining({
      kind: 'thinking',
      content: 'Inspect configuration',
      reasoningKind: 'summary',
      isStreaming: true,
    }),
  ])
  const streamingRow = streaming[0]!

  play(frames[3]!)
  expect(selectTranscriptRows(state, 'session-1')).toEqual([
    expect.objectContaining({
      id: streamingRow.id,
      kind: 'thinking',
      content: 'Inspect configuration\n\nCheck dependencies',
      isStreaming: true,
    }),
  ])

  // The completed assistant block, not content_block_stop, owns reconciliation.
  play(frames[4]!)
  const finalized = selectTranscriptRows(state, 'session-1')
  expect(finalized).toHaveLength(1)
  expect(finalized[0]).toMatchObject({
    id: streamingRow.id,
    kind: 'thinking',
    content: 'Inspect configuration\n\nCheck dependencies',
    signature: 'reasoning-signature',
    reasoningKind: 'summary',
  })
  expect(finalized[0]).not.toHaveProperty('isStreaming')
  expect(state.sessions['session-1']!.streamingThinkingBlocks).toEqual({})

  play(frames[5]!)
  play(frames[6]!)
  play(frames[7]!)
  play(frames[8]!)
  expect(
    selectTranscriptRows(state, 'session-1')
      .filter(row => row.kind === 'thinking' || row.kind === 'assistant-text')
      .map(row => row.kind),
  ).toEqual(['thinking', 'assistant-text'])
})

test('reconciles concurrent raw and summary reasoning against their own block indexes', () => {
  const frames: ServerFrame[] = [
    ready('session-1'),
    ...S1_CONCURRENT_REASONING_TURN.messages.map(message =>
      messageFrame('session-1', message),
    ),
  ]
  const state = projectSequential(frames)
  const reasoning = selectTranscriptRows(state, 'session-1').filter(
    row => row.kind === 'thinking',
  )

  expect(reasoning).toMatchObject([
    {
      id: 'session-1:msg_01S1ConcurrentReasoning:0:thinking',
      blockIndex: 0,
      content: 'Summary',
      signature: 'summary-signature',
      reasoningKind: 'summary',
    },
    {
      id: 'session-1:msg_01S1ConcurrentReasoning:1:thinking',
      blockIndex: 1,
      content: 'Raw',
      signature: 'raw-signature',
      reasoningKind: 'raw',
    },
  ])
  expect(projectServerFrames(createTranscriptState(), frames)).toEqual(state)
})

test('thinking starts are idempotent and readable deltas remain distinct by block index', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  const play = (message: SDKMessage) => {
    state = projectServerFrame(state, messageFrame('session-1', message))
  }

  play(S1_STREAMING_REASONING_TURN.messages[0]!)
  play(S1_STREAMING_REASONING_TURN.messages[1]!)
  play(S1_STREAMING_REASONING_TURN.messages[2]!)
  play(S1_STREAMING_REASONING_TURN.messages[1]!)
  play({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: ' second' },
    },
    uuid: '00000000-0000-4000-8000-000000000025',
  })
  play({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    },
    uuid: '00000000-0000-4000-8000-000000000026',
  })
  play({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'Answer' },
    },
    uuid: '00000000-0000-4000-8000-000000000027',
  })
  play({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'thinking', thinking: '' },
    },
    uuid: '00000000-0000-4000-8000-000000000028',
  })
  play({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'thinking_delta', thinking: 'Check result' },
    },
    uuid: '00000000-0000-4000-8000-000000000029',
  })

  const rows = selectTranscriptRows(state, 'session-1')
  expect(rows.map(row => row.kind)).toEqual([
    'thinking',
    'assistant-text',
    'thinking',
  ])
  expect(rows.filter(row => row.kind === 'thinking').map(row => row.content)).toEqual([
    'Inspect configuration second',
    'Check result',
  ])
  expect(new Set(rows.filter(row => row.kind === 'thinking').map(row => row.id)).size)
    .toBe(2)
})

test('thinking stream failures retain finalized projected content and malformed deltas are no-ops', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  const play = (message: SDKMessage) => {
    state = projectServerFrame(state, messageFrame('session-1', message))
  }

  play(S1_STREAMING_REASONING_TURN.messages[0]!)
  for (const malformed of [
    '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"missing index"}}}',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":"0","delta":{"type":"thinking_delta","thinking":"string index"}}}',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0}}',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta"}}}',
  ]) {
    play(JSON.parse(malformed) as SDKMessage)
  }
  expect(selectTranscriptRows(state, 'session-1')).toEqual([])

  play(S1_STREAMING_REASONING_TURN.messages[1]!)
  play(S1_STREAMING_REASONING_TURN.messages[2]!)
  play(S1_STREAMING_REASONING_TURN.messages.at(-1)!)
  const session = state.sessions['session-1']!
  expect(selectTranscriptRows(state, 'session-1').filter(row => row.kind === 'thinking')).toEqual([
    expect.objectContaining({
      kind: 'thinking',
      content: 'Inspect configuration',
    }),
  ])
  expect(selectTranscriptRows(state, 'session-1')[0]).not.toHaveProperty('isStreaming')
  expect(session.currentStreamMessageId).toBeNull()
  expect(session.currentStreamBlockIndex).toBeNull()
  expect(session.streamingTextBlocks).toEqual({})
  expect(session.streamingThinkingBlocks).toEqual({})
})

test('encrypted-only thinking and transcript reset never retain a temporary readable row', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  const play = (message: SDKMessage) => {
    state = projectServerFrame(state, messageFrame('session-1', message))
  }

  play(S1_STREAMING_REASONING_TURN.messages[0]!)
  play(S1_STREAMING_REASONING_TURN.messages[1]!)
  play({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'encrypted-signature' },
    },
    uuid: '00000000-0000-4000-8000-000000000030',
  })
  expect(selectTranscriptRows(state, 'session-1')).toEqual([])

  play(S1_STREAMING_REASONING_TURN.messages[2]!)
  state = projectServerFrame(state, {
    kind: 'transcript.reset',
    protocolVersion: 1,
    sessionId: 'session-1',
  })
  const session = state.sessions['session-1']!
  expect(session.rows).toEqual([])
  expect(session.streamingThinkingBlocks).toEqual({})
  expect(session.currentStreamMessageId).toBeNull()
  expect(session.currentStreamBlockIndex).toBeNull()
})

test('stream events are droppable garnish: final transcript matches with stream frames stripped', () => {
  const project = (messages: readonly SDKMessage[]) => {
    let state = createTranscriptState()
    state = projectServerFrame(state, ready('session-1'))
    for (const message of messages) {
      state = projectServerFrame(state, messageFrame('session-1', message))
    }
    return selectTranscriptRows(state, 'session-1')
  }

  expect(project(S1_STREAMING_TEXT_TURN.messages)).toHaveLength(
    S1_STREAMING_TEXT_TURN.expectFinalRows,
  )
  expect(project(S1_STREAMING_TEXT_TURN.messages)).toEqual(
    project(
      S1_STREAMING_TEXT_TURN.messages.filter(
        message => message.type !== 'stream_event',
      ),
    ),
  )
})

test('result is the only turn-end marker and assistant stop_reason is ignored', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  const play = (message: SDKMessage) => {
    state = projectServerFrame(state, messageFrame('session-1', message))
  }

  play({
    type: 'stream_event',
    event: { type: 'message_start', message: { id: 'msg-before-result-1' } },
    uuid: '00000000-0000-4000-8000-000000000040',
  })
  play({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    uuid: '00000000-0000-4000-8000-000000000041',
  })
  play({
    type: 'assistant',
    message: {
      id: 'msg-before-result-1',
      role: 'assistant',
      content: [{ type: 'text', text: 'First API message.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 999, output_tokens: 999 },
    },
    parent_tool_use_id: null,
    session_id: 'engine-session-1',
    uuid: '00000000-0000-4000-8000-000000000042',
  })
  play({
    type: 'stream_event',
    event: { type: 'message_stop' },
    uuid: '00000000-0000-4000-8000-000000000043',
  })
  play({
    type: 'stream_event',
    event: { type: 'message_start', message: { id: 'msg-before-result-2' } },
    uuid: '00000000-0000-4000-8000-000000000044',
  })
  play({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    uuid: '00000000-0000-4000-8000-000000000045',
  })
  play({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Still streaming before result.' },
    },
    uuid: '00000000-0000-4000-8000-000000000046',
  })

  expect(
    selectTranscriptRows(state, 'session-1')
      .filter(row => row.kind === 'assistant-text')
      .map(row => row.content),
  ).toEqual([
    'First API message.',
    'Still streaming before result.',
  ])

  play({
    type: 'result',
    subtype: 'success',
    duration_ms: 10,
    duration_api_ms: 8,
    is_error: false,
    num_turns: 1,
    result: 'done',
    stop_reason: 'end_turn',
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
    permission_denials: [],
    fast_mode_state: 'off',
    session_id: 'engine-session-1',
    uuid: '00000000-0000-4000-8000-000000000047',
  })

  expect(
    selectTranscriptRows(state, 'session-1')
      .filter(row => row.kind === 'assistant-text')
      .map(row => row.content),
  ).toEqual(['First API message.', 'Still streaming before result.'])
})

test('skips malformed blocks without dropping valid siblings', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'assistant',
      message: {
        id: 'msg-malformed',
        role: 'assistant',
        content: [
          'not a block',
          { type: 'text', text: 42 },
          { type: 'tool_use', input: { missing: 'name' } },
          { type: 'thinking', thinking: 42 },
          { type: 'tool_use', id: 'toolu_ok', name: 'Bash', input: null },
        ],
      },
      uuid: '00000000-0000-4000-8000-000000000011',
    }),
  )

  expect(selectTranscriptRows(state, 'session-1')).toEqual([
    {
      id: 'session-1:msg-malformed:4:toolu_ok',
      sessionId: 'session-1',
      messageId: 'msg-malformed',
      frameId: '00000000-0000-4000-8000-000000000011',
      blockIndex: 4,
      parentToolUseId: null,
      kind: 'tool-use',
      toolUseId: 'toolu_ok',
      toolName: 'Bash',
      toolFamily: 'bash',
      input: {},
      status: 'pending',
      result: null,
      agentCompletion: null,
    },
  ])
})

test('keys transcript rows by envelope session and ignores unknown sessions', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    messageFrame('session-2', {
      type: 'assistant',
      message: {
        id: 'wrong-session',
        role: 'assistant',
        content: [{ type: 'text', text: 'must not leak' }],
      },
      uuid: '00000000-0000-4000-8000-000000000012',
    }),
  )

  expect(Object.keys(state.sessions)).toEqual(['session-1'])
  expect(selectTranscriptRows(state, 'session-1')).toEqual([])
})

test('leaves state untouched for unhandled messages and non-message events', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  const initial = state
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'result',
      subtype: 'success',
    }),
  )
  state = projectServerFrame(state, {
    kind: 'event',
    protocolVersion: 1,
    sessionId: 'session-1',
    event: { type: 'abort.status', abort: { status: 'requested' } },
  })

  expect(state).toBe(initial)
})

test('projects result with subtype: interrupted as a non-error result row', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'result',
      subtype: 'interrupted',
      is_error: false,
      duration_ms: 1800,
      total_cost_usd: 0,
      uuid: 'result-interrupted-1',
    }),
  )

  const rows = selectTranscriptRows(state, 'session-1')
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    kind: 'result',
    subtype: 'interrupted',
    isError: false,
    durationMs: 1800,
    totalCostUsd: 0,
  })
})

/* ─────────────────────────────────────────────────────────────────────────
 * P2-0 exhaustive SDKMessage coverage (PROGRAM-PLAN §5 acceptance artifact).
 * The fixture's mapped type already fails to COMPILE if the union grows a
 * discriminant; these tests prove the runtime contract over every sample.
 * ───────────────────────────────────────────────────────────────────────── */

test('fixture spans all 15 SDKMessage discriminants with ≥1 sample each', () => {
  const keys = Object.keys(SDK_MESSAGE_FIXTURE).sort()
  expect(keys).toEqual([
    'assistant',
    'assistant_error',
    'auth_status',
    'permission_denial',
    'prompt_suggestion',
    'rate_limit_event',
    'result',
    'status',
    'stream_event',
    'streamlined_text',
    'streamlined_tool_use_summary',
    'system',
    'tool_progress',
    'tool_use_summary',
    'user',
  ])
  for (const [key, samples] of Object.entries(SDK_MESSAGE_FIXTURE)) {
    expect(samples.length).toBeGreaterThan(0)
    for (const sample of samples) {
      expect(key).toBe(sample.message.type)
    }
  }
})

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

test('fixture covers every assistant content-block discriminant the engine renders', () => {
  const blockTypes = new Set<string>()
  for (const sample of SDK_MESSAGE_FIXTURE.assistant) {
    for (const block of sample.message.message.content) {
      const record = asRecord(block)
      if (record && typeof record.type === 'string') {
        blockTypes.add(record.type)
      }
    }
  }
  // Message.tsx:497-634 switch + one unknown/future block for tolerance.
  for (const required of [
    'text',
    'tool_use',
    'thinking',
    'redacted_thinking',
    'server_tool_use',
    'compaction',
  ]) {
    expect(blockTypes.has(required)).toBe(true)
  }
})

test('every fixture sample projects without crashing and adds exactly its documented rows', () => {
  for (const sample of allSdkMessageSamples()) {
    let state = createTranscriptState()
    state = projectServerFrame(state, ready('session-1'))
    const next = projectServerFrame(
      state,
      messageFrame('session-1', sample.message),
    )
    const rows = selectTranscriptRows(next, 'session-1')
    if (rows.length !== sample.expectRows) {
      throw new Error(
        `${sample.name}: expected ${sample.expectRows} row(s), got ${rows.length}`,
      )
    }
  }
})

test('documented no-op variants leave state reference-equal (no half-applied writes)', () => {
  const projectingDiscriminants = new Set([
    'assistant',
    'result',
    'stream_event',
    'system',
    'user',
  ])
  for (const sample of allSdkMessageSamples()) {
    if (projectingDiscriminants.has(sample.message.type)) continue
    let state = createTranscriptState()
    state = projectServerFrame(state, ready('session-1'))
    const next = projectServerFrame(
      state,
      messageFrame('session-1', sample.message),
    )
    if (next !== state) {
      throw new Error(`${sample.name}: no-op variant mutated projector state`)
    }
  }
})

test('one session survives the ENTIRE fixture sequence with its one live reasoning preview', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  let expectedRows = 0
  for (const sample of allSdkMessageSamples()) {
    state = projectServerFrame(state, messageFrame('session-1', sample.message))
    expectedRows += sample.expectRows
  }
  // The individual thinking_delta sample has no message_start in isolation,
  // but its ordered fixture sequence does. A readable delta is now one live row.
  expect(selectTranscriptRows(state, 'session-1')).toHaveLength(expectedRows + 1)
})

test('subagent frames preserve parent_tool_use_id on their rows', () => {
  const subagentSample = SDK_MESSAGE_FIXTURE.assistant.find(sample =>
    sample.name.startsWith('assistant: subagent frame'),
  )
  if (!subagentSample) throw new Error('subagent fixture sample missing')

  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    messageFrame('session-1', subagentSample.message),
  )

  const rows = selectTranscriptRows(state, 'session-1')
  expect(rows).toHaveLength(1)
  expect(
    rows[0] && 'parentToolUseId' in rows[0]
      ? rows[0].parentToolUseId
      : undefined,
  ).toBe('toolu_01FixTask1')

  // Top-level frames stay null.
  const textSample = SDK_MESSAGE_FIXTURE.assistant[0]
  if (!textSample) throw new Error('assistant text fixture sample missing')
  state = projectServerFrame(state, messageFrame('session-1', textSample.message))
  const topLevelRow = selectTranscriptRows(state, 'session-1')[1]
  expect(
    topLevelRow && 'parentToolUseId' in topLevelRow
      ? topLevelRow.parentToolUseId
      : undefined,
  ).toBeNull()
})

test('schema-drift wire frames are tolerated no-ops, never crashes', () => {
  // Wire bytes, exactly as the socket would deliver them: a variant minted by
  // an engine newer than the pinned types. JSON.parse + a deliberate cast is
  // the honest simulation — the runtime tolerance is what is under test.
  const driftMessage = JSON.parse(DRIFT_WIRE_SAMPLE_JSON) as SDKMessage
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  const before = state
  state = projectServerFrame(state, messageFrame('session-1', driftMessage))
  expect(state).toBe(before)
})

test('malformed assistant wire frames (no message body) are tolerated no-ops', () => {
  const malformed = JSON.parse(
    '{"type":"assistant","message":"not an object","uuid":"00000000-0000-4000-8000-0000000000ff"}',
  ) as SDKMessage
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  const before = state
  state = projectServerFrame(state, messageFrame('session-1', malformed))
  expect(state).toBe(before)
})

test('projects assistant thinking blocks and preserves Codex reasoning metadata', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'assistant',
      message: {
        id: 'msg-thinking',
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'First inspect the boundary.',
            signature: 'sig-1',
            reasoning_kind: 'summary',
          },
          {
            type: 'thinking',
            thinking: 'Then preserve the engine spelling.',
            reasoningKind: 'raw',
          },
          { type: 'redacted_thinking', data: 'encrypted-reasoning' },
        ],
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-000000000201',
    }),
  )

  expect(selectTranscriptRows(state, 'session-1')).toMatchObject([
    {
      kind: 'thinking',
      content: 'First inspect the boundary.',
      signature: 'sig-1',
      reasoningKind: 'summary',
    },
    {
      kind: 'thinking',
      content: 'Then preserve the engine spelling.',
      reasoningKind: 'raw',
    },
    { kind: 'redacted-thinking', data: 'encrypted-reasoning' },
  ])
})

test('projects plain user text, real command metadata, and image blocks', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'inspect this image' },
          {
            type: 'text',
            text: '<command-message>compact</command-message>\n<command-args>focus on tests</command-args>',
          },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'iVBORw0KGgoAAAANSUhEUg',
            },
          },
        ],
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-000000000202',
      timestamp: '2026-07-04T09:00:00.000Z',
    }),
  )

  expect(selectTranscriptRows(state, 'session-1')).toMatchObject([
    { kind: 'user-text', role: 'user', content: 'inspect this image' },
    {
      kind: 'command-echo',
      commandName: 'compact',
      args: 'focus on tests',
      content: '/compact focus on tests',
    },
    {
      kind: 'user-image',
      source: {
        type: 'base64',
        mediaType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUg',
      },
    },
  ])
})

/** Project one user frame with the given `origin` and return its rows. */
function rowsForUserOrigin(
  origin: unknown,
  content: unknown = 'a message the operator did not write',
) {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  const raw = JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    uuid: '00000000-0000-4000-8000-000000000301',
    ...(origin === undefined ? {} : { origin }),
  })
  state = projectServerFrame(
    state,
    // Parsed JSON, exactly as the socket delivers it — never a compile-time
    // value, so drifted/malformed origins can be exercised too.
    messageFrame('session-1', JSON.parse(raw) as SDKMessage),
  )
  return selectTranscriptRows(state, 'session-1')
}

test('projects an engine task-notification banner as a system-side notice, not a user bubble', () => {
  // Regression (bug-sweep #4, 2026-07-21). Status now comes from the wire
  // `origin.status` rather than a regex over the banner text.
  const banner = [
    'Task notification',
    'Task ID: a9b0c1b002e2dd6e3',
    'Status: completed',
    'Summary: Agent @Hamilton completed',
    'Result:',
    'No — the inventory is not complete.',
  ].join('\n')

  const rows = rowsForUserOrigin(
    { kind: 'task-notification', status: 'completed', summary: 'Agent @Hamilton completed' },
    [{ type: 'text', text: banner }],
  )
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    kind: 'task-notification',
    status: 'completed',
    summary: 'Agent @Hamilton completed',
  })
  // The critical assertion: it is NOT rendered as a user-side row.
  expect(rows[0]?.kind).not.toBe('user-text')
  // Regression (leak, 2026-08-01): the row carries the one-line summary and
  // NOTHING of the model-facing banner. The task id is the specific string the
  // operator saw on screen.
  expect(rows[0]).not.toHaveProperty('content')
  expect(JSON.stringify(rows[0])).not.toContain('a9b0c1b002e2dd6e3')
  expect(JSON.stringify(rows[0])).not.toContain('Task notification')
})

test('a task-notification with no summary yields a row the view declines to draw', () => {
  // `UserAgentNotificationMessage.tsx:37` returns null without a summary; the
  // desktop keeps the row (ordering) and `TaskNotificationBox` renders nothing,
  // rather than drawing an empty banner shell.
  const rows = rowsForUserOrigin({ kind: 'task-notification', status: 'completed' }, [
    { type: 'text', text: 'Task notification\nTask ID: deadbeef\nStatus: completed' },
  ])
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ kind: 'task-notification', summary: null })
  expect(JSON.stringify(rows[0])).not.toContain('deadbeef')
})

/**
 * The kinds that had NO desktop handling at all: `coordinator`, `channel`,
 * `teammate`, `deferred-continuation` (`MessageOrigin`, src/types/message.ts:10),
 * joined 2026-09-03 by `peer`. Each carries `role:'user'` but was written by the
 * engine, and each rendered as the operator's own right-aligned bubble before
 * `origin` crossed the wire.
 */
test.each([
  [{ kind: 'coordinator' }, 'coordinator', null],
  [{ kind: 'channel', server: 'slack' }, 'channel', 'slack'],
  [{ kind: 'channel', server: 'slack', user: 'dana' }, 'channel', 'slack · dana'],
  [{ kind: 'teammate', from: 'scout' }, 'teammate', 'scout'],
  [{ kind: 'teammate' }, 'teammate', null],
  [{ kind: 'deferred-continuation' }, 'deferred-continuation', null],
  // PEER-SESSIONS §6 / HOST-REQUEST-PLANE §6: the sender is the peer's NAME,
  // the one sender fact `SDKMessageOrigin`'s `peer` member carries.
  [{ kind: 'peer', name: 'Bear' }, 'peer', 'Bear'],
  // A peer claim off the socket with no usable name still reads as injected —
  // unlabelled, never re-attributed to the operator.
  [{ kind: 'peer' }, 'peer', null],
  [{ kind: 'peer', name: '' }, 'peer', null],
  [{ kind: 'peer', name: 42 }, 'peer', null],
])(
  'projects origin %j as an injected-turn row, never a user bubble',
  (origin, injectedKind, label) => {
    const rows = rowsForUserOrigin(origin)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'injected-turn',
      injectedKind,
      label,
      content: 'a message the operator did not write',
    })
    // The assertion that fails without the wire change:
    expect(rows[0]?.kind).not.toBe('user-text')
  },
)

/**
 * HOST-REQUEST-PLANE §6 owes the OTHER half of the peer-rendering rule: an
 * incoming peer message must never appear in the staged-prompt strip either.
 * That strip is fed by the `queued-prompts.snapshot` read seam, a different
 * frame on a different store, so the guarantee is that the two paths do not
 * meet: the same user frame that mints a peer transcript row leaves the queued
 * store untouched, and the strip therefore has nothing to draw.
 *
 * A message from a peer has already reached the model. Showing it as "waiting
 * to be sent", in the user's own dashed bubble, would attribute the peer's text
 * to the operator on the one surface that draws it as their unsent draft.
 */
test('a peer message reaches the transcript only, never the staged-prompt strip', () => {
  const frame = messageFrame(
    'session-1',
    JSON.parse(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'ran the migration, all green' },
        parent_tool_use_id: null,
        uuid: '00000000-0000-4000-8000-000000000401',
        origin: { kind: 'peer', name: 'Bear' },
      }),
    ) as SDKMessage,
  )

  let transcript = createTranscriptState()
  transcript = projectServerFrame(transcript, ready('session-1'))
  transcript = projectServerFrame(transcript, frame)
  expect(selectTranscriptRows(transcript, 'session-1')).toHaveLength(1)

  // The same frame through the queued store: nothing staged, no session key.
  let queued = createQueuedPromptsState()
  queued = reduceQueuedPromptsState(queued, { type: 'frame', frame })
  expect(selectQueuedPrompts(queued, 'session-1' as SessionId)).toHaveLength(0)
})

test('an operator turn still renders as a user bubble — with or without a human origin', () => {
  for (const origin of [undefined, { kind: 'human' }]) {
    const rows = rowsForUserOrigin(origin, 'run the tests please')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'user-text',
      role: 'user',
      content: 'run the tests please',
    })
  }
})

test('provenance outranks the command-echo text heuristic', () => {
  // An injected turn may legitimately contain a `<command-message>` marker; the
  // operator must not be shown as the author of a command they never ran.
  const echo =
    '<command-message>compact</command-message>\n<command-name>/compact</command-name>'
  expect(rowsForUserOrigin({ kind: 'coordinator' }, echo)[0]).toMatchObject({
    kind: 'injected-turn',
    injectedKind: 'coordinator',
  })
  // …while a real operator command echo is untouched.
  expect(rowsForUserOrigin(undefined, echo)[0]).toMatchObject({
    kind: 'command-echo',
    commandName: 'compact',
  })
})

test('a drifted or malformed origin degrades to an injected row, never a user bubble and never a throw', () => {
  // A kind minted by a newer engine: the row must still be attributed away from
  // the operator (TranscriptView renders an unknown kind with a neutral label).
  expect(rowsForUserOrigin({ kind: 'future-kind-2027' })[0]).toMatchObject({
    kind: 'injected-turn',
    injectedKind: 'future-kind-2027',
    label: null,
  })
  // Structurally broken origins are not provenance claims — they fall back to
  // the operator-turn reading rather than inventing an injected row.
  for (const broken of [null, 42, 'coordinator', {}, { kind: '' }, { kind: 7 }]) {
    const rows = rowsForUserOrigin(broken, 'plain text')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('user-text')
  }
  // A channel origin missing its server still reads as injected, just unlabelled.
  expect(rowsForUserOrigin({ kind: 'channel' })[0]).toMatchObject({
    kind: 'injected-turn',
    injectedKind: 'channel',
    label: null,
  })
})

test('legacy <task-notification> transcripts (no origin field) do not regress', () => {
  // Real stored transcripts written before `origin` existed carry only this XML
  // envelope (`src/utils/taskNotification.ts:119` "compatibility-only"). They
  // must keep rendering system-side.
  const legacy =
    '<task-notification>\n<status>failed</status>\n<summary>build broke</summary>\n</task-notification>'
  const rows = rowsForUserOrigin(undefined, legacy)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    kind: 'task-notification',
    status: 'failed',
    // The envelope's own `<summary>`, not the envelope. These transcripts have
    // no join key, so they always stay a standalone row.
    summary: 'build broke',
    toolUseId: null,
  })
  expect(JSON.stringify(rows[0])).not.toContain('<task-notification>')
})

/* ── background-agent finish stays in transcript order ───────────────────── */
function stateWithBackgroundAgent(origin: unknown) {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'assistant',
      message: {
        id: 'msg-spawn',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_agent_1',
            name: 'Agent',
            input: { subagent_type: 'Explore', description: 'Find the owner files' },
          },
        ],
      },
      uuid: '00000000-0000-4000-8000-000000000401',
    }),
  )
  const raw = JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'text',
          // The real banner, verbatim — the projector must keep every one of
          // these internals off the row.
          text: [
            'Task notification',
            'Task ID: ae916c961d15ead2f',
            'Output file: /private/tmp/tasks/ae916c961d15ead2f.output',
            'Tool use ID: toolu_agent_1',
            'Status: completed',
            'Summary: Agent @Ada completed',
            'Result:',
            'Sidebar lives in app/renderer/src/Sidebar.tsx',
          ].join('\n'),
        },
      ],
    },
    parent_tool_use_id: null,
    uuid: '00000000-0000-4000-8000-000000000402',
    origin,
  })
  return projectServerFrame(
    state,
    messageFrame('session-1', JSON.parse(raw) as SDKMessage),
  )
}

const ADA_ORIGIN = {
  kind: 'task-notification',
  status: 'completed',
  summary: 'Agent @Ada completed',
  toolUseId: 'toolu_agent_1',
  result: 'Sidebar lives in app/renderer/src/Sidebar.tsx',
  usage: { totalTokens: 12400, toolUses: 3, durationMs: 48000 },
}

test('a background agent finish stays a later notification row and leaves its launch card unchanged', () => {
  const rows = selectTranscriptRows(stateWithBackgroundAgent(ADA_ORIGIN), 'session-1')

  expect(rows).toHaveLength(2)
  expect(rows[0]).toMatchObject({
    kind: 'tool-use',
    toolUseId: 'toolu_agent_1',
    agentCompletion: null,
  })
  expect(rows[1]).toMatchObject({
    kind: 'task-notification',
    status: 'completed',
    summary: 'Agent @Ada completed',
  })

  // The leak, pinned shut: not one of the banner's internals survives into
  // anything the view can read.
  const serialized = JSON.stringify(rows)
  for (const leaked of [
    'ae916c961d15ead2f',
    '/private/tmp/tasks',
    'Task notification',
    'Output file',
    'Tool use ID',
  ]) {
    expect(serialized).not.toContain(leaked)
  }
})

test('the nested selector preserves the launch card followed by its completion row', () => {
  const nested = selectNestedTranscriptRows(
    stateWithBackgroundAgent(ADA_ORIGIN),
    'session-1',
  )
  expect(nested).toHaveLength(2)
  expect(nested[0]).toMatchObject({
    kind: 'tool-use',
    toolFamily: 'agent',
    agentCompletion: null,
  })
  expect(nested[1]).toMatchObject({ kind: 'task-notification' })
})

test('a completion whose card never arrived stays a visible row, never vanishes', () => {
  // Degraded placement, not data loss — the same posture as an orphaned child
  // row surfacing at top level.
  const rows = selectTranscriptRows(
    stateWithBackgroundAgent({ ...ADA_ORIGIN, toolUseId: 'toolu_never_spawned' }),
    'session-1',
  )
  const notifications = rows.filter(row => row.kind === 'task-notification')
  expect(notifications).toHaveLength(1)
  expect(notifications[0]).toMatchObject({
    kind: 'task-notification',
    summary: 'Agent @Ada completed',
    toolUseId: 'toolu_never_spawned',
  })
  // …and the agent card that WAS spawned keeps a null completion.
  expect(rows.find(row => row.kind === 'tool-use')).toMatchObject({
    agentCompletion: null,
  })
})

test('a background SHELL finish keeps its own row', () => {
  // `LocalShellTask.tsx:165` notifies with the Bash `toolUseId`. A Bash card has
  // no completion renderer, so folding one in would delete the notice outright.
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'assistant',
      message: {
        id: 'msg-bash',
        content: [
          { type: 'tool_use', id: 'toolu_bash_1', name: 'Bash', input: { command: 'bun test' } },
        ],
      },
      uuid: '00000000-0000-4000-8000-000000000501',
    }),
  )
  const raw = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'Task notification\nSummary: bun test completed' }] },
    parent_tool_use_id: null,
    uuid: '00000000-0000-4000-8000-000000000502',
    origin: {
      kind: 'task-notification',
      status: 'completed',
      summary: 'bun test completed',
      toolUseId: 'toolu_bash_1',
    },
  })
  state = projectServerFrame(
    state,
    messageFrame('session-1', JSON.parse(raw) as SDKMessage),
  )

  const rows = selectTranscriptRows(state, 'session-1')
  expect(rows.filter(row => row.kind === 'task-notification')).toHaveLength(1)
  // …and the Bash card never grows a completion it cannot draw.
  expect(rows.find(row => row.kind === 'tool-use')).toMatchObject({
    toolFamily: 'bash',
    agentCompletion: null,
  })
})

test('a partial or malformed completion usage never leaks into the notification row', () => {
  for (const usage of [
    { totalTokens: 10, toolUses: 2 },
    { totalTokens: 'lots', toolUses: 2, durationMs: 5 },
    { totalTokens: Number.NaN, toolUses: 2, durationMs: 5 },
    null,
    'usage',
  ]) {
    const rows = selectTranscriptRows(
      stateWithBackgroundAgent({ ...ADA_ORIGIN, usage }),
      'session-1',
    )
    expect(rows[0]).toMatchObject({ agentCompletion: null })
    expect(rows[1]).toMatchObject({
      kind: 'task-notification',
      summary: 'Agent @Ada completed',
    })
  }
})

/* ── local slash-command output (bug, 2026-07-29) ──────────────────────────
 * A terminal slash command's RESULT is persisted as a plain `type:'user'`
 * message whose entire content is the raw wrapper
 * (src/utils/processUserInput/processSlashCommand.tsx:625). It carries no
 * `origin` and no synthetic flag, so the app showed the operator as the author
 * of output they never typed. The terminal has always branched on the tag
 * itself (src/components/messages/UserTextMessage.tsx:76-81). */

test('projects local slash-command output as a system notice, never a user bubble', () => {
  const rows = rowsForUserOrigin(
    undefined,
    '<local-command-stdout>Set model to GPT 5.6 Sol</local-command-stdout>',
  )
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    kind: 'system-notice',
    noticeType: 'local_command_output',
    content: 'Set model to GPT 5.6 Sol',
  })
  // The assertions that fail against the pre-fix projector: the row was the
  // operator's own bubble, wrapper tags and all.
  expect(rows[0]).not.toMatchObject({ kind: 'user-text', role: 'user' })
  expect(rows[0]?.kind).not.toBe('user-text')
})

test('strips the ANSI bytes a restored slash-command result still carries', () => {
  // Nothing strips them on the way in: the engine's stripAnsi passes
  // (src/QueryEngine.ts:673, src/utils/messages/mappers.ts:266) do not cover
  // `toSDKMessages`' `case 'user'` (mappers.ts:191-213).
  const sample = SDK_MESSAGE_FIXTURE.user.find(entry =>
    entry.name.includes('live ANSI bytes'),
  )
  if (!sample) throw new Error('local-command ANSI fixture is missing')
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(state, messageFrame('session-1', sample.message))
  const rows = selectTranscriptRows(state, 'session-1')
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    kind: 'system-notice',
    noticeType: 'local_command_output',
    content: 'Set model to GPT 5.6 Sol · Provider OpenAI',
  })
  expect(rows[0]?.kind).not.toBe('user-text')
})

test('local slash-command stderr, both streams, and empty output read the same way', () => {
  expect(
    rowsForUserOrigin(
      undefined,
      '<local-command-stderr>/model needs an argument</local-command-stderr>',
    )[0],
  ).toMatchObject({
    kind: 'system-notice',
    noticeType: 'local_command_output',
    content: '/model needs an argument',
  })
  expect(
    rowsForUserOrigin(
      undefined,
      '<local-command-stdout>done</local-command-stdout><local-command-stderr>one warning</local-command-stderr>',
    )[0],
  ).toMatchObject({
    kind: 'system-notice',
    noticeType: 'local_command_output',
    content: 'done\none warning',
  })
  // Both payloads empty is the terminal's NO_CONTENT_MESSAGE case
  // (src/components/messages/UserLocalCommandOutputMessage.tsx:24-34), not an
  // empty operator bubble.
  expect(
    rowsForUserOrigin(
      undefined,
      '<local-command-stdout></local-command-stdout><local-command-stderr></local-command-stderr>',
    )[0],
  ).toMatchObject({
    kind: 'system-notice',
    noticeType: 'local_command_output',
    content: '(no content)',
  })
})

/* ── bash-mode (`!`) command output (2026-07-29) ────────────────────────────
 * Same leak, other producer: processBashCommand.tsx:109,125,132 persists the
 * result as a plain `type:'user'` message. The terminal branches on it with the
 * identical anchored `startsWith` shape one line above the local-command branch
 * (src/components/messages/UserTextMessage.tsx:69-74), so both ride one branch
 * here. It reuses `local_command_output` because the notice-type union is
 * duplicated in TranscriptView.tsx:1711,1730 (SystemNoticeBox prop +
 * exhaustive NOTICE_STYLE record); adding a member is a two-file change, not a
 * projector-local one. */

test('projects bash-mode command output as a system notice, never a user bubble', () => {
  const rows = rowsForUserOrigin(
    undefined,
    '<bash-stdout>README.md\npackage.json</bash-stdout><bash-stderr></bash-stderr>',
  )
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    kind: 'system-notice',
    noticeType: 'local_command_output',
    content: 'README.md\npackage.json',
  })
  // The assertions that fail against the pre-fix projector: the row was the
  // operator's own bubble, wrapper tags and all.
  expect(rows[0]).not.toMatchObject({ kind: 'user-text', role: 'user' })
  expect(rows[0]?.kind).not.toBe('user-text')
})

test('bash stderr, both streams, and empty output read the same way', () => {
  expect(
    rowsForUserOrigin(
      undefined,
      '<bash-stderr>ls: nope: No such file or directory</bash-stderr>',
    )[0],
  ).toMatchObject({
    kind: 'system-notice',
    noticeType: 'local_command_output',
    content: 'ls: nope: No such file or directory',
  })
  expect(
    rowsForUserOrigin(
      undefined,
      '<bash-stdout>built</bash-stdout><bash-stderr>1 warning</bash-stderr>',
    )[0],
  ).toMatchObject({
    kind: 'system-notice',
    noticeType: 'local_command_output',
    content: 'built\n1 warning',
  })
  // A silent `!` command: both payloads empty. A notice row with no text would
  // read as a rendering fault, so it reuses the terminal's NO_CONTENT_MESSAGE.
  expect(
    rowsForUserOrigin(
      undefined,
      '<bash-stdout></bash-stdout><bash-stderr></bash-stderr>',
    )[0],
  ).toMatchObject({
    kind: 'system-notice',
    noticeType: 'local_command_output',
    content: '(no content)',
  })
})

test('strips the ANSI bytes bash output carries, like slash-command output', () => {
  expect(
    rowsForUserOrigin(
      undefined,
      '<bash-stdout>\u001B[32mok\u001B[39m</bash-stdout>',
    )[0],
  ).toMatchObject({
    kind: 'system-notice',
    noticeType: 'local_command_output',
    content: 'ok',
  })
})

test('unwraps the <persisted-output> a large `!` command nests inside bash-stdout', () => {
  // processBashCommand.tsx:106 keeps buildLargeToolResultMessage's inner
  // wrapper unescaped on purpose, so the tag survives into the stdout payload
  // and the notice printed it verbatim. The terminal unwraps it again
  // (UserBashOutputMessage.tsx:14-18).
  const sample = SDK_MESSAGE_FIXTURE.user.find(entry =>
    entry.name.includes('large persisted output'),
  )
  if (!sample) throw new Error('bash persisted-output fixture is missing')
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(state, messageFrame('session-1', sample.message))
  const rows = selectTranscriptRows(state, 'session-1')
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    kind: 'system-notice',
    noticeType: 'local_command_output',
    content:
      'Output too large (1.4MB). Full output saved to: /tmp/cat-code/bash-9f2c.txt\n\nPreview (first 10.0KB):\nsrc/QueryEngine.ts\nsrc/main.tsx\n...',
  })
  // The assertion that fails against the pre-fix projector.
  const row = rows[0]
  expect(row && 'content' in row ? row.content : '').not.toContain(
    'persisted-output',
  )
})

test('bash output without the inner wrapper is left exactly as it was', () => {
  // The terminal's `?? rawStdout` fallback (UserBashOutputMessage.tsx:14-18):
  // no inner tag means the payload is untouched.
  expect(
    rowsForUserOrigin(
      undefined,
      '<bash-stdout>README.md\npackage.json</bash-stdout>',
    )[0],
  ).toMatchObject({
    kind: 'system-notice',
    noticeType: 'local_command_output',
    content: 'README.md\npackage.json',
  })
})

test('local-command output keeps a persisted-output wrapper it happens to carry', () => {
  // Pinned scope limit, matching the terminal: only UserBashOutputMessage
  // unwraps the inner tag. UserLocalCommandOutputMessage.tsx:22-23 extracts the
  // two local-command tags and nothing else, so a slash command that prints
  // that literal text keeps it.
  expect(
    rowsForUserOrigin(
      undefined,
      '<local-command-stdout><persisted-output>saved</persisted-output></local-command-stdout>',
    )[0],
  ).toMatchObject({
    kind: 'system-notice',
    noticeType: 'local_command_output',
    content: '<persisted-output>saved</persisted-output>',
  })
})

test('<bash-input> stays an operator turn and is NOT folded into the notice', () => {
  // Deliberate exclusion, pinned so nobody "fixes" it by accident: <bash-input>
  // is the command the operator typed, not its output, and the terminal routes
  // it to UserBashInputMessage via `includes` rather than the anchored
  // `startsWith` used for output (UserTextMessage.tsx:102 vs :69-74). Giving it
  // an input-style row is a separate, unmade design decision; until then it
  // stays a user row rather than being mislabelled as command output.
  const rows = rowsForUserOrigin(undefined, '<bash-input>ls -la</bash-input>')
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ kind: 'user-text', role: 'user' })
  expect(rows[0]).not.toMatchObject({ kind: 'system-notice' })
})

test('a turn that merely mentions the wrapper is still the operator speaking', () => {
  // Anchored `startsWith`, exactly the engine predicate: only a message that IS
  // the wrapper is command output.
  expect(
    rowsForUserOrigin(
      undefined,
      'why does <local-command-stdout> show up in my transcript?',
    )[0],
  ).toMatchObject({ kind: 'user-text', role: 'user' })
})

test('rejects malformed P2-1 content blocks without partial rows', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'assistant',
      message: {
        id: 'msg-malformed-p2-1',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 42 },
          { type: 'thinking', thinking: 'valid', reasoning_kind: 42 },
          { type: 'redacted_thinking', data: null },
        ],
      },
      uuid: '00000000-0000-4000-8000-000000000203',
    }),
  )
  const malformedUser = JSON.parse(
    '{"type":"user","message":{"role":"user","content":[{"type":"text","text":42},{"type":"image","source":{"type":"base64","media_type":"image/png"}},{"type":"image","source":{"type":"future","url":"https://example.com"}}]},"uuid":"00000000-0000-4000-8000-000000000204"}',
  ) as SDKMessage
  state = projectServerFrame(
    state,
    messageFrame('session-1', malformedUser),
  )

  expect(selectTranscriptRows(state, 'session-1')).toEqual([])
})

test('captures the init frame slash_commands catalog per session (P3-7)', () => {
  const initWith = (
    sessionId: string,
    uuid: string,
    slashCommands: unknown,
  ): SDKMessage =>
    ({
      type: 'system',
      subtype: 'init',
      cwd: '/Users/pt/cat-code',
      model: 'claude-sonnet-5',
      tools: ['Read', 'Edit'],
      permissionMode: 'default',
      slash_commands: slashCommands,
      uuid,
    }) as SDKMessage

  let state = createTranscriptState()
  // No init frame yet → empty catalog (picker shows nothing, not a crash).
  expect(selectSlashCommands(state, 'session-1')).toEqual([])

  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(state, ready('session-2'))
  state = projectServerFrame(
    state,
    messageFrame(
      'session-1',
      initWith('session-1', '00000000-0000-4000-8000-0000000003c1', [
        'help',
        'clear',
        'compact',
      ]),
    ),
  )
  // A second session's catalog stays isolated (keyed by sessionId).
  state = projectServerFrame(
    state,
    messageFrame(
      'session-2',
      initWith('session-2', '00000000-0000-4000-8000-0000000003c2', ['model']),
    ),
  )

  expect(selectSlashCommands(state, 'session-1')).toEqual([
    'help',
    'clear',
    'compact',
  ])
  expect(selectSlashCommands(state, 'session-2')).toEqual(['model'])

  // P4-23: the init frame captures the catalog but emits NO visible transcript
  // row (the ✦ "Session started" banner was removed, operator 2026-07-09). The
  // catalog survival above proves `case 'init'` still runs.
  expect(selectTranscriptRows(state, 'session-1')).toEqual([])
  expect(selectTranscriptRows(state, 'session-2')).toEqual([])

  // A later turn's init frame refreshes the catalog for that session only.
  state = projectServerFrame(
    state,
    messageFrame(
      'session-1',
      initWith('session-1', '00000000-0000-4000-8000-0000000003c3', ['help']),
    ),
  )
  expect(selectSlashCommands(state, 'session-1')).toEqual(['help'])
  expect(selectSlashCommands(state, 'session-2')).toEqual(['model'])

  // A malformed/absent slash_commands degrades to [] without dropping the row.
  let degraded = createTranscriptState()
  degraded = projectServerFrame(degraded, ready('session-3'))
  degraded = projectServerFrame(
    degraded,
    messageFrame(
      'session-3',
      initWith('session-3', '00000000-0000-4000-8000-0000000003c4', 'not-array'),
    ),
  )
  expect(selectSlashCommands(degraded, 'session-3')).toEqual([])
  // P4-23: a degraded (non-array slash_commands) init still captures `[]` and
  // emits no row — the frame handler runs, the banner row is gone.
  expect(selectTranscriptRows(degraded, 'session-3')).toEqual([])
})

/* ── compaction status (2026-08-22) ────────────────────────────────────────
 * Compaction is invisible to the transcript while it runs: it mints no row
 * until `compact_boundary` lands at the end. The engine's own signal is a
 * pushed `system/subtype:'status'` (`src/services/compact/compact.ts`
 * `setSDKStatus`), wired onto this path by
 * `src/app-runtime/createRuntimeBackedAppSession.ts`. Without it the
 * activity verb read "Working" for the whole compaction. */

function statusFrame(status: string | null, uuid: string) {
  return messageFrame('session-1', {
    type: 'system',
    subtype: 'status',
    status,
    uuid,
  } as unknown as SDKMessage)
}

test('the engine status signal raises and clears the compacting flag', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  expect(selectIsCompacting(state, 'session-1')).toBe(false)

  state = projectServerFrame(
    state,
    statusFrame('compacting', '00000000-0000-4000-8000-0000000002a1'),
  )
  expect(selectIsCompacting(state, 'session-1')).toBe(true)
  // No row: the boundary at the end is the durable record.
  expect(selectTranscriptRows(state, 'session-1')).toHaveLength(0)

  // The 30s keep-alive re-emits the SAME status. Identity must survive it, or
  // every read-time slice cache downstream busts twice a minute.
  const before = state
  state = projectServerFrame(
    state,
    statusFrame('compacting', '00000000-0000-4000-8000-0000000002a2'),
  )
  expect(state.sessions['session-1']).toBe(before.sessions['session-1'])

  state = projectServerFrame(
    state,
    statusFrame(null, '00000000-0000-4000-8000-0000000002a3'),
  )
  expect(selectIsCompacting(state, 'session-1')).toBe(false)
})

test('the boundary and the turn end both clear a compaction left running', () => {
  const start = statusFrame('compacting', '00000000-0000-4000-8000-0000000002b1')

  let viaBoundary = createTranscriptState()
  viaBoundary = projectServerFrame(viaBoundary, ready('session-1'))
  viaBoundary = projectServerFrame(viaBoundary, start)
  viaBoundary = projectServerFrame(
    viaBoundary,
    messageFrame('session-1', {
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'manual', pre_tokens: 147150 },
      uuid: '00000000-0000-4000-8000-0000000002b2',
    } as unknown as SDKMessage),
  )
  expect(selectIsCompacting(viaBoundary, 'session-1')).toBe(false)
  expect(selectTranscriptRows(viaBoundary, 'session-1')[0]).toMatchObject({
    kind: 'compact-boundary',
    trigger: 'manual',
    preTokens: 147150,
  })

  // An ABORTED compaction never reaches the engine's own clear, so the turn
  // boundary is the backstop: without it the verb stays "Compacting" forever.
  let viaResult = createTranscriptState()
  viaResult = projectServerFrame(viaResult, ready('session-1'))
  viaResult = projectServerFrame(viaResult, start)
  viaResult = projectServerFrame(
    viaResult,
    messageFrame('session-1', {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      duration_ms: 10,
      uuid: '00000000-0000-4000-8000-0000000002b3',
    } as unknown as SDKMessage),
  )
  expect(selectIsCompacting(viaResult, 'session-1')).toBe(false)
})

/**
 * A recovered `compact_boundary` is an OLDER boundary read back from history
 * by `history.loadEarlier` (`recovered: true`), not the live compaction
 * finishing. Clearing `compacting` on it means the live compaction's own
 * boundary later only re-clears an already-false flag, so the activity verb
 * drops "Compacting" while the summarization call is still in flight and
 * never gets it back.
 */
function recoveredCompactBoundaryFrame(sessionId: string, label: string) {
  return {
    ...messageFrame(sessionId, {
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'manual', pre_tokens: 147150 },
      uuid: `00000000-0000-4000-8000-recovered-cb-${label}`,
    } as unknown as SDKMessage),
    replay: true as const,
    recovered: true as const,
  }
}

test('a recovered compact_boundary does not clear a live compaction (single-frame path)', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(state, assistantFrame('session-1', 1))
  state = projectServerFrame(
    state,
    statusFrame('compacting', '00000000-0000-4000-8000-0000000002e1'),
  )
  expect(selectIsCompacting(state, 'session-1')).toBe(true)

  state = projectServerFrame(
    state,
    recoveredCompactBoundaryFrame('session-1', 'a'),
  )

  // The live compaction is still running: an OLDER boundary loaded from
  // history must not stop the indicator from saying "Compacting".
  expect(selectIsCompacting(state, 'session-1')).toBe(true)
  // The boundary row still lands at the head, above the conversation it
  // precedes.
  expect(selectTranscriptRows(state, 'session-1')[0]).toMatchObject({
    kind: 'compact-boundary',
    trigger: 'manual',
    preTokens: 147150,
  })
})

test('a recovered compact_boundary does not clear a live compaction (batch path)', () => {
  const frames = [
    ready('session-1'),
    assistantFrame('session-1', 1),
    statusFrame('compacting', '00000000-0000-4000-8000-0000000002e2'),
    recoveredCompactBoundaryFrame('session-1', 'b'),
  ]
  const state = projectServerFrames(createTranscriptState(), frames)

  expect(selectIsCompacting(state, 'session-1')).toBe(true)
  expect(selectTranscriptRows(state, 'session-1')[0]).toMatchObject({
    kind: 'compact-boundary',
    trigger: 'manual',
    preTokens: 147150,
  })
})

test('the compaction echo drops its terminal-only shortcut, keeps hook output', () => {
  // `buildDisplayText` (src/commands/compact/compact.ts) joins the TUI shortcut
  // line and any PreCompact/PostCompact `userDisplayMessage` into one string.
  expect(stripCompactionEcho('Compacted (ctrl+o to see full summary)')).toBeNull()
  expect(stripCompactionEcho('Compacted')).toBeNull()
  // A remapped binding still matches: the shortcut is whatever the keymap says.
  expect(stripCompactionEcho('Compacted (cmd+t to see full summary)')).toBeNull()
  expect(
    stripCompactionEcho('Compacted (ctrl+o to see full summary)\nHook wrote notes.md'),
  ).toBe('Hook wrote notes.md')
  // Verbose mode omits the shortcut line entirely.
  expect(stripCompactionEcho('Compacted\nHook wrote notes.md')).toBe(
    'Hook wrote notes.md',
  )
  // Any other command's output is untouched.
  expect(stripCompactionEcho('Total cost: $0.42')).toBe('Total cost: $0.42')
})

test('the whole compaction echo row is dropped, boundary seam aside', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'user',
      message: {
        role: 'user',
        content:
          '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>',
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-0000000002c1',
    } as unknown as SDKMessage),
  )
  expect(selectTranscriptRows(state, 'session-1')).toHaveLength(0)
})

test('projects user-visible system notices and emits boundary rows once', () => {
  const messages: SDKMessage[] = [
    {
      type: 'system',
      subtype: 'init',
      cwd: '/Users/pt/cat-code',
      model: 'claude-sonnet-5',
      tools: ['Read', 'Edit'],
      permissionMode: 'default',
      uuid: '00000000-0000-4000-8000-000000000205',
    },
    {
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 1234 },
      uuid: '00000000-0000-4000-8000-000000000206',
    },
    {
      type: 'system',
      subtype: 'api_retry',
      attempt: 2,
      max_retries: 10,
      retry_delay_ms: 8000,
      error: { type: 'assistant_error', message: 'Overloaded' },
      uuid: '00000000-0000-4000-8000-000000000207',
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Finished',
      duration_ms: 1200,
      total_cost_usd: 0.01,
      uuid: '00000000-0000-4000-8000-000000000208',
    },
  ]

  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  for (const message of messages) {
    state = projectServerFrame(state, messageFrame('session-1', message))
    state = projectServerFrame(state, messageFrame('session-1', message))
  }

  // P4-23: the init frame no longer emits a 'session-init' row (banner removed).
  expect(selectTranscriptRows(state, 'session-1').map(row => row.kind)).toEqual([
    'compact-boundary',
    'system-notice',
    'result',
  ])
  expect(selectTranscriptRows(state, 'session-1')).toMatchObject([
    { trigger: 'auto', preTokens: 1234 },
    { noticeType: 'api_retry', content: 'Overloaded' },
    {
      subtype: 'success',
      isError: false,
      result: 'Finished',
      durationMs: 1200,
      totalCostUsd: 0.01,
    },
  ])
})

test('renders a retry notice whether the frame carries copy or a bare code', () => {
  // The engine used to send `error` as a bare classification code, which this
  // projector dropped: every retry notice a transcript recorded before the
  // object form landed was invisible. Replaying one has to produce a notice,
  // and it has to produce readable copy rather than the internal code.
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'system',
      subtype: 'api_retry',
      attempt: 1,
      max_retries: 1,
      retry_delay_ms: 0,
      error: {
        type: 'assistant_error',
        message: 'Connection interrupted. Continuing automatically.',
        error: 'connection_error',
      },
      uuid: '00000000-0000-4000-8000-0000000002d1',
    } as unknown as SDKMessage),
  )
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'system',
      subtype: 'api_retry',
      attempt: 2,
      max_retries: 10,
      retry_delay_ms: 8000,
      error: 'rate_limit',
      uuid: '00000000-0000-4000-8000-0000000002d2',
    } as unknown as SDKMessage),
  )

  const rows = selectTranscriptRows(state, 'session-1')
  expect(rows.map(row => row.kind)).toEqual(['system-notice', 'system-notice'])
  expect(rows).toMatchObject([
    {
      noticeType: 'api_retry',
      content: 'Connection interrupted. Continuing automatically.',
    },
    { noticeType: 'api_retry', content: 'Rate limited. Retrying.' },
  ])

  // The batch path is the one a replayed transcript actually takes, which is
  // the case a bare code comes from. It shares the same helper, and nothing
  // would notice if it stopped.
  const batch = projectServerFrames(createTranscriptState(), [
    ready('session-2'),
    messageFrame('session-2', {
      type: 'system',
      subtype: 'api_retry',
      attempt: 2,
      max_retries: 10,
      retry_delay_ms: 8000,
      error: 'rate_limit',
      uuid: '00000000-0000-4000-8000-0000000002d3',
    } as unknown as SDKMessage),
  ])
  expect(selectTranscriptRows(batch, 'session-2')).toMatchObject([
    { noticeType: 'api_retry', content: 'Rate limited. Retrying.' },
  ])
})

test('replays the full S1 turn grammar end-to-end into a correct transcript', () => {
  // S1 spec §3: system init → api_message (streamed: per-block assistant
  // frames arrive BEFORE their content_block_stop) → tool_result user frame →
  // second api_message (non-streaming fallback, new message id, no stream
  // events) → result. Stream events must be droppable garnish; result is the
  // only turn-end marker.
  const init = SDK_MESSAGE_FIXTURE.system[0]
  const toolResultCarrier = SDK_MESSAGE_FIXTURE.user[1]
  const resultSuccess = SDK_MESSAGE_FIXTURE.result[0]
  if (!init || !toolResultCarrier || !resultSuccess) {
    throw new Error('expected fixture samples missing')
  }

  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  const play = (message: SDKMessage) => {
    state = projectServerFrame(state, messageFrame('session-1', message))
  }

  play(init.message)
  play({
    type: 'stream_event',
    event: { type: 'message_start', message: { id: 'msg_S1' } },
    uuid: '00000000-0000-4000-8000-000000000100',
  })
  play({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    uuid: '00000000-0000-4000-8000-000000000101',
  })
  play({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Reading the config.' },
    },
    uuid: '00000000-0000-4000-8000-000000000102',
  })
  play({
    type: 'assistant',
    message: {
      id: 'msg_S1',
      role: 'assistant',
      content: [{ type: 'text', text: 'Reading the config.' }],
      stop_reason: null,
    },
    parent_tool_use_id: null,
    session_id: 'engine-session-1',
    uuid: '00000000-0000-4000-8000-000000000103',
  })
  play({
    type: 'stream_event',
    event: { type: 'content_block_stop', index: 0 },
    uuid: '00000000-0000-4000-8000-000000000104',
  })
  play({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_S1', name: 'Read', input: '' },
    },
    uuid: '00000000-0000-4000-8000-000000000105',
  })
  play({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"file_path":"/repo/config.json"}' },
    },
    uuid: '00000000-0000-4000-8000-000000000106',
  })
  play({
    type: 'assistant',
    message: {
      id: 'msg_S1',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_S1',
          name: 'Read',
          input: { file_path: '/repo/config.json' },
        },
      ],
      stop_reason: null,
    },
    parent_tool_use_id: null,
    session_id: 'engine-session-1',
    uuid: '00000000-0000-4000-8000-000000000107',
  })
  play({
    type: 'stream_event',
    event: { type: 'content_block_stop', index: 1 },
    uuid: '00000000-0000-4000-8000-000000000108',
  })
  play({
    type: 'stream_event',
    event: {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 61 },
    },
    uuid: '00000000-0000-4000-8000-000000000109',
  })
  play({
    type: 'stream_event',
    event: { type: 'message_stop' },
    uuid: '00000000-0000-4000-8000-00000000010a',
  })
  play(toolResultCarrier.message)
  // Second api_message: idle-watchdog fallback — same content re-arrives as a
  // plain assistant frame under a NEW message id, no stream events (S1 §3
  // rule 4).
  play({
    type: 'assistant',
    message: {
      id: 'msg_S2',
      role: 'assistant',
      content: [{ type: 'text', text: 'The config sets name to cat-code.' }],
      stop_reason: null,
    },
    parent_tool_use_id: null,
    session_id: 'engine-session-1',
    uuid: '00000000-0000-4000-8000-00000000010b',
  })
  play(resultSuccess.message)

  const rows = selectTranscriptRows(state, 'session-1')
  // P4-23: the leading 'session-init' row is gone (banner removed); the init
  // frame still runs (catalog capture) but emits no row.
  expect(rows.map(row => row.kind)).toEqual([
    'assistant-text',
    'tool-use',
    'assistant-text',
    'result',
  ])
  const contentRows = rows.filter(row => 'messageId' in row)
  expect(contentRows.map(row => row.messageId)).toEqual([
    'msg_S1',
    'msg_S1',
    'msg_S2',
  ])
  expect(contentRows.map(row => row.blockIndex)).toEqual([0, 1, 0])
  expect(new Set(rows.map(row => row.id)).size).toBe(4)

  // Duplicate delivery of an already-seen frame (uuid dedupe) is a no-op —
  // replay-buffer double-delivery must not duplicate rows.
  const before = state
  play({
    type: 'assistant',
    message: {
      id: 'msg_S1',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_S1',
          name: 'Read',
          input: { file_path: '/repo/config.json' },
        },
      ],
      stop_reason: null,
    },
    parent_tool_use_id: null,
    session_id: 'engine-session-1',
    uuid: '00000000-0000-4000-8000-000000000107',
  })
  expect(state).toBe(before)
})

/* ─────────────────────────────────────────────────────────────────────────
 * P2-2 tool-card families + tool_use/tool_result correlation.
 * Status is DERIVED (never stored): a ToolCard reads `pending` until its
 * `tool_use_id` gets a correlated result, then `success`/`error` from that
 * result's own signal — never from a stored flag on the row itself.
 * ───────────────────────────────────────────────────────────────────────── */

test('a tool_use row is pending until its tool_result correlates, then resolves to success', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'assistant',
      message: {
        id: 'msg_corr_1',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_corr_1', name: 'Read', input: { file_path: '/a' } },
        ],
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-0000000c0001',
    }),
  )

  const pendingRow = selectTranscriptRows(state, 'session-1')[0]
  expect(pendingRow?.kind).toBe('tool-use')
  if (pendingRow?.kind !== 'tool-use') throw new Error('expected tool-use row')
  expect(pendingRow.status).toBe('pending')
  expect(pendingRow.result).toBeNull()
  expect(pendingRow.toolFamily).toBe('read')

  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_corr_1',
            content: [{ type: 'text', text: 'file contents' }],
            is_error: false,
          },
        ],
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-0000000c0002',
    }),
  )

  const resolvedRow = selectTranscriptRows(state, 'session-1')[0]
  if (resolvedRow?.kind !== 'tool-use') throw new Error('expected tool-use row')
  expect(resolvedRow.status).toBe('success')
  expect(resolvedRow.result).toEqual({
    isError: false,
    content: 'file contents',
    diff: null,
  })
  // The stored row itself was never mutated — only the read-time join changed.
  expect(pendingRow.status).toBe('pending')
})

test('an is_error tool_result resolves the card to the error status', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'assistant',
      message: {
        id: 'msg_corr_2',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_corr_2', name: 'Bash', input: { command: 'exit 1' } },
        ],
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-0000000c0003',
    }),
  )
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_corr_2',
            content: [{ type: 'text', text: 'command failed' }],
            is_error: true,
          },
        ],
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-0000000c0004',
    }),
  )

  const row = selectTranscriptRows(state, 'session-1')[0]
  if (row?.kind !== 'tool-use') throw new Error('expected tool-use row')
  expect(row.status).toBe('error')
  expect(row.result?.isError).toBe(true)
})

test('a redelivered user frame is a total no-op, correlation side effect included', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'assistant',
      message: {
        id: 'msg_dedupe_1',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_dedupe_1', name: 'Read', input: { file_path: '/a' } },
        ],
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-0000000d0001',
    }),
  )
  const userFrame = messageFrame('session-1', {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_dedupe_1',
          content: [{ type: 'text', text: 'file contents' }],
          is_error: false,
        },
        { type: 'text', text: 'now summarize it' },
      ],
    },
    parent_tool_use_id: null,
    uuid: '00000000-0000-4000-8000-0000000d0002',
  })
  state = projectServerFrame(state, userFrame)

  const before = state
  const rowsBefore = selectTranscriptRows(state, 'session-1')
  const nestedBefore = selectNestedTranscriptRows(state, 'session-1')
  const itemsBefore = selectTranscriptDisplayItems(state, 'session-1')

  // Replay-buffer double-delivery of the SAME frame.
  state = projectServerFrame(state, userFrame)

  expect(state).toBe(before)
  expect(selectTranscriptRows(state, 'session-1')).toEqual(rowsBefore)
  // Re-folding would mint a fresh result object under the same id, replacing the
  // session slice; the slice-keyed read caches would then all miss and the whole
  // transcript would re-render for a frame that changed nothing.
  expect(selectNestedTranscriptRows(state, 'session-1')).toBe(nestedBefore)
  expect(selectTranscriptDisplayItems(state, 'session-1')).toBe(itemsBefore)
})

test('a tool_result with no matching tool_use is tolerated (correlated but orphaned, no crash)', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  // No tool_use row was ever projected for this id.
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_never_projected',
            content: [{ type: 'text', text: 'orphaned result' }],
            is_error: false,
          },
        ],
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-0000000c0005',
    }),
  )

  // No row exists to correlate against — the transcript has zero rows, not a crash.
  expect(selectTranscriptRows(state, 'session-1')).toEqual([])
})

test('a tool_result-only user frame is marked seen after correlation', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'assistant',
      message: {
        id: 'tool-parent',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool-only', name: 'Read', input: {} }],
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-0000000d1001',
    }),
  )
  const resultOnly = messageFrame('session-1', {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool-only', content: 'ok' }],
    },
    parent_tool_use_id: null,
    uuid: '00000000-0000-4000-8000-0000000d1002',
  })
  state = projectServerFrame(state, resultOnly)
  const beforeReplay = state
  const replayed = projectServerFrame(state, resultOnly)

  expect(replayed).toBe(beforeReplay)
})

test('a tool_use with no matching tool_result stays pending forever (not a crash, not an error)', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'assistant',
      message: {
        id: 'msg_corr_3',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_never_resolved', name: 'Bash', input: {} },
        ],
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-0000000c0006',
    }),
  )

  const row = selectTranscriptRows(state, 'session-1')[0]
  if (row?.kind !== 'tool-use') throw new Error('expected tool-use row')
  expect(row.status).toBe('pending')
  expect(row.result).toBeNull()
})

test('a server-executed tool (server_tool_use) resolves via a result block riding a LATER assistant frame, no user reply', () => {
  const useSample = SDK_MESSAGE_FIXTURE.assistant.find(sample =>
    sample.name.startsWith('assistant: server_tool_use block'),
  )
  const resultSample = SDK_MESSAGE_FIXTURE.assistant.find(sample =>
    sample.name.startsWith('assistant: web_search_tool_result block'),
  )
  if (!useSample || !resultSample) throw new Error('expected fixture samples missing')

  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(state, messageFrame('session-1', useSample.message))

  const pendingRow = selectTranscriptRows(state, 'session-1')[0]
  if (pendingRow?.kind !== 'tool-use') throw new Error('expected tool-use row')
  expect(pendingRow.status).toBe('pending')
  expect(pendingRow.toolFamily).toBe('web')

  // The result rides a SEPARATE later assistant frame (same message id in
  // this fixture pair), never a `user` frame — no client round-trip exists
  // for server-executed tools.
  state = projectServerFrame(state, messageFrame('session-1', resultSample.message))

  const resolvedRow = selectTranscriptRows(state, 'session-1')[0]
  if (resolvedRow?.kind !== 'tool-use') throw new Error('expected tool-use row')
  expect(resolvedRow.status).toBe('success')
  // Real web_search_tool_result content is web_search_result sources
  // ({title, url, ...}), not text blocks — flattenToolResultContent only
  // keeps type:'text' parts, so this legitimately flattens to empty (F6
  // Phase-4 flag: whether that's acceptable tool-card chrome is undecided).
  expect(resolvedRow.result?.content).toBe('')
})

test('a GenerateImage result and preview merge into one completed image row', () => {
  const toolUseId = 'toolu_generate_image_1'
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'assistant',
      message: {
        id: 'msg_generate_image_1',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: toolUseId,
            name: 'GenerateImage',
            input: {
              prompt: 'A cat typing at a terminal',
              size: '1024x1024',
              quality: 'high',
              output_format: 'png',
            },
          },
        ],
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-0000000c0007',
    }),
  )
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: [{ type: 'text', text: 'Generated image saved' }],
            is_error: false,
          },
        ],
      },
      parent_tool_use_id: null,
      isSynthetic: true,
      tool_use_result: {
        filePath: '/tmp/generated-cat.png',
        model: 'gpt-image-2',
        size: '1024x1024',
        outputFormat: 'png',
        bytes: 4,
      },
      uuid: '00000000-0000-4000-8000-0000000c0008',
    }),
  )
  state = projectServerFrame(state, {
    kind: 'generated-image-preview',
    protocolVersion: 1,
    sessionId: 'session-1',
    toolUseId,
    mediaType: 'image/png',
    data: 'AAAA',
  })

  const row = selectTranscriptRows(state, 'session-1')[0]
  if (row?.kind !== 'tool-use') throw new Error('expected tool-use row')
  expect(row.status).toBe('success')
  expect(row.result?.generatedImage).toEqual({
    filePath: '/tmp/generated-cat.png',
    model: 'gpt-image-2',
    size: '1024x1024',
    outputFormat: 'png',
    bytes: 4,
    preview: { mediaType: 'image/png', data: 'AAAA' },
  })
})

test('GenerateImage previews merge before results and stay isolated by session', () => {
  const toolUseId = 'toolu_shared_generate_image'
  let state = createTranscriptState()
  for (const sessionId of ['session-1', 'session-2']) {
    state = projectServerFrame(state, ready(sessionId))
    state = projectServerFrame(
      state,
      messageFrame(sessionId, {
        type: 'assistant',
        message: {
          id: `msg_${sessionId}_image`,
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: toolUseId,
              name: 'GenerateImage',
              input: { prompt: `image for ${sessionId}` },
            },
          ],
        },
        parent_tool_use_id: null,
        uuid:
          sessionId === 'session-1'
            ? '00000000-0000-4000-8000-0000000c0011'
            : '00000000-0000-4000-8000-0000000c0012',
      }),
    )
    state = projectServerFrame(state, {
      kind: 'generated-image-preview',
      protocolVersion: 1,
      sessionId,
      toolUseId,
      mediaType: 'image/png',
      data: sessionId === 'session-1' ? 'AAAA' : 'BBBB',
    })
  }

  for (const sessionId of ['session-1', 'session-2']) {
    state = projectServerFrame(
      state,
      messageFrame(sessionId, {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: [{ type: 'text', text: 'Generated image saved' }],
              is_error: false,
            },
          ],
        },
        parent_tool_use_id: null,
        isSynthetic: true,
        tool_use_result: {
          filePath: `/tmp/${sessionId}.png`,
          model: 'gpt-image-2',
          size: '1024x1024',
          outputFormat: 'png',
          bytes: 4,
        },
        uuid:
          sessionId === 'session-1'
            ? '00000000-0000-4000-8000-0000000c0013'
            : '00000000-0000-4000-8000-0000000c0014',
      }),
    )
  }

  const first = selectTranscriptRows(state, 'session-1')[0]
  const second = selectTranscriptRows(state, 'session-2')[0]
  if (first?.kind !== 'tool-use' || second?.kind !== 'tool-use') {
    throw new Error('expected tool-use rows')
  }
  expect(first.result?.generatedImage?.preview).toEqual({
    mediaType: 'image/png',
    data: 'AAAA',
  })
  expect(second.result?.generatedImage?.preview).toEqual({
    mediaType: 'image/png',
    data: 'BBBB',
  })
})

test('GenerateImage previews stay isolated by tool-use id within one session', () => {
  const images = [
    {
      toolUseId: 'toolu_generate_first',
      data: 'AAAA',
      suffix: '21',
      path: '/tmp/first.png',
    },
    {
      toolUseId: 'toolu_generate_second',
      data: 'BBBB',
      suffix: '22',
      path: '/tmp/second.png',
    },
  ] as const
  let state = projectServerFrame(createTranscriptState(), ready('session-1'))

  for (const image of images) {
    state = projectServerFrame(
      state,
      messageFrame('session-1', {
        type: 'assistant',
        message: {
          id: `msg_generate_${image.suffix}`,
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: image.toolUseId,
              name: 'GenerateImage',
              input: { prompt: image.toolUseId },
            },
          ],
        },
        parent_tool_use_id: null,
        uuid: `00000000-0000-4000-8000-0000000c00${image.suffix}`,
      }),
    )
    state = projectServerFrame(state, {
      kind: 'generated-image-preview',
      protocolVersion: 1,
      sessionId: 'session-1',
      toolUseId: image.toolUseId,
      mediaType: 'image/png',
      data: image.data,
    })
    state = projectServerFrame(
      state,
      messageFrame('session-1', {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: image.toolUseId,
              content: [{ type: 'text', text: 'Generated image saved' }],
              is_error: false,
            },
          ],
        },
        parent_tool_use_id: null,
        isSynthetic: true,
        tool_use_result: {
          filePath: image.path,
          model: 'gpt-image-2',
          size: '1024x1024',
          outputFormat: 'png',
          bytes: 4,
        },
        uuid: `00000000-0000-4000-8000-0000000d00${image.suffix}`,
      }),
    )
  }

  const rows = selectTranscriptRows(state, 'session-1')
  for (const image of images) {
    const row = rows.find(
      candidate =>
        candidate.kind === 'tool-use' &&
        candidate.toolUseId === image.toolUseId,
    )
    if (row?.kind !== 'tool-use') throw new Error('expected tool-use row')
    expect(row.result?.generatedImage?.preview).toEqual({
      mediaType: 'image/png',
      data: image.data,
    })
  }
})

test('FileEditTool tool_use_result narrows to a DiffView/MultiDiffCard hunk shape', () => {
  const useSample = SDK_MESSAGE_FIXTURE.assistant.find(sample =>
    sample.name.startsWith('assistant: FileEditTool diff result'),
  )
  const resultSample = SDK_MESSAGE_FIXTURE.user.find(sample =>
    sample.name.startsWith('user: FileEditTool tool_result carrying structuredPatch'),
  )
  if (!useSample || !resultSample) throw new Error('expected fixture samples missing')

  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(state, messageFrame('session-1', useSample.message))
  state = projectServerFrame(state, messageFrame('session-1', resultSample.message))

  const row = selectTranscriptRows(state, 'session-1')[0]
  if (row?.kind !== 'tool-use') throw new Error('expected tool-use row')
  expect(row.toolFamily).toBe('edit')
  expect(row.status).toBe('success')
  expect(row.result?.diff).toEqual({
    filePath: '/repo/src/config.ts',
    hunks: [
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        lines: [
          ' export const config = {',
          '-  port: 3000,',
          '+  port: 4000,',
          ' }',
        ],
      },
    ],
  })
})

test('Apply_patch tool_use_result (files[] envelope) narrows to a diff — primary file when many', () => {
  // Current FilePatchTool output shape: `{ files: [{ path, type, firstLine,
  // structuredPatch }] }` (src/tools/FilePatchTool/types.ts, emitted
  // FilePatchTool.tsx) — a MULTI-file envelope, unlike FileEditTool's
  // top-level `filePath`+`structuredPatch`. Whole-file `before`/`after` are no
  // longer written; the legacy test below covers transcripts that still have
  // them. The single-file ToolDiffProjection names one path, so the primary
  // (first file with hunks) is projected.
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'assistant',
      message: {
        id: 'msg_patch_1',
        model: 'claude-sonnet-5',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_patch_1',
            name: 'Apply_patch',
            // FilePatchToolInput `{ input: string }` envelope
            // (src/tools/FilePatchTool/types.ts:125-136), NOT Edit's
            // old_string/new_string.
            input: {
              input:
                '*** Begin Patch\n*** Update File: /repo/src/a.ts\n@@\n export const a = {\n-  x: 1,\n+  x: 2,\n }\n*** Update File: /repo/src/b.ts\n@@\n-const b = false\n+const b = true\n*** End Patch',
            },
          },
        ],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 900, output_tokens: 30, service_tier: null },
      },
      parent_tool_use_id: null,
      session_id: 'session-1',
      uuid: '00000000-0000-4000-8000-0000000c0009',
    }),
  )
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_patch_1',
            content: 'Applied patch to 2 files: /repo/src/a.ts, /repo/src/b.ts',
          },
        ],
      },
      parent_tool_use_id: null,
      isSynthetic: true,
      tool_use_result: {
        files: [
          {
            path: '/repo/src/a.ts',
            type: 'update',
            firstLine: 'export const a = {',
            structuredPatch: [
              {
                oldStart: 1,
                oldLines: 3,
                newStart: 1,
                newLines: 3,
                lines: [' export const a = {', '-  x: 1,', '+  x: 2,', ' }'],
              },
            ],
          },
          {
            path: '/repo/src/b.ts',
            type: 'update',
            firstLine: 'const b = false',
            structuredPatch: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: ['-const b = false', '+const b = true'],
              },
            ],
          },
        ],
      },
      session_id: 'session-1',
      uuid: '00000000-0000-4000-8000-0000000c000a',
    }),
  )

  const row = selectTranscriptRows(state, 'session-1')[0]
  if (row?.kind !== 'tool-use') throw new Error('expected tool-use row')
  expect(row.toolFamily).toBe('edit')
  expect(row.status).toBe('success')
  // Primary (first) file's diff is projected — the Diff section now renders.
  expect(row.result?.diff).toEqual({
    filePath: '/repo/src/a.ts',
    hunks: [
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        lines: [' export const a = {', '-  x: 1,', '+  x: 2,', ' }'],
      },
    ],
  })
  // Every touched path still shows in the result content (nothing hidden).
  expect(row.result?.content).toContain('/repo/src/b.ts')
})

test('legacy Apply_patch result with whole-file before/after still narrows to a diff', () => {
  // Transcripts written before FilePatchTool stopped persisting file contents
  // are still on disk and still resumed, so the projector must keep reading
  // them by `path` + `structuredPatch` and ignore the extra fields.
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'assistant',
      message: {
        id: 'msg_patch_legacy',
        model: 'claude-sonnet-5',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_patch_legacy',
            name: 'Apply_patch',
            input: {
              input:
                '*** Begin Patch\n*** Update File: /repo/src/a.ts\n@@\n export const a = {\n-  x: 1,\n+  x: 2,\n }\n*** End Patch',
            },
          },
        ],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 900, output_tokens: 30, service_tier: null },
      },
      parent_tool_use_id: null,
      session_id: 'session-1',
      uuid: '00000000-0000-4000-8000-0000000c000b',
    }),
  )
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_patch_legacy',
            content: 'Applied patch to 1 file: /repo/src/a.ts',
          },
        ],
      },
      parent_tool_use_id: null,
      isSynthetic: true,
      tool_use_result: {
        files: [
          {
            path: '/repo/src/a.ts',
            type: 'update',
            before: 'export const a = {\n  x: 1,\n}\n',
            after: 'export const a = {\n  x: 2,\n}\n',
            structuredPatch: [
              {
                oldStart: 1,
                oldLines: 3,
                newStart: 1,
                newLines: 3,
                lines: [' export const a = {', '-  x: 1,', '+  x: 2,', ' }'],
              },
            ],
          },
        ],
      },
      session_id: 'session-1',
      uuid: '00000000-0000-4000-8000-0000000c000c',
    }),
  )

  const row = selectTranscriptRows(state, 'session-1')[0]
  if (row?.kind !== 'tool-use') throw new Error('expected tool-use row')
  expect(row.status).toBe('success')
  expect(row.result?.diff).toEqual({
    filePath: '/repo/src/a.ts',
    hunks: [
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        lines: [' export const a = {', '-  x: 1,', '+  x: 2,', ' }'],
      },
    ],
  })
})

/*
 * The RUNNING-name path. The C4 nesting test also asserts this, but a break here
 * should fail a test named for identity rather than one named for nesting, and
 * the absent case below is not covered anywhere else.
 */
test('a nested frame\'s engine-minted agent_name reaches the child row while the agent runs', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  for (const message of AGENT_WITH_NESTED_SUBAGENT_TURN.messages) {
    state = projectServerFrame(state, messageFrame('session-1', message))
  }

  const agent = selectNestedTranscriptRows(state, 'session-1')[0]
  if (agent?.kind !== 'tool-use') throw new Error('expected agent tool-use row')
  const child = agent.children[0]
  if (child?.kind !== 'tool-use') throw new Error('expected nested child tool-use row')
  expect(child.agentName).toBe('Ada')
})

test('a nested frame with no agent_name leaves the child row unnamed, never guessing one', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  for (const message of AGENT_WITH_NESTED_SUBAGENT_TURN.messages) {
    // Same turn with identity stripped: the projector must degrade to no name
    // rather than fall back to the parent's type or the session plane.
    const { agent_name: _dropped, ...withoutName } = message as Record<string, unknown>
    state = projectServerFrame(state, messageFrame('session-1', withoutName as SDKMessage))
  }

  const agent = selectNestedTranscriptRows(state, 'session-1')[0]
  if (agent?.kind !== 'tool-use') throw new Error('expected agent tool-use row')
  const child = agent.children[0]
  if (child?.kind !== 'tool-use') throw new Error('expected nested child tool-use row')
  expect(child.agentName).toBeUndefined()
})

test('an Agent tool_use_result carries the worker name onto the row, @-stripped', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'assistant',
      message: {
        id: 'msg_agent_name',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_agent_name',
            name: 'Task',
            input: { subagent_type: 'Explore', description: 'trace the seam' },
          },
        ],
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-0000000d0001',
    }),
  )
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_agent_name', content: 'done', is_error: false },
        ],
      },
      parent_tool_use_id: null,
      // The real `AgentToolResult` shape (agentToolUtils.ts:727). The engine
      // also spells the name into the model-facing result TEXT; the projector
      // must read this structured field, not that prose.
      tool_use_result: { agentId: 'agent-1', agentType: 'Explore', agentName: ' @Ada ' },
      uuid: '00000000-0000-4000-8000-0000000d0002',
    }),
  )

  const row = selectTranscriptRows(state, 'session-1')[0]
  if (row?.kind !== 'tool-use') throw new Error('expected tool-use row')
  expect(row.result?.agentName).toBe('Ada')
  expect(row.result?.agentId).toBe('agent-1')
})

test('an Agent tool_use_result carries the leased Codex account, or nothing at all', () => {
  const project = (result: unknown) => {
    let state = createTranscriptState()
    state = projectServerFrame(state, ready('session-1'))
    state = projectServerFrame(
      state,
      messageFrame('session-1', {
        type: 'assistant',
        message: {
          id: 'msg_agent_account',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_agent_account',
              name: 'Task',
              input: { subagent_type: 'Explore', description: 'trace the seam' },
            },
          ],
        },
        parent_tool_use_id: null,
        uuid: '00000000-0000-4000-8000-0000000e0001',
      }),
    )
    state = projectServerFrame(
      state,
      messageFrame('session-1', {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_agent_account', content: 'done', is_error: false },
          ],
        },
        parent_tool_use_id: null,
        tool_use_result: result,
        uuid: '00000000-0000-4000-8000-0000000e0002',
      }),
    )
    const row = selectTranscriptRows(state, 'session-1')[0]
    if (row?.kind !== 'tool-use') throw new Error('expected tool-use row')
    return row.result?.agentAccount
  }

  expect(
    project({
      agentId: 'agent-1',
      account: { accountId: 'acct-1', accountAlias: 'onbi' },
    }),
  ).toEqual({ accountId: 'acct-1', accountAlias: 'onbi' })

  // An account the pool cannot name is still a true statement about the run.
  expect(
    project({ agentId: 'agent-1', account: { accountId: 'acct-1' } }),
  ).toEqual({ accountId: 'acct-1', accountAlias: null })

  // Absent for an Anthropic-path worker, and for results recorded before the
  // engine stamped one.
  expect(project({ agentId: 'agent-1' })).toBeUndefined()

  // A foreign shape degrades to absent rather than half-populating the slot.
  expect(project({ agentId: 'agent-1', account: { alias: 'onbi' } })).toBeUndefined()
  expect(project({ agentId: 'agent-1', account: 'onbi' })).toBeUndefined()
})

test('ResumeAgent projects as an independent agent card joined to the original identity and its own completion', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'assistant',
      message: {
        id: 'msg_original_agent',
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'toolu_original_agent',
          name: 'Agent',
          input: { subagent_type: 'Explore', description: 'Summarize the release notes' },
        }],
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-0000000d1001',
    }),
  )
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_original_agent',
          content: 'done',
          is_error: false,
        }],
      },
      parent_tool_use_id: null,
      tool_use_result: {
        agentId: 'agent-1',
        agentName: 'Rue',
        totalTokens: 22400,
        totalToolUseCount: 9,
      },
      uuid: '00000000-0000-4000-8000-0000000d1002',
    }),
  )
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'assistant',
      message: {
        id: 'msg_resume_agent',
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'toolu_resume_agent',
          name: 'ResumeAgent',
          input: {
            agentId: 'agent-1',
            prompt: 'Add the migration guide for the config rename',
          },
        }],
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-0000000d1003',
    }),
  )
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_resume_agent',
          content: '{"success":true,"message":"resumed"}',
          is_error: false,
        }],
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-0000000d1004',
    }),
  )
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'Task notification' }] },
      parent_tool_use_id: null,
      origin: {
        kind: 'task-notification',
        status: 'completed',
        summary: 'Agent @Rue completed',
        toolUseId: 'toolu_resume_agent',
        result: 'The migration guide now covers the rename.',
        usage: { totalTokens: 9500, toolUses: 5, durationMs: 52000 },
      },
      uuid: '00000000-0000-4000-8000-0000000d1005',
    }),
  )

  const rows = selectTranscriptRows(state, 'session-1')
  expect(rows).toHaveLength(2)
  expect(rows[0]).toMatchObject({
    toolUseId: 'toolu_original_agent',
    result: { agentId: 'agent-1', agentName: 'Rue' },
    agentCompletion: null,
  })
  expect(rows[1]).toMatchObject({
    toolUseId: 'toolu_resume_agent',
    toolFamily: 'agent',
    input: { prompt: 'Add the migration guide for the config rename' },
    result: { agentId: 'agent-1', agentName: 'Rue' },
    agentCompletion: {
      result: 'The migration guide now covers the rename.',
      usage: { totalTokens: 9500, toolUses: 5, durationMs: 52000 },
    },
  })
})

test('TaskOutput narrows a local agent clean answer from its structured retrieval result', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'assistant',
      message: {
        id: 'msg_task_output',
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'toolu_task_output',
          name: 'TaskOutput',
          input: { task_id: 'task-1', block: true },
        }],
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-0000000d2001',
    }),
  )
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_task_output',
          content: '<retrieval_status>success</retrieval_status>',
          is_error: false,
        }],
      },
      parent_tool_use_id: null,
      tool_use_result: {
        retrieval_status: 'success',
        task: {
          task_id: 'task-1',
          task_type: 'local_agent',
          status: 'completed',
          description: 'Find every caller of the retry helper',
          output: 'raw fallback',
          result: 'Four callers in the request layer.',
        },
      },
      uuid: '00000000-0000-4000-8000-0000000d2002',
    }),
  )

  const row = selectTranscriptRows(state, 'session-1')[0]
  if (row?.kind !== 'tool-use') throw new Error('expected tool-use row')
  expect(row.result?.taskOutput).toEqual({
    taskId: 'task-1',
    description: 'Find every caller of the retry helper',
    output: 'Four callers in the request layer.',
  })
})

test('a non-Agent tool_use_result leaves agentName absent, never an empty string', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'assistant',
      message: {
        id: 'msg_no_name',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_no_name', name: 'Bash', input: {} }],
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-0000000d0003',
    }),
  )
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_no_name', content: 'ok', is_error: false },
        ],
      },
      parent_tool_use_id: null,
      // A blank name must degrade to absent, so no card renders an empty handle.
      tool_use_result: { agentName: '   ' },
      uuid: '00000000-0000-4000-8000-0000000d0004',
    }),
  )

  const row = selectTranscriptRows(state, 'session-1')[0]
  if (row?.kind !== 'tool-use') throw new Error('expected tool-use row')
  expect(row.result?.agentName).toBeUndefined()
})

test('a foreign/malformed tool_use_result never crashes and yields diff: null', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'assistant',
      message: {
        id: 'msg_corr_4',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_corr_4', name: 'Bash', input: {} }],
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-0000000c0007',
    }),
  )
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_corr_4',
            content: 'plain string stdout, not a content-block array',
            is_error: false,
          },
        ],
      },
      parent_tool_use_id: null,
      // A foreign shape: has a `structuredPatch`-like key but the wrong
      // inner shape, plus no `filePath` — must degrade, never crash or guess.
      tool_use_result: { structuredPatch: 'not an array', unrelated: true },
      uuid: '00000000-0000-4000-8000-0000000c0008',
    }),
  )

  const row = selectTranscriptRows(state, 'session-1')[0]
  if (row?.kind !== 'tool-use') throw new Error('expected tool-use row')
  expect(row.status).toBe('success')
  expect(row.result?.diff).toBeNull()
  expect(row.result?.content).toBe('plain string stdout, not a content-block array')
})

test('D2/C4: subagent tool_use + tool_result nest under the owning agent card, never interleaving at top level', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))

  // Top-level: the orchestrator's own Agent/Task tool_use — the owning card.
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'assistant',
      message: {
        id: 'msg_agent_1',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_01FixTask1', name: 'Agent', input: { prompt: 'find call sites' } },
        ],
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-0000000d0001',
    }),
  )

  // Subagent full frame (P2-0 finding): non-null parent_tool_use_id, a
  // nested Grep tool_use — must NOT appear at top level.
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'assistant',
      message: {
        id: 'msg_agent_2',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_01FixSubGrep1', name: 'Grep', input: { pattern: 'projectServerFrame' } },
        ],
      },
      parent_tool_use_id: 'toolu_01FixTask1',
      uuid: '00000000-0000-4000-8000-0000000d0002',
    }),
  )

  // Subagent tool_result — also carries the non-null parent id (S1 §1 +
  // queryHelpers.ts:141-153, the same subagent progress re-emit path).
  const subagentResultSample = SDK_MESSAGE_FIXTURE.user.find(sample =>
    sample.name.startsWith('user: tool_result for a subagent-scoped tool_use'),
  )
  if (!subagentResultSample) throw new Error('expected fixture sample missing')
  state = projectServerFrame(state, messageFrame('session-1', subagentResultSample.message))

  // Flat selector: both rows present, arrival order, NOT interleaved by any
  // reordering — but both still appear at the same flat level (this selector
  // makes no nesting decision; selectNestedTranscriptRows does).
  const flatRows = selectTranscriptRows(state, 'session-1')
  expect(flatRows.map(r => (r.kind === 'tool-use' ? r.toolUseId : null))).toEqual([
    'toolu_01FixTask1',
    'toolu_01FixSubGrep1',
  ])

  // Nested selector: the subagent row must be a CHILD of the agent card, not
  // a top-level sibling.
  const nested = selectNestedTranscriptRows(state, 'session-1')
  expect(nested).toHaveLength(1)
  const agentRow = nested[0]
  if (agentRow?.kind !== 'tool-use') throw new Error('expected agent tool-use row')
  expect(agentRow.toolUseId).toBe('toolu_01FixTask1')
  expect(agentRow.toolFamily).toBe('agent')
  expect(agentRow.children).toHaveLength(1)
  const childRow = agentRow.children[0]
  if (childRow?.kind !== 'tool-use') throw new Error('expected child tool-use row')
  expect(childRow.toolUseId).toBe('toolu_01FixSubGrep1')
  expect(childRow.parentToolUseId).toBe('toolu_01FixTask1')
  // The subagent's OWN tool_result correlated too — nesting doesn't block
  // correlation, they are independent read-time joins.
  expect(childRow.status).toBe('success')
})

/* ─────────────────────────────────────────────────────────────────────────
 * Orphaned subagent rows. Truncation drops the OLDEST frames first on both
 * retention paths (`app/main/replayBuffer.ts` eviction, `sidecarServer.ts`
 * newest-first replay tail), and an Agent `tool_use` is always older than the
 * children it spawned, so a boundary landing inside an agent run keeps the
 * children and drops the card. Those children must never be promoted to
 * ordinary top-level rows: `user-text` renders as a user bubble and
 * `assistant-text` as the main assistant's reply, so the transcript would
 * attribute a subagent's internal messages to the two participants who did not
 * write them (review 2026-08-19 §4).
 * ───────────────────────────────────────────────────────────────────────── */

function orphanedSubagentSession() {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  // The surviving tail of a subagent run whose Agent `tool_use` fell off the
  // front of the window: the worker's own task prompt, then its prose.
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'user',
      message: { role: 'user', content: 'find every call site' },
      parent_tool_use_id: 'toolu_never_seen',
      agent_name: 'Ada',
      uuid: '00000000-0000-4000-8000-0000000d0003',
    }),
  )
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'assistant',
      message: {
        id: 'msg_orphan_child',
        role: 'assistant',
        content: [{ type: 'text', text: 'orphaned subagent text' }],
      },
      parent_tool_use_id: 'toolu_never_seen',
      agent_name: 'Ada',
      uuid: '00000000-0000-4000-8000-0000000d0004',
    }),
  )
  return state
}

test('a child row whose parent is missing is gathered under an orphaned-agent placeholder, never promoted to top level', () => {
  const state = orphanedSubagentSession()

  // The rows themselves are all still there, flat and in arrival order: the
  // guard is a placement rule, not a filter.
  const flat = selectTranscriptRows(state, 'session-1')
  expect(flat.map(row => row.kind)).toEqual(['user-text', 'assistant-text'])

  const nested = selectNestedTranscriptRows(state, 'session-1')
  expect(nested).toHaveLength(1)
  const placeholder = nested[0]
  if (placeholder?.kind !== 'orphaned-agent') {
    throw new Error('expected an orphaned-agent placeholder')
  }
  expect(placeholder.missingToolUseId).toBe('toolu_never_seen')
  // Identity comes from the orphaned frames themselves; nothing else about the
  // missing card is invented.
  expect(placeholder.agentName).toBe('Ada')
  expect(placeholder.children.map(child => child.kind)).toEqual([
    'user-text',
    'assistant-text',
  ])
  // The point of the guard, stated directly.
  expect(nested.some(row => row.kind === 'user-text')).toBe(false)
  expect(nested.some(row => row.kind === 'assistant-text')).toBe(false)
})

test('the orphaned-agent placeholder holds its position and keeps one group per missing parent', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'user',
      message: { role: 'user', content: 'what the operator actually typed' },
      uuid: '00000000-0000-4000-8000-0000000d0010',
    }),
  )
  for (const [index, parent] of ['toolu_gone_a', 'toolu_gone_b', 'toolu_gone_a'].entries()) {
    state = projectServerFrame(
      state,
      messageFrame('session-1', {
        type: 'assistant',
        message: {
          id: `msg_orphan_${index}`,
          role: 'assistant',
          content: [{ type: 'text', text: `orphan ${index}` }],
        },
        parent_tool_use_id: parent,
        uuid: `00000000-0000-4000-8000-0000000d001${index + 1}`,
      }),
    )
  }

  const nested = selectNestedTranscriptRows(state, 'session-1')
  // The operator's own message stays exactly where it was; each missing parent
  // gets ONE placeholder, emitted where its first surviving child arrived.
  expect(nested.map(row => row.kind)).toEqual([
    'user-text',
    'orphaned-agent',
    'orphaned-agent',
  ])
  const first = nested[1]
  const second = nested[2]
  if (first?.kind !== 'orphaned-agent' || second?.kind !== 'orphaned-agent') {
    throw new Error('expected two orphaned-agent placeholders')
  }
  expect(first.missingToolUseId).toBe('toolu_gone_a')
  expect(first.children).toHaveLength(2)
  expect(second.missingToolUseId).toBe('toolu_gone_b')
  expect(second.children).toHaveLength(1)
  expect(first.id).not.toBe(second.id)
})

test('a grandchild arriving under a nested agent reaches the tree, and unchanged branches keep their identity', () => {
  // The nesting caches key on a row's SOURCE object and that object survives
  // untouched when a row arrives BELOW it, so a cache that only compared direct
  // children served a stale subtree: an agent running inside an agent had its
  // frames filed under a parent that never showed them.
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'assistant',
      message: {
        id: 'msg_outer',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_outer_agent',
            name: 'Agent',
            input: { subagent_type: 'general-purpose', prompt: 'delegate' },
          },
        ],
      },
      uuid: '00000000-0000-4000-8000-0000000d0030',
    }),
  )
  // The outer worker spawns its own agent: a tool_use row that is a CHILD here
  // and a parent one level down.
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'assistant',
      message: {
        id: 'msg_inner',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_inner_agent',
            name: 'Agent',
            input: { subagent_type: 'general-purpose', prompt: 'sub-delegate' },
          },
        ],
      },
      parent_tool_use_id: 'toolu_outer_agent',
      uuid: '00000000-0000-4000-8000-0000000d0031',
    }),
  )

  // Read once so both levels are cached before the deep frame arrives.
  const before = selectNestedTranscriptRows(state, 'session-1')
  const outerBefore = before[0]
  if (outerBefore?.kind !== 'tool-use') throw new Error('expected the outer agent row')
  expect(outerBefore.children).toHaveLength(1)
  expect(outerBefore.children[0]?.children).toEqual([])

  // The grandchild. Nothing above it changes: `selectTranscriptRows` hands back
  // the same source objects for both agent rows.
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'assistant',
      message: {
        id: 'msg_grandchild',
        role: 'assistant',
        content: [{ type: 'text', text: 'the inner worker reporting' }],
      },
      parent_tool_use_id: 'toolu_inner_agent',
      uuid: '00000000-0000-4000-8000-0000000d0032',
    }),
  )

  const after = selectNestedTranscriptRows(state, 'session-1')
  const outerAfter = after[0]
  if (outerAfter?.kind !== 'tool-use') throw new Error('expected the outer agent row')
  const innerAfter = outerAfter.children[0]
  expect(innerAfter?.children).toHaveLength(1)
  const grandchild = innerAfter?.children[0]
  if (grandchild?.kind !== 'assistant-text') throw new Error('expected the grandchild row')
  expect(grandchild.content).toBe('the inner worker reporting')
  // A change deep in one branch rebuilds only that branch's spine.
  expect(outerAfter).not.toBe(outerBefore)
})

test('an untouched branch keeps its whole subtree identity across an unrelated frame', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'assistant',
      message: {
        id: 'msg_agent',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_settled_agent',
            name: 'Agent',
            input: { subagent_type: 'general-purpose', prompt: 'delegate' },
          },
        ],
      },
      uuid: '00000000-0000-4000-8000-0000000d0040',
    }),
  )
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'assistant',
      message: {
        id: 'msg_agent_child',
        role: 'assistant',
        content: [{ type: 'text', text: 'worker prose' }],
      },
      parent_tool_use_id: 'toolu_settled_agent',
      uuid: '00000000-0000-4000-8000-0000000d0041',
    }),
  )
  const before = selectNestedTranscriptRows(state, 'session-1')[0]

  // An unrelated top-level turn invalidates the slice cache, so this exercises
  // the per-row cache: the memoized `TranscriptView` rows must not re-render
  // just because something else in the transcript moved.
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'user',
      message: { role: 'user', content: 'an unrelated operator turn' },
      uuid: '00000000-0000-4000-8000-0000000d0042',
    }),
  )

  expect(selectNestedTranscriptRows(state, 'session-1')[0]).toBe(before)
})

test('an orphaned-agent placeholder built entirely from hidden rows reads as hidden itself', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'user',
      message: { role: 'user', content: 'engine bookkeeping inside a worker' },
      parent_tool_use_id: 'toolu_never_seen',
      isSynthetic: true,
      uuid: '00000000-0000-4000-8000-0000000d0020',
    }),
  )

  // Default view: the hidden tier is filtered BEFORE nesting, so nothing is
  // orphaned and no placeholder forms at all.
  expect(selectNestedTranscriptRows(state, 'session-1')).toEqual([])

  // Revealed view: the placeholder exists, and P4-36 requires it to read dimmed
  // like the traffic it holds. The wrapper is a fresh object, so it has to be
  // marked deliberately.
  const revealed = selectNestedTranscriptRows(state, 'session-1', true)
  expect(revealed).toHaveLength(1)
  expect(revealed[0]?.kind).toBe('orphaned-agent')
  expect(revealed[0]?.isHidden).toBe(true)
})

test('an orphaned-agent placeholder keeps its identity while its own rows are unchanged', () => {
  let state = orphanedSubagentSession()
  const before = selectNestedTranscriptRows(state, 'session-1')[0]

  // An unrelated later frame invalidates the slice cache, so this exercises the
  // per-group cache rather than the per-slice one.
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'user',
      message: { role: 'user', content: 'a real operator turn' },
      uuid: '00000000-0000-4000-8000-0000000d0005',
    }),
  )

  const after = selectNestedTranscriptRows(state, 'session-1')
  expect(after).toHaveLength(2)
  expect(after[0]).toBe(before)
})

/* ─────────────────────────────────────────────────────────────────────────
 * D2/§3/C3 DelegateGroup: parallel agents launched together (same message.id)
 * coalesce into ONE agent-group display item — a pure read-time derivation
 * (`groupAgentDelegates`), never a new frame or message type. The grouping key
 * matches the engine's own second pass (`src/utils/groupToolUses.ts:76`).
 * ───────────────────────────────────────────────────────────────────────── */

test('DelegateGroup: two parallel Agent tool_uses (same message.id) coalesce into one agent-group item', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  for (const message of PARALLEL_AGENTS_TURN.messages) {
    state = projectServerFrame(state, messageFrame('session-1', message))
  }

  // Both agents are distinct top-level rows in arrival order (no interleave).
  const nested = selectNestedTranscriptRows(state, 'session-1')
  expect(nested.map(r => (r.kind === 'tool-use' ? r.toolUseId : null))).toEqual([
    PARALLEL_AGENTS_TURN.toolUseIds[0],
    PARALLEL_AGENTS_TURN.toolUseIds[1],
  ])

  // The derivation groups them into a single agent-group display item.
  const items = selectTranscriptDisplayItems(state, 'session-1')
  expect(items).toHaveLength(1)
  const group = items[0]
  if (group?.kind !== 'agent-group') throw new Error('expected an agent-group item')
  expect(group.groupKey).toBe(`${PARALLEL_AGENTS_TURN.sharedMessageId}:Agent`)
  expect(group.members.map(m => m.toolUseId)).toEqual([
    PARALLEL_AGENTS_TURN.toolUseIds[0],
    PARALLEL_AGENTS_TURN.toolUseIds[1],
  ])
})

test('DelegateGroup: a lone Agent tool_use is a single item, never grouped', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'assistant',
      message: {
        id: 'msg_solo_agent',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_solo_agent',
            name: 'Agent',
            input: { subagent_type: 'Explore', description: 'look around' },
          },
        ],
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-0000008cf001',
    }),
  )

  const items = selectTranscriptDisplayItems(state, 'session-1')
  expect(items).toHaveLength(1)
  expect(items[0]?.kind).toBe('single')
})

test('C4: an Agent tool_use with a nested subagent stays ONE single display item whose card owns the child', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  for (const message of AGENT_WITH_NESTED_SUBAGENT_TURN.messages) {
    state = projectServerFrame(state, messageFrame('session-1', message))
  }

  // C4 nesting: the subagent Grep row is a CHILD of the Agent card, not a sibling.
  const nested = selectNestedTranscriptRows(state, 'session-1')
  expect(nested).toHaveLength(1)
  const agentRow = nested[0]
  if (agentRow?.kind !== 'tool-use') throw new Error('expected agent tool-use row')
  expect(agentRow.toolFamily).toBe('agent')
  expect(agentRow.toolUseId).toBe(AGENT_WITH_NESTED_SUBAGENT_TURN.parentToolUseId)
  expect(agentRow.children).toHaveLength(1)
  const child = agentRow.children[0]
  if (child?.kind !== 'tool-use') throw new Error('expected nested child tool-use row')
  expect(child.toolUseId).toBe(AGENT_WITH_NESTED_SUBAGENT_TURN.childToolUseId)
  expect(child.parentToolUseId).toBe(AGENT_WITH_NESTED_SUBAGENT_TURN.parentToolUseId)
  expect(child.agentName).toBe('Ada')
  // The nested subagent's own tool_result correlated too (read-time join).
  expect(child.status).toBe('success')

  // A lone agent (one member) is a single item, NOT a group; its child never
  // surfaces as a sibling top-level display item.
  const items = selectTranscriptDisplayItems(state, 'session-1')
  expect(items).toHaveLength(1)
  expect(items[0]?.kind).toBe('single')
})

test('groupAgentDelegates never groups non-agent rows and is a stable passthrough for singles', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  // Two Read tool_uses in one message.id — a groupable-by-position pair, but
  // Read has no grouped renderer (only AgentTool does), so they stay singles.
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'assistant',
      message: {
        id: 'msg_reads',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_read_a', name: 'Read', input: { file_path: '/a' } }],
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-0000008cf101',
    }),
  )
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'assistant',
      message: {
        id: 'msg_reads',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_read_b', name: 'Read', input: { file_path: '/b' } }],
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-0000008cf102',
    }),
  )

  const rows = selectNestedTranscriptRows(state, 'session-1')
  const items = groupAgentDelegates(rows)
  expect(items).toHaveLength(2)
  expect(items.every(item => item.kind === 'single')).toBe(true)
  // Slice-stable: same input array → identity-equal output (memo-friendly).
  expect(groupAgentDelegates(rows)).toBe(items)
})

/* ─────────────────────────────────────────────────────────────────────────
 * S1 §4 stop_reason/usage trap: assistant frames always serialize
 * `stop_reason: null` (the engine's post-serialize write-back never reaches
 * the renderer). The projector must never surface stop_reason/usage off an
 * assistant frame — the ONLY real sources are the `message_delta` stream
 * event and the terminal `result` frame. This test proves the projector
 * holds that line: even though every assistant sample below LITERALLY
 * CARRIES `stop_reason: null` (a truthy null, not absent), no row anywhere
 * in this file's type or any correlation output exposes a stop_reason/usage
 * field pulled from an assistant frame — TranscriptRow has no such field,
 * and the real values are asserted to live on the message_delta/result
 * frames themselves, never copied onto a row.
 * ───────────────────────────────────────────────────────────────────────── */

test('S1 §4: stop_reason/usage are never read off an assistant frame — only message_delta and result carry them', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))

  // Every real mint site serializes assistant frames with stop_reason:null
  // (S1 §4) — confirm the fixture's own samples model this trap faithfully,
  // then confirm no row ever surfaces a stop_reason/usage value from them.
  for (const sample of SDK_MESSAGE_FIXTURE.assistant) {
    const body = sample.message.message
    if (body && typeof body === 'object' && 'stop_reason' in body) {
      expect(body.stop_reason).toBeNull()
    }
  }

  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'assistant',
      message: {
        id: 'msg_trap_1',
        role: 'assistant',
        content: [{ type: 'text', text: 'about to call a tool' }],
        // A real assistant frame literally carries this — the trap.
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 2 },
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-0000000e0001',
    }),
  )

  const row = selectTranscriptRows(state, 'session-1')[0]
  // The row type structurally has no stop_reason/usage field to leak one
  // into — this assertion would fail to compile (not just fail at runtime)
  // if a future edit ever added one without sourcing it from message_delta
  // or result, since TranscriptRow is a closed, explicit union.
  expect(row).not.toHaveProperty('stop_reason')
  expect(row).not.toHaveProperty('usage')

  // The message_delta stream event is the ONLY event carrying the real
  // stop_reason for this message — the projector tracks stream position off
  // it (S1 grouping) but still never promotes stop_reason onto a row.
  const messageDeltaSample = SDK_MESSAGE_FIXTURE.stream_event.find(sample =>
    sample.name.startsWith('stream_event: message_delta'),
  )
  if (!messageDeltaSample) throw new Error('expected fixture sample missing')
  const event = messageDeltaSample.message.event
  expect(event && typeof event === 'object' && 'delta' in event).toBe(true)

  const before = selectTranscriptRows(state, 'session-1')
  state = projectServerFrame(state, messageFrame('session-1', messageDeltaSample.message))
  // Confirmed droppable garnish (S1 §3 rule 5): no row set changes at all,
  // let alone one gaining a stop_reason/usage field from it.
  expect(selectTranscriptRows(state, 'session-1')).toEqual(before)

  // The result frame is the other (and ONLY other) real source — turn
  // totals live there (S1 §3 rule 3), never promoted onto a transcript row.
  const resultSample = SDK_MESSAGE_FIXTURE.result.find(
    sample => sample.name.startsWith('result: success'),
  )
  if (!resultSample) throw new Error('expected fixture sample missing')
  expect(resultSample.message).toHaveProperty('stop_reason')
  expect(resultSample.message).toHaveProperty('usage')
  const beforeResult = selectTranscriptRows(state, 'session-1')
  state = projectServerFrame(state, messageFrame('session-1', resultSample.message))
  // P2-1 projects the result boundary, but stop_reason/usage remain source
  // facts and are never copied onto either existing content or the ResultRow.
  const afterResult = selectTranscriptRows(state, 'session-1')
  expect(afterResult.slice(0, beforeResult.length)).toEqual(beforeResult)
  expect(afterResult.at(-1)).toMatchObject({ kind: 'result' })
  expect(afterResult.at(-1)).not.toHaveProperty('stop_reason')
  expect(afterResult.at(-1)).not.toHaveProperty('usage')
})

/* ── P4-36 hidden tier ──────────────────────────────────────────────────────
 * The engine keeps `isMeta`/`isVisibleInTranscriptOnly` user messages out of the
 * default transcript (`shouldShowUserMessage`, src/utils/messages.ts:4823) and
 * the sidecar forwards that as ONE flag, `isSynthetic`
 * (src/utils/messages/mappers.ts:203). The projector used to DISCARD those
 * frames outright, which left a reveal control with nothing to reveal. */

/** Frame uuids are UUID-shaped at the type level, so these are real uuid strings. */
const HIDDEN = {
  first: '00000000-0000-4000-8000-0000000036a1',
  hidden: '00000000-0000-4000-8000-0000000036b2',
  second: '00000000-0000-4000-8000-0000000036c3',
  toolUse: '00000000-0000-4000-8000-0000000036d4',
  carrier: '00000000-0000-4000-8000-0000000036e5',
  resultOnly: '00000000-0000-4000-8000-0000000036f6',
} as const

function userTextFrame(
  uuid: `${string}-${string}-${string}-${string}-${string}`,
  text: string,
  isSynthetic?: true,
) {
  return messageFrame('session-1', {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    session_id: 'session-1',
    uuid,
    ...(isSynthetic === undefined ? {} : { isSynthetic }),
  })
}

test('hidden tier: a synthetic user frame is retained and revealed IN PLACE', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(state, userTextFrame(HIDDEN.first, 'first real turn'))
  state = projectServerFrame(
    state,
    userTextFrame(HIDDEN.hidden, '<system-reminder>budget</system-reminder>', true),
  )
  state = projectServerFrame(state, userTextFrame(HIDDEN.second, 'second real turn'))

  // Default view is EXACTLY what it was before retention existed.
  const visible = selectTranscriptRows(state, 'session-1')
  expect(visible.map(row => row.frameId)).toEqual([HIDDEN.first, HIDDEN.second])
  expect(visible.every(row => row.isHidden === undefined)).toBe(true)

  // Revealed view restores the row to its ARRIVAL position (not appended at the
  // end), which is only possible because it was stored, not re-derived.
  const revealed = selectTranscriptRows(state, 'session-1', true)
  expect(revealed.map(row => row.frameId)).toEqual([HIDDEN.first, HIDDEN.hidden, HIDDEN.second])
  expect(revealed.map(row => row.isHidden)).toEqual([undefined, true, undefined])
  expect(revealed[1]).toMatchObject({
    kind: 'user-text',
    content: '<system-reminder>budget</system-reminder>',
  })
  expect(selectHasHiddenRows(state, 'session-1')).toBe(true)
})

test('hidden tier: the mark is READ-TIME ONLY, never stored on a row', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    userTextFrame(HIDDEN.hidden, 'engine bookkeeping', true),
  )
  // Reading the revealed view first must not leak the mark into the default one.
  expect(selectTranscriptRows(state, 'session-1', true)[0]?.isHidden).toBe(true)
  expect(selectTranscriptRows(state, 'session-1')).toEqual([])
  expect(selectTranscriptRows(state, 'session-1', true)[0]?.isHidden).toBe(true)
})

test('hidden tier: absent by default, so no session grows an empty reveal', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(state, userTextFrame(HIDDEN.first, 'ordinary turn'))
  expect(selectHasHiddenRows(state, 'session-1')).toBe(false)
  expect(selectHasHiddenRows(state, 'session-missing')).toBe(false)
  expect(selectHasHiddenRows(state, null)).toBe(false)
  // No hidden frames ⇒ the revealed read matches the default one (the selector
  // skips both branches).
  expect(selectTranscriptRows(state, 'session-1', true)).toEqual(
    selectTranscriptRows(state, 'session-1'),
  )
})

test('hidden tier: a synthetic frame correlates its tool_result EXACTLY ONCE', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'assistant',
      message: {
        id: 'msg_hidden_corr',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_hidden', name: 'Read', input: {} },
        ],
      },
      parent_tool_use_id: null,
      session_id: 'session-1',
      uuid: HIDDEN.toolUse,
    }),
  )
  expect(selectTranscriptRows(state, 'session-1')[0]).toMatchObject({
    kind: 'tool-use',
    status: 'pending',
  })

  // ONE frame that is BOTH hidden AND a result carrier: exactly the shape the
  // ordering comment above `correlateToolResults` protects.
  const hiddenCarrier = messageFrame('session-1', {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_hidden',
          content: 'file contents',
        },
        { type: 'text', text: 'Caveat: local command output follows' },
      ],
    },
    parent_tool_use_id: null,
    session_id: 'session-1',
    uuid: HIDDEN.carrier,
    isSynthetic: true,
  })

  state = projectServerFrame(state, hiddenCarrier)
  const afterFirst = selectTranscriptRows(state, 'session-1')
  expect(afterFirst[0]).toMatchObject({ kind: 'tool-use', status: 'success' })
  // Its text row is retained but hidden, and the tool_result block still
  // projects no row of its own.
  expect(afterFirst).toHaveLength(1)
  expect(selectTranscriptRows(state, 'session-1', true)).toHaveLength(2)

  // Replay: dedupe now covers this frame (retention marks `seenFrameIds`), so
  // the whole projection is a total no-op and the correlation CANNOT re-fold.
  // Re-folding would mint a fresh ToolResultProjection and force every read to
  // clone its tool-use rows.
  const replayed = projectServerFrame(state, hiddenCarrier)
  expect(replayed).toBe(state)
  expect(selectTranscriptRows(replayed, 'session-1', true)).toEqual(
    selectTranscriptRows(state, 'session-1', true),
  )
})

test('hidden tier: a tool_result-only synthetic frame correlates and reveals nothing', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'assistant',
      message: {
        id: 'msg_hidden_only',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_only', name: 'Bash', input: {} },
        ],
      },
      parent_tool_use_id: null,
      session_id: 'session-1',
      uuid: HIDDEN.toolUse,
    }),
  )
  state = projectServerFrame(
    state,
    messageFrame('session-1', {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_only', content: 'ok' },
        ],
      },
      parent_tool_use_id: null,
      session_id: 'session-1',
      uuid: HIDDEN.resultOnly,
      isSynthetic: true,
    }),
  )
  expect(selectTranscriptRows(state, 'session-1')[0]).toMatchObject({
    kind: 'tool-use',
    status: 'success',
  })
  // No visible row ⇒ no hidden row either: the reveal control must not appear
  // for a frame that has nothing to show.
  expect(selectHasHiddenRows(state, 'session-1')).toBe(false)
  expect(selectTranscriptRows(state, 'session-1', true)).toHaveLength(1)
})

test('hidden tier: the two views cache separately and each stays identity-stable', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(state, userTextFrame(HIDDEN.first, 'ordinary turn'))
  state = projectServerFrame(
    state,
    userTextFrame(HIDDEN.hidden, 'engine bookkeeping', true),
  )

  const defaultRows = selectNestedTranscriptRows(state, 'session-1')
  const revealedRows = selectNestedTranscriptRows(state, 'session-1', true)
  // Slice-stable per view (memoized consumers keep identity across unrelated
  // re-renders) and never the SAME array — one shared cache line would serve the
  // wrong view the moment the toggle flips.
  expect(selectNestedTranscriptRows(state, 'session-1')).toBe(defaultRows)
  expect(selectNestedTranscriptRows(state, 'session-1', true)).toBe(revealedRows)
  expect(revealedRows).not.toBe(defaultRows)
  expect(defaultRows).toHaveLength(1)
  expect(revealedRows).toHaveLength(2)
  // The grouping pass rides the same array identity, so display items stay
  // stable per view too.
  expect(selectTranscriptDisplayItems(state, 'session-1', true)).toBe(
    selectTranscriptDisplayItems(state, 'session-1', true),
  )
})

/* ── slash-command replay identity (bug, 2026-08-08) ───────────────────────
 * A sidecar broadcasts a live echo of the raw prompt, then persists the
 * EXPANDED `<command-name>` breadcrumb. Both must carry the submitted uuid
 * (src/utils/processUserInput/processSlashCommand.tsx `case 'local'`), because
 * replay dedupe here is uuid-keyed and nothing else links the two shapes. When
 * the breadcrumb minted its own uuid, an in-run sidecar restart replayed it as
 * a second `/compact` row. The fix is at the producer: no assertion below
 * correlates on CONTENT, and none should be added — see
 * docs/migration/reviews/2026-08-08-slash-command-replay-duplicate.md. */

const SLASH_UUID = '00000000-0000-4000-8000-0000000009f1'
const SLASH_BREADCRUMB =
  '<command-name>/compact</command-name>\n' +
  '<command-message>compact</command-message>\n' +
  '<command-args></command-args>'

function slashFrame(content: string, uuid: string, replay?: true) {
  const raw = JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    uuid,
  })
  return {
    ...messageFrame('session-1', JSON.parse(raw) as SDKMessage),
    ...(replay ? { replay: true as const } : {}),
  }
}

test('a replayed slash breadcrumb sharing the submit uuid does not add a row', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  // Live: the sidecar's echo of what the operator typed.
  state = projectServerFrame(state, slashFrame('/compact', SLASH_UUID))
  // Restore: the same command, now as the persisted expanded breadcrumb.
  state = projectServerFrame(
    state,
    slashFrame(SLASH_BREADCRUMB, SLASH_UUID, true),
  )
  // Its output row is separately identified and must survive the dedupe.
  // Deliberately NOT `/compact`'s own stdout: that one preamble is dropped on
  // purpose now (`stripCompactionEcho`), and this test is about uuid-keyed
  // replay, not about which commands print something.
  state = projectServerFrame(
    state,
    slashFrame(
      '<local-command-stdout>Total cost: $0.42</local-command-stdout>',
      '00000000-0000-4000-8000-0000000009f2',
      true,
    ),
  )

  const rows = selectTranscriptRows(state, 'session-1')
  expect(rows.filter(row => row.kind === 'user-text')).toHaveLength(1)
  expect(rows[0]).toMatchObject({ kind: 'user-text', content: '/compact' })
  expect(rows[1]).toMatchObject({ noticeType: 'local_command_output' })
  expect(rows).toHaveLength(2)
})

test('a breadcrumb under a FRESH uuid duplicates — the defect the producer owns', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(state, slashFrame('/compact', SLASH_UUID))
  state = projectServerFrame(
    state,
    slashFrame(SLASH_BREADCRUMB, '00000000-0000-4000-8000-0000000009f3', true),
  )

  // Two rows that both READ `/compact` — the reported symptom. They are not the
  // same kind (the live echo is user text, the breadcrumb is a command echo),
  // which is precisely why no consumer-side rule can collapse them. This is
  // CORRECT behaviour for a uuid-keyed dedupe handed two distinct identities.
  const rows = selectTranscriptRows(state, 'session-1')
  expect(rows).toHaveLength(2)
  expect(rows.map(row => row.kind)).toEqual(['user-text', 'command-echo'])
  expect(
    rows.every(row => 'content' in row && row.content === '/compact'),
  ).toBe(true)
})

/* ── the retention boundary at the top of an incomplete transcript ── */

function truncationFrame(sessionId: string, requestId: string) {
  return {
    kind: 'error' as const,
    protocolVersion: 1 as const,
    sessionId,
    requestId,
    code: 'internal_error' as const,
    message: 'Only the 2 most recent messages are shown.',
    retryable: false,
  }
}

function assistantFrame(sessionId: string, index: number) {
  return messageFrame(sessionId, {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: `body ${index}` }],
    },
    parent_tool_use_id: null,
    uuid: `00000000-0000-4000-8000-0000000ab0${index}`,
  } as unknown as SDKMessage)
}

/**
 * The defect this pins (2026-08-19 review, finding 1): both boundary frames
 * were minted end to end and both were dropped before display, so a pane whose
 * history had been cut opened mid-conversation with no cue that anything was
 * missing.
 */
test('a truncation frame yields exactly one boundary row, above the oldest message', () => {
  for (const requestId of [
    'catcode.replay-truncated',
    'catcode.history-truncated',
  ]) {
    let state = createTranscriptState()
    state = projectServerFrame(state, ready('session-1'))
    state = projectServerFrame(state, truncationFrame('session-1', requestId))
    state = projectServerFrame(state, assistantFrame('session-1', 1))
    state = projectServerFrame(state, assistantFrame('session-1', 2))

    const rows = selectNestedTranscriptRows(state, 'session-1')
    expect(rows.map(row => row.kind)).toEqual([
      'history-boundary',
      'assistant-text',
      'assistant-text',
    ])
    // Read-time only: nothing was stored, so the message rows are untouched.
    expect(selectTranscriptRows(state, 'session-1')).toHaveLength(2)
  }
})

test('a pane carrying BOTH boundary frames still draws exactly one row', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    truncationFrame('session-1', 'catcode.replay-truncated'),
  )
  state = projectServerFrame(
    state,
    truncationFrame('session-1', 'catcode.history-truncated'),
  )
  state = projectServerFrame(state, assistantFrame('session-1', 1))

  expect(
    selectNestedTranscriptRows(state, 'session-1').filter(
      row => row.kind === 'history-boundary',
    ),
  ).toHaveLength(1)
})

test('a complete transcript draws no boundary row, and no ordinary error mints one', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(state, assistantFrame('session-1', 1))
  expect(
    selectNestedTranscriptRows(state, 'session-1').map(row => row.kind),
  ).toEqual(['assistant-text'])

  // A live failure is the error line's business. Projecting it as transcript
  // would write a transient condition into permanent history.
  const before = state
  state = projectServerFrame(state, {
    kind: 'error' as const,
    protocolVersion: 1 as const,
    sessionId: 'session-1',
    requestId: 'req-1',
    code: 'internal_error' as const,
    message: 'something went wrong',
    retryable: false,
  })
  expect(state).toBe(before)
  expect(
    selectNestedTranscriptRows(state, 'session-1').map(row => row.kind),
  ).toEqual(['assistant-text'])
})

test('a truncated session with no surviving row draws nothing at all', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    truncationFrame('session-1', 'catcode.history-truncated'),
  )
  // The pane owes the reader its welcome/restore state here, not a hairline
  // over messages that are not on screen to be missing from.
  expect(selectNestedTranscriptRows(state, 'session-1')).toEqual([])
})

test('the boundary row keeps its identity while the oldest surviving row is unchanged', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    truncationFrame('session-1', 'catcode.replay-truncated'),
  )
  state = projectServerFrame(state, assistantFrame('session-1', 1))
  const first = selectNestedTranscriptRows(state, 'session-1')[0]

  state = projectServerFrame(state, assistantFrame('session-1', 2))
  const second = selectNestedTranscriptRows(state, 'session-1')[0]

  expect(second).toBe(first)
})

/* ── an Agent card whose branch did not survive the restore ──────────────── */

/**
 * The defect this pins (2026-08-19 review, finding 5): a restored session loads
 * subagent branches only into the room its main transcript left over, so a long
 * session's Agent cards come back correct in every visible detail and completely
 * empty — indistinguishable from an agent that ran and produced nothing.
 */
function agentSpawnFrame(
  sessionId: string,
  toolUseId: string,
  input: Record<string, unknown> = {
    subagent_type: 'Explore',
    description: 'Find the owner files',
  },
) {
  return messageFrame(sessionId, {
    type: 'assistant',
    message: {
      id: `msg-${toolUseId}`,
      content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input }],
    },
    parent_tool_use_id: null,
    uuid: `00000000-0000-4000-8000-00000000a${toolUseId.slice(-3)}`,
  } as unknown as SDKMessage)
}

function agentResultFrame(
  sessionId: string,
  toolUseId: string,
  isError = false,
) {
  return messageFrame(sessionId, {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: 'the agent answered',
          ...(isError ? { is_error: true } : {}),
        },
      ],
    },
    parent_tool_use_id: null,
    uuid: `00000000-0000-4000-8000-00000000b${toolUseId.slice(-3)}`,
  } as unknown as SDKMessage)
}

/** One step of a live agent run, nested under its card by `parent_tool_use_id`. */
function agentChildFrame(
  sessionId: string,
  toolUseId: string,
  index: number,
  isSynthetic = false,
) {
  return messageFrame(sessionId, {
    type: 'user',
    message: { role: 'user', content: `step ${index}` },
    parent_tool_use_id: toolUseId,
    agent_name: 'Ada',
    uuid: `00000000-0000-4000-8000-00000000c${toolUseId.slice(-2)}${index}`,
    ...(isSynthetic ? { isSynthetic: true } : {}),
  } as unknown as SDKMessage)
}

function restoredAgentState(
  spawn: ReturnType<typeof agentSpawnFrame>,
  ...rest: ReturnType<typeof messageFrame>[]
) {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    truncationFrame('session-1', 'catcode.history-truncated'),
  )
  state = projectServerFrame(state, spawn)
  for (const frame of rest) state = projectServerFrame(state, frame)
  return state
}

function agentRow(state: ReturnType<typeof createTranscriptState>) {
  return selectNestedTranscriptRows(state, 'session-1').find(
    row => row.kind === 'tool-use',
  )
}

test('a restored Agent card that answered with no steps beneath it says so', () => {
  const state = restoredAgentState(
    agentSpawnFrame('session-1', 'toolu_agent_1'),
    agentResultFrame('session-1', 'toolu_agent_1'),
  )
  const row = agentRow(state)
  expect(row).toMatchObject({ kind: 'tool-use', stepsNotLoaded: true })
  expect(row?.children).toEqual([])
  // Read-time only: the stored row is untouched, exactly as the boundary row is.
  expect(
    selectTranscriptRows(state, 'session-1').every(
      stored => !('stepsNotLoaded' in stored),
    ),
  ).toBe(true)
})

test('a LIVE agent run in the same incomplete pane is never labelled', () => {
  // The false positive that would matter most: this agent really ran here, and
  // its own steps are on screen under it.
  const state = restoredAgentState(
    agentSpawnFrame('session-1', 'toolu_agent_1'),
    agentChildFrame('session-1', 'toolu_agent_1', 1),
    agentResultFrame('session-1', 'toolu_agent_1'),
  )
  const row = agentRow(state)
  expect(row?.stepsNotLoaded).toBeUndefined()
  expect(row?.children).toHaveLength(1)
})

test('an agent whose every step is hidden-tier traffic is never labelled', () => {
  // Its steps ARE loaded; the default view simply does not draw them. Read off
  // the filtered list this would flip with the reveal control.
  const state = restoredAgentState(
    agentSpawnFrame('session-1', 'toolu_agent_1'),
    agentChildFrame('session-1', 'toolu_agent_1', 1, true),
    agentResultFrame('session-1', 'toolu_agent_1'),
  )
  expect(agentRow(state)?.stepsNotLoaded).toBeUndefined()
  const revealed = selectNestedTranscriptRows(state, 'session-1', true).find(
    row => row.kind === 'tool-use',
  )
  expect(revealed?.stepsNotLoaded).toBeUndefined()
})

test('a background launch record is never labelled: its steps never join this pane', () => {
  const state = restoredAgentState(
    agentSpawnFrame('session-1', 'toolu_agent_1', {
      subagent_type: 'Explore',
      description: 'Find the owner files',
      run_in_background: true,
    }),
    agentResultFrame('session-1', 'toolu_agent_1'),
  )
  expect(agentRow(state)?.stepsNotLoaded).toBeUndefined()
})

test('a refused or interrupted agent is never labelled: nothing ran to be missing', () => {
  const state = restoredAgentState(
    agentSpawnFrame('session-1', 'toolu_agent_1'),
    agentResultFrame('session-1', 'toolu_agent_1', true),
  )
  expect(agentRow(state)?.stepsNotLoaded).toBeUndefined()
})

test('an agent still running is never labelled: its steps have not happened yet', () => {
  const state = restoredAgentState(agentSpawnFrame('session-1', 'toolu_agent_1'))
  expect(agentRow(state)?.stepsNotLoaded).toBeUndefined()
})

test('a WHOLE transcript never labels an empty Agent card', () => {
  // Without a retention boundary there is no reason to believe anything is
  // missing, so an agent that genuinely produced nothing keeps saying so.
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(state, agentSpawnFrame('session-1', 'toolu_agent_1'))
  state = projectServerFrame(state, agentResultFrame('session-1', 'toolu_agent_1'))
  expect(agentRow(state)?.stepsNotLoaded).toBeUndefined()
})

test('a late child row un-labels the card rather than serving the cached one', () => {
  let state = restoredAgentState(
    agentSpawnFrame('session-1', 'toolu_agent_1'),
    agentResultFrame('session-1', 'toolu_agent_1'),
  )
  expect(agentRow(state)?.stepsNotLoaded).toBe(true)
  state = projectServerFrame(
    state,
    agentChildFrame('session-1', 'toolu_agent_1', 9),
  )
  const row = agentRow(state)
  expect(row?.stepsNotLoaded).toBeUndefined()
  expect(row?.children).toHaveLength(1)
})

/**
 * Compile-time half of the same fact: the flag is declared on the agent card's
 * arm of the union, so the rows that can never carry it cannot be asked about
 * it either. Each `@ts-expect-error` below fails the typecheck the moment the
 * flag is widened back across the whole union — `bun test` cannot see this, only
 * `bun run --cwd app typecheck` can.
 */
type NestedRowOfKind<Kind extends NestedTranscriptRow['kind']> = Extract<
  NestedTranscriptRow,
  { kind: Kind }
>
type _AgentCardCarriesIt = NestedRowOfKind<'tool-use'>['stepsNotLoaded']
// @ts-expect-error — prose is not an agent card.
type _ProseDoesNot = NestedRowOfKind<'assistant-text'>['stepsNotLoaded']
// @ts-expect-error — the retention boundary describes the pane, not a run.
type _BoundaryDoesNot = NestedRowOfKind<'history-boundary'>['stepsNotLoaded']
// @ts-expect-error — the orphan placeholder is the missing card, not a loaded one.
type _OrphanDoesNot = NestedRowOfKind<'orphaned-agent'>['stepsNotLoaded']

/* ── B1/B4: recovered history (decisions/HISTORY-LOAD-EARLIER.md) ── */

/**
 * One message recovered by `history.loadEarlier`. Same `replay` as a restore
 * frame; `recovered` is the whole difference, and it is what tells an INSERTION
 * apart from an append.
 */
function recoveredFrame(sessionId: string, label: string) {
  return {
    ...messageFrame(sessionId, {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: label }],
      },
      parent_tool_use_id: null,
      uuid: `00000000-0000-4000-8000-recovered-${label}`,
    } as unknown as SDKMessage),
    replay: true as const,
    recovered: true as const,
  }
}

function recoveredUserFrame(sessionId: string, label: string) {
  return {
    ...messageFrame(sessionId, {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: label }] },
      parent_tool_use_id: null,
      uuid: `00000000-0000-4000-8000-recovered-user-${label}`,
    } as unknown as SDKMessage),
    replay: true as const,
    recovered: true as const,
  }
}

function loadEarlierResult(
  sessionId: string,
  complete: boolean,
  requestId = 'req-1',
) {
  return {
    kind: 'history.loadEarlier.result' as const,
    protocolVersion: 1 as const,
    sessionId,
    requestId,
    ok: true,
    message: 'Loaded earlier messages.',
    added: 1,
    complete,
  }
}

function bodies(state: ReturnType<typeof createTranscriptState>): string[] {
  return selectTranscriptRows(state, 'session-1').flatMap(row =>
    row.kind === 'assistant-text' || row.kind === 'user-text'
      ? [row.content]
      : [],
  )
}

/**
 * The defect this pins (B1): `appendFrameRows` appended unconditionally and
 * nothing in the module sorts, so messages recovered mid-session rendered
 * UNDERNEATH the conversation they precede.
 */
test('a recovered batch lands above the conversation, oldest first', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(state, assistantFrame('session-1', 1))
  state = projectServerFrame(state, assistantFrame('session-1', 2))

  // The sidecar emits the missing prefix oldest-first.
  state = projectServerFrame(state, recoveredFrame('session-1', 'old-a'))
  state = projectServerFrame(state, recoveredUserFrame('session-1', 'old-b'))
  state = projectServerFrame(state, recoveredFrame('session-1', 'old-c'))
  state = projectServerFrame(state, loadEarlierResult('session-1', false))

  expect(bodies(state)).toEqual([
    'old-a',
    'old-b',
    'old-c',
    'body 1',
    'body 2',
  ])
})

test('a replacement attach rebuilds retained transcript rows from its replay', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(state, assistantFrame('session-1', 99))

  // A replacement sidecar emits ready before the retained historical tail.
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    truncationFrame('session-1', 'catcode.history-truncated'),
  )
  state = projectServerFrame(state, {
    ...assistantFrame('session-1', 1),
    replay: true,
  })
  state = projectServerFrame(state, {
    ...assistantFrame('session-1', 2),
    replay: true,
  })

  expect(bodies(state)).toEqual(['body 1', 'body 2'])
  expect(
    selectNestedTranscriptRows(state, 'session-1').map(row => row.kind),
  ).toContain('history-boundary')
})

/** The other half: nothing about the ordinary append path moved. */
test('an ordinary frame still appends after a recovery batch has closed', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(state, assistantFrame('session-1', 1))
  state = projectServerFrame(state, recoveredFrame('session-1', 'old-a'))
  state = projectServerFrame(state, loadEarlierResult('session-1', false))
  state = projectServerFrame(state, assistantFrame('session-1', 2))

  expect(bodies(state)).toEqual(['old-a', 'body 1', 'body 2'])
})

/**
 * An interrupted batch cannot corrupt what follows: the closing result never
 * arrives (the connection dropped), and the next live frame must still append.
 * The cursor is re-derived from every frame, so a frame without `recovered`
 * cannot reach the insertion branch at all.
 */
test('a live frame appends even when the closing result never arrived', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(state, assistantFrame('session-1', 1))
  state = projectServerFrame(state, recoveredFrame('session-1', 'old-a'))
  // No `history.loadEarlier.result` here.
  state = projectServerFrame(state, assistantFrame('session-1', 2))

  expect(bodies(state)).toEqual(['old-a', 'body 1', 'body 2'])
})

/**
 * Successive recoveries reach FURTHER back, so each batch stacks above the
 * previous one. That only holds because the result frame resets the cursor.
 */
test('a second recovery stacks above the first', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(state, assistantFrame('session-1', 1))

  state = projectServerFrame(state, recoveredFrame('session-1', 'near-a'))
  state = projectServerFrame(state, recoveredFrame('session-1', 'near-b'))
  state = projectServerFrame(
    state,
    loadEarlierResult('session-1', false, 'req-1'),
  )

  state = projectServerFrame(state, recoveredFrame('session-1', 'far-a'))
  state = projectServerFrame(state, recoveredFrame('session-1', 'far-b'))
  state = projectServerFrame(
    state,
    loadEarlierResult('session-1', false, 'req-2'),
  )

  expect(bodies(state)).toEqual([
    'far-a',
    'far-b',
    'near-a',
    'near-b',
    'body 1',
  ])
})

/** Rows are never rewritten: an insertion places rows, it does not touch them. */
test('an insertion leaves every existing row object identical', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(state, assistantFrame('session-1', 1))
  const before = selectTranscriptRows(state, 'session-1')

  state = projectServerFrame(state, recoveredFrame('session-1', 'old-a'))
  const after = selectTranscriptRows(state, 'session-1')

  expect(after).toHaveLength(2)
  expect(after[1]).toBe(before[0])
})

/**
 * The boundary row is synthesized above `rows[0]`, and `rows[0]` is exactly what
 * an insertion changes.
 */
test('the boundary row stays above the newly inserted rows', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    truncationFrame('session-1', 'catcode.history-truncated'),
  )
  state = projectServerFrame(state, assistantFrame('session-1', 1))
  state = projectServerFrame(state, recoveredFrame('session-1', 'old-a'))
  state = projectServerFrame(state, loadEarlierResult('session-1', false))

  expect(
    selectNestedTranscriptRows(state, 'session-1').map(row => row.kind),
  ).toEqual(['history-boundary', 'assistant-text', 'assistant-text'])
  expect(bodies(state)).toEqual(['old-a', 'body 1'])
})

/**
 * The defect this pins (B4): `historyTruncated` latched permanently, so a
 * renderer wired to this frame would leave the boundary row standing over a
 * transcript that is now whole — inverting the design's own completeness
 * signal, that the row's ABSENCE means you are seeing everything.
 */
test('a complete result clears the boundary row, an incomplete one leaves it', () => {
  for (const complete of [true, false]) {
    let state = createTranscriptState()
    state = projectServerFrame(state, ready('session-1'))
    state = projectServerFrame(
      state,
      truncationFrame('session-1', 'catcode.history-truncated'),
    )
    state = projectServerFrame(state, assistantFrame('session-1', 1))
    state = projectServerFrame(state, recoveredFrame('session-1', 'old-a'))
    state = projectServerFrame(state, loadEarlierResult('session-1', complete))

    const kinds = selectNestedTranscriptRows(state, 'session-1').map(
      row => row.kind,
    )
    expect(kinds.includes('history-boundary')).toBe(!complete)
  }
})

/** A refusal learned nothing, so it cannot claim the transcript is whole. */
test('a refused result never clears the boundary row', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  state = projectServerFrame(
    state,
    truncationFrame('session-1', 'catcode.history-truncated'),
  )
  state = projectServerFrame(state, assistantFrame('session-1', 1))
  state = projectServerFrame(state, {
    ...loadEarlierResult('session-1', true),
    ok: false,
    added: 0,
  })

  expect(
    selectNestedTranscriptRows(state, 'session-1').map(row => row.kind),
  ).toContain('history-boundary')
})

function projectSequential(
  frames: readonly ServerFrame[],
): ReturnType<typeof createTranscriptState> {
  return frames.reduce(projectServerFrame, createTranscriptState())
}

function projectSequentialDeliveries(
  deliveries: readonly (readonly ServerFrame[])[],
): ReturnType<typeof createTranscriptState> {
  return deliveries.reduce(
    (state, delivery) => delivery.reduce(projectServerFrame, state),
    createTranscriptState(),
  )
}

function projectBatchDeliveries(
  deliveries: readonly (readonly ServerFrame[])[],
): ReturnType<typeof createTranscriptState> {
  return deliveries.reduce(projectServerFrames, createTranscriptState())
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value
  }
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

/**
 * Baseline oracle for the batched projector. It deliberately uses only the
 * established single-frame reducer: the optimization is added after this
 * corpus is committed, so its expected state cannot inherit transaction
 * assumptions. Whole-state equality covers every TranscriptSessionState
 * collection, rather than only the visible row projection.
 */
test('sequential transcript projection is invariant across replay delivery partitions', () => {
  const sessionId = 'session-1'
  const secondSessionId = 'session-2'
  const fixtureFrames = allSdkMessageSamples().map(sample =>
    messageFrame(sessionId, sample.message),
  )
  const frames: ServerFrame[] = [
    ready(sessionId),
    ...fixtureFrames,
    messageFrame(sessionId, {
      type: 'user',
      message: {
        role: 'user',
        content: 'hidden transcript bookkeeping',
      },
      parent_tool_use_id: null,
      isSynthetic: true,
      uuid: '00000000-0000-4000-8000-00000000d001',
    }),
    {
      kind: 'generated-image-preview',
      protocolVersion: 1,
      sessionId,
      toolUseId: 'toolu_oracle_image',
      mediaType: 'image/png',
      data: 'AAAA',
    },
    truncationFrame(sessionId, 'catcode.history-truncated'),
    recoveredFrame(sessionId, 'oracle-old-a'),
    recoveredUserFrame(sessionId, 'oracle-old-b'),
    loadEarlierResult(sessionId, true, 'oracle-recovery'),
    ready(secondSessionId),
    assistantFrame(secondSessionId, 1),
    messageFrame('unknown-session', {
      type: 'assistant',
      message: {
        id: 'must-not-project',
        role: 'assistant',
        content: [{ type: 'text', text: 'unknown session' }],
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-00000000d002',
    }),
  ]
  const expected = projectSequential(frames)

  expect(projectServerFrames(createTranscriptState(), frames)).toEqual(expected)
  expect(projectBatchDeliveries(frames.map(frame => [frame]))).toEqual(expected)
  expect(projectSequentialDeliveries([frames])).toEqual(expected)
  expect(projectSequentialDeliveries(frames.map(frame => [frame]))).toEqual(
    expected,
  )

  // Every boundary in this bounded adversarial corpus, plus partitions shaped
  // like frame caps, byte caps, and the lazy replay timer's partial flush.
  for (let splitAt = 1; splitAt < frames.length; splitAt += 1) {
    expect(
      projectSequentialDeliveries([
        frames.slice(0, splitAt),
        frames.slice(splitAt),
      ]),
    ).toEqual(expected)
    expect(
      projectBatchDeliveries([
        frames.slice(0, splitAt),
        frames.slice(splitAt),
      ]),
    ).toEqual(expected)
  }
  for (const partition of [
    [1, 1, 2, 1, 3],
    [4, 7, 2],
    [8, 1, 1],
  ]) {
    const deliveries: ServerFrame[][] = []
    let cursor = 0
    for (const size of partition) {
      deliveries.push(frames.slice(cursor, cursor + size))
      cursor += size
    }
    deliveries.push(frames.slice(cursor))
    expect(projectSequentialDeliveries(deliveries)).toEqual(expected)
    expect(projectBatchDeliveries(deliveries)).toEqual(expected)
  }
})

test('batch projection matches the single-frame projector at every streaming reasoning prefix', () => {
  for (const fixture of [
    S1_STREAMING_REASONING_TURN,
    S1_CONCURRENT_REASONING_TURN,
  ]) {
    const frames: ServerFrame[] = [
      ready('session-1'),
      ...fixture.messages.map(message => messageFrame('session-1', message)),
    ]
    for (let count = 1; count <= frames.length; count += 1) {
      const prefix = frames.slice(0, count)
      expect(projectServerFrames(createTranscriptState(), prefix)).toEqual(
        projectSequential(prefix),
      )
    }
  }
})

test('batch projection preserves sequential semantics for interleaved sessions and adversarial frames', () => {
  const primary = 'batch-primary'
  const secondary = 'batch-secondary'
  const streamedFinal = messageFrame(primary, {
    type: 'assistant',
    message: {
      id: 'batch-streamed-message',
      role: 'assistant',
      content: [{ type: 'text', text: 'streamed final text' }],
    },
    parent_tool_use_id: null,
    uuid: '00000000-0000-4000-8000-00000000b101',
  } as unknown as SDKMessage)
  const toolUse = messageFrame(secondary, {
    type: 'assistant',
    message: {
      id: 'batch-tool-message',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_batch_correlation',
          name: 'Read',
          input: { file_path: '/batch.txt' },
        },
      ],
    },
    parent_tool_use_id: null,
    uuid: '00000000-0000-4000-8000-00000000b102',
  } as unknown as SDKMessage)
  const frames: ServerFrame[] = [
    ready(primary),
    ready(secondary),
    messageFrame(primary, {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: { id: 'batch-streamed-message' },
      },
    } as unknown as SDKMessage),
    toolUse,
    messageFrame(primary, {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
    } as unknown as SDKMessage),
    messageFrame(secondary, {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_batch_correlation',
            content: [{ type: 'text', text: 'correlated output' }],
            is_error: false,
          },
        ],
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-00000000b103',
    } as unknown as SDKMessage),
    messageFrame(primary, {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'streamed ' },
      },
    } as unknown as SDKMessage),
    streamedFinal,
    // Duplicate delivery must remain a no-op even when it is interleaved with
    // frames for another session.
    toolUse,
    messageFrame(primary, {
      type: 'assistant',
      message: 'malformed assistant payload',
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-00000000b104',
    } as unknown as SDKMessage),
    truncationFrame(primary, 'ordinary-live-error'),
    {
      ...messageFrame(primary, {
        type: 'assistant',
        message: {
          id: 'batch-recovered',
          role: 'assistant',
          content: [{ type: 'text', text: 'recovered without result' }],
        },
        parent_tool_use_id: null,
        uuid: '00000000-0000-4000-8000-00000000b105',
      } as unknown as SDKMessage),
      recovered: true as const,
    },
    // No history.loadEarlier.result follows. The next ordinary frame must
    // still close the insertion cursor, exactly as live projection does.
    assistantFrame(primary, 8),
  ]

  const expected = projectSequential(frames)
  expect(projectServerFrames(createTranscriptState(), frames)).toEqual(expected)
  expect(projectBatchDeliveries([
    frames.slice(0, 3),
    frames.slice(3, 8),
    frames.slice(8),
  ])).toEqual(expected)
})

test('batch projection preserves source identities and publishes no-op batches', () => {
  const initial = projectSequential([
    ready('session-1'),
    assistantFrame('session-1', 1),
    ready('session-2'),
  ])
  const session = initial.sessions['session-1']!
  const untouchedSession = initial.sessions['session-2']!
  const rows = session.rows
  const sourceSnapshot = structuredClone(initial)
  deepFreeze(initial)

  expect(projectServerFrames(initial, [])).toBe(initial)
  expect(
    projectServerFrames(initial, [
      assistantFrame('session-1', 1),
    ]),
  ).toBe(initial)

  const next = projectServerFrames(initial, [
    assistantFrame('session-1', 2),
  ])
  expect(next).not.toBe(initial)
  expect(next.sessions['session-1']).not.toBe(session)
  expect(next.sessions['session-1']!.rows).not.toBe(rows)
  expect(next.sessions['session-1']!.rows[0]).toBe(rows[0])
  expect(next.sessions['session-2']).toBe(untouchedSession)
  expect(initial.sessions['session-1']).toBe(session)
  expect(initial.sessions['session-1']!.rows).toBe(rows)
  expect(initial).toEqual(sourceSnapshot)
})

test('single live reducer projection remains the single-frame projector path', () => {
  const state = projectSequential([ready('session-1')])
  const frame = assistantFrame('session-1', 1)
  expect(reduceLiveTranscriptState(state, frame)).toEqual(
    projectServerFrame(state, frame),
  )
})

test('batch projection retains a recovered typed assistant error without a frame id', () => {
  const frame = {
    ...messageFrame('session-1', {
      type: 'assistant',
      error: 'overloaded_error',
      message: { role: 'assistant', content: [] },
      parent_tool_use_id: null,
    } as unknown as SDKMessage),
    recovered: true as const,
  }
  const frames = [ready('session-1'), frame]

  expect(projectServerFrames(createTranscriptState(), frames)).toEqual(
    projectSequential(frames),
  )
})

/**
 * The compaction boundary in main's replay ring, seen from the renderer
 * (2026-09-02 assessment §5 item 2). Main drops a stream's `stream_event`
 * partials at its `message_stop`, never at a finished `assistant` frame — the
 * provider yields one `assistant` per content block and only reaches
 * `message_stop` after the last of them, so an earlier boundary would strip the
 * `message_start` that a SECOND block's deltas need to find their stream after a
 * reload. This drives the real `FrameReplayBuffer` so the two sides cannot drift.
 */
test('a mid-turn reload replays the open stream, so the turn’s second block still streams', () => {
  const sessionId = 'session-two-block'
  const buffer = new FrameReplayBuffer()
  const record = (frame: ServerFrame) => {
    buffer.record(sessionId, frame)
    return frame
  }
  const partial = (event: Record<string, unknown>, seq: number) =>
    record(
      messageFrame(sessionId, {
        type: 'stream_event',
        event,
        parent_tool_use_id: null,
        session_id: `engine-${sessionId}`,
        uuid: `00000000-0000-4000-8000-9${String(seq).padStart(11, '0')}`,
      } as SDKMessage),
    )
  const assistantBlock = (text: string, seq: number) =>
    record(
      messageFrame(sessionId, {
        type: 'assistant',
        message: {
          id: 'msg-two-block',
          role: 'assistant',
          content: [{ type: 'text', text }],
          stop_reason: null,
        },
        parent_tool_use_id: null,
        session_id: `engine-${sessionId}`,
        uuid: `00000000-0000-4000-8000-8${String(seq).padStart(11, '0')}`,
      } as SDKMessage),
    )

  record(ready(sessionId) as ServerFrame)
  partial({ type: 'message_start', message: { id: 'msg-two-block' } }, 1)
  partial({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 2)
  partial({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'first' } }, 3)
  partial({ type: 'content_block_stop', index: 0 }, 4)
  assistantBlock('first block.', 1)

  // The reload: a fresh renderer state catches up from main's ring alone.
  let state = projectServerFrames(createTranscriptState(), buffer.snapshot())
  expect(selectTranscriptRows(state, sessionId)).toMatchObject([
    { blockIndex: 0, kind: 'assistant-text', content: 'first block.' },
  ])

  // Block 1 arrives live into the reloaded pane. Its delta can only find a
  // stream because the replay carried the `message_start`.
  state = projectServerFrame(
    state,
    partial({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }, 5),
  )
  state = projectServerFrame(
    state,
    partial({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'second' } }, 6),
  )
  expect(selectTranscriptRows(state, sessionId)).toMatchObject([
    { blockIndex: 0, kind: 'assistant-text', content: 'first block.' },
    { blockIndex: 1, kind: 'assistant-text', content: 'second', isStreaming: true },
  ])

  state = projectServerFrame(state, partial({ type: 'content_block_stop', index: 1 }, 7))
  state = projectServerFrame(state, assistantBlock('second block.', 2))
  state = projectServerFrame(state, partial({ type: 'message_stop' }, 8))

  const finished = [
    { blockIndex: 0, kind: 'assistant-text', content: 'first block.' },
    { blockIndex: 1, kind: 'assistant-text', content: 'second block.' },
  ]
  expect(selectTranscriptRows(state, sessionId)).toMatchObject(finished)

  // A reload AFTER the stream stopped replays a ring with no partials left in
  // it, and projects the identical finished rows.
  const compacted = buffer.snapshot()
  expect(
    compacted.filter(
      frame =>
        frame.kind === 'event' &&
        frame.event.type === 'message' &&
        frame.event.message.type === 'stream_event',
    ),
  ).toEqual([])
  expect(
    selectTranscriptRows(
      projectServerFrames(createTranscriptState(), compacted),
      sessionId,
    ),
  ).toMatchObject(finished)
})
