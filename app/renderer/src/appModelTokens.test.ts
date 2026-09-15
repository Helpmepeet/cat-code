import { expect, test } from 'bun:test'
import { selectLiveTokenEstimate } from './appModel.js'
import {
  createTranscriptState,
  projectServerFrame,
  selectNestedTranscriptRows,
} from './transcriptProjector.js'
import type { SDKMessage } from '@cat-code/engine/sdk'
import type { SessionId } from '../../shared/protocol.js'

/**
 * The byline's token count, exercised end to end: every case below feeds the
 * SAME message array to the real projector and to the selector, so the join key
 * (`row.messageId` ↔ the id `message_start` announced) is proven against the
 * shapes the projector actually emits rather than against hand-built rows. The
 * sibling `appModelActivity.test.ts` adopted that rule after a hand-built draft
 * drifted from the wire shape.
 *
 * Every assistant FRAME below carries a deliberately stale `usage`
 * (`output_tokens: 1`). A live assistant frame serialises message_start-era
 * usage and the engine's later write-back mutates only its own copy (S1 §4,
 * `sdkMessageFixtures.ts:128-130`), so any expectation landing on 1 would mean
 * the selector read the frame instead of the stream layer.
 */
const SESSION = 'session-1' as SessionId
const ENGINE = 'engine-1'

