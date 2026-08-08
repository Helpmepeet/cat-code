import { readFileSync } from 'node:fs'
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AskQuestionFlow } from './AskQuestionFlow.js'
import {
  abandonOtherText,
  buildAskAnswerPayload,
} from './askQuestionFlowModel.js'
import type { AskQuestion } from './askQuestionState.js'

const SINGLE: AskQuestion[] = [
  {
    question: 'Which date library should we use?',
    header: 'Library',
    multiSelect: false,
    options: [
      { label: 'date-fns', description: 'lightweight & tree-shakeable', preview: 'import { format } from "date-fns"' },
      { label: 'luxon', description: 'rich immutable API', preview: null },
    ],
  },
]

const MULTI: AskQuestion[] = [
  {
    question: 'Which date library should we use?',
    header: 'Library',
    multiSelect: false,
    options: [
      { label: 'date-fns', description: 'lightweight', preview: null },
      { label: 'luxon', description: 'rich', preview: null },
    ],
  },
  {
    question: 'Which features do you need?',
    header: 'Features',
    multiSelect: true,
    options: [
      { label: 'parsing', description: '', preview: null },
      { label: 'timezones', description: '', preview: null },
    ],
  },
]

// `renderToStaticMarkup` never runs effects, so these tests cover MARKUP only.
// The source pin below covers the contentEditable guard, but event dispatch
// remains a GUI-verified surface until the renderer has a DOM harness.
function render(questions: AskQuestion[], isActivePane = true) {
  return renderToStaticMarkup(
    <AskQuestionFlow
      isActivePane={isActivePane}
      onAnswer={() => {}}
      onCancel={() => {}}
      questions={questions}
      requestId="perm-1"
    />,
  )
}

test('the window key handler leaves contentEditable targets to their editor', () => {
  const source = readFileSync(new URL('./AskQuestionFlow.tsx', import.meta.url), 'utf8')
  expect(source).toContain('target?.isContentEditable')
})

test('renders the question, header chip, option rows with numbers + descriptions', () => {
  const html = render(SINGLE)
  // Not a raw JSON dump — the real flow.
  expect(html).toContain('Which date library should we use?')
  expect(html).toContain('Library') // header chip
  expect(html).toContain('date-fns')
  expect(html).toContain('lightweight &amp; tree-shakeable')
  expect(html).toContain('luxon')
  // Numbered pick affordance (option 1 badge, cursor starts at row 0).
  expect(html).toContain('1')
})

test('renders the preview badge for an option carrying a preview, and the focused preview pane', () => {
  const html = render(SINGLE)
  expect(html).toContain('preview') // per-option badge
  // Cursor starts on option 0 (date-fns), which has a preview → the pane shows.
  expect(html).toContain('Preview')
  expect(html).toContain('import { format } from &quot;date-fns&quot;')
})

test('renders the built-in "Other…" freeform row', () => {
  const html = render(SINGLE)
  expect(html).toContain('Other…')
  // 2 options → the Other row is number 3, a key that exists.
  expect(html).toContain('>3<')
})

test('the Other row never shows a number no key can produce', () => {
  const many: AskQuestion[] = [
    {
      question: 'Which one?',
      header: 'Pick',
      multiSelect: false,
      options: Array.from({ length: 9 }, (_, i) => ({
        label: `option ${i + 1}`,
        description: '',
        preview: null,
      })),
    },
  ]
  const html = render(many)
  // 9 options put the Other row at 10: two digits in a 16px circle, and
  // unreachable from the digit shortcuts, which stop at 9.
  expect(html).not.toContain('>10<')
  expect(html).toContain('>o<')
})

test('single question shows a Submit footer + single-select key hints, no stepper', () => {
  const html = render(SINGLE)
  expect(html).toContain('Submit')
  expect(html).toContain('1–9 pick · ↑↓ move')
  expect(html).not.toContain('Next question')
  expect(html).not.toContain('multi-select')
})

test('multi-question shows Next question + stepper + the multi-select badge on q2', () => {
  const html = render(MULTI)
  // First step footer advances rather than submits.
  expect(html).toContain('Next question')
  expect(html).not.toContain('Submit')
  // Stepper "1/2".
  expect(html).toContain('1/2')
})

test('a multi-select question renders the multi-select badge + toggle hint', () => {
  const html = render([MULTI[1]!])
  expect(html).toContain('multi-select')
  expect(html).toContain('1–9 / space toggle · ↑↓ move')
})

test('cancel affordance is present (esc)', () => {
  const html = render(SINGLE)
  expect(html).toContain('Cancel')
  expect(html).toContain('esc')
})

// --- payload builder (the renderer authors ONLY indices + trimmed freeform) ---

test('buildAskAnswerPayload keeps option indices and omits empty freeform', () => {
  expect(
    buildAskAnswerPayload([
      { optionIndices: [0], other: '' },
      { optionIndices: [0, 1], other: '   ' },
    ]),
  ).toEqual([{ optionIndices: [0] }, { optionIndices: [0, 1] }])
})

test('buildAskAnswerPayload trims and carries a real freeform answer', () => {
  expect(
    buildAskAnswerPayload([{ optionIndices: [], other: '  moment  ' }]),
  ).toEqual([{ optionIndices: [], other: 'moment' }])
})

test('leaving the freeform field keeps the option the user already picked', () => {
  // Escape out of "Other…" used to run the TYPING transition, which for a
  // single-select question clears the pick (one option supersedes freeform, and
  // freeform supersedes the option). Pressing 1 then the Other digit then Escape
  // therefore silently deselected option 1 and greyed out Submit.
  expect(abandonOtherText({ optionIndices: [0], other: 'mome' })).toEqual({
    optionIndices: [0],
    other: '',
  })
  // Multi-select keeps every pick too, and an untouched draft is unchanged.
  expect(abandonOtherText({ optionIndices: [0, 2], other: 'x' })).toEqual({
    optionIndices: [0, 2],
    other: '',
  })
  expect(abandonOtherText({ optionIndices: [], other: '' })).toEqual({
    optionIndices: [],
    other: '',
  })
})
