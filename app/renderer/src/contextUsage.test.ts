import { expect, test } from 'bun:test'
import type { SDKMessage } from '@cat-code/engine/sdk'
import { selectContextUsage } from './contextUsage.js'

/** A minimal `result` frame (SDKBaseMessage is all-optional + index-signature). */
function result(
  usage: Record<string, unknown>,
  modelUsage: Record<string, Record<string, number>>,
): SDKMessage {
  return { type: 'result', subtype: 'success', usage, modelUsage }
}

const filler: SDKMessage = { type: 'stream_event' }

test('derives percent from per-turn usage (input + both cache buckets) ÷ window', () => {
  const usage = selectContextUsage([
    result(
      { input_tokens: 40_000, cache_read_input_tokens: 8_000, cache_creation_input_tokens: 2_000 },
      { 'claude-opus-4-8': { contextWindow: 200_000 } },
    ),
  ])
  expect(usage).toEqual({ usedTokens: 50_000, contextWindow: 200_000, percentUsed: 25 })
})

test('ignores modelUsage cumulative token fields — uses the per-turn usage only', () => {
  // modelUsage.inputTokens is the whole-session cumulative (would read >100%);
  // the numerator must come from the result `usage`, not modelUsage.
  const usage = selectContextUsage([
    result(
      { input_tokens: 10_000 },
      { 'claude-opus-4-8': { contextWindow: 200_000, inputTokens: 9_999_999 } },
    ),
  ])
  expect(usage?.usedTokens).toBe(10_000)
  expect(usage?.percentUsed).toBe(5)
})

test('uses the current model window after switching away from a historical 1M model', () => {
  const usage = selectContextUsage(
    [
      result(
        { input_tokens: 100_000, cache_read_input_tokens: 20_000 },
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
    result({ input_tokens: 250_000 }, { m: { contextWindow: 200_000 } }),
  ])
  expect(usage?.percentUsed).toBe(100)
})

test('uses the LATEST result when several are present', () => {
  const usage = selectContextUsage([
    result({ input_tokens: 20_000 }, { m: { contextWindow: 200_000 } }),
    filler,
    result({ input_tokens: 120_000 }, { m: { contextWindow: 200_000 } }),
  ])
  expect(usage?.usedTokens).toBe(120_000)
  expect(usage?.percentUsed).toBe(60)
})

test('shows a 0% default gauge when no result frame yet (the prototype donut is always on)', () => {
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
      result(
        { input_tokens: 100_000 },
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
    [result({ input_tokens: 50_000 }, { 'gpt-5.6-terra': { contextWindow: 372_000 } })],
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
    result({ input_tokens: 10_000 }, { m: { inputTokens: 10_000 } }),
  ])
  expect(usage).toEqual({ usedTokens: 10_000, contextWindow: 200_000, percentUsed: 5 })
})
