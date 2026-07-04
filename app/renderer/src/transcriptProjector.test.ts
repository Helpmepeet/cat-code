import { expect, test } from 'bun:test'
import type { SDKMessage } from '@cat-code/engine/session-events'
import {
  createTranscriptState,
  projectServerFrame,
  selectNestedTranscriptRows,
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
          { type: 'thinking', thinking: 42 },
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
      toolFamily: 'bash',
      input: {},
      status: 'pending',
      result: null,
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

  expect(selectTranscriptRows(state)).toMatchObject([
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

  expect(selectTranscriptRows(state)).toMatchObject([
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

  expect(selectTranscriptRows(state)).toEqual([])
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

  expect(selectTranscriptRows(state).map(row => row.kind)).toEqual([
    'session-init',
    'compact-boundary',
    'system-notice',
    'result',
  ])
  expect(selectTranscriptRows(state)).toMatchObject([
    { cwd: '/Users/pt/cat-code', model: 'claude-sonnet-5' },
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
    'session-init',
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
  expect(new Set(rows.map(row => row.id)).size).toBe(5)

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
  expect(resolvedRow.result?.content).toContain('sun_path')
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

test('a child row whose parent never arrived surfaces at top level (degraded placement, not data loss)', () => {
  let state = createTranscriptState()
  state = projectServerFrame(state, ready('session-1'))
  // Only the child frame arrives — its claimed parent tool_use_id was never
  // projected as a row (e.g. truncated replay window).
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
      uuid: '00000000-0000-4000-8000-0000000d0003',
    }),
  )

  const nested = selectNestedTranscriptRows(state, 'session-1')
  expect(nested).toHaveLength(1)
  expect(nested[0]?.kind).toBe('assistant-text')
  expect(nested[0]?.children).toEqual([])
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
