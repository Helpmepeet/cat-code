import { expect, test } from 'bun:test'
import type { SDKMessage } from '@cat-code/engine/session-events'
import {
  createTranscriptState,
  projectServerFrame,
  selectTranscriptRows,
} from './transcriptProjector.js'
import {
  allSdkMessageSamples,
  DRIFT_WIRE_SAMPLE_JSON,
  SDK_MESSAGE_FIXTURE,
} from './sdkMessageFixtures.js'

function ready(sessionId: string) {
  return {
    kind: 'ready' as const,
    protocolVersion: 1 as const,
    sessionId,
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
  expect(rows.map(row => row.messageId)).toEqual([
    'msg_shared_1',
    'msg_shared_1',
    'msg_shared_1',
  ])
  expect(rows.map(row => row.blockIndex)).toEqual([0, 1, 2])
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

  expect(selectTranscriptRows(state)[0]).toMatchObject({
    messageId: '00000000-0000-4000-8000-000000000010',
    frameId: '00000000-0000-4000-8000-000000000010',
    blockIndex: 0,
  })
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
          { type: 'thinking', thinking: 'unhandled variant' },
          { type: 'tool_use', id: 'toolu_ok', name: 'Bash', input: null },
        ],
      },
      uuid: '00000000-0000-4000-8000-000000000011',
    }),
  )

  expect(selectTranscriptRows(state)).toEqual([
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
      input: {},
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
  const projectingDiscriminants = new Set(['assistant', 'stream_event'])
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

test('one session survives the ENTIRE fixture in sequence with the documented row total', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  let expectedRows = 0
  for (const sample of allSdkMessageSamples()) {
    state = projectServerFrame(state, messageFrame('session-1', sample.message))
    expectedRows += sample.expectRows
  }
  expect(selectTranscriptRows(state, 'session-1')).toHaveLength(expectedRows)
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
  expect(rows[0]?.parentToolUseId).toBe('toolu_01FixTask1')

  // Top-level frames stay null.
  const textSample = SDK_MESSAGE_FIXTURE.assistant[0]
  if (!textSample) throw new Error('assistant text fixture sample missing')
  state = projectServerFrame(state, messageFrame('session-1', textSample.message))
  expect(selectTranscriptRows(state, 'session-1')[1]?.parentToolUseId).toBeNull()
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
  expect(rows.map(row => row.kind)).toEqual([
    'assistant-text',
    'tool-use',
    'assistant-text',
  ])
  expect(rows.map(row => row.messageId)).toEqual(['msg_S1', 'msg_S1', 'msg_S2'])
  expect(rows.map(row => row.blockIndex)).toEqual([0, 1, 0])
  expect(new Set(rows.map(row => row.id)).size).toBe(3)

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
