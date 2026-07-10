import { describe, expect, test } from 'bun:test'

import type { Message } from '../types/message.js'
import {
  finalContextTokensFromLastResponse,
  getCacheHitRate,
  getCurrentUsage,
  getDisplayedTokenCountFromUsage,
  getFreshInputTokens,
  getTotalInputTokens,
  tokenCountWithEstimation,
} from './tokens.js'

function createUserMessage(text: string): Message {
  return {
    type: 'user',
    uuid: `user-${text}`,
    timestamp: '2026-04-21T00:00:00.000Z',
    message: {
      role: 'user',
      content: text,
    },
  }
}

function createThinkingMessage({
  signature,
  thinking = '',
}: {
  signature: string
  thinking?: string
}): Message {
  return {
    type: 'assistant',
    uuid: `thinking-${signature.length}-${thinking.length}`,
    message: {
      id: `msg-thinking-${signature.length}-${thinking.length}`,
      model: 'gpt-5.6-luna',
      role: 'assistant',
      content: [
        {
          type: 'thinking',
          thinking,
          signature,
        },
      ],
    },
  }
}

function createAssistantUsageMessage(overrides?: {
  iterations?: Array<{ input_tokens: number; output_tokens: number }>
}): Message {
  return {
    type: 'assistant',
    uuid: 'assistant-usage',
    message: {
      id: 'msg-usage',
      model: 'gpt-5.6-luna',
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'done',
        },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 7,
        ...(overrides?.iterations ? { iterations: overrides.iterations } : {}),
      },
    },
  } as Message
}

describe('getTotalInputTokens', () => {
  test('empty usage returns 0', () => {
    expect(getTotalInputTokens({ input_tokens: 0, output_tokens: 0 })).toBe(0)
  })

  test('native Anthropic-like usage sums all three buckets', () => {
    expect(
      getTotalInputTokens({
        input_tokens: 1000,
        output_tokens: 200,
        cache_creation_input_tokens: 500,
        cache_read_input_tokens: 3000,
      }),
    ).toBe(4500)
  })

  test('Codex-adapter-emitted usage: creation is 0, fields sum correctly', () => {
    expect(
      getTotalInputTokens({
        input_tokens: 3276,
        output_tokens: 500,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 13824,
      }),
    ).toBe(17100)
  })

  test('undefined cache fields treated as 0', () => {
    expect(
      getTotalInputTokens({ input_tokens: 500, output_tokens: 100 }),
    ).toBe(500)
  })
})

describe('getCacheHitRate', () => {
  test('all-zero usage returns 0, not NaN', () => {
    expect(getCacheHitRate({ input_tokens: 0, output_tokens: 0 })).toBe(0)
  })

  test('native Anthropic: rate = read / (input + creation + read)', () => {
    const rate = getCacheHitRate({
      input_tokens: 1000,
      output_tokens: 200,
      cache_creation_input_tokens: 500,
      cache_read_input_tokens: 3000,
    })
    expect(rate).toBeCloseTo(3000 / 4500)
  })

  test('Codex adapter path: rate ≈ 0.808, not 4.22', () => {
    const rate = getCacheHitRate({
      input_tokens: 3276,
      output_tokens: 500,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 13824,
    })
    expect(rate).toBeCloseTo(13824 / 17100)
    expect(rate).toBeLessThan(1)
  })

  test('only cache reads: rate = 1.0', () => {
    expect(
      getCacheHitRate({
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 1000,
      }),
    ).toBe(1.0)
  })

  test('undefined cache_creation_input_tokens treated as 0, no NaN', () => {
    const rate = getCacheHitRate({
      input_tokens: 500,
      output_tokens: 100,
      cache_read_input_tokens: 500,
    })
    expect(rate).toBeCloseTo(0.5)
    expect(Number.isNaN(rate)).toBe(false)
  })
})

