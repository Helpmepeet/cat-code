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

test('renders the question, header chip, option rows with key caps + descriptions', () => {
  const html = render(SINGLE)
  // Not a raw JSON dump — the real flow.
  expect(html).toContain('Which date library should we use?')
  expect(html).toContain('Library') // header chip
  expect(html).toContain('date-fns')
  expect(html).toContain('lightweight &amp; tree-shakeable')
  expect(html).toContain('luxon')
  // The digit is a SHORTCUT, so it reads as a key cap at the row's far end
  // rather than as the state marker at its head.
  expect(html).toContain('>1</span>')
})

test('a row past the ninth advertises no key cap, because no key reaches it', () => {
  const eleven: AskQuestion[] = [
    {
      question: 'Which one?',
      header: 'Pick',
      multiSelect: false,
      options: Array.from({ length: 11 }, (_, i) => ({
        label: `option ${i + 1}`,
        description: '',
        preview: null,
      })),
    },
  ]
  const html = render(eleven)
  expect(html).toContain('>9</span>')
  expect(html).not.toContain('>10</span>')
  expect(html).not.toContain('>11</span>')
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
  // Single-select is the ordinary case and says nothing about how to pick (§7).
  expect(html).not.toContain('Pick as many as you like')
})

test('multi-question shows Next question + stepper + the multi-select badge on q2', () => {
  const html = render(MULTI)
  // First step footer advances rather than submits.
  expect(html).toContain('Next question')
  expect(html).not.toContain('Submit')
  // Stepper "1/2".
  expect(html).toContain('1/2')
})

test('a multi-select question says so in words, without a full-width key legend', () => {
  const html = render([MULTI[1]!])
  // The old `multi-select` chip was a 9px metadata tag next to the header chip,
  // and it read as a label rather than as an instruction. What the operator
  // needed was to be told what to DO with the list.
  expect(html).toContain('Pick as many as you like')
  expect(html).not.toContain('multi-select')
  expect(html).not.toContain('space toggle · ↑↓ move')
})

test('an option row is a real checkbox or radio, empty until it is chosen', () => {
  // Chosen state used to live in an alpha step and a digit swapping to a tick
  // inside an already-filled chip. Empty-outline versus filled-accent is a
  // difference in KIND, which is what survived live use.
  const multi = render([MULTI[1]!])
  expect(multi).toContain('role="checkbox"')
  expect(multi).toContain('aria-checked="false"')
  expect(multi).toContain('rounded-[5px]') // square: more than one allowed
  const single = render(SINGLE)
  expect(single).toContain('role="radio"')
  expect(single).toContain('rounded-full') // round: exactly one

  // Nothing is chosen at rest, so no marker anywhere carries a tick — including
  // the row the cursor starts on, which used to render in the loudest tint on
  // the card before the operator had touched anything.
  expect(single).not.toContain('✓')
})

test('a chosen row outranks the cursor row', () => {
  // `rowTone`: the cursor is the WEAKER accent step. It was the stronger one,
  // so the brightest row on the card was whichever the mouse was passing over.
  const html = render(SINGLE)
  expect(html).toContain('border-accent/25 bg-accent/[0.05]') // cursor, unchosen
  expect(html).not.toContain('border-accent/45 bg-accent/10') // the old cursor tint
})

test('every option row can be clicked, and says so', () => {
  // Tailwind v4 preflight dropped v3's `button { cursor: pointer }`, so a row
  // that is a plain <button> shows an arrow. Nothing about the list invited a
  // click.
  const html = render(SINGLE)
  // Both the option rows and the "Other…" row, each named exactly: measured as
  // a computed `cursor: default` on every row before this change.
  expect(html).toContain('flex w-full cursor-pointer items-start')
  expect(html).toContain('flex-1 cursor-pointer bg-transparent')
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