const ready = {
  kind: 'ready',
  protocolVersion: 2,
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
    protocolVersion: 2,
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

const streamEvent = (event: unknown) => ({
  type: 'stream_event',
  ...base,
  uuid: uuid(),
  event,
})

/** Anthropic seeds real input/cache buckets and `output_tokens: 1` here. */
const messageStart = (messageId: string, usage: Record<string, number>) =>
  streamEvent({ type: 'message_start', message: { id: messageId, usage } })

const blockStart = (index: number, contentBlock: Record<string, unknown>) =>
  streamEvent({ type: 'content_block_start', index, content_block: contentBlock })

const textDelta = (index: number, text: string) =>
  streamEvent({
    type: 'content_block_delta',
    index,
    delta: { type: 'text_delta', text },
  })

const blockStop = (index: number) =>
  streamEvent({ type: 'content_block_stop', index })

/** The event that states the message's real total output, on both providers. */
const messageDelta = (usage: Record<string, number>) =>
  streamEvent({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage,
  })

const messageStop = () => streamEvent({ type: 'message_stop' })

const assistantFrame = (
  messageId: string,
  content: unknown[],
  parentToolUseId: string | null = null,
) => ({
  type: 'assistant',
  ...base,
  parent_tool_use_id: parentToolUseId,
  uuid: uuid(),
  message: {
    id: messageId,
    role: 'assistant',
    type: 'message',
    model: 'claude-sonnet-5',
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 1, service_tier: null },
    content,
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

function project(messages: unknown[]) {
  let state = projectServerFrame(createTranscriptState(), ready)
  for (const message of messages) {
    state = projectServerFrame(state, frame(message))
  }
  return {
    rows: selectNestedTranscriptRows(state, SESSION),
    messages: messages as SDKMessage[],
  }
}

const kinds = (rows: ReturnType<typeof project>['rows']) =>
  rows.map(row => row.kind)

test('an Anthropic-shaped turn reports the real output, including encrypted reasoning', () => {
  // `redacted-thinking` carries an opaque blob, not text, so the character
  // count scored the whole reasoning block as zero. Reasoning is billed inside
  // `output_tokens` (Anthropic's Usage has no separate thinking field,
  // `@anthropic-ai/sdk/resources/messages/messages.d.ts:1368`), so the stream
  // layer counts it exactly.
  const { rows, messages } = project([
    userTurn('think hard, then answer'),
    messageStart('msg_anthropic', {
      input_tokens: 1200,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 8000,
      output_tokens: 1,
    }),
    blockStart(0, { type: 'redacted_thinking', data: '' }),
    blockStop(0),
    assistantFrame('msg_anthropic', [
      { type: 'redacted_thinking', data: 'EncRypTedBlob==' },
    ]),
    blockStart(1, { type: 'text', text: '' }),
    textDelta(1, 'Done.'),
    blockStop(1),
    assistantFrame('msg_anthropic', [{ type: 'text', text: 'Done.' }]),
    messageDelta({
      output_tokens: 4210,
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    }),
    messageStop(),
  ])
  expect(kinds(rows)).toEqual([
    'user-text',
    'redacted-thinking',
    'assistant-text',
  ])
  // The character estimate over these rows is round((0 + 5) / 4) = 1.
  expect(selectLiveTokenEstimate(rows, messages)).toBe(4210)
})

test('a Codex-shaped turn is not zeroed by its {0,0,0,0} message_start', () => {
  // The Codex adapter seeds every bucket at 0 on message_start and fills real
  // numbers only on the final delta (`codex-fetch-adapter.ts:1719,2908`), and
  // what it returns as visible text is a reasoning SUMMARY, a fraction of the
  // reasoning actually billed.
  const { rows, messages } = project([
    userTurn('plan the migration'),
    messageStart('msg_codex', {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
    }),
    blockStart(0, { type: 'thinking', thinking: '' }),
    blockStop(0),
    assistantFrame('msg_codex', [
      { type: 'thinking', thinking: 'Considering options.' },
    ]),
    blockStart(1, { type: 'text', text: '' }),
    textDelta(1, 'Here it is.'),
    blockStop(1),
    assistantFrame('msg_codex', [{ type: 'text', text: 'Here it is.' }]),
    messageDelta({
      output_tokens: 1800,
      input_tokens: 5000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    }),
    messageStop(),
  ])
  expect(kinds(rows)).toEqual(['user-text', 'thinking', 'assistant-text'])
  // The summary text is 31 characters, so the old estimate read 8.
  expect(selectLiveTokenEstimate(rows, messages)).toBe(1800)
})

test('a multi-message turn with tool calls sums each message, prior turns excluded', () => {
  // Within ONE message usage is folded (each event restates the total); ACROSS
  // the turn's messages the folded values are summed, which is what the engine
  // does at `message_stop` (`src/QueryEngine.ts:930`).
  const { rows, messages } = project([
    userTurn('first turn'),
    messageStart('msg_prior', { output_tokens: 1 }),
    assistantFrame('msg_prior', [{ type: 'text', text: 'earlier answer' }]),
    messageDelta({ output_tokens: 9999 }),
    messageStop(),

    userTurn('second turn'),
    messageStart('msg_one', { output_tokens: 1 }),
    assistantFrame('msg_one', [
      {
        type: 'tool_use',
        id: 'toolu_a',
        name: 'Bash',
        input: { command: 'ls -la' },
      },
    ]),
    messageDelta({ output_tokens: 300 }),
    messageStop(),
    toolResult('toolu_a'),
    messageStart('msg_two', { output_tokens: 1 }),
    assistantFrame('msg_two', [{ type: 'text', text: 'that listed the files' }]),
    messageDelta({ output_tokens: 120 }),
    messageStop(),
  ])
  expect(kinds(rows)).toEqual([
    'user-text',
    'assistant-text',
    'user-text',
    'tool-use',
    'assistant-text',
  ])
  expect(selectLiveTokenEstimate(rows, messages)).toBe(420)
})

test('the message still streaming keeps contributing a character estimate', () => {
  // Pure usage would make the counter sit still until `message_stop` and then
  // jump. The completed message reports real tokens; the open one is estimated.
  const { rows, messages } = project([
    userTurn('write it out'),
    messageStart('msg_done', { output_tokens: 1 }),
    assistantFrame('msg_done', [{ type: 'text', text: 'first part' }]),
    messageDelta({ output_tokens: 300 }),
    messageStop(),

    messageStart('msg_open', { output_tokens: 1 }),
    blockStart(0, { type: 'text', text: '' }),
    textDelta(0, 'x'.repeat(200)),
  ])
  expect(rows.at(-1)).toMatchObject({
    kind: 'assistant-text',
    isStreaming: true,
  })
  // 300 real + round(200 / 4) estimated.
  expect(selectLiveTokenEstimate(rows, messages)).toBe(350)

  // And the open message flips to its real number the moment it closes, without
  // the estimate being counted twice.
  const closed = project([
    ...messages,
    messageDelta({ output_tokens: 90 }),
    messageStop(),
    assistantFrame('msg_open', [{ type: 'text', text: 'x'.repeat(200) }]),
  ])
  expect(selectLiveTokenEstimate(closed.rows, closed.messages)).toBe(390)
})

test('a background agent finishing mid-turn no longer restarts the count', () => {
  // `task-notification` is INJECTED mid-turn (`src/QueryEngine.ts:995`, drained
  // at `src/query.ts:1605`), so counting it as a turn boundary threw away every
  // token the turn had already spent.
  const { rows, messages } = project([
    userTurn('do the work'),
    messageStart('msg_before', { output_tokens: 1 }),
    assistantFrame('msg_before', [{ type: 'text', text: 'starting' }]),
    messageDelta({ output_tokens: 300 }),
    messageStop(),
    taskNotification(),
    messageStart('msg_after', { output_tokens: 1 }),
    assistantFrame('msg_after', [{ type: 'text', text: 'finishing' }]),
    messageDelta({ output_tokens: 120 }),
    messageStop(),
  ])
  // The notification really did project a row: without this the test could pass
  // for the wrong reason.
  expect(kinds(rows)).toEqual([
    'user-text',
    'assistant-text',
    'task-notification',
    'assistant-text',
  ])
  expect(selectLiveTokenEstimate(rows, messages)).toBe(420)
})

test('subagent traffic stays out of the byline', () => {
  // A subagent's rows nest under their Task card rather than sitting at top
  // level, and the engine drops subagent stream deltas, so neither half of the
  // hybrid can see them. That matches the context gauge, which excludes
  // subagent traffic for the same reason (`contextUsage.ts` `isMainThread`).
  const { rows, messages } = project([
    userTurn('delegate it'),
    messageStart('msg_parent', { output_tokens: 1 }),
    assistantFrame('msg_parent', [
      {
        type: 'tool_use',
        id: 'toolu_task',
        name: 'Task',
        input: { subagent_type: 'Explore', description: 'look around' },
      },
    ]),
    messageDelta({ output_tokens: 500 }),
    messageStop(),
    assistantFrame(
      'msg_child',
      [{ type: 'text', text: 'y'.repeat(4000) }],
      'toolu_task',
    ),
  ])
  expect(kinds(rows)).toEqual(['user-text', 'tool-use'])
  expect(rows.at(-1)?.children.map(child => child.kind)).toEqual([
    'assistant-text',
  ])
  expect(selectLiveTokenEstimate(rows, messages)).toBe(500)
})

test('replayed history with no stream events still reports the old estimate', () => {
  // Restored transcripts carry no stream layer, so every message falls through
  // to the character estimate. Degraded, never zero and never a crash.
  const { rows, messages } = project([
    userTurn('what happened'),
    assistantFrame('msg_replay', [{ type: 'text', text: 'a'.repeat(80) }]),
  ])
  expect(kinds(rows)).toEqual(['user-text', 'assistant-text'])
  expect(selectLiveTokenEstimate(rows, messages)).toBe(20)
})

test('no operator turn in view reports nothing rather than a large wrong number', () => {
  const { rows, messages } = project([
    messageStart('msg_orphan', { output_tokens: 1 }),
    assistantFrame('msg_orphan', [{ type: 'text', text: 'x'.repeat(400) }]),
    messageDelta({ output_tokens: 9999 }),
    messageStop(),
  ])
  expect(kinds(rows)).toEqual(['assistant-text'])
  expect(selectLiveTokenEstimate(rows, messages)).toBe(0)
})
