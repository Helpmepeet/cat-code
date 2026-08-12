import { describe, expect, test } from 'bun:test'
import type { UUID } from 'crypto'
import { annotateBoundaryWithPreservedSegment } from '../services/compact/compact.js'
import type { Message } from '../types/message.js'
import {
  createAssistantMessage,
  createCompactBoundaryMessage,
  createUserMessage,
  dropPreservedMessageDuplicates,
  normalizeMessages,
} from '../utils/messages.js'

/**
 * Messages.tsx renders through Ink, which does not exit under the test runner,
 * so these cover the projection step the component applies to its `messages`
 * prop plus the wiring that makes it run. What no test here can see: how the
 * seam and the rounds below it actually look in a live terminal.
 */

/**
 * A preserving compaction as the REPL array holds it: the summarized rounds,
 * the preserved rounds where they happened, then the boundary, the summary,
 * and the SAME preserved message objects re-listed by buildPostCompactMessages.
 *
 * The first assistant message carries two content blocks on purpose. That is
 * what flips normalizeMessages into deriving fresh per-block UUIDs for every
 * later message, which is why the projection cannot run after it.
 */
function conversationWithPreservingCompaction(): {
  messages: Message[]
  keptAskUuid: string
} {
  const summarizedAsk = createUserMessage({ content: 'summarized ask' })
  const summarizedAnswer = createAssistantMessage({
    content: [
      { type: 'text', text: 'thinking out loud' },
      { type: 'text', text: 'summarized answer' },
    ] as Parameters<typeof createAssistantMessage>[0]['content'],
  })
  const keptAsk = createUserMessage({ content: 'preserved ask' })
  const keptAnswer = createAssistantMessage({ content: 'preserved answer' })
  const summary = createUserMessage({
    content: 'the summary',
    isCompactSummary: true,
  })
  const boundary = annotateBoundaryWithPreservedSegment(
    createCompactBoundaryMessage('auto', 150_000),
    summary.uuid as UUID,
    [keptAsk, keptAnswer],
  )
  return {
    messages: [
      summarizedAsk,
      summarizedAnswer,
      keptAsk,
      keptAnswer,
      boundary,
      summary,
      keptAsk,
      keptAnswer,
    ],
    keptAskUuid: keptAsk.uuid,
  }
}

function countByUuidPrefix(messages: { uuid: string }[], uuid: string): number {
  // deriveUUID keeps the first 24 chars of the source uuid, so this counts a
  // message whether or not normalizeMessages re-derived its id.
  const prefix = uuid.slice(0, 24)
  return messages.filter(m => m.uuid.slice(0, 24) === prefix).length
}

describe('transcript projection after a preserving compaction', () => {
  test('the rounds compaction preserved render once, not twice', () => {
    const { messages, keptAskUuid } = conversationWithPreservingCompaction()

    // The array itself carries both copies, which is what every display that
    // skips the compact-boundary filter used to show.
    expect(countByUuidPrefix(normalizeMessages(messages), keptAskUuid)).toBe(2)

    expect(
      countByUuidPrefix(
        normalizeMessages(dropPreservedMessageDuplicates(messages)),
        keptAskUuid,
      ),
    ).toBe(1)
  })

  test('the projection is dead unless it runs before normalizeMessages', () => {
    // normalizeMessages re-derives UUIDs once any message splits into several
    // content blocks, and the boundary's preserved list names the originals.
    const { messages, keptAskUuid } = conversationWithPreservingCompaction()

    expect(
      countByUuidPrefix(
        dropPreservedMessageDuplicates(normalizeMessages(messages)),
        keptAskUuid,
      ),
    ).toBe(2)
  })

  test('Messages.tsx projects before normalizing', async () => {
    const source = await Bun.file(
      new URL('./Messages.tsx', import.meta.url),
    ).text()

    expect(source).toContain(
      'normalizeMessages(dropPreservedMessageDuplicates(messages))',
    )
  })
})
