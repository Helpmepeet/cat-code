import { expect, test } from 'bun:test'
import { deriveActivity } from './appModel.js'
import {
  createTranscriptState,
  projectServerFrame,
  selectNestedTranscriptRows,
} from './transcriptProjector.js'
import type { SessionId } from '../../shared/protocol.js'

/**
 * Rows are PROJECTED from real SDK messages rather than hand-built. A hand-built
 * row can drift from the shape the projector actually emits and leave the test
 * asserting nothing; the first draft of this file did exactly that, and only
 * `tsc` noticed. Every case below therefore also asserts the row kinds it
 * projected, so a wrong message shape fails loudly instead of silently.
 */
const SESSION = 'session-1' as SessionId
const ENGINE = 'engine-1'

const ready = {
  kind: 'ready',
  protocolVersion: 1,
  sessionId: SESSION,
  engineSessionId: ENGINE,
  payload: {
    type: 'app.ready',
    protocolVersion: 1,
    inputEnabled: true,
    activeTurn: false,
    abort: { status: 'idle' },
    goalSnapshot: null,
    pendingPermissionRequests: [],
  },
} as never

let uuidCounter = 0
const uuid = () =>
  `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`

const frame = (message: unknown) =>
  ({
    kind: 'event',
    protocolVersion: 1,
    sessionId: SESSION,
    event: { type: 'message', message },
  }) as never

const base = { parent_tool_use_id: null, session_id: ENGINE }

const userTurn = (text: string) => ({
  type: 'user',
  ...base,
  uuid: uuid(),
  message: { role: 'user', content: text },
})

/** One assistant message carrying N tool_use blocks, as parallel calls arrive. */
const toolCalls = (calls: Array<{ id: string; name: string }>) => ({
  type: 'assistant',
  ...base,
  uuid: uuid(),
  message: {
    id: `msg-${uuid()}`,
    role: 'assistant',
    type: 'message',
    model: 'claude-sonnet-5',
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, service_tier: null },
    content: calls.map(call => ({
      type: 'tool_use',
      id: call.id,
      name: call.name,
      input: {},
    })),
  },
})

const toolResult = (toolUseId: string) => ({
  type: 'user',
  ...base,
  uuid: uuid(),
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }],
  },
})

/** Shape copied from the `task-notification` origin sample in sdkMessageFixtures. */
const taskNotification = () => ({
  type: 'user',
  ...base,
  uuid: uuid(),
  isReplay: true,
  timestamp: '2026-08-02T09:00:00.000Z',
  message: {
    role: 'user',
    content: 'Task notification\nStatus: completed\nSummary: agent finished',
  },
  origin: {
    kind: 'task-notification',
    status: 'completed',
    summary: 'agent finished',
    toolUseId: 'toolu_no_card_here',
    result: 'done',
    usage: { totalTokens: 10, toolUses: 1, durationMs: 10 },
  },
})

const streamingText = (text: string) => [
  {
    type: 'stream_event',
    ...base,
    uuid: uuid(),
    event: { type: 'message_start', message: { id: `msg-stream-${uuid()}` } },
  },
  {
    type: 'stream_event',
    ...base,
    uuid: uuid(),
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
  },
  {
    type: 'stream_event',
    ...base,
    uuid: uuid(),
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    },
  },
]

function project(messages: unknown[]) {
  let state = projectServerFrame(createTranscriptState(), ready)
  for (const message of messages) state = projectServerFrame(state, frame(message))
  return selectNestedTranscriptRows(state, SESSION)
}

const kinds = (rows: ReturnType<typeof project>) => rows.map(row => row.kind)

test('a pending tool is reported even when it is not the last row', () => {
  // THE REGRESSION. Three tools dispatched together, the LAST one finishing
  // first: the tail-only read reported "Working" with two still executing.
  const rows = project([
    userTurn('search the repo'),
    toolCalls([
      { id: 'toolu_a', name: 'Grep' },
      { id: 'toolu_b', name: 'Glob' },
      { id: 'toolu_c', name: 'Read' },
    ]),
    toolResult('toolu_c'),
  ])
  expect(kinds(rows)).toEqual(['user-text', 'tool-use', 'tool-use', 'tool-use'])
  expect(rows.at(-1)).toMatchObject({ kind: 'tool-use', status: 'success' })
  expect(deriveActivity(rows)).toEqual({ verb: 'Running', target: 'Grep' })
})

