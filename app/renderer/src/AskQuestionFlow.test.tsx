import { readFileSync } from 'node:fs'
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AskQuestionFlow } from './AskQuestionFlow.js'
import {
  abandonOtherText,
  buildAskAnswerPayload,
} from './askQuestionFlowModel.js'
import type { AskQuestion } from './askQuestionState.js'
import {
  PERMISSION_KEY_HOST_ATTR,
  permissionKeysAreLive,
} from './permissionPromptModel.js'

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
// Focus, key ownership and event dispatch are NOT GUI-only: they are proved
// against a real DOM in AskQuestionFlow.dom.test.tsx, which is where any
// behavioural assertion about this component belongs.
function render(
  questions: AskQuestion[],
  isActivePane = true,
  pendingCount?: number,
) {
  return renderToStaticMarkup(
    <AskQuestionFlow
      isActivePane={isActivePane}
      onAnswer={() => {}}
      onCancel={() => {}}
      pendingCount={pendingCount}
      questions={questions}
      requestId="perm-1"
    />,
  )
}

/**
 * A focus target described the way `Element.closest` answers about it — the
 * same stand-in `PermissionPrompt.test.tsx` uses, because both cards are read
 * by the one `permissionKeysAreLive` predicate.
 */
function focusTarget(owner: 'host' | 'control' | null) {
  return {
    closest: () =>
      owner === null
        ? null
        : {
            hasAttribute: (name: string) =>
              owner === 'host' && name === PERMISSION_KEY_HOST_ATTR,
          },
  }
}

test('the window key handler ignores already-claimed and modified events', () => {
  // NOT a pin on `!permissionKeysAreLive(event.target)` any more: that string
  // survives as a substring of the containment guard, so it passed before the
  // fix, during the bug, and after — it could never have caught any of them.
  // Who owns a keypress is proved behaviourally in AskQuestionFlow.dom.test.tsx.
  const source = readFileSync(new URL('./AskQuestionFlow.tsx', import.meta.url), 'utf8')
  expect(source).toContain('event.defaultPrevented')
  expect(source).toContain('event.repeat')
})

test('the shared predicate still rules outside the card', () => {
  // Inside the card, ownership is behavioural and is proved against real
  // keydown events in AskQuestionFlow.dom.test.tsx (three mutants: the old
  // guard, a detached ref, and a guard that claims activation keys). What SSR
  // can still assert is the untouched half of the rule — outside the card the
  // composer keeps the keys it is being typed into.
  expect(permissionKeysAreLive(focusTarget('control'))).toBe(false)
  expect(permissionKeysAreLive(focusTarget('host'))).toBe(true)
  expect(permissionKeysAreLive(focusTarget(null))).toBe(true)
})

test('the active pane can be focused at all, and an inactive one cannot', () => {
  // A split workspace mounts one flow per visible pane, and only the active
  // pane listens. `tabIndex={-1}` is never a TAB stop either way; what it
  // controls is programmatic focusability, so its absence is what stops the
  // mount effect from taking the keyboard onto a card nothing listens for.
  expect(render(SINGLE)).toContain('tabindex="-1"')
  expect(render(SINGLE, false)).not.toContain('tabindex')
})

test('the card body is a bounded scroller', () => {
  const html = render(SINGLE)
  // Docked in the column rather than portaled over the transcript, so the card
  // grows into the dock. The ceiling bounds THIS card's share of it, which is
  // all it was ever able to do: the composer is kept on screen by the dock
  // itself, which yields and scrolls its panel region (`App.tsx`; asserted by
  // `composerDock.test.tsx`).
  expect(html).toContain('max-h-[60vh]')
  expect(html).toContain('overflow-y-auto')
  expect(html).toContain('py-2.5')
  expect(html).toContain('gap-0.5')
  expect(html).not.toContain('bg-[#0d0d0f]')
})

test('the kicker names the request family and counts what is queued behind it', () => {
  // Only past one: a lone question must not imply something follows it.
  expect(render(SINGLE, true, 1)).not.toContain('pending')
  expect(render(SINGLE)).not.toContain('pending')
  const queued = render(SINGLE, true, 3)
  // Not a bare `>3<`: two options put the "Other…" row at 3 as well.
  expect(queued).toContain('>3</b>')
  expect(queued).toContain('pending')
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
  expect(html).not.toContain('1–9 · o pick')
})

test('single question shows a Submit footer with no full-width key legend or stepper', () => {
  const html = render(SINGLE)
  expect(html).toContain('Submit')
  expect(html).not.toContain('pick · ↑↓ move')
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

test('a multi-select question renders the multi-select badge without a full-width key legend', () => {
  const html = render([MULTI[1]!])
  expect(html).toContain('multi-select')
  expect(html).not.toContain('space toggle · ↑↓ move')
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
