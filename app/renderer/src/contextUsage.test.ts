import { expect, test } from 'bun:test'
import type { SDKMessage } from '@cat-code/engine/sdk'
import { selectContextUsage } from './contextUsage.js'

/** A minimal `result` frame (SDKBaseMessage is all-optional + index-signature).
 * Its `usage` is the session-LIFETIME accumulator (`QueryEngine.totalUsage`), so
 * these fixtures pass a deliberately huge one: no test may let it reach the
 * numerator. Only `modelUsage` is legitimate here, for the window. */
function result(
  usage: Record<string, unknown>,
  modelUsage: Record<string, Record<string, number>>,
): SDKMessage {
  return { type: 'result', subtype: 'success', usage, modelUsage }
}

/**
 * An Anthropic-shaped turn: the input and cache buckets land on `message_start`
 * and the delta carries only the final output count. Reading the delta alone
 * would score this turn at `output` tokens.
 */
function anthropicTurn(
  input: number,
  cacheRead: number,
  output: number,
  cacheCreation = 0,
): SDKMessage[] {
  return [
    {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          id: 'msg_1',
          usage: {
            input_tokens: input,
            cache_read_input_tokens: cacheRead,
            cache_creation_input_tokens: cacheCreation,
            output_tokens: 1,
          },
        },
      },
    },
    {
      type: 'stream_event',
      event: { type: 'message_delta', usage: { output_tokens: output } },
    },
    { type: 'stream_event', event: { type: 'message_stop' } },
  ]
}

/**
 * A Codex/GPT-shaped turn: the adapter seeds `{0,0,0,0}` on `message_start` and
 * fills real numbers only on the final delta (`src/utils/tokens.ts:350-355`).
 * Overwriting from the start event unconditionally would zero this turn.
 */
function codexTurn(
  input: number,
  cacheRead: number,
  output: number,
): SDKMessage[] {
  return [
    {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          id: 'msg_1',
          usage: {
            input_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: 0,
          },
        },
      },
    },
    {
      type: 'stream_event',
      event: {
        type: 'message_delta',
        usage: {
          input_tokens: input,
          cache_read_input_tokens: cacheRead,
          cache_creation_input_tokens: 0,
          output_tokens: output,
        },
      },
    },
    { type: 'stream_event', event: { type: 'message_stop' } },
  ]
}

/** A replayed assistant frame, as a preview cache or restored transcript holds
 * it: final usage, because the engine's late write-back already ran. */
function assistantFrame(
  usage: Record<string, unknown>,
  parentToolUseId: string | null = null,
): SDKMessage {
  return {
    type: 'assistant',
    message: { id: 'msg_a', model: 'gpt-5.6-sol', role: 'assistant', content: [], usage },
    parent_tool_use_id: parentToolUseId,
  }
}

const filler: SDKMessage = { type: 'stream_event' }

// ---------------------------------------------------------------------------
// Numerator: one message's context, on both provider shapes
// ---------------------------------------------------------------------------

test('Anthropic shape: folds the message_start buckets with the delta output', () => {
  // 40,000 + 8,000 + 2,000 + 900 = 50,900. Reading only the delta would give 900.
  const usage = selectContextUsage([
    ...anthropicTurn(40_000, 8_000, 900, 2_000),
    result({ input_tokens: 9_999_999 }, { 'claude-opus-4-8': { contextWindow: 200_000 } }),
  ])
  expect(usage).toEqual({
    usedTokens: 50_900,
    contextWindow: 200_000,
    percentUsed: 25,
  })
})

test('Codex shape: the zero-seeded message_start never erases the filling delta', () => {
  const usage = selectContextUsage([
    ...codexTurn(654, 29_184, 123),
    result({ input_tokens: 9_999_999 }, { 'gpt-5.6-sol': { contextWindow: 372_000 } }),
  ])
  expect(usage.usedTokens).toBe(29_961)
})

test('includes output_tokens — the engine numerator is getTokenCountFromUsage', () => {
  // src/utils/tokens.ts:52-59 sums all three input buckets PLUS output. Dropping
  // output undercounts by exactly one response, which the next request carries.
  const [start] = anthropicTurn(1_000, 0, 500)
  expect(start).toBeDefined()
  // Only the start event: output is still the streaming seed of 1.
  expect(selectContextUsage([start as SDKMessage]).usedTokens).toBe(1_001)
  // With the delta, the real output count replaces it and is counted.
  expect(selectContextUsage(anthropicTurn(1_000, 0, 500)).usedTokens).toBe(1_500)
})

// ---------------------------------------------------------------------------
// The regression this suite exists for
// ---------------------------------------------------------------------------