describe('getFreshInputTokens', () => {
  test('excludes cache reads', () => {
    expect(
      getFreshInputTokens({
        input_tokens: 3276,
        output_tokens: 500,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 13824,
      }),
    ).toBe(3276)
  })

  test('includes cache creation writes', () => {
    expect(
      getFreshInputTokens({
        input_tokens: 1000,
        output_tokens: 200,
        cache_creation_input_tokens: 500,
        cache_read_input_tokens: 3000,
      }),
    ).toBe(1500)
  })

})

describe('getDisplayedTokenCountFromUsage', () => {
  test('returns 0 when usage is missing', () => {
    expect(getDisplayedTokenCountFromUsage(undefined)).toBe(0)
  })

  test('excludes cache reads from headline token count', () => {
    expect(
      getDisplayedTokenCountFromUsage({
        input_tokens: 3276,
        output_tokens: 500,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 13824,
      }),
    ).toBe(3776)
  })

})

describe('reasoning-aware token accounting', () => {
  test('getCurrentUsage trusts server usage; no historical-reasoning estimate added', () => {
    const usage = getCurrentUsage([
      createThinkingMessage({ signature: 'x'.repeat(40) }),
      createThinkingMessage({ signature: 'y'.repeat(40), thinking: 'visible reasoning' }),
      createUserMessage('question'),
      createAssistantUsageMessage(),
    ])

    expect(usage).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 7,
    })
  })

  test('finalContextTokensFromLastResponse trusts server usage; no estimate added', () => {
    expect(
      finalContextTokensFromLastResponse([
        createThinkingMessage({ signature: 'x'.repeat(40) }),
        createUserMessage('question'),
        createAssistantUsageMessage(),
      ]),
    ).toBe(120)
  })

  test('tokenCountWithEstimation trusts server usage; no estimate added', () => {
    expect(
      tokenCountWithEstimation([
        createThinkingMessage({ signature: 'x'.repeat(40) }),
        createUserMessage('question'),
        createAssistantUsageMessage(),
      ]),
    ).toBe(130)
  })

  // Regression: Codex agents emit {input_tokens:0, output_tokens:0} seed usage
  // on tool-use sub-records. tokenCountWithEstimation must skip them and anchor
  // on the last record with real usage, not read the context as ~0 (which made
  // autocompact never fire until the API 413'd at >100% of the window).
  test('skips zero-context Codex seed usage and anchors on real usage', () => {
    const zeroSeed: Message = {
      type: 'assistant',
      uuid: 'assistant-zero-seed',
      message: {
        id: 'msg-codex-toolcall',
        model: 'gpt-5.6-luna',
        role: 'assistant',
        content: [{ type: 'text', text: 'tool call split' }],
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    } as Message
    // Anchors on the real usage (130) and rough-estimates the trailing
    // zero-seed record's content, rather than collapsing the base to ~0.
    const count = tokenCountWithEstimation([
      createAssistantUsageMessage(),
      zeroSeed,
    ])
    expect(count).toBeGreaterThanOrEqual(130)
    expect(count).toBeLessThan(200)
  })
})

