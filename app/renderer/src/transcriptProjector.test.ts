import { expect, test } from 'bun:test'
import {
  createTranscriptState,
  projectSessionEvent,
} from './transcriptProjector.js'

test('projects an assistant message with text + tool_use blocks into ordered rows', () => {
  let state = createTranscriptState()

  state = projectSessionEvent(state, {
    type: 'message',
    message: {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: "I'll read that file." },
          {
            type: 'tool_use',
            id: 'toolu_p13_1',
            name: 'Read',
            input: { file_path: '/etc/hosts' },
          },
        ],
      },
      parent_tool_use_id: null,
      session_id: 'session-1',
      uuid: '00000000-0000-4000-8000-000000000001',
    },
  })

  expect(state.rows).toEqual([
    {
      kind: 'assistant-text',
      role: 'assistant',
      content: "I'll read that file.",
    },
    {
      kind: 'tool-use',
      toolUseId: 'toolu_p13_1',
      toolName: 'Read',
      input: { file_path: '/etc/hosts' },
    },
  ])
})

test('skips malformed content blocks without dropping the valid ones', () => {
  let state = createTranscriptState()

  state = projectSessionEvent(state, {
    type: 'message',
    message: {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          'not a block',
          { type: 'text', text: 42 },
          { type: 'tool_use', input: { missing: 'name' } },
          { type: 'thinking', thinking: 'unhandled variant' },
          { type: 'tool_use', id: 'toolu_ok', name: 'Bash', input: null },
        ],
      },
      session_id: 'session-1',
      uuid: '00000000-0000-4000-8000-000000000002',
    },
  })

  expect(state.rows).toEqual([
    { kind: 'tool-use', toolUseId: 'toolu_ok', toolName: 'Bash', input: {} },
  ])
})

test('leaves state untouched for unhandled SDKMessage variants and non-message events', () => {
  const initial = createTranscriptState()

  const afterStream = projectSessionEvent(initial, {
    type: 'message',
    message: {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'partial' },
      },
      session_id: 'session-1',
      uuid: '00000000-0000-4000-8000-000000000003',
    },
  })
  const afterResult = projectSessionEvent(afterStream, {
    type: 'message',
    message: { type: 'result', subtype: 'success' },
  })
  const afterAbort = projectSessionEvent(afterResult, {
    type: 'abort.status',
    abort: { status: 'requested' },
  })

  expect(afterAbort).toBe(initial)
  expect(afterAbort.rows).toEqual([])
})
