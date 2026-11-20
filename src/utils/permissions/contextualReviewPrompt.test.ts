import { expect, test } from 'bun:test'
import { parseContextualVerdict } from './contextualReviewPrompt.js'

test('accepts a complete native verdict with optional rationale and JSON fencing', () => {
  expect(parseContextualVerdict('```json\n{"decision":"allow","risk":"medium"}\n```'))
    .toMatchObject({ decision: 'allow', risk: 'medium' })
})

test('an ambiguous decision or a high-risk allow cannot release the action', () => {
  for (const reply of [
    '{"decision":"deny","d\\u0065cision":"allow","risk":"low","rationale":"local"}',
    '{"decision":"allow","risk":"high","rationale":"requested"}',
    '{"decision":"allow","risk":"low","rationale":"local","__proto__":{}}',
  ]) expect(parseContextualVerdict(reply)).toBeUndefined()
})
