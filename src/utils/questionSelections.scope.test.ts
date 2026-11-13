import { expect, test } from 'bun:test'
import { readQuestionSelections, reconstructQuestionSelection, recordQuestionSelections, takeQuestionSelections } from './questionSelections.js'
import { reconstructAskUserQuestionAnswers } from '../../app/sidecar/sidecarServer.js'

const questions = ['First', 'Second', 'Third'].map(question => ({ question, multiSelect: false, options: [
  { label: 'Send', description: 'Send draft', preview: 'To Alice only; exclude Bob; draft v2' },
  { label: 'Publish', description: 'Publish draft', preview: 'Unselected public scope' },
] }))

test('selected preview is engine scope context, including through desktop narrowing', () => {
  const expected = reconstructQuestionSelection('scope', 0, questions[0]!, { optionIndices: [0] })
  expect(expected.selectedOptions[0]?.previewContext).toBe(questions[0]!.options[0]!.preview)
  expect(JSON.stringify(expected)).not.toContain('Unselected public scope')
  const desktop = reconstructAskUserQuestionAnswers({ questions }, questions.map(() => ({ optionIndices: [0] })))
  if (desktop.ok === false) throw new Error(desktop.reason)
  expect(desktop.selections[0]).toEqual({ ...expected, toolUseId: '' })
  expect(readQuestionSelections([expected], 'scope', questions)).toEqual([expected])
  const changed = structuredClone(questions)
  changed[0]!.options[0]!.preview = 'To Bob instead'
  expect(readQuestionSelections([expected], 'scope', changed)).toBeNull()
  const forged = structuredClone(expected)
  forged.selectedOptions[0]!.previewContext = 'To Bob instead'
  expect(readQuestionSelections([forged], 'scope', questions)).toBeNull()
  delete forged.selectedOptions[0]!.previewContext
  expect(readQuestionSelections([forged], 'scope', questions)).toBeNull()
})

test('partial answers preserve original indices and reject empty, duplicate, reordered or misplaced answers', () => {
  const first = reconstructQuestionSelection('partial', 0, questions[0]!, { optionIndices: [0] })
  const third = reconstructQuestionSelection('partial', 2, questions[2]!, { optionIndices: [], other: 'Not yet' })
  expect(readQuestionSelections([third], 'partial', questions)).toEqual([third])
  expect(readQuestionSelections([first, third], 'partial', questions)).toEqual([first, third])
  for (const invalid of [[], [third, first], [first, first], [{ ...third, questionIndex: 1 }], [{ ...third, questionIndex: 3 }], [{ ...third, other: '' }]]) {
    expect(readQuestionSelections(invalid, 'partial', questions)).toBeNull()
  }
  expect(readQuestionSelections([third], 'another-tool', questions)).toBeNull()
})

test('partial receipts bind complete questions and actual answer map, including preview changes', () => {
  const selected = reconstructQuestionSelection('receipt', 2, questions[2]!, { optionIndices: [0] })
  const answers = { Third: 'Send' }
  recordQuestionSelections('receipt', questions, answers, [selected])
  expect(takeQuestionSelections('receipt', questions, answers)).toEqual([selected])
  recordQuestionSelections('receipt', questions, answers, [selected])
  expect(takeQuestionSelections('receipt', questions, { First: 'Send', ...answers })).toBeUndefined()
  recordQuestionSelections('receipt', questions, answers, [selected])
  const changed = structuredClone(questions)
  changed[0]!.options[0]!.preview = 'Changed unanswered question'
  expect(takeQuestionSelections('receipt', changed, answers)).toBeUndefined()
})
