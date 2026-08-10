import type { Anthropic } from '@anthropic-ai/sdk'
import { describe, expect, test } from 'bun:test'
import { jsonStringify } from '../utils/slowOperations.js'
import {
  roughTokenCountEstimationForContent,
  roughTokenCountEstimationForMessages,
} from './tokenEstimation.js'

/**
 * Shape-aware chars/token ratios (2026-08-10 calibration audit, o200k_base
 * proxy).  These tests pin which block shapes get which ratio; they are the
 * regression guard against a future edit collapsing them back to a flat 4.
 */

/** Grep-style output: no identifier density, exercises the structured ratio. */
const STRUCTURED_SEED =
  'src/services/compact/autoCompact.ts:42:  const threshold = getThreshold(model)\n'

/** UUID list: hex-and-dash saturated, trips the identifier escalator. */
const IDENTIFIER_SEED = '9f2c1b04-7a3e-4d51-b8c6-0e5a2f7d9134\n'

/** Builds a string of exactly `length` chars so expectations stay explicit. */
function padded(seed: string, length: number): string {
  return seed.repeat(Math.ceil(length / seed.length)).slice(0, length)
}

const LEN = 1200
const STRUCTURED_TEXT = padded(STRUCTURED_SEED, LEN)
const IDENTIFIER_TEXT = padded(IDENTIFIER_SEED, LEN)

function toolResult(
  content: Anthropic.ToolResultBlockParam['content'],
): Anthropic.ContentBlockParam {
  return { type: 'tool_result', tool_use_id: 'toolu_01', content }
}

describe('roughTokenCountEstimationForContent ratios', () => {
  test('text block stays at 4 chars/token', () => {
    expect(
      roughTokenCountEstimationForContent([
        { type: 'text', text: STRUCTURED_TEXT },
      ]),
    ).toBe(LEN / 4)
  })

  test('tool_result string content uses 3 chars/token', () => {
    expect(
      roughTokenCountEstimationForContent([toolResult(STRUCTURED_TEXT)]),
    ).toBe(LEN / 3)
  })

  test('text nested in a tool_result array gets the tool_result ratio, not the prose ratio', () => {
    // The discriminating case: the identical string counted as a top-level
    // text block is 300, but as tool output it is 400.
    expect(
      roughTokenCountEstimationForContent([
        toolResult([{ type: 'text', text: STRUCTURED_TEXT }]),
      ]),
    ).toBe(LEN / 3)
  })

  test('identifier-dense tool_result string escalates to 2 chars/token', () => {
    expect(
      roughTokenCountEstimationForContent([toolResult(IDENTIFIER_TEXT)]),
    ).toBe(LEN / 2)
  })

  test('a tool_result string below the density threshold is not escalated', () => {
    // Grep output measures ~0.23 hex-and-dash density against a 0.65
    // threshold, so ordinary code and prose output must stay at 3.
    expect(
      roughTokenCountEstimationForContent([toolResult(STRUCTURED_TEXT)]),
    ).not.toBe(LEN / 2)
  })

  test('density is sampled from the leading 4KB only, so the check stays bounded', () => {
    // Documented tradeoff: a result that opens with 4KB of ids is treated as
    // identifier-dense even when a prose tail follows.
    const headDense = padded(IDENTIFIER_SEED, 4096) + padded(STRUCTURED_SEED, 4096)
    expect(roughTokenCountEstimationForContent([toolResult(headDense)])).toBe(
      Math.round(headDense.length / 2),
    )
  })

  test('the escalator applies to string content only, not to array items', () => {
    // Array-shaped tool results recurse at the flat structured ratio.
    expect(
      roughTokenCountEstimationForContent([
        toolResult([{ type: 'text', text: IDENTIFIER_TEXT }]),
      ]),
    ).toBe(LEN / 3)
  })

  test('tool_use input stays at 4 chars/token', () => {
    const block: Anthropic.ContentBlockParam = {
      type: 'tool_use',
      id: 'toolu_02',
      name: 'Bash',
      input: { command: STRUCTURED_TEXT },
    }
    expect(roughTokenCountEstimationForContent([block])).toBe(
      Math.round(('Bash' + jsonStringify(block.input)).length / 4),
    )
  })

  test('thinking blocks stay at 4 chars/token', () => {
    expect(
      roughTokenCountEstimationForContent([
        { type: 'thinking', thinking: STRUCTURED_TEXT, signature: 'sig' },
      ]),
    ).toBe(LEN / 4)
  })

  test('the server-tool catch-all uses 3 chars/token', () => {
    const block = {
      type: 'server_tool_use',
      id: 'srvtoolu_01',
      name: 'web_search',
      input: { query: STRUCTURED_TEXT },
    } as unknown as Anthropic.ContentBlockParam
    const serialized = jsonStringify(block)
    expect(roughTokenCountEstimationForContent([block])).toBe(
      Math.round(serialized.length / 3),
    )
    // Guard the direction: the catch-all must not fall back to the old flat 4.
    expect(roughTokenCountEstimationForContent([block])).toBeGreaterThan(
      Math.round(serialized.length / 4),
    )
  })
})

describe('roughTokenCountEstimationForMessages', () => {
  test('carries the tool_result ratio through the message walk', () => {
    // The real consumer path (src/utils/tokens.ts) counts whole messages, so
    // prove the ratio survives the message -> content -> block walk.
    const tokens = roughTokenCountEstimationForMessages([
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: STRUCTURED_TEXT }] },
      },
      {
        type: 'user',
        message: { content: [toolResult(STRUCTURED_TEXT)] },
      },
    ])
    expect(tokens).toBe(LEN / 4 + LEN / 3)
  })
})
