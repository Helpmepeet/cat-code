import { expect, test } from 'bun:test'
import { questionReplyMessageSchema } from './nonblockingQuestionMessages.js'
import { MAX_NONBLOCKING_QUESTION_TEXT_CHARS, MAX_QUESTION_ANSWER_CHARS } from '../shared/limits.js'

const reply = (text: string) => ({ type: 'askUserQuestion.reply' as const, requestId: 'reply', replies: [{
  toolUseId: 'call', questionIndex: 0,
  answer: { optionIndices: [0], other: text, notes: [{ optionIndex: 0, text }] },
}] })

test('nonblocking Other/free text and notes preserve the 20000-character contract', () => {
  expect(MAX_QUESTION_ANSWER_CHARS).toBe(4096)
  for (const size of [4096, 4097, MAX_NONBLOCKING_QUESTION_TEXT_CHARS]) {
    const message = reply('界'.repeat(size))
    expect(questionReplyMessageSchema.parse(message)).toEqual(message)
  }
  expect(questionReplyMessageSchema.safeParse(reply('x'.repeat(MAX_NONBLOCKING_QUESTION_TEXT_CHARS + 1))).success).toBe(false)
  const oversized = 'x'.repeat(MAX_NONBLOCKING_QUESTION_TEXT_CHARS + 1)
  const valid = reply('ok')
  expect(questionReplyMessageSchema.safeParse({ ...valid, replies: [{ ...valid.replies[0], answer: {
    ...valid.replies[0]!.answer, other: oversized,
  } }] }).success).toBe(false)
  expect(questionReplyMessageSchema.safeParse({ ...valid, replies: [{ ...valid.replies[0], answer: {
    ...valid.replies[0]!.answer, notes: [{ optionIndex: 0, text: oversized }],
  } }] }).success).toBe(false)
})

test('nonblocking reply remains closed and bounds references, picks and batch cardinality', () => {
  const valid = reply('text')
  for (const message of [
    { ...valid, origin: 'trusted' },
    { ...valid, replies: [{ ...valid.replies[0], question: 'forged' }] },
    { ...valid, replies: [{ ...valid.replies[0], answer: { ...valid.replies[0]!.answer, images: [] } }] },
    { ...valid, replies: [{ ...valid.replies[0], questionIndex: 4 }] },
    { ...valid, replies: [{ ...valid.replies[0], toolUseId: 'x'.repeat(257) }] },
    { ...valid, replies: [{ ...valid.replies[0], answer: { optionIndices: [4] } }] },
    { ...valid, replies: Array(257).fill(valid.replies[0]) },
  ]) expect(questionReplyMessageSchema.safeParse(message).success).toBe(false)
})
