import { describe, expect, test } from 'bun:test'
import { PROTOCOL_VERSION, type ServerFrame } from '../../shared/protocol.js'
import { createOutputTokenState, reduceOutputTokenState, selectOutputTokens, UNAVAILABLE_OUTPUT_TOKENS, type OutputTokenState } from './outputTokenState.js'
import { createRawMessageLogState, reduceServerFrame, selectRawMessageLog, DEFAULT_MAX_RAW_MESSAGES, DEFAULT_MAX_RAW_MESSAGE_BYTES } from './rawMessageLog.js'

// Deliberately permit malformed payloads: these tests exercise the receiving boundary.
const frame = (value: object, sessionId = 's'): ServerFrame => ({ protocolVersion: PROTOCOL_VERSION, sessionId, ...value }) as ServerFrame
const ready = (activeTurn = false, engineSessionId = 'engine') => frame({ kind: 'ready', engineSessionId, payload: {
  type: 'app.ready', protocolVersion: 1, activeTurn, inputEnabled: !activeTurn,
  abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [],
} })
const active = (activeTurn = true) => frame({ kind: 'event', event: { type: 'turn.status', activeTurn } })
const msg = (message: object, flags = {}) => frame({ kind: 'event', ...flags, event: { type: 'message', message } })
let sequence = 0
const traced = (f: ServerFrame, streamEpoch = 'sidecar-stream', seq = ++sequence): ServerFrame => ({
  ...f, deliveryTrace: {
    streamEpoch, sequence: seq, traceId: `trace-${seq}`, deliveryAttempt: 1, replay: false,
    sourceProcessInstanceId: 'sidecar', sourceWallTimestamp: '2026-10-30T00:00:00.000Z',
    sourceMonotonicTimestampMs: seq, connectionEpoch: 1,
  },
})
const stream = (event: object, extra = {}) => {
  const f = traced(msg({ type: 'stream_event', parent_tool_use_id: null, event, ...extra }))
  if (f.kind === 'event' && f.event.type === 'message') {
    f.event.message.uuid ??= `stream-${f.deliveryTrace!.sequence}`
  }
  return f
}
const start = (id = 'r', output_tokens = 0) => stream({ type: 'message_start', message: { id, model: 'provider', usage: { output_tokens } } })
const block = (index = 0, type = 'text', initial = '') => stream({ type: 'content_block_start', index, content_block: { type, text: initial, thinking: initial } })
const delta = (text = 'abcd', index = 0, type = 'text_delta') => stream({ type: 'content_block_delta', index, delta: { type, text, thinking: text, partial_json: text } })
const usage = (output_tokens: unknown) => stream({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens } })
const stop = () => stream({ type: 'message_stop' })
const assistant = (id = 'r', uuid = 'a', text = 'abcd', output_tokens: unknown = undefined, stop_reason: unknown = null, extra = {}) => msg({
  type: 'assistant', uuid, parent_tool_use_id: null, message: { id, model: 'provider', content: [{ type: 'text', text }], usage: { output_tokens }, stop_reason }, ...extra,
})
const feed = (s: OutputTokenState, ...frames: ServerFrame[]) => reduceOutputTokenState(s, { type: 'frames', frames })
const live = () => feed(createOutputTokenState(), ready(), active())
const reading = (s: OutputTokenState) => selectOutputTokens(s, 's')
const estimated = (tokens: number) => ({ tokens, quality: 'estimated' as const })
const reported = (tokens: number) => ({ tokens, quality: 'reported' as const })
const completed = (id: string, tokens: number) => [start(id), usage(tokens), stop()]

