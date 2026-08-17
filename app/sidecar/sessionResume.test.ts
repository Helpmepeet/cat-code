/**
 * D1b — reconstructing the mid-turn queue from the durable queue-operation log
 * (`selectUndeliveredPrompts`). The end-to-end proof over real engine
 * persistence is `sessionResume.probe.test.ts`; these are the shapes the log
 * can hold that are awkward to mint through two processes.
 */

import { expect, test } from 'bun:test'
import type { SessionQueueOperation } from '../../src/utils/sessionStorage.js'
import { selectUndeliveredPrompts } from './sessionResume.js'

const SESSION = 'engine-session'

function op(
  operation: SessionQueueOperation['operation'],
  uuid: string,
  extra: Partial<SessionQueueOperation> = {},
): SessionQueueOperation {
  return {
    operation,
    timestamp: '2026-08-17T00:00:00.000Z',
    sessionId: SESSION,
    uuid: uuid as SessionQueueOperation['uuid'],
    ...(operation === 'enqueue' ? { mode: 'prompt', content: uuid } : {}),
    ...extra,
  }
}

function select(
  operations: SessionQueueOperation[],
  delivered: string[] = [],
): string[] {
  return selectUndeliveredPrompts({
    operations,
    messageUuids: new Set(delivered),
  }).map(prompt => prompt.uuid)
}

test('every retraction verb subtracts its message, whichever primitive wrote it', () => {
  expect(
    select([
      op('enqueue', 'recalled'),
      op('enqueue', 'discarded'),
      op('enqueue', 'pulled-into-the-composer'),
      op('enqueue', 'still-waiting'),
      op('dequeue', 'recalled'),
      op('remove', 'discarded'),
      op('popAll', 'pulled-into-the-composer'),
    ]),
  ).toEqual(['still-waiting'])
})

test('a message resent after a take-back is recovered, because it is a new message', () => {
  // The user takes it back, edits, and sends again: same words, new uuid. The
  // retraction must not reach through to the resent copy.
  expect(
    select([
      op('enqueue', 'first-attempt', { content: 'ship it' }),
      op('dequeue', 'first-attempt'),
      op('enqueue', 'second-attempt', { content: 'ship it' }),
    ]),
  ).toEqual(['second-attempt'])
})

test('a retraction subtracts its enqueue whatever order the records land in', () => {
  // The log is appended from a fire-and-forget writer, so a reader that only
  // looked backwards from each retraction would be betting on write ordering.
  expect(
    select([op('dequeue', 'recalled'), op('enqueue', 'recalled')]),
  ).toEqual([])
})

test('a delivered message is left to the transcript that already holds it', () => {
  expect(select([op('enqueue', 'delivered')], ['delivered'])).toEqual([])
})

test('only main-thread prompts are recovered', () => {
  expect(
    select([
      op('enqueue', 'worker-result', { mode: 'task-notification' }),
      op('enqueue', 'user-prompt'),
    ]),
  ).toEqual(['user-prompt'])
})

test('an image-bearing message restores as the blocks that were sent', () => {
  const content = [
    { type: 'text' as const, text: 'what is this?' },
    {
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: 'image/png' as const,
        data: 'aGVsbG8=',
      },
    },
  ]
  expect(
    selectUndeliveredPrompts({
      operations: [op('enqueue', 'with-image', { content })],
      messageUuids: new Set<string>(),
    })[0]?.content,
  ).toEqual(content)
})

test('a record with no usable content is dropped rather than half-restored', () => {
  // Legacy records (written before content was recorded for every prompt) and
  // anything hand-edited on disk. A row is either faithful or absent.
  expect(
    select([
      op('enqueue', 'legacy', { content: undefined }),
      op('enqueue', 'corrupt', { content: 7 as unknown as string }),
      op('enqueue', 'intact'),
    ]),
  ).toEqual(['intact'])
})

test('a retraction that recorded no uuid subtracts nothing', () => {
  // Sessions written before the retraction verbs recorded their command. The
  // enqueue is all that survives, so restore still recovers it: guessing by
  // text would be worse than replaying one stale row.
  expect(
    select([
      op('enqueue', 'legacy-waiting'),
      { ...op('dequeue', 'ignored'), uuid: undefined },
    ]),
  ).toEqual(['legacy-waiting'])
})
