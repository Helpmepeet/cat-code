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
  }).prompts.map(prompt => prompt.uuid)
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

test('a message put back on the queue under the same uuid survives', () => {
  // `drainOneQueuedPrompt` re-enqueues the SAME command object after a turn that
  // rejected before `onInputPersisted`, and again when `startTurn` refuses
  // outright (`app/sidecar/sidecarServer.ts` onSettled / !started). So a uuid
  // legitimately stops and starts waiting again, and the log reads
  // enqueue-dequeue-enqueue while the message is genuinely on the queue. Read as
  // an order-independent set of retracted uuids, that destroyed the user's text
  // on restore with no trace.
  expect(
    select([
      op('enqueue', 'requeued'),
      op('dequeue', 'requeued'),
      op('enqueue', 'requeued'),
    ]),
  ).toEqual(['requeued'])
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
    }).prompts[0]?.content,
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

test('only blocks a composer submit can produce are restored as user content', () => {
  // These all satisfied the old `string or array` check and went into a
  // `type:'user'` frame unexamined. None of them is a message anyone typed.
  const unrestorable: SessionQueueOperation['content'][] = [
    '',
    [],
    [1, 2, 3] as unknown as SessionQueueOperation['content'],
    [{}] as unknown as SessionQueueOperation['content'],
    [{ type: 'text' }] as unknown as SessionQueueOperation['content'],
    [
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
    ] as unknown as SessionQueueOperation['content'],
    [
      { type: 'document', source: { type: 'base64', data: 'x' } },
    ] as unknown as SessionQueueOperation['content'],
  ]
  for (const content of unrestorable) {
    expect(select([op('enqueue', 'unrestorable', { content })])).toEqual([])
  }
})

test('every discarded enqueue record is counted, not just skipped', () => {
  // The restore records this count (`session.restore.completed`), because this
  // whole path exists to stop a restore getting its row set wrong in silence.
  const selection = selectUndeliveredPrompts({
    operations: [
      op('enqueue', 'corrupt', { content: [] }),
      { ...op('enqueue', 'uuid-less'), uuid: undefined },
      op('enqueue', 'intact'),
      op('enqueue', 'notification', { mode: 'task-notification' }),
      op('dequeue', 'intact'),
    ],
    messageUuids: new Set<string>(),
  })
  expect(selection.prompts).toEqual([])
  // The corrupt one and the uuid-less one. A retraction is not a discard, and a
  // task notification was never a candidate.
  expect(selection.droppedRecords).toBe(2)
})

test('a retraction that recorded no uuid takes back nothing, not everything', () => {
  // Sessions written before the retraction verbs recorded their command. Such a
  // record cannot name what stopped waiting, and `dequeueAll`/`clearCommandQueue`
  // do clear the whole queue, so reading it as clear-all is the tempting wrong
  // move: it would discard the message the paired retraction was not about.
  expect(
    select([
      op('enqueue', 'still-waiting'),
      op('enqueue', 'recalled'),
      { ...op('dequeue', 'ignored'), uuid: undefined },
      op('dequeue', 'recalled'),
    ]),
  ).toEqual(['still-waiting'])
})
