import { describe, expect, test } from 'bun:test'
import { SDKControlRequestSchema } from './controlSchemas.js'

const reply = { toolUseId: 'call-1', questionIndex: 0, answer: { optionIndices: [0] } }
const envelope = (request: unknown) => ({ type: 'control_request', request_id: 'request-1', request })
const accepts = (request: unknown) => SDKControlRequestSchema().safeParse(envelope(request)).success

describe('SDK question controls are closed at the receiving boundary', () => {
  test('accepts structured replies, image-only replies and dismissals', () => {
    expect(accepts({ subtype: 'question_reply', replies: [reply] })).toBe(true)
    expect(accepts({ subtype: 'question_reply', replies: [{ ...reply, answer: { optionIndices: [], other: 'Custom', notes: [{ optionIndex: 0, text: 'Later' }] } }] })).toBe(true)
    expect(accepts({ subtype: 'question_reply', replies: [{ ...reply, answer: { optionIndices: [] }, images: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }] }] })).toBe(true)
    expect(accepts({ subtype: 'question_dismiss', toolUseId: 'call-1', questionIndex: 0 })).toBe(true)
  })

  test.each([
    { subtype: 'question_reply', replies: [] },
    { subtype: 'question_reply', replies: Array(257).fill(reply) },
    { subtype: 'question_reply', replies: [reply], requestId: 'forged' },
    { subtype: 'question_reply', replies: [{ ...reply, question: 'forged' }] },
    { subtype: 'question_reply', replies: [{ ...reply, toolUseId: '' }] },
    { subtype: 'question_reply', replies: [{ ...reply, toolUseId: 'x'.repeat(257) }] },
    { subtype: 'question_reply', replies: [{ ...reply, questionIndex: -1 }] },
    { subtype: 'question_reply', replies: [{ ...reply, questionIndex: 4 }] },
    { subtype: 'question_reply', replies: [{ ...reply, questionIndex: 0.5 }] },
    { subtype: 'question_reply', replies: [{ ...reply, answer: { optionIndices: [0], label: 'forged' } }] },
    { subtype: 'question_reply', replies: [{ ...reply, answer: { optionIndices: [4] } }] },
    { subtype: 'question_reply', replies: [{ ...reply, answer: { optionIndices: [0, 1, 2, 3, 0] } }] },
    { subtype: 'question_reply', replies: [{ ...reply, answer: { optionIndices: [0], other: 'x'.repeat(20_001) } }] },
    { subtype: 'question_reply', replies: [{ ...reply, answer: { optionIndices: [0], notes: [{ optionIndex: 0, text: 'note', selectedPreview: 'forged' }] } }] },
    { subtype: 'question_reply', replies: [{ ...reply, images: [{ type: 'image', source: { type: 'url', url: 'https://example.com/image' } }] }] },
    { subtype: 'question_reply', replies: [{ ...reply, images: [{ type: 'image', source: { type: 'base64', media_type: 'text/plain', data: 'aGVsbG8=' } }] }] },
    { subtype: 'question_reply', replies: [{ ...reply, images: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'not base64!' } }] }] },
    { subtype: 'question_dismiss', toolUseId: 'call-1', questionIndex: 0, answer: { optionIndices: [0] } },
    { subtype: 'question_dismiss', toolUseId: 'call-1', questionIndex: 0, requestId: 'forged' },
    { subtype: 'question_dismiss', toolUseId: 'call-1' },
    { subtype: 'question_dismiss', toolUseId: 'call-1', questionIndex: '0' },
  ])('rejects malformed question control %#', request => {
    expect(accepts(request)).toBe(false)
  })
})