describe('post-compaction preserved-segment skip', () => {
  // A kept-tail assistant carries its PRE-compaction usage (huge input_tokens).
  // The boundary records the kept range as head/tail UUIDs. Usage walks must
  // skip it so the context reads small again, not stale-full.
  function staleAssistant(uuid: string): Message {
    return {
      type: 'assistant',
      uuid,
      message: {
        id: `msg-${uuid}`,
        model: 'gpt-5.6-luna',
        role: 'assistant',
        content: [{ type: 'text', text: 'pre-compact reply' }],
        usage: {
          input_tokens: 180_000, // ~full window before compaction
          output_tokens: 500,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    } as Message
  }

  function boundary(headUuid: string, tailUuid: string): Message {
    return {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: 'compact-boundary',
      timestamp: '2026-04-21T00:00:00.000Z',
      compactMetadata: {
        preservedSegment: { headUuid, anchorUuid: headUuid, tailUuid },
      },
    } as Message
  }

  // [boundary, summary(user), ...kept(stale assistant), attachment(user)]
  function postCompactMessages(): Message[] {
    const kept = staleAssistant('kept-asst')
    return [
      boundary(kept.uuid as string, kept.uuid as string),
      createUserMessage('compact summary'),
      kept,
      createUserMessage('post-compact attachment'),
    ]
  }

  test('getCurrentUsage ignores stale kept-tail usage', () => {
    expect(getCurrentUsage(postCompactMessages())).toBeNull()
  })

  test('tokenCountWithEstimation does not anchor on stale 180k usage', () => {
    // Falls through to rough estimation of the small post-compact array.
    expect(tokenCountWithEstimation(postCompactMessages())).toBeLessThan(10_000)
  })

  test('a fresh post-compact response after the kept tail still counts', () => {
    // Once the next API response lands (after tailUuid), its usage is real.
    const msgs = [...postCompactMessages(), createAssistantUsageMessage()]
    const usage = getCurrentUsage(msgs)
    expect(usage?.input_tokens).toBe(100)
  })
})

describe('gpt→claude usage-anchor invalidation (Item 2)', () => {
  // A gpt-anchored assistant whose server usage reflects the wire-TRUNCATED
  // tool outputs, followed by a large user tool_result that IS in the transcript
  // at full size. On the openai path the anchor is trusted (small); on a switch
  // to a Claude model the full transcript is sent, so the anchor understates and
  // must be invalidated in favour of a full rough estimate.
  function bigUserToolResult(): Message {
    return {
      type: 'user',
      uuid: 'user-big-tool-result',
      timestamp: '2026-04-21T00:00:00.000Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_x',
            content: 'W'.repeat(200_000), // ~50k tokens of real transcript
          },
        ],
      },
    } as Message
  }

  // Large tool_result BEFORE the anchor: the gpt server truncated it on the
  // wire, so the anchor's small usage number (130) excludes it — but the full
  // transcript sent to a Claude model contains it at full size.
  const conversation = (): Message[] => [
    createUserMessage('question'),
    bigUserToolResult(), // ~50k tokens of real transcript, PRE-anchor
    createAssistantUsageMessage(), // model gpt-5.6-luna, usage total 130 (truncated)
  ]

  test('current model still openai: trusts the anchor (no invalidation)', () => {
    const withGpt = tokenCountWithEstimation(conversation(), 'gpt-5.6-terra')
    const withNothing = tokenCountWithEstimation(conversation())
    expect(withGpt).toBe(withNothing)
    // Anchor total 130, trailing content is empty → tiny count.
    expect(withGpt).toBeLessThan(1_000)
  })

  test('switch to a claude model: invalidates the gpt anchor, full re-estimate', () => {
    const anchored = tokenCountWithEstimation(conversation(), 'gpt-5.6-terra')
    const reestimated = tokenCountWithEstimation(
      conversation(),
      'claude-sonnet-4-6',
    )
    // The gpt anchor hid the pre-anchor 50k tool_result; the full re-estimate
    // sees it. reestimated must dwarf the truncated-anchor count.
    expect(reestimated).toBeGreaterThan(40_000)
    expect(reestimated).toBeGreaterThan(anchored * 10)
  })

  test('claude→gpt is safe: an anthropic anchor is never invalidated on gpt', () => {
    // Anchor produced under claude (anthropic path already reflects full sizes).
    const claudeAnchor: Message = {
      type: 'assistant',
      uuid: 'assistant-claude-usage',
      message: {
        id: 'msg-claude-usage',
        model: 'claude-sonnet-4-6',
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 3,
          cache_read_input_tokens: 7,
        },
      },
    } as Message
    const msgs = [createUserMessage('q'), bigUserToolResult(), claudeAnchor]
    // currentModel gpt-5.6-terra must NOT invalidate a claude-produced anchor.
    const onGpt = tokenCountWithEstimation(msgs, 'gpt-5.6-terra')
    const noModel = tokenCountWithEstimation(msgs)
    expect(onGpt).toBe(noModel)
    // Anchor trusted → the pre-anchor big result is NOT re-counted.
    expect(onGpt).toBeLessThan(1_000)
  })
})
