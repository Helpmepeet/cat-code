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

test('takes the MAX contextWindow across models (the main conversation window)', () => {
  const usage = selectContextUsage([
    result(
      { input_tokens: 100_000 },
      {
        'small-fast': { contextWindow: 200_000 },
        'claude-opus-4-8[1m]': { contextWindow: 1_000_000 },
      },
    ),
  ])
  expect(usage?.contextWindow).toBe(1_000_000)
  expect(usage?.percentUsed).toBe(10)
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

test('defaults the window when the result omits contextWindow (still shows the donut)', () => {
  // A frame with usage but no contextWindow (e.g. stale fixtures) falls back to the
  // 200k default rather than hiding — matches the prototype's `contextMax || 200000`.
  const usage = selectContextUsage([
    result({ input_tokens: 10_000 }, { m: { inputTokens: 10_000 } }),
  ])
  expect(usage).toEqual({ usedTokens: 10_000, contextWindow: 200_000, percentUsed: 5 })
})
