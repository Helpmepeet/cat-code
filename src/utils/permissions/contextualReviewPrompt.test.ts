import { expect, test } from 'bun:test'
import { contextualReviewSystem, parseContextualVerdict } from './contextualReviewPrompt.js'

test('v10 reserves interruptions for high-risk decisions and treats omitted history as unknown', () => {
  const prompt = contextualReviewSystem('Bash')
  expect(prompt).toStartWith('cat-code-contextual-review-v10')
  expect(prompt).toContain('History may be cut; anything not shown is unknown.')
  expect(prompt).toContain('Your own uncertainty is never a reason to interrupt the user.')
  expect(prompt).toContain('from the operator, the actor\'s assignment, workspace instructions or settings')
  expect(prompt).toContain('Repeating a routine action needs no fresh approval.')
  expect(prompt).not.toContain('user_authorization')
})

test('a Script cell review judges the whole script, whatever tool triggered it', () => {
  const child = contextualReviewSystem('Bash')
  expect(child).toContain('You review exactly one pending shell command before it runs')
  expect(child).not.toContain('Script review:')
  for (const tool of ['Bash', 'Edit']) {
    const cell = contextualReviewSystem(tool, [], true)
    expect(cell).toContain('You review exactly one pending Script before its held child runs')
    expect(cell).toContain('- "allow": the Script may run once now.')
    expect(cell).not.toContain('pending shell command')
    expect(cell).not.toContain('An allow covers only this invocation.')
    expect(cell).toContain('action.script.source contains the complete current Script')
    expect(cell).toContain('An allow lets every call in the current Script run without another model review')
    expect(cell).toContain('give the highest risk among them')
    expect(cell).toContain('sh`...` runs a shell command; each ${value} becomes one quoted argument')
  }
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