test('NEVER reads result.usage — it is the session-lifetime accumulator', () => {
  // `result.usage` is QueryEngine.totalUsage: seeded once in the constructor and
  // accumulated on every message_stop for the life of the session. It looks
  // per-turn because it is correct on turn one.
  const usage = selectContextUsage([
    ...anthropicTurn(600, 29_184, 100),
    result(
      {
        input_tokens: 3_000,
        cache_read_input_tokens: 233_000,
        cache_creation_input_tokens: 0,
        output_tokens: 893,
      },
      { 'gpt-5.6-sol': { contextWindow: 372_000 } },
    ),
  ])
  expect(usage.usedTokens).toBe(29_884)
  expect(usage.percentUsed).toBe(8)
})

test('a long cheap session stays flat instead of climbing ~30k per turn', () => {
  // Replay of the reference session (app 9d74a6cc / engine c5df3243), whose real
  // per-call usage is recorded in
  // docs/migration/reviews/2026-08-02-context-gauge-accumulator.md. Its gauge
  // read 48% / 177k after five trivial questions and 64% / 237k after seven,
  // while the engine's own measurement never left ~29.8k.
  const calls: Array<[number, number, number]> = [
    [29_307, 0, 12],
    [216, 29_184, 134],
    [456, 29_184, 23],
    [622, 29_184, 23],
    [654, 29_184, 123],
  ]
  const messages: SDKMessage[] = []
  let accumulated = 0
  for (const [input, cacheRead, output] of calls) {
    messages.push(...codexTurn(input, cacheRead, output))
    accumulated += input + cacheRead + output
    messages.push(
      result(
        { input_tokens: accumulated },
        { 'gpt-5.6-sol': { contextWindow: 372_000 } },
      ),
    )
  }

  const usage = selectContextUsage(messages, 'gpt-5.6-sol')
  expect(usage.usedTokens).toBe(29_961)
  expect(usage.percentUsed).toBe(8)
  // The accumulator the old gauge reported, for contrast: it must not appear.
  expect(accumulated).toBeGreaterThan(140_000)
  expect(usage.usedTokens).toBeLessThan(31_000)
})

test('subagent traffic carries its own context and never moves the gauge', () => {
  // The reference session's Agent turn was a real 19,194-token context of its own.
  const subagentTurn = anthropicTurn(19_194, 0, 14).map(message => ({
    ...message,
    parent_tool_use_id: 'toolu_sub',
  }))
  const usage = selectContextUsage([
    ...anthropicTurn(456, 29_184, 23),
    ...subagentTurn,
    assistantFrame({ input_tokens: 19_194, output_tokens: 14 }, 'toolu_sub'),
  ])
  expect(usage.usedTokens).toBe(29_663)
})

// ---------------------------------------------------------------------------
// Source precedence: stream layer live, assistant frames on replay
// ---------------------------------------------------------------------------

test('falls back to the newest assistant frame when no stream events exist', () => {
  // A preview cache or restored transcript: written after the engine's late
  // usage write-back, so these numbers are final and safe to read.
  const usage = selectContextUsage([
    assistantFrame({ input_tokens: 300, cache_read_input_tokens: 29_184, output_tokens: 40 }),
    assistantFrame({ input_tokens: 654, cache_read_input_tokens: 29_184, output_tokens: 123 }),
    result({ input_tokens: 9_999_999 }, { 'gpt-5.6-sol': { contextWindow: 372_000 } }),
  ])
  expect(usage.usedTokens).toBe(29_961)
})

test('the stream layer wins over a stale live assistant frame (S1 §4)', () => {
  // On the wire an assistant frame serialises message_start-era usage; the
  // engine's write-back mutates only its own copy. The fold is authoritative.
  const usage = selectContextUsage([
    ...anthropicTurn(654, 29_184, 123),
    assistantFrame({ input_tokens: 654, output_tokens: 1 }),
  ])
  expect(usage.usedTokens).toBe(29_961)
})

test('a Codex message_start with no delta yet holds the prior reading, not 0%', () => {
  const usage = selectContextUsage([
    assistantFrame({ input_tokens: 654, cache_read_input_tokens: 29_184, output_tokens: 123 }),
    {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          id: 'msg_2',
          usage: {
            input_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: 0,
          },
        },
      },
    },
  ])
  expect(usage.usedTokens).toBe(29_961)
})

/** The live Codex shape, which the fixture above does NOT model: the adapter's
 * zero seed reaches the assistant frames too, because every per-block sub-record
 * shares one usage object (`src/services/api/claude.ts:2436-2453`) and the app's
 * copy is serialised before the engine's late write-back. Counted against real
 * transcripts in `~/.cat-code/projects/`, only 9 of 55 gpt-5.6-sol responses
 * carried nonzero assistant usage; live ones carried none. Reading only the
 * newest group therefore dropped the donut to 0% for the whole generation of
 * every API call, several times per turn in a tool loop. */