describe('frame-driven main-turn output', () => {
  test('stable unavailable default and immutable prior state', () => {
    const original = live()
    const next = feed(original, start(), block(), delta())
    expect(reading(original)).toEqual(reported(0))
    expect(reading(next)).toEqual(estimated(1))
    expect(selectOutputTokens(original, null)).toBe(UNAVAILABLE_OUTPUT_TOKENS)
    expect(selectOutputTokens(original, 'absent')).toBe(UNAVAILABLE_OUTPUT_TOKENS)
    expect(feed(original).sessions.get('s')).toBe(original.sessions.get('s'))
  })

  test('initial content, two text blocks, thinking, and forming tool JSON use explicit indexes', () => {
    let s = feed(live(), start(), block(0, 'text', 'abcd'), delta(), block(1, 'text', 'abcd'), delta('abcd', 1),
      block(2, 'thinking', 'abcd'), delta('abcd', 2, 'thinking_delta'),
      block(3, 'tool_use'), delta('x'.repeat(40_000), 3, 'input_json_delta'))
    expect(reading(s)).toEqual(estimated(10006))
    s = feed(s, assistant('r', 'a', 'x'.repeat(40_000)), assistant('r', 'b', 'more'), usage(80), stop())
    expect(reading(s)).toEqual(reported(80))
  })

  test('signatures, encrypted/redacted thinking, input/context/cache/reasoning totals are not added', () => {
    const s = feed(live(), start(), block(0, 'redacted_thinking', 'x'.repeat(1000)), delta('secret', 0, 'signature_delta'),
      block(1, 'thinking'), delta('abcd', 1, 'thinking_delta'), delta('secret', 1, 'signature_delta'),
      stream({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7, input_tokens: 1000, reasoning_tokens: 99, cache_read_input_tokens: 900 } }), stop())
    expect(reading(s)).toEqual(reported(7))
  })

  test.each([0, 1])('start-%s and bare stop never become reported', initial => {
    expect(reading(feed(live(), start('r', initial), block(), delta('abcdefgh'), stop()))).toEqual(estimated(2))
    expect(reading(feed(live(), start('r', initial), stop()))).toEqual(estimated(0))
  })

  test('cumulative delta replacement only becomes reported on stop', () => {
    let s = feed(live(), start(), block(), delta(), usage(10), usage(20))
    expect(reading(s)).toEqual(estimated(1))
    s = feed(s, stop(), stop(), assistant('r', 'final', '', 99, 'end_turn'))
    expect(reading(s)).toEqual(reported(20))
  })

  test('duplicate UUID-bearing stream batches do not duplicate deltas or reopen responses', () => {
    const frames = [start(), block(), delta('abcdefgh'), usage(10), stop()].map((f, i) => {
      if (f.kind !== 'event' || f.event.type !== 'message') throw new Error('fixture')
      return { ...f, event: { ...f.event, message: { ...f.event.message, uuid: `stream-${i}` } } } as ServerFrame
    })
    const partial = feed(live(), ...frames.slice(0, 3), ...frames.slice(0, 3))
    expect(reading(partial)).toEqual(estimated(2))
    expect(reading(feed(partial, ...frames, ...frames))).toEqual(reported(10))
  })

  test('orphan output and malformed block indexes invalidate rather than showing a partial total', () => {
    for (const frames of [[delta()], [start(), delta()], [start(), block(-1)], [start(), block(1.5)]]) {
      expect(reading(feed(live(), ...frames))).toBe(UNAVAILABLE_OUTPUT_TOKENS)
    }
    expect(reading(feed(live(), start(), block(), delta(), usage(20), usage(-1), stop()))).toEqual(estimated(1))
  })

  test('nested stream interleaving does not steal the main response association', () => {
    const s = feed(live(), start(), block(), delta(),
      stream({ type: 'message_start', message: { id: 'nested' } }, { parent_tool_use_id: 'worker' }),
      stream({ type: 'message_stop' }, { parent_tool_use_id: 'worker' }),
      delta(), usage(20), stop())
    expect(reading(s)).toEqual(reported(20))
  })

  test('explicit empty final zero is reported, visible output zero stays estimated', () => {
    expect(reading(feed(live(), start(), usage(0), stop()))).toEqual(reported(0))
    expect(reading(feed(live(), start(), block(), delta('abcdefgh'), usage(0), stop()))).toEqual(estimated(2))
    expect(reading(feed(live(), assistant('r', 'a', 'abcdefgh', 0, 'end_turn')))).toEqual(estimated(2))
  })

  test.each([-1, 1.5, Infinity, NaN, '20', null, {}, undefined])('rejects malformed usage %p', n => {
    expect(reading(feed(live(), start(), block(), delta(), usage(n), stop()))).toEqual(estimated(1))
    expect(reading(feed(live(), assistant('r', 'a', 'abcd', n, 'end_turn')))).toEqual(estimated(1))
  })

  test('assistant-only frames deduplicate UUIDs, group same response, and require valid final evidence', () => {
    let s = feed(live(), assistant('r', 'a', 'abcd', 1), assistant('r', 'b', 'abcdefgh', 1), assistant('r', 'a', 'abcd', 1))
    expect(reading(s)).toEqual(estimated(3))
    s = feed(s, assistant('r', 'c', '', 50, 'end_turn'), assistant('r', 'c', '', 50, 'end_turn'))
    expect(reading(s)).toEqual(reported(50))
    expect(reading(feed(live(), assistant('r', 'a', 'abcd', 50, 'bogus')))).toEqual(estimated(1))
  })

  test('stream ownership discards all assistant estimates rather than inferring block correspondence', () => {
    let s = feed(live(), assistant('r', 'a', 'x'.repeat(80)), start(), block(0, 'text', 'abcd'), block(1, 'text', 'abcdefgh'))
    expect(reading(s)).toEqual(estimated(3))
    s = feed(s, assistant('r', 'b', 'x'.repeat(100)), stop())
    expect(reading(s)).toEqual(estimated(3))
  })

  test('empty stream scaffolding without countable content leaves assistant-only estimation available', () => {
    const s = feed(live(), start(), block(), assistant('r', 'a', 'abcdefgh'), stop())
    expect(reading(s)).toEqual(estimated(2))
  })

  test('live nonstreaming fallback is final, but does not erase an abandoned response', () => {
    expect(reading(feed(live(), assistant('fallback', 'a', 'abcd', 80, 'end_turn')))).toEqual(reported(80))
    const s = feed(live(), start('abandoned'), block(), delta('abcdefgh'),
      msg({ type: 'system', subtype: 'api_retry' }), assistant('fallback', 'a', 'abcd', 80, 'end_turn'))
    expect(reading(s)).toEqual(estimated(82))
  })

  test('assistant final evidence can close an abandoned stream, but not an actively streaming response', () => {
    let s = feed(live(), start('old'), block(), delta(), assistant('old', 'a', '', 10, 'end_turn'))
    expect(reading(s)).toEqual(estimated(10))
    s = feed(s, start('new'), block(), delta(), assistant('old', 'b', '', 10, 'end_turn'), usage(20), stop())
    expect(reading(s)).toEqual(reported(30))
  })

  test('retry replacement keeps unfinished output separate and does not transfer usage', () => {
    let s = feed(live(), start('old'), block(), delta('abcdefgh'), start('new'), block(), delta(), usage(20), stop())
    expect(reading(s)).toEqual(estimated(22))
    s = feed(s, start('old'))
    expect(reading(s)).toBe(UNAVAILABLE_OUTPUT_TOKENS)
  })

  test('nested workers and synthetic/errors never contribute, including after a later turn starts', () => {
    let s = feed(live(), ...completed('old', 100), active(false), active())
    s = feed(s, assistant('worker', 'w', 'x'.repeat(100), 500, 'end_turn', { parent_tool_use_id: 'old-worker' }),
      assistant('fg', 'fg', 'x'.repeat(100), 500, 'end_turn', { parent_tool_use_id: 'foreground' }),
      assistant('err', 'e', 'x'.repeat(100), 500, 'end_turn', { error: 'max_output_tokens' }),
      msg({ type: 'assistant', uuid: 'syn', message: { id: 'syn', model: '<synthetic>', content: [{ type: 'text', text: 'refusal' }], usage: { output_tokens: 500 }, stop_reason: 'refusal' } }),
      stream({ type: 'message_start', message: { id: 'nested', model: 'provider' } }, { parent_tool_use_id: 'worker' }),
      stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'secret' } }, { parent_tool_use_id: 'worker' }),
      ...completed('real', 17))
    expect(reading(s)).toEqual(reported(17))
  })

  test('peer-only turns open on lifecycle edge; peer/task/operator input midturn does not reset', () => {
    const input = (kind?: string) => msg({ type: 'user', message: { role: 'user', content: 'follow-up' }, ...(kind ? { origin: { kind } } : {}) })
    let s = feed(live(), input('peer'), ...completed('r', 200), input('peer'), input('task-notification'), input(), active(), ready())
    expect(reading(s)).toEqual(reported(200))
    s = feed(s, active(false), input('peer'), active(), ...completed('next', 7))
    expect(reading(s)).toEqual(reported(7))
  })

  test('ordered lifecycle transitions in one batch equal split batches; compaction does not reset', () => {
    const frames = [ready(), active(), ...completed('first', 100), active(false), active(),
      msg({ type: 'system', subtype: 'compact_boundary' }), ...completed('second', 20)]
    const batch = feed(createOutputTokenState(), ...frames)
    const split = frames.reduce((s, f) => feed(s, f), createOutputTokenState())
    expect(reading(batch)).toEqual(reported(20))
    expect(reading(batch)).toEqual(reading(split))
  })

  test('late output after closure is ignored and sessions stay independent', () => {
    let s = feed(live(), ...completed('r', 11), active(false), assistant('late', 'late', 'abcd', 100, 'end_turn'))
    expect(reading(s)).toEqual(reported(11))
    s = feed(s, ...[ready(), active(), ...completed('other', 70)].map(f => ({ ...f, sessionId: 'other' })))
    expect(reading(s)).toEqual(reported(11))
    expect(selectOutputTokens(s, 'other')).toEqual(reported(70))
    expect(reading(reduceOutputTokenState(s, { type: 'session-removed', sessionId: 's' }))).toBe(UNAVAILABLE_OUTPUT_TOKENS)
  })
})

