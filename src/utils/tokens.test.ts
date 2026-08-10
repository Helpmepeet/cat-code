import { describe, expect, test } from 'bun:test'

import type { Message } from '../types/message.js'
import {
  finalContextTokensFromLastResponse,
  getCacheHitRate,
  getCurrentUsage,
  getDisplayedTokenCountFromUsage,
  getFreshInputTokens,
  getTokenUsage,
  getTotalInputTokens,
  messageTokenCountFromLastAPIResponse,
  NON_MESSAGE_REQUEST_OVERHEAD_TOKENS,
  tokenCountFromLastAPIResponse,
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
    // Falls through to rough estimation of the small post-compact array, plus
    // the non-message request overhead a pure rough estimate cannot see.
    const count = tokenCountWithEstimation(postCompactMessages())
    expect(count).toBeLessThan(NON_MESSAGE_REQUEST_OVERHEAD_TOKENS + 10_000)
    // Nowhere near the stale 180k anchor it must not have used.
    expect(count).toBeLessThan(100_000)
  })

  test('a fresh post-compact response after the kept tail still counts', () => {
    // Once the next API response lands (after tailUuid), its usage is real.
    const msgs = [...postCompactMessages(), createAssistantUsageMessage()]
    const usage = getCurrentUsage(msgs)
    expect(usage?.input_tokens).toBe(100)
  })
})

describe('compact-boundary walk floor', () => {
  // Display/telemetry callers (StatusLine, REPL, Notifications, sessionMemory)
  // pass the UNSLICED message array, and fullscreen mode keeps pre-compact
  // scrollback in it. A usage walk that ignores the boundary anchors on a
  // pre-compact record and reports a freshly-compacted session as still-full.
  // Note there is NO preservedSegment here: the stale usage sits BEFORE the
  // boundary, so the preserved-segment skip cannot help.
  function preCompactAssistant(uuid: string): Message {
    return {
      type: 'assistant',
      uuid,
      message: {
        id: `msg-${uuid}`,
        model: 'claude-sonnet-4-6',
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'pre-compact reply' }],
        usage: {
          input_tokens: 180_000,
          output_tokens: 500,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    } as Message
  }

  function bareBoundary(): Message {
    return {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: 'compact-boundary',
      timestamp: '2026-04-21T00:00:00.000Z',
      compactMetadata: {},
    } as Message
  }

  // What a fullscreen array looks like after /compact: scrollback, boundary,
  // then the summary and a short new exchange.
  function fullscreenShaped(): Message[] {
    return [
      createUserMessage('old question'),
      preCompactAssistant('old-asst'),
      bareBoundary(),
      createUserMessage('compact summary'),
      createUserMessage('new question'),
    ]
  }

  test('tokenCountWithEstimation ignores pre-boundary scrollback usage', () => {
    const count = tokenCountWithEstimation(fullscreenShaped())
    // Before the fix this anchored on the pre-boundary 180,500 usage.
    expect(count).toBeLessThan(NON_MESSAGE_REQUEST_OVERHEAD_TOKENS + 10_000)
    expect(count).toBeLessThan(100_000)
  })

  test('getCurrentUsage ignores pre-boundary scrollback usage', () => {
    expect(getCurrentUsage(fullscreenShaped())).toBeNull()
  })

  test('a post-boundary response is still anchored on normally', () => {
    const msgs = [...fullscreenShaped(), createAssistantUsageMessage()]
    expect(getCurrentUsage(msgs)?.input_tokens).toBe(100)
    // Anchor path: no overhead added, and nothing from before the boundary.
    expect(tokenCountWithEstimation(msgs)).toBeLessThan(1_000)
  })

  test('the rough fallback estimates only from the boundary onward', () => {
    // A huge pre-boundary user message (no usage anywhere) must not be counted:
    // query.ts slices it away before the request is built.
    const huge = createUserMessage('W'.repeat(400_000)) // ~100k tokens
    const withScrollback: Message[] = [
      huge,
      bareBoundary(),
      createUserMessage('compact summary'),
    ]
    const count = tokenCountWithEstimation(withScrollback)
    expect(count).toBeLessThan(NON_MESSAGE_REQUEST_OVERHEAD_TOKENS + 10_000)
    // Sanity: the same array WITHOUT a boundary does count the huge message,
    // proving the assertion above is the boundary's doing and not a dead input.
    expect(
      tokenCountWithEstimation([huge, createUserMessage('compact summary')]),
    ).toBeGreaterThan(90_000)
  })
})