test('a zero-seeded Codex call holds the prior call, even with all-zero assistant frames', () => {
  const zeroFrame = assistantFrame({
    input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 0,
  })
  const usage = selectContextUsage([
    ...codexTurn(654, 29_184, 123),
    zeroFrame,
    // The next API call has started; its filling delta has not arrived.
    {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          id: 'msg_2',
          usage: {
            input_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: 0,
          },
        },
      },
    },
    zeroFrame,
  ])
  expect(usage.usedTokens).toBe(29_961)
})

/** The walk-back must not cross a compaction: usage from before it measures a
 * context that no longer exists. The engine refuses the same anchor
 * (`getPreservedSegmentRange`, `src/utils/tokens.ts:60-96`). Reporting the prior
 * group here would read 81% on a session that is really at 11%. */
test('never anchors across a compact boundary, even when that means 0%', () => {
  const usage = selectContextUsage([
    ...codexTurn(654, 300_000, 123),
    { type: 'system', subtype: 'compact_boundary' },
    {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          id: 'msg_2',
          usage: {
            input_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: 0,
          },
        },
      },
    },
  ])
  expect(usage.usedTokens).toBe(0)
})

/** Compaction is stale on BOTH sides of its boundary. The kept messages are the
 * ORIGINALS, spliced in AFTER the boundary with their ORIGINAL usage
 * (`src/utils/tokens.ts:61-66`), so a floor cannot reach them. On a restored or
 * previewed session there are no stream events at all, which makes the assistant
 * fallback the only source: without the preserved-segment skip it anchors on the
 * kept tail and freezes the gauge at the pre-compact percentage. */
function compactBoundaryWithTail(): SDKMessage {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: {
      trigger: 'auto',
      pre_tokens: 300_777,
      preserved_segment: {
        head_uuid: 'uuid-head',
        anchor_uuid: 'uuid-head',
        tail_uuid: 'uuid-tail',
      },
    },
  }
}

function keptFrame(uuid: string, usage: Record<string, unknown>): SDKMessage {
  return {
    type: 'assistant',
    message: { id: `msg_${uuid}`, model: 'gpt-5.6-sol', role: 'assistant', content: [], usage },
    parent_tool_use_id: null,
    uuid,
  }
}

test('a restored compacted session skips the preserved tail rather than freezing pre-compact', () => {
  const usage = selectContextUsage([
    compactBoundaryWithTail(),
    keptFrame('uuid-head', { input_tokens: 654, cache_read_input_tokens: 300_000, output_tokens: 123 }),
    keptFrame('uuid-tail', { input_tokens: 700, cache_read_input_tokens: 300_000, output_tokens: 77 }),
  ])
  expect(usage.usedTokens).toBe(0)
})

test('a post-compaction response outranks the preserved tail it sits above', () => {
  const usage = selectContextUsage([
    compactBoundaryWithTail(),
    keptFrame('uuid-head', { input_tokens: 654, cache_read_input_tokens: 300_000, output_tokens: 123 }),
    keptFrame('uuid-tail', { input_tokens: 700, cache_read_input_tokens: 300_000, output_tokens: 77 }),
    keptFrame('uuid-fresh', { input_tokens: 11_000, output_tokens: 40 }),
  ])
  expect(usage.usedTokens).toBe(11_040)
})

test('a post-compaction call reports its own context, not the pre-compact one', () => {
  const usage = selectContextUsage([
    ...codexTurn(654, 300_000, 123),
    { type: 'system', subtype: 'compact_boundary' },
    ...codexTurn(11_000, 0, 40),
  ])
  expect(usage.usedTokens).toBe(11_040)
})

/** Each group folds only its own events. Folding to the end of the array would
 * let a newer call's delta land on an older call's start and report a context
 * that never existed. */
test('an older group never absorbs a newer call delta', () => {
  const usage = selectContextUsage([
    ...codexTurn(500, 0, 10),
    {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          id: 'msg_2',
          usage: {
            input_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: 0,
          },
        },
      },
    },
    // A REAL delta on the newer call, with buckets distinct from the older
    // call's. Folding to the end of the array would land these on the older
    // `message_start` and report 7,777 — a context that never existed. Without
    // this delta the case is only accidentally covered.
    {
      type: 'stream_event',
      event: {
        type: 'message_delta',
        usage: { cache_read_input_tokens: 7_000, output_tokens: 777 },
      },
    },
  ])
  expect(usage.usedTokens).toBe(7_777)
})

test('tolerates malformed and absent usage without throwing', () => {
  expect(selectContextUsage([{ type: 'stream_event', event: 'nonsense' }]).usedTokens).toBe(0)
  expect(
    selectContextUsage([
      { type: 'stream_event', event: { type: 'message_start', message: null } },
      { type: 'stream_event', event: { type: 'message_delta', usage: 'nope' } },
    ]).usedTokens,
  ).toBe(0)
  expect(selectContextUsage([assistantFrame({ input_tokens: 'lots' })]).usedTokens).toBe(0)
})