describe('bootstrap and recovery are deliberately unavailable', () => {
  test('unmarked compacted buffer with historical brackets never seeds accounting', () => {
    let s = reduceOutputTokenState(createOutputTokenState(), { type: 'frames', baseline: true, frames: [ready(), active(), assistant('past', 'past', 'abcd', 8000, 'end_turn'), active(false), active(), start()] })
    expect(reading(s)).toBe(UNAVAILABLE_OUTPUT_TOKENS)
    s = feed(s, block(), delta(), usage(50), stop(), active())
    expect(reading(s)).toBe(UNAVAILABLE_OUTPUT_TOKENS)
    s = feed(s, active(false), active(), ...completed('new', 9))
    expect(reading(s)).toEqual(reported(9))
  })

  test('empty bootstrap permits first live idle-to-active batch; bootstrap ending idle also permits it', () => {
    let s = reduceOutputTokenState(createOutputTokenState(), { type: 'frames', baseline: true, frames: [] })
    expect(reading(feed(s, ready(), active(), ...completed('r', 10)))).toEqual(reported(10))
    s = reduceOutputTokenState(createOutputTokenState(), { type: 'frames', baseline: true, frames: [ready(), active(), active(false)] })
    expect(reading(feed(s, active(), ...completed('r', 11)))).toEqual(reported(11))
  })

  test('restored/backfilled message and turn frames cannot mutate current accounting', () => {
    let s = feed(live(), ...completed('real', 8))
    for (const flags of [{ replay: true }, { recovered: true }, { replay: true, recovered: true }]) {
      s = feed(s, ...[active(false), active(), assistant('past', 'past', 'abcd', 8000, 'end_turn')].map(f => ({ ...f, ...flags }) as ServerFrame))
    }
    expect(reading(s)).toEqual(reported(8))
  })

  test('ready while active is unavailable; repeated ready cannot reset a known epoch', () => {
    const s = feed(createOutputTokenState(), ready(true), start(), block(), delta(), usage(80), stop())
    expect(reading(s)).toBe(UNAVAILABLE_OUTPUT_TOKENS)
    expect(reading(feed(s, active(false), active(), ...completed('new', 12), ready(true)))).toEqual(reported(12))
  })

  test.each(['disconnected', 'failed', 'exited'])('replacement with reused identity after %s invalidates', status => {
    let s = feed(live(), ...completed('r', 80), frame({ kind: 'lifecycle', status }), ready(true), assistant('past', 'p', '', 1000, 'end_turn'))
    expect(reading(s)).toBe(UNAVAILABLE_OUTPUT_TOKENS)
    s = feed(s, active(false), active(), ...completed('new', 5))
    expect(reading(s)).toEqual(reported(5))
  })

  test('engine change, startup error, transcript reset and preview-to-live reset stay conservative', () => {
    const known = feed(live(), ...completed('r', 80))
    for (const f of [ready(true, 'replacement'), frame({ kind: 'error', code: 'session_not_ready' }), frame({ kind: 'transcript.reset' })]) {
      expect(reading(feed(known, f, active(), assistant('past', 'p', '', 1000, 'end_turn')))).toBe(UNAVAILABLE_OUTPUT_TOKENS)
    }
    const reset = reduceOutputTokenState(known, { type: 'session-reset', sessionId: 's' })
    expect(reading(feed(reset, active(), start()))).toBe(UNAVAILABLE_OUTPUT_TOKENS)
    expect(reading(feed(reset, active(false), active(), ...completed('new', 6)))).toEqual(reported(6))
    const idleReset = reduceOutputTokenState(feed(known, active(false)), { type: 'session-reset', sessionId: 's' })
    expect(reading(feed(idleReset, active(), ...completed('new', 6)))).toEqual(reported(6))
  })
})

