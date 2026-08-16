import { describe, expect, test } from 'bun:test'
import type { UUID } from 'crypto'
import { annotateBoundaryWithPreservedSegment } from '../services/compact/compact.js'
import type { Message } from '../types/message.js'
import {
  createAssistantMessage,
  createCompactBoundaryMessage,
  createUserMessage,
  dropPreservedMessageDuplicates,
  isCompactBoundaryMessage,
  normalizeMessages,
} from '../utils/messages.js'
import { selectableUserMessagesFilter } from './MessageSelector.js'

/**
 * Messages.tsx and MessageSelector.tsx render through Ink, which does not exit
 * under the test runner, so these cover the projection step both components
 * apply to their `messages` prop plus the wiring that makes it run. What no
 * test here can see: how the seam and the rounds below it actually look in a
 * live terminal, or how the rewind picker paints them.
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

/**
 * The rewind picker resolves the message to restore by uuid
 * (computeDiffStatsBetweenMessages, handleSelect), while REPL's
 * rewindConversationTo resolves it by object identity with lastIndexOf. On a
 * raw array holding a preserved round twice those land on different copies, so
 * the row's diff stats describe a span the rewind does not cut.
 */
describe('rewind selection after a preserving compaction', () => {
  test('the raw array resolves the same message to two different copies', () => {
    const { messages, keptAskUuid } = conversationWithPreservingCompaction()

    const byUuid = messages.findIndex(m => m.uuid === keptAskUuid)
    const keptAsk = messages[byUuid]!
    const byIdentity = messages.lastIndexOf(keptAsk)

    expect(byUuid).not.toBe(byIdentity)
    // And the disagreement is what makes the stats wrong: the uuid lookup
    // starts above the seam, so its span swallows the boundary and summary.
    expect(
      messages.slice(byUuid, byIdentity).some(isCompactBoundaryMessage),
    ).toBe(true)
  })

  test('the projection makes both resolutions land on the surviving copy', () => {
    const { messages, keptAskUuid } = conversationWithPreservingCompaction()
    const projected = dropPreservedMessageDuplicates(messages)

    const keptAsk = messages[messages.findIndex(m => m.uuid === keptAskUuid)]!
    const rewindTarget = messages[messages.lastIndexOf(keptAsk)]

    const byUuid = projected.findIndex(m => m.uuid === keptAskUuid)
    expect(projected[byUuid]).toBe(rewindTarget)
    expect(projected.slice(byUuid).some(isCompactBoundaryMessage)).toBe(false)
  })

  test('the picker offers the preserved round once, not twice', () => {
    const { messages, keptAskUuid } = conversationWithPreservingCompaction()

    expect(
      messages.filter(selectableUserMessagesFilter).filter(m => m.uuid === keptAskUuid),
    ).toHaveLength(2)
    expect(
      dropPreservedMessageDuplicates(messages)
        .filter(selectableUserMessagesFilter)
        .filter(m => m.uuid === keptAskUuid),
    ).toHaveLength(1)
  })

  test('MessageSelector projects its prop, and REPL resolves the same copy', async () => {
    const selector = await Bun.file(
      new URL('./MessageSelector.tsx', import.meta.url),
    ).text()
    expect(selector).toContain(
      'dropPreservedMessageDuplicates(rawMessages)',
    )

    // findRawIndex feeds messagesAfterAreOnlySynthetic, which decides whether a
    // message-actions edit skips the confirm dialog. Scanning from the earlier
    // copy crosses the seam and always finds something non-synthetic.
    const repl = await Bun.file(
      new URL('../screens/REPL.tsx', import.meta.url),
    ).text()
    expect(repl).toContain(
      'messages.findLastIndex(m => m.uuid.slice(0, 24) === prefix)',
    )
  })
})