describe('split-response sibling double-counting (bug #1)', () => {
  // Streaming splits one API response into several assistant records sharing
  // one message.id (claude.ts:2414-2456); only the LAST split gets the final
  // usage and stop_reason written back (claude.ts:2496-2503). The anchor's
  // output_tokens already covers every sibling's generated content, so
  // rough-counting the sibling records again is phantom context.
  const BIG_INPUT = { path: '/tmp/x.txt', content: 'W'.repeat(40_000) }

  function split(seq: number, opts: { terminal: boolean }): Message {
    return {
      type: 'assistant',
      uuid: `split-${seq}`,
      message: {
        id: 'msg-shared-response',
        model: 'claude-sonnet-4-6',
        role: 'assistant',
        // Only the terminal split carries stop_reason + final usage.
        stop_reason: opts.terminal ? 'tool_use' : null,
        content: [
          {
            type: 'tool_use',
            id: `call_${seq}`,
            name: 'Write',
            input: BIG_INPUT,
          },
        ],
        usage: opts.terminal
          ? {
              input_tokens: 50_000,
              output_tokens: 31_000,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            }
          : // message_start seed: real input_tokens, output_tokens ~1.
            {
              input_tokens: 50_000,
              output_tokens: 1,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
      },
    } as Message
  }

  function toolResult(seq: number): Message {
    return {
      type: 'user',
      uuid: `result-${seq}`,
      timestamp: '2026-04-21T00:00:00.000Z',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: `call_${seq}`, content: 'ok' },
        ],
      },
    } as Message
  }

  // Three parallel 40KB Writes, tool_results interleaved between the splits.
  function parallelWrites(terminalLast: boolean): Message[] {
    return [
      createUserMessage('write three files'),
      split(1, { terminal: false }),
      toolResult(1),
      split(2, { terminal: false }),
      toolResult(2),
      split(3, { terminal: terminalLast }),
      toolResult(3),
    ]
  }

  test('terminal anchor: sibling tool_use content is not counted again', () => {
    const count = tokenCountWithEstimation(parallelWrites(true))
    // Anchor total is 81,000. The only thing left to estimate is the trailing
    // tool_results (a few tokens). Before the fix the two earlier splits'
    // 40KB inputs were rough-counted on top, adding ~20k of phantom context.
    expect(count).toBeGreaterThanOrEqual(81_000)
    expect(count).toBeLessThan(82_000)
  })

  test('interrupted anchor (no stop_reason): sibling content IS still counted', () => {
    // The stream died before the final usage was written back, so the anchor is
    // a seed whose output_tokens is 1 and covers none of the generated content.
    // Excluding siblings here would flip an overcount into an undercount.
    const count = tokenCountWithEstimation(parallelWrites(false))
    expect(count).toBeGreaterThan(60_000)
  })

  test('interleaved tool_results are counted on both paths', () => {
    // The walk-back to the first sibling exists so these are not missed.
    const withResults = tokenCountWithEstimation(parallelWrites(true))
    const withoutResults = tokenCountWithEstimation([
      createUserMessage('write three files'),
      split(1, { terminal: false }),
      split(2, { terminal: false }),
      split(3, { terminal: true }),
    ])
    expect(withResults).toBeGreaterThan(withoutResults)
  })
})