describe('bookkeeping and raw retention are independent', () => {
  test.each([
    { metadata: true, shape: 'many' },
    { metadata: false, shape: 'many' },
    { metadata: true, shape: 'long' },
    { metadata: false, shape: 'long' },
  ])('more than 8192 UUID-bearing chunks: $shape responses, metadata=$metadata', ({ metadata, shape }) => {
    const frames: ServerFrame[] = []
    let expected = 0
    if (shape === 'many') {
      for (let i = 0; i < 600; i++) {
        frames.push(start(`response-${i}`), block())
        for (let j = 0; j < 15; j++) frames.push(delta())
        frames.push(usage(100), stop())
        expected += 100
      }
    } else {
      frames.push(start('long'), block())
      for (let j = 0; j < 9000; j++) frames.push(delta('x'.repeat(1200)))
      frames.push(usage(58001), stop())
      expected = 58001
    }
    const delivered = metadata ? frames : frames.map(({ deliveryTrace: _trace, ...f }) => f as ServerFrame)
    let raw = reduceServerFrame(createRawMessageLogState(), ready())
    for (const f of delivered) raw = reduceServerFrame(raw, f)
    const log = selectRawMessageLog(raw, 's')
    expect(log.truncated).toBe(true)
    if (shape === 'many') expect(log.messages.length).toBe(DEFAULT_MAX_RAW_MESSAGES)
    else {
      expect(log.messages.length).toBeLessThan(DEFAULT_MAX_RAW_MESSAGES)
      expect(log.retainedBytes).toBeLessThanOrEqual(DEFAULT_MAX_RAW_MESSAGE_BYTES)
    }
    // Multiple reducer calls also exercise copying the compact bookkeeping.
    let s = live()
    for (let i = 0; i < delivered.length; i += 128) s = feed(s, ...delivered.slice(i, i + 128))
    expect(reading(s)).toEqual(reported(expected))
    expect(s.sessions.get('s')!.recentStreamIds.size).toBeLessThanOrEqual(256)
    expect(s.sessions.get('s')!.responses.size).toBe(shape === 'many' ? 600 : 1)
  })

  test('sequence high-water ignores stale chunks, stops, and turn boundaries during a later response/turn', () => {
    const oldStart = start('old')
    const oldChunk = delta('x'.repeat(1000))
    const oldStop = stop()
    const oldIdle = traced(active(false))
    let s = feed(live(), oldStart, block(), oldChunk)
    // Build these in delivery order rather than in fixture creation order.
    const suffix = [usage(10), stop()]
    s = feed(s, ...suffix)
    const newTurn = [traced(active(false)), traced(active()), start('new'), block(), delta('abcd')]
    s = feed(s, ...newTurn)
    const before = reading(s)
    s = feed(s, oldChunk, oldStop, oldStart, oldIdle, ...suffix)
    expect(reading(s)).toEqual(before)
    expect(reading(feed(s, usage(20), stop()))).toEqual(reported(20))
  })

  test('metadata-free recent duplicate batches are bounded; old response restarts invalidate rather than steal ownership', () => {
    const withoutTrace = ({ deliveryTrace: _trace, ...f }: ServerFrame) => f as ServerFrame
    const old = [start('old'), block(), delta(), usage(10), stop()].map(withoutTrace)
    let s = feed(live(), ...old, ...old)
    expect(reading(s)).toEqual(reported(10))
    const next = [start('next'), block(), ...Array.from({ length: 300 }, () => delta())].map(withoutTrace)
    s = feed(s, ...next)
    expect(reading(s)).toEqual(estimated(310))
    expect(reading(feed(s, ...old))).toBe(UNAVAILABLE_OUTPUT_TOKENS)
  })

  test('delivery epoch changes invalidate, malformed sequences invalidate, and reset preserves stale-delivery protection', () => {
    const old = [start('old'), block(), delta(), usage(10), stop()]
    const known = feed(live(), ...old)
    expect(reading(feed(known, traced(delta(), 'other-process')))).toBe(UNAVAILABLE_OUTPUT_TOKENS)
    expect(reading(feed(known, traced(delta(), 'sidecar-stream', -1)))).toBe(UNAVAILABLE_OUTPUT_TOKENS)
    let reset = reduceOutputTokenState(feed(known, active(false)), { type: 'session-reset', sessionId: 's' })
    reset = feed(reset, active(), start('new'), block(), delta())
    expect(reading(feed(reset, ...old))).toEqual(estimated(1))
  })

  test.each(['count', 'bytes'])('default raw-log %s cap does not discard reported totals', cap => {
    let s = live()
    let raw = reduceServerFrame(createRawMessageLogState(), ready())
    const output = [...completed('response', 58001)]
    const count = cap === 'count' ? DEFAULT_MAX_RAW_MESSAGES + 1 : 10
    const text = cap === 'bytes' ? 'x'.repeat(Math.ceil(DEFAULT_MAX_RAW_MESSAGE_BYTES / 8)) : 'padding'
    const frames = [...output, ...Array.from({ length: count }, () => msg({ type: 'user', message: { role: 'user', content: text } }))]
    // Feed the real raw reducer with default production limits beside accounting.
    for (const f of frames) raw = reduceServerFrame(raw, f)
    s = feed(s, ...frames)
    expect(selectRawMessageLog(raw, 's').truncated).toBe(true)
    expect(selectRawMessageLog(raw, 's').messages.some(m => m.type === 'stream_event')).toBe(false)
    expect(reading(s)).toEqual(reported(58001))
  })

  test.each(['response', 'assistant', 'block', 'identifier'])('%s cap hides subtotal, releases bookkeeping, and next turn recovers', cap => {
    const known = completed('known', 100)
    let frames: ServerFrame[]
    if (cap === 'response') frames = Array.from({ length: 4097 }, (_, i) => assistant(`r${i}`, `a${i}`, '', 1, 'end_turn'))
    else if (cap === 'assistant') frames = Array.from({ length: 8193 }, (_, i) => assistant('r', `a${i}`, 'abcd'))
    else if (cap === 'block') frames = [start(), ...Array.from({ length: 1025 }, (_, i) => block(i))]
    else frames = [start('x'.repeat(257))]
    let s = feed(live(), ...known, ...frames)
    expect(reading(s)).toBe(UNAVAILABLE_OUTPUT_TOKENS)
    const session = s.sessions.get('s')!
    expect(session.responses.size).toBe(0)
    expect(session.assistantIds.size).toBe(0)
    expect(session.blocks.size).toBe(0)
    s = feed(s, active(false), active(), ...completed('new', 3))
    expect(reading(s)).toEqual(reported(3))
  })

  test('bounded identifiers apply to assistant UUID and API IDs; no content survives in state', () => {
    expect(reading(feed(live(), assistant('r', 'x'.repeat(257))))).toBe(UNAVAILABLE_OUTPUT_TOKENS)
    const secret = 'NEVER_RETAIN_THIS_TEXT'
    const s = feed(live(), start(), block(), delta(secret), assistant('r', 'a', secret))
    const session = s.sessions.get('s')!
    expect(JSON.stringify([...session.responses])).not.toContain(secret)
    expect(JSON.stringify([...session.blocks])).not.toContain(secret)
  })
})
