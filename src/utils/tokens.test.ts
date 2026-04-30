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
      model: 'gpt-5.4',
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
      model: 'gpt-5.4',
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
})