describe('non-message request overhead on the rough fallback (bug #3a)', () => {
  test('pure rough estimate includes the overhead', () => {
    // No usage anywhere → nothing anchors → rough path.
    const count = tokenCountWithEstimation([createUserMessage('hello')])
    expect(count).toBeGreaterThanOrEqual(NON_MESSAGE_REQUEST_OVERHEAD_TOKENS)
  })

  test('an empty session still reports 0, not the overhead', () => {
    expect(tokenCountWithEstimation([])).toBe(0)
  })

  test('the anchor path never adds the overhead', () => {
    // Server usage already includes system prompt + tools + userContext.
    expect(
      tokenCountWithEstimation([
        createUserMessage('question'),
        createAssistantUsageMessage(),
      ]),
    ).toBeLessThan(1_000)
  })

  test('immediately post-compaction the overhead is still added', () => {
    const boundaryOnly: Message[] = [
      {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'compact-boundary',
        timestamp: '2026-04-21T00:00:00.000Z',
        compactMetadata: {},
      } as Message,
      createUserMessage('compact summary'),
    ]
    expect(tokenCountWithEstimation(boundaryOnly)).toBeGreaterThanOrEqual(
      NON_MESSAGE_REQUEST_OVERHEAD_TOKENS,
    )
  })
})

describe('getTokenUsage synthetic detection', () => {
  function assistantSaying(text: string, model: string): Message {
    return {
      type: 'assistant',
      uuid: `asst-${text.length}-${model}`,
      message: {
        id: 'msg-x',
        model,
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text }],
        usage: {
          input_tokens: 5_000,
          output_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    } as Message
  }

  test('a genuine reply of exactly "No response requested." keeps its usage', () => {
    // The text used to be matched against SYNTHETIC_MESSAGES, which discarded
    // this turn's real usage and fell back to an older anchor.
    const usage = getTokenUsage(
      assistantSaying('No response requested.', 'claude-sonnet-4-6'),
    )
    expect(usage?.input_tokens).toBe(5_000)
  })

  test('the same text from the synthetic model is still excluded', () => {
    expect(
      getTokenUsage(assistantSaying('No response requested.', '<synthetic>')),
    ).toBeUndefined()
  })

  test('tokenCountWithEstimation anchors on the genuine reply', () => {
    const count = tokenCountWithEstimation([
      createUserMessage('q'),
      assistantSaying('No response requested.', 'claude-sonnet-4-6'),
    ])
    expect(count).toBeGreaterThanOrEqual(5_010)
    // Anchored, so no rough-path overhead.
    expect(count).toBeLessThan(6_000)
  })
})

describe('zero-usage seed guards on every walker', () => {
  // After an interrupted Codex turn the trailing records carry the {0,0,0,0}
  // message_start seed. Anchoring on one reports the context as 0.
  const zeroSeed: Message = {
    type: 'assistant',
    uuid: 'assistant-zero-seed',
    message: {
      id: 'msg-codex-seed',
      model: 'gpt-5.6-luna',
      role: 'assistant',
      stop_reason: null,
      content: [{ type: 'text', text: 'seed' }],
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  } as Message

  const withSeed = (): Message[] => [createAssistantUsageMessage(), zeroSeed]

  test('tokenCountFromLastAPIResponse skips the seed', () => {
    expect(tokenCountFromLastAPIResponse(withSeed())).toBe(130)
  })

  test('getCurrentUsage skips the seed', () => {
    expect(getCurrentUsage(withSeed())?.input_tokens).toBe(100)
  })

  test('finalContextTokensFromLastResponse skips the seed', () => {
    expect(finalContextTokensFromLastResponse(withSeed())).toBe(120)
  })

  test('messageTokenCountFromLastAPIResponse skips the seed', () => {
    expect(messageTokenCountFromLastAPIResponse(withSeed())).toBe(20)
  })

  test('all four still return 0 when there is no real usage at all', () => {
    const onlySeeds = [zeroSeed]
    expect(tokenCountFromLastAPIResponse(onlySeeds)).toBe(0)
    expect(getCurrentUsage(onlySeeds)).toBeNull()
    expect(finalContextTokensFromLastResponse(onlySeeds)).toBe(0)
    expect(messageTokenCountFromLastAPIResponse(onlySeeds)).toBe(0)
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
            // ~67k tokens of real transcript: tool_result content is rough
            // counted at 3 chars/token as of the 2026-08-10 calibration.
            content: 'W'.repeat(200_000),
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
    bigUserToolResult(), // ~67k tokens of real transcript, PRE-anchor
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
    // The gpt anchor hid the pre-anchor 67k tool_result; the full re-estimate
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