// ---------------------------------------------------------------------------
// Denominator: unchanged behaviour, now fed a real numerator
// ---------------------------------------------------------------------------

test('ignores modelUsage cumulative token fields', () => {
  const usage = selectContextUsage([
    ...anthropicTurn(10_000, 0, 0),
    result(
      { input_tokens: 9_999_999 },
      { 'claude-opus-4-8': { contextWindow: 200_000, inputTokens: 9_999_999 } },
    ),
  ])
  expect(usage.usedTokens).toBe(10_000)
  expect(usage.percentUsed).toBe(5)
})

test('uses the current model window after switching away from a historical 1M model', () => {
  const usage = selectContextUsage(
    [
      ...anthropicTurn(100_000, 20_000, 0),
      result(
        { input_tokens: 9_999_999 },
        {
          'claude-opus-4-8[1m]': { contextWindow: 1_000_000, inputTokens: 900_000 },
          'gpt-5.6-terra': { contextWindow: 200_000, inputTokens: 100_000 },
        },
      ),
    ],
    'gpt-5.6-terra',
  )
  expect(usage).toEqual({
    usedTokens: 120_000,
    contextWindow: 200_000,
    percentUsed: 60,
  })
})

test('clamps to 100% when the context exceeds the window', () => {
  const usage = selectContextUsage([
    ...anthropicTurn(250_000, 0, 0),
    result({ input_tokens: 9_999_999 }, { m: { contextWindow: 200_000 } }),
  ])
  expect(usage.percentUsed).toBe(100)
})

test('shows a 0% default gauge before any turn (the prototype donut is always on)', () => {
  const empty = { usedTokens: 0, contextWindow: 200_000, percentUsed: 0 }
  expect(selectContextUsage([])).toEqual(empty)
  expect(selectContextUsage([filler])).toEqual(empty)
})

/**
 * The bug: with no `result` frame there is no window anywhere in the transcript,
 * so every model divided by the 200k constant and the gauge read the same before
 * every first turn. The run-controls snapshot carries the engine-resolved window
 * for the model that is about to run, which is the only source that exists yet.
 */
test('before any turn the gauge sizes to the current model, not the 200k default', () => {
  expect(selectContextUsage([], 'claude-opus-5', 1_000_000)).toEqual({
    usedTokens: 0,
    contextWindow: 1_000_000,
    percentUsed: 0,
  })
  expect(selectContextUsage([], 'gpt-5.6-terra', 372_000).contextWindow).toBe(372_000)
  // No snapshot yet (a preview, or the moment before attach) keeps the default.
  expect(selectContextUsage([], 'claude-opus-5', null).contextWindow).toBe(200_000)
})

/**
 * After a switch, the newest result frame only knows the model that already ran,
 * so its modelUsage has no entry for the new one. That is the second state where
 * the resolved window is the only truth, and the used tokens still count.
 */
test('after a model switch the window follows the new model while usage stays real', () => {
  const usage = selectContextUsage(
    [
      ...anthropicTurn(100_000, 0, 0),
      result(
        { input_tokens: 9_999_999 },
        { 'claude-haiku-4-5-20251001': { contextWindow: 200_000 } },
      ),
    ],
    'claude-opus-5',
    1_000_000,
  )
  expect(usage).toEqual({
    usedTokens: 100_000,
    contextWindow: 1_000_000,
    percentUsed: 10,
  })
})

test('a result frame that states the window for the current model still wins', () => {
  // Same function resolved both, so they agree; the frame is the more specific
  // statement (it is what that turn actually ran under) and stays authoritative.
  const usage = selectContextUsage(
    [
      ...anthropicTurn(50_000, 0, 0),
      result({ input_tokens: 9_999_999 }, { 'gpt-5.6-terra': { contextWindow: 372_000 } }),
    ],
    'gpt-5.6-terra',
    1_000_000,
  )
  expect(usage.contextWindow).toBe(372_000)
})

test.each([0, -1, Number.NaN, null, undefined])(
  'a resolved window of %p is ignored in favour of the default',
  window => {
    expect(selectContextUsage([], 'claude-opus-5', window).contextWindow).toBe(200_000)
  },
)

test('defaults the window when the result omits contextWindow (still shows the donut)', () => {
  // A frame with usage but no contextWindow (e.g. stale fixtures) falls back to the
  // 200k default rather than hiding — matches the prototype's `contextMax || 200000`.
  const usage = selectContextUsage([
    ...anthropicTurn(10_000, 0, 0),
    result({ input_tokens: 9_999_999 }, { m: { inputTokens: 10_000 } }),
  ])
  expect(usage).toEqual({ usedTokens: 10_000, contextWindow: 200_000, percentUsed: 5 })
})