test('the target holds still while siblings finish out of order', () => {
  const rows = project([
    userTurn('search the repo'),
    toolCalls([
      { id: 'toolu_a', name: 'Grep' },
      { id: 'toolu_b', name: 'Glob' },
    ]),
    toolResult('toolu_b'),
  ])
  expect(deriveActivity(rows)).toEqual({ verb: 'Running', target: 'Grep' })
})

test('only when every tool in the turn has settled does the verb move on', () => {
  const rows = project([
    userTurn('search the repo'),
    toolCalls([
      { id: 'toolu_a', name: 'Grep' },
      { id: 'toolu_b', name: 'Glob' },
    ]),
    toolResult('toolu_a'),
    toolResult('toolu_b'),
  ])
  expect(deriveActivity(rows)).toEqual({ verb: 'Working', target: null })
})

test('a task notification arriving mid-turn does not orphan running tools', () => {
  // The interaction the review named as a precondition. Counting
  // `task-notification` as a boundary opens a fresh window at the notification,
  // drops both pending tools out of scope, and reports "Working" while they
  // run. The token byline made the same mistake until 2026-08-02; both selectors
  // now share `OPERATOR_TURN_BOUNDARY_KINDS`.
  const rows = project([
    userTurn('search the repo'),
    toolCalls([
      { id: 'toolu_a', name: 'Grep' },
      { id: 'toolu_b', name: 'Glob' },
    ]),
    taskNotification(),
  ])
  // The notification really did project as a boundary-kind row: without this
  // the test could pass for the wrong reason.
  expect(kinds(rows)).toEqual([
    'user-text',
    'tool-use',
    'tool-use',
    'task-notification',
  ])
  expect(deriveActivity(rows)).toEqual({ verb: 'Running', target: 'Grep' })
})

test("a previous turn's abandoned pending tool never leaks into the next turn", () => {
  // An aborted turn leaves its tool-use row pending forever, because no
  // tool_result ever arrives. Unscoped, it would pin the verb for the rest of
  // the session.
  const rows = project([
    userTurn('first turn'),
    toolCalls([{ id: 'toolu_stale', name: 'Bash' }]),
    userTurn('second turn'),
    ...streamingText('answering now'),
  ])
  expect(rows.some(row => row.kind === 'tool-use' && row.status === 'pending')).toBe(
    true,
  )
  expect(deriveActivity(rows)).toEqual({ verb: 'Responding', target: null })
})

test('streaming assistant text reports Responding', () => {
  const rows = project([userTurn('hello'), ...streamingText('partial')])
  expect(rows.at(-1)).toMatchObject({ kind: 'assistant-text', isStreaming: true })
  expect(deriveActivity(rows)).toEqual({ verb: 'Responding', target: null })
})

test('the quiet phases report Working rather than an unobservable state', () => {
  // Right after submit, and while the model reasons, nothing has been added to
  // the transcript, so there is no evidence for a more specific verb. Thinking
  // is deliberately NOT synthesized from that silence.
  expect(deriveActivity([])).toEqual({ verb: 'Working', target: null })
  expect(deriveActivity(project([userTurn('hello')]))).toEqual({
    verb: 'Working',
    target: null,
  })
})

test('a pending tool with no operator turn ahead of it is not reported', () => {
  // Restored history with no operator boundary: a leftover pending row must not
  // present as live work.
  const rows = project([toolCalls([{ id: 'toolu_a', name: 'Grep' }])])
  expect(kinds(rows)).toEqual(['tool-use'])
  expect(deriveActivity(rows)).toEqual({ verb: 'Working', target: null })
})

test('a running compaction reports Compacting, outranking a pending tool', () => {
  // Compaction mints no row while it runs, so the rows say "Working" (or name
  // whatever tool the turn that triggered an auto-compaction left pending).
  // Neither is what the session is doing; the flag comes from the engine's own
  // status signal (`selectIsCompacting`) and wins outright.
  const quiet = project([userTurn('hello')])
  expect(deriveActivity(quiet)).toEqual({ verb: 'Working', target: null })
  expect(deriveActivity(quiet, true)).toEqual({
    verb: 'Compacting',
    target: null,
  })

  const midTool = project([
    userTurn('hello'),
    toolCalls([{ id: 'toolu_live', name: 'Bash' }]),
  ])
  expect(deriveActivity(midTool)).toEqual({ verb: 'Running', target: 'Bash' })
  expect(deriveActivity(midTool, true)).toEqual({
    verb: 'Compacting',
    target: null,
  })
})
