import { expect, test } from 'bun:test'
import type { SDKMessage } from '@cat-code/engine/session-events'
import {
  createTranscriptState,
  groupAgentDelegates,
  projectServerFrame,
  selectHasHiddenRows,
  selectNestedTranscriptRows,
  selectSlashCommands,
  selectTranscriptDisplayItems,
  selectTranscriptRows,
} from './transcriptProjector.js'
import {
  AGENT_WITH_NESTED_SUBAGENT_TURN,
  allSdkMessageSamples,
  DRIFT_WIRE_SAMPLE_JSON,
  PARALLEL_AGENTS_TURN,
  S1_STREAMING_TEXT_TURN,
  SDK_MESSAGE_FIXTURE,
} from './sdkMessageFixtures.js'

function ready(sessionId: string) {
  return {
    kind: 'ready' as const,
    protocolVersion: 1 as const,
    sessionId,
    engineSessionId: `engine-${sessionId}`,
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
  ).toEqual(['First API message.'])
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
 * The four kinds that had NO desktop handling at all: `coordinator`, `channel`,
 * `teammate`, `deferred-continuation` (`MessageOrigin`, src/types/message.ts:10).
 * Each carries `role:'user'` but was written by the engine, and each rendered as
 * the operator's own right-aligned bubble before `origin` crossed the wire.
 */
test.each([
  [{ kind: 'coordinator' }, 'coordinator', null],
  [{ kind: 'channel', server: 'slack' }, 'channel', 'slack'],
  [{ kind: 'channel', server: 'slack', user: 'dana' }, 'channel', 'slack · dana'],
  [{ kind: 'teammate', from: 'scout' }, 'teammate', 'scout'],
  [{ kind: 'teammate' }, 'teammate', null],
  [{ kind: 'deferred-continuation' }, 'deferred-continuation', null],
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

/* ── background-agent finish folds into its card (leak fix, 2026-08-01) ──────
 * The prototype's disposition (`~/catcode_prototype/cat-app/data.js:153-165`):
 * the notification is joined to the named spawn card on the task id and the
 * duplicate row is dropped, because upstream it is a `role:'user'` message and
 * "rendering it as a human turn would misread the conversation".
 */
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
    } as unknown as SDKMessage),
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

test('a background agent’s finish rides its own card, and the banner row disappears', () => {
  const rows = selectTranscriptRows(stateWithBackgroundAgent(ADA_ORIGIN), 'session-1')

  // One finished agent reads as ONE row, not a card plus a banner.
  expect(rows.filter(row => row.kind === 'task-notification')).toHaveLength(0)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    kind: 'tool-use',
    toolUseId: 'toolu_agent_1',
    agentCompletion: {
      status: 'completed',
      summary: 'Agent @Ada completed',
      result: 'Sidebar lives in app/renderer/src/Sidebar.tsx',
      usage: { totalTokens: 12400, toolUses: 3, durationMs: 48000 },
    },
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

test('the completion reaches the agent card through the nested selector too', () => {
  const nested = selectNestedTranscriptRows(
    stateWithBackgroundAgent(ADA_ORIGIN),
    'session-1',
  )
  expect(nested).toHaveLength(1)
  expect(nested[0]).toMatchObject({
    kind: 'tool-use',
    toolFamily: 'agent',
    agentCompletion: { summary: 'Agent @Ada completed' },
  })
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

test('a background SHELL finish keeps its own row — only agent cards absorb one', () => {
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
    } as unknown as SDKMessage),
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

test('a partial or malformed usage object reads as no usage, never a holed stat line', () => {
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
    expect(rows[0]).toMatchObject({ agentCompletion: { usage: null } })
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
