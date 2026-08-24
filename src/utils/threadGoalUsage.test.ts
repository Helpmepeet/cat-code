import { describe, expect, test } from 'bun:test'
import type { Message } from '../types/message.js'
import { SYNTHETIC_MODEL } from './messages.js'
import {
  MAX_CHARGED_RESPONSE_IDS,
  mergeChargedResponseIds,
  sumRealThreadGoalUsage,
} from './threadGoalUsage.js'

function assistant({
  id,
  uuid = `uuid-${id}`,
  model = 'claude-opus-5',
  input = 0,
  cacheCreation = 0,
  cacheRead = 0,
  output = 0,
}: {
  id: string
  uuid?: string
  model?: string
  input?: number
  cacheCreation?: number
  cacheRead?: number
  output?: number
}): Message {
  return {
    type: 'assistant',
    uuid,
    message: {
      id,
      model,
      usage: {
        input_tokens: input,
        cache_creation_input_tokens: cacheCreation,
        cache_read_input_tokens: cacheRead,
        output_tokens: output,
      },
    },
  } as unknown as Message
}

describe('sumRealThreadGoalUsage', () => {
  test('charges uncached input plus output, and reports cache reads separately', () => {
    const delta = sumRealThreadGoalUsage([
      assistant({
        id: 'resp-1',
        input: 100,
        cacheCreation: 50,
        cacheRead: 9_000,
        output: 25,
      }),
    ])

    expect(delta.inputTokens).toBe(150)
    expect(delta.outputTokens).toBe(25)
    expect(delta.cachedInputTokens).toBe(9_000)
    // Cache reads are excluded from the budget number: a long goal must not be
    // charged the whole window again on every turn.
    expect(delta.billableTokens).toBe(175)
    expect(delta.responseCount).toBe(1)
  })

  test('charges one API response once even when it split across records', () => {
    // Parallel tool calls stream as several assistant records that share one
    // message id AND one usage object. Summing per record would multiply the
    // response's cost by its content-block count.
    const usage = { id: 'resp-1', input: 1_000, output: 200 }
    const delta = sumRealThreadGoalUsage([
      assistant({ ...usage, uuid: 'uuid-a' }),
      assistant({ ...usage, uuid: 'uuid-b' }),
      assistant({ ...usage, uuid: 'uuid-c' }),
    ])

    expect(delta.billableTokens).toBe(1_200)
    expect(delta.responseCount).toBe(1)
    expect(delta.chargedResponseIds).toEqual(['resp-1'])
  })

  test('skips responses already charged', () => {
    const messages = [
      assistant({ id: 'resp-1', input: 1_000, output: 100 }),
      assistant({ id: 'resp-2', input: 2_000, output: 200 }),
    ]

    const first = sumRealThreadGoalUsage(messages)
    expect(first.billableTokens).toBe(3_300)

    // The same array is walked again at the next turn boundary. Nothing is
    // charged twice.
    const second = sumRealThreadGoalUsage(
      messages,
      new Set(first.chargedResponseIds),
    )
    expect(second.billableTokens).toBe(0)
    expect(second.chargedResponseIds).toEqual([])

    // A new response on the same array is charged, and only that one.
    const third = sumRealThreadGoalUsage(
      [...messages, assistant({ id: 'resp-3', input: 10, output: 5 })],
      new Set(first.chargedResponseIds),
    )
    expect(third.billableTokens).toBe(15)
    expect(third.chargedResponseIds).toEqual(['resp-3'])
  })

  test('ignores synthetic messages and non-assistant records', () => {
    const delta = sumRealThreadGoalUsage([
      assistant({ id: 'synth', model: SYNTHETIC_MODEL, input: 999, output: 999 }),
      { type: 'user', uuid: 'u1', message: { content: 'hi' } } as unknown as Message,
      { type: 'progress', uuid: 'p1' } as unknown as Message,
    ])

    expect(delta.billableTokens).toBe(0)
    expect(delta.responseCount).toBe(0)
  })

  test('charges a record with no response id exactly once, by its uuid', () => {
    const noId = {
      type: 'assistant',
      uuid: 'uuid-only',
      message: {
        model: 'claude-opus-5',
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 5,
        },
      },
    } as unknown as Message

    const delta = sumRealThreadGoalUsage([noId, noId])
    expect(delta.billableTokens).toBe(15)
    expect(delta.chargedResponseIds).toEqual(['uuid-only'])
  })
})

describe('mergeChargedResponseIds', () => {
  test('keeps the newest ids when the ledger overflows', () => {
    const existing = Array.from({ length: MAX_CHARGED_RESPONSE_IDS }, (_, i) =>
      String(i),
    )
    const merged = mergeChargedResponseIds(existing, ['new-a', 'new-b'])

    expect(merged).toHaveLength(MAX_CHARGED_RESPONSE_IDS)
    expect(merged.at(-1)).toBe('new-b')
    expect(merged).not.toContain('0')
  })

  test('adding nothing returns a copy, not the same array', () => {
    const existing = ['a', 'b']
    const merged = mergeChargedResponseIds(existing, [])

    expect(merged).toEqual(['a', 'b'])
    expect(merged).not.toBe(existing)
  })
})
