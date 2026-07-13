import { describe, expect, test } from 'bun:test'
import type { AssistantMessage } from '../types/message.js'
import { normalizeMessages } from './messages.js'
import { shouldShowReasoningBlock } from './reasoningDisplay.js'

type ReasoningBlock = {
  type: 'thinking'
  thinking: string
  signature: string
  reasoningKind: 'summary' | 'raw'
}

function reasoningBlock(
  reasoningKind: ReasoningBlock['reasoningKind'],
  thinking = `${reasoningKind} reasoning`,
): ReasoningBlock {
  return { type: 'thinking', thinking, signature: '', reasoningKind }
}

function visibleReasoningKinds(
  displayMode: 'off' | 'summary' | 'raw',
  content: ReasoningBlock[],
): ReasoningBlock['reasoningKind'][] {
  // claude.ts yields one AssistantMessage per content_block_stop. Sibling
  // blocks from the same provider response have distinct UUIDs but share the
  // provider message.id.
  const messages: AssistantMessage<ReasoningBlock>[] = content.map(
    (block, index) => ({
      type: 'assistant',
      uuid: `00000000-0000-0000-0000-${index.toString().padStart(12, '0')}`,
      message: {
        id: 'provider-message-1',
        role: 'assistant',
        content: [block],
      },
    }),
  )
  const normalized = normalizeMessages(messages as AssistantMessage[])

  return normalized.flatMap(row => {
    const block = row.message.content[0] as ReasoningBlock
    return shouldShowReasoningBlock(
      displayMode,
      block.reasoningKind,
      row.hasRawReasoning === true,
      block.thinking.trim().length > 0,
    )
      ? [block.reasoningKind]
      : []
  })
}

describe('shouldShowReasoningBlock', () => {
  test('raw mode falls back to the summary when no raw reasoning exists', () => {
    expect(shouldShowReasoningBlock('raw', 'summary', false)).toBe(true)
  })

  test('raw mode prefers raw reasoning when it exists', () => {
    expect(shouldShowReasoningBlock('raw', 'summary', true)).toBe(false)
    expect(shouldShowReasoningBlock('raw', 'raw', true)).toBe(true)
  })

  test('summary and off modes preserve their display contracts', () => {
    expect(shouldShowReasoningBlock('summary', 'summary', false)).toBe(true)
    expect(shouldShowReasoningBlock('summary', 'raw', true)).toBe(false)
    expect(shouldShowReasoningBlock('off', 'summary', false)).toBe(false)
    expect(shouldShowReasoningBlock('off', 'raw', true)).toBe(false)
  })

  test('normalization preserves provider-message raw availability for rendering', () => {
    expect(
      visibleReasoningKinds('raw', [
        reasoningBlock('summary'),
        reasoningBlock('raw'),
      ]),
    ).toEqual(['raw'])
    expect(visibleReasoningKinds('raw', [reasoningBlock('summary')])).toEqual([
      'summary',
    ])
    expect(visibleReasoningKinds('raw', [reasoningBlock('raw')])).toEqual([
      'raw',
    ])
    expect(
      visibleReasoningKinds('summary', [
        reasoningBlock('summary'),
        reasoningBlock('raw'),
      ]),
    ).toEqual(['summary'])
    expect(
      visibleReasoningKinds('off', [
        reasoningBlock('summary'),
        reasoningBlock('raw'),
      ]),
    ).toEqual([])
  })

  test('empty raw reasoning does not suppress the summary fallback', () => {
    expect(
      visibleReasoningKinds('raw', [
        reasoningBlock('summary'),
        reasoningBlock('raw', '   '),
      ]),
    ).toEqual(['summary'])
  })

  test('reasoning messages without provider IDs are not grouped together', () => {
    const messages: AssistantMessage<ReasoningBlock>[] = [
      {
        type: 'assistant',
        uuid: '00000000-0000-0000-0000-000000000010',
        message: {
          role: 'assistant',
          content: [reasoningBlock('summary')],
        },
      },
      {
        type: 'assistant',
        uuid: '00000000-0000-0000-0000-000000000011',
        message: {
          role: 'assistant',
          content: [reasoningBlock('raw')],
        },
      },
    ]

    expect(
      normalizeMessages(messages as AssistantMessage[]).map(
        message => message.hasRawReasoning,
      ),
    ).toEqual([false, true])
  })
})
