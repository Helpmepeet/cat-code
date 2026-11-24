import { expect, test } from 'bun:test'
import { contextualReviewSystem, parseContextualVerdict } from './contextualReviewPrompt.js'

test('v7 reserves interruptions for high-risk decisions and asks for a fact when effects are unclear', () => {
  const prompt = contextualReviewSystem('Bash')
  expect(prompt).toStartWith('cat-code-contextual-review-v7')
  expect(prompt).toContain('Your own uncertainty is never a reason to interrupt the user.')
  expect(prompt).toContain('from the operator, the actor\'s assignment, workspace instructions or settings')
  expect(prompt).toContain('Repeating a routine action needs no fresh approval.')
  expect(prompt).not.toContain('user_authorization')
})

test('a Script cell review says one allow covers the whole script', () => {
  const child = contextualReviewSystem('Bash')
  const cell = contextualReviewSystem('Bash', [], true)
  expect(child).toContain('Review each Script child on its final arguments, using the script as context. An allow covers only this invocation.')
  expect(cell).not.toContain('An allow covers only this invocation.')
  expect(cell).toContain("Review a Script as a whole from its source and the triggering call's final arguments. An allow covers every action the code takes.")
  expect(cell.replace(/Review a Script as a whole[^.]*\. An allow covers every action the code takes\./u, ''))
    .toBe(child.replace(/Review each Script child[^.]*\. An allow covers only this invocation\./u, ''))
})

test('accepts a complete native verdict with optional rationale and JSON fencing', () => {
  expect(parseContextualVerdict('```json\n{"decision":"allow","risk":"medium"}\n```'))
    .toMatchObject({ decision: 'allow', risk: 'medium' })
})

test('accepts legacy user_authorization without changing the verdict', () => {
  const verdict = parseContextualVerdict('{"decision":"allow","risk":"medium","user_authorization":"unknown"}')
  expect(verdict).toMatchObject({ decision: 'allow', risk: 'medium' })
  expect(verdict).not.toHaveProperty('user_authorization')
})

test('an ambiguous decision or a high-risk allow cannot release the action', () => {
  for (const reply of [
    '{"decision":"deny","d\\u0065cision":"allow","risk":"low","rationale":"local"}',
    '{"decision":"allow","risk":"high","rationale":"requested"}',
    '{"decision":"allow","risk":"low","rationale":"local","__proto__":{}}',
  ]) expect(parseContextualVerdict(reply)).toBeUndefined()
})
