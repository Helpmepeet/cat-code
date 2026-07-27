import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AskQuestionFlow } from './AskQuestionFlow.js'
import { buildAskAnswerPayload } from './askQuestionFlowModel.js'
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

// `renderToStaticMarkup` never runs effects, so these tests cover MARKUP only —
// the window keydown handler (and its `isActivePane` gate, which stops one
// keypress from resolving every flow in a split workspace) is NOT exercised
// here. The renderer suite is SSR-only by construction; closing that gap needs
// operator sign-off for a DOM harness. Until then it is a GUI-verified surface.
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
