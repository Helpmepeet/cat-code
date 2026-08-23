/**
 * Behavioural proof for the flow's keyboard ownership.
 *
 * The SSR suites (`AskQuestionFlow.test.tsx`) render with
 * `renderToStaticMarkup`: no effects, no focus, no events. Everything this file
 * asserts is therefore structurally invisible there, which is why the guard
 * shipped once as source pins — and a source pin cannot fail for the reason it
 * exists. Detaching `ref={cardRef}` breaks every behaviour below while leaving
 * all of those pinned strings byte-identical.
 *
 * The rule under test: the card takes focus when it appears. Inside it, the
 * card owns navigation plus Enter on option rows, while footer controls keep
 * their own activation keys. Outside the card the shared
 * `permissionKeysAreLive` predicate still rules.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'

import { AskQuestionFlow } from './AskQuestionFlow.js'
import type { AskQuestion } from './askQuestionState.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import type { AskUserQuestionAnswer } from '../../shared/protocol.js'

let harness: DomTestHarness

beforeAll(async () => {
  harness = await createDomTestHarness()
})

afterEach(async () => {
  await harness.unmountAll()
  document.body.innerHTML = ''
})

afterAll(async () => {
  await harness.teardown()
})

const SINGLE: AskQuestion[] = [
  {
    question: 'Which date library?',
    header: 'Library',
    multiSelect: false,
    options: [
      { label: 'date-fns', description: 'lightweight', preview: null },
      { label: 'luxon', description: 'rich', preview: null },
      { label: 'temporal', description: 'native', preview: null },
    ],
  },
]

const MULTI: AskQuestion[] = [
  {
    question: 'Which features?',
    header: 'Features',
    multiSelect: true,
    options: [
      { label: 'parsing', description: '', preview: null },
      { label: 'timezones', description: '', preview: null },
    ],
  },
]

const TWO_QUESTIONS: AskQuestion[] = [
  SINGLE[0]!,
  {
    question: 'Which runtime?',
    header: 'Runtime',
    multiSelect: false,
    options: [
      { label: 'Bun', description: '', preview: null },
      { label: 'Node', description: '', preview: null },
    ],
  },
]

const ALL_TYPES: AskQuestion[] = [
  SINGLE[0]!,
  {
    question: 'Which colors?',
    header: 'Multiple',
    multiSelect: true,
    options: [
      { label: 'Red', description: '', preview: null },
      { label: 'Green', description: '', preview: null },
      { label: 'Blue', description: '', preview: null },
      { label: 'Yellow', description: '', preview: null },
    ],
  },
  {
    question: 'Which code style?',
    header: 'Preview',
    multiSelect: false,
    options: [
      { label: 'Early return', description: '', preview: 'return early' },
      { label: 'Nested branch', description: '', preview: 'use a branch' },
      { label: 'Ternary', description: '', preview: 'use a ternary' },
    ],
  },
  {
    question: 'Custom response?',
    header: 'Custom',
    multiSelect: false,
    options: [
      { label: 'Preset one', description: '', preview: null },
      { label: 'Preset two', description: '', preview: null },
    ],
  },
]

type Calls = {
  answers: AskUserQuestionAnswer[][]
  cancels: number
}

async function mountFlow(questions: AskQuestion[] = SINGLE) {
  const calls: Calls = { answers: [], cancels: 0 }
  const tree = await harness.mount(
    <AskQuestionFlow
      isActivePane
      onAnswer={answers => calls.answers.push(answers)}
      onCancel={() => {
        calls.cancels += 1
      }}
      questions={questions}
      requestId="perm-1"
    />,
  )
  // The mount effect focuses on a 0 ms timer.
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  const card = tree.container.querySelector('section') as HTMLElement
  const rows = Array.from(
    card.querySelectorAll<HTMLButtonElement>('button[data-ask-active], button'),
  )
  return { calls, tree, card }
}

/** Focus inside act(): the row's own `onFocus` moves the cursor. */
async function focusIn(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.focus()
  })
}

/** Dispatch a real keydown FROM `from`, the way a focused element does. */
async function press(from: Element, key: string): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
  })
  await act(async () => {
    from.dispatchEvent(event)
  })
  return event
}

function optionRows(card: HTMLElement): HTMLButtonElement[] {
  // The rows mark themselves. Filtering on a font-mono child used to sweep the
  // footer's Submit and Cancel in with them, because their key chips are
  // font-mono too.
  return Array.from(
    card.querySelectorAll<HTMLButtonElement>('button[data-ask-option]'),
  )
}

function buttonWithText(card: HTMLElement, text: string): HTMLButtonElement {
  const match = Array.from(
    card.querySelectorAll<HTMLButtonElement>('button'),
  ).find(button => button.textContent?.trim().startsWith(text))
  if (!match) throw new Error(`no button starting with ${text}`)
  return match
}

/**
 * What the row's checkbox/radio marker shows: '✓' when the option is part of
 * the answer, empty when it is not. The digit moved out of the marker and onto
 * a keycap at the row's other end, so the marker now carries ONLY the chosen
 * state — which is the whole point of the 2026-08-23 vocabulary change.
 */
function markerText(row: HTMLElement): string {
  return row.querySelector('[data-ask-marker]')?.textContent?.trim() ?? ''
}

function checkedState(row: HTMLElement): string | null {
  return row.getAttribute('aria-checked')
}

test('the card takes the keyboard on mount', async () => {
  const { card } = await mountFlow()
  expect(document.activeElement).toBe(card)
})

test('a focused option row does not kill the navigation keys', async () => {
  // THE HEADLINE FIX. A mouse click leaves the row focused; the old guard
  // resolved that <button> as the key owner and bailed on every key after it.
  const { card, calls } = await mountFlow()
  const rows = optionRows(card)
  await focusIn(rows[1]!)
  expect(document.activeElement).toBe(rows[1]!)

  const down = await press(rows[1]!, 'ArrowDown')
  expect(down.defaultPrevented).toBe(true)

  const digit = await press(rows[1]!, '1')
  expect(digit.defaultPrevented).toBe(true)
  expect(markerText(optionRows(card)[0]!)).toBe('✓')

  const escape = await press(rows[1]!, 'Escape')
  expect(escape.defaultPrevented).toBe(true)
  expect(calls.cancels).toBe(1)
  expect(calls.answers).toHaveLength(0)
})

test('Enter submits an option picked with the mouse', async () => {
  const { card, calls } = await mountFlow()
  const row = optionRows(card)[1]!
  await act(async () => {
    row.click()
    row.focus()
  })
  expect(markerText(row)).toBe('✓')
  expect(document.activeElement).toBe(row)

  const enter = await press(row, 'Enter')
  expect(enter.defaultPrevented).toBe(true)
  expect(calls.answers).toEqual([[{ optionIndices: [1] }]])
})

test('Enter on the focused Cancel button is left to the button, not claimed as submit', async () => {
  // The regression the containment test introduced: claiming Enter everywhere
  // inside the card meant `preventDefault()` suppressed the browser's
  // Enter -> click, and `advance()` ran instead. The user pressed Enter on a
  // button labelled Cancel and the answer went to the engine.
  const { card, calls } = await mountFlow()
  await press(optionRows(card)[0]!, '1') // make the answer submittable
  const cancel = buttonWithText(card, 'Cancel')
  await focusIn(cancel)

  const enter = await press(cancel, 'Enter')
  expect(enter.defaultPrevented).toBe(false) // the button's own activation survives
  expect(calls.answers).toHaveLength(0)
})

test('Space on a focused footer button is left to the button', async () => {
  const { card, calls } = await mountFlow(MULTI)
  const cancel = buttonWithText(card, 'Cancel')
  await focusIn(cancel)
  const space = await press(cancel, ' ')
  expect(space.defaultPrevented).toBe(false)
  // ...and it did NOT toggle the cursor's option row behind the user's back.
  expect(markerText(optionRows(card)[0]!)).toBe('')
  expect(checkedState(optionRows(card)[0]!)).toBe('false')
  expect(calls.answers).toHaveLength(0)
})

test('one Enter selects the highlighted option and submits', async () => {
  const { card, calls } = await mountFlow()
  const enter = await press(card, 'Enter')
  expect(enter.defaultPrevented).toBe(true)
  expect(calls.answers).toHaveLength(1)
  expect(calls.answers[0]).toEqual([{ optionIndices: [0] }])
})

test('one Enter per single-select step selects each highlighted option and advances', async () => {
  const { card, calls } = await mountFlow(TWO_QUESTIONS)
  await press(card, 'Enter')
  expect(calls.answers).toHaveLength(0)
  expect(card.textContent).toContain('Which runtime?')

  await press(card, 'Enter')
  expect(calls.answers).toEqual([
    [{ optionIndices: [0] }, { optionIndices: [0] }],
  ])
})

test('the full sequence preserves multi-select and reaches the third preview option', async () => {
  const { card, calls } = await mountFlow(ALL_TYPES)
  await press(card, 'Enter')
  expect(card.textContent).toContain('Which colors?')

  // Enter cannot invent a single answer for a multi-select question.
  await press(card, 'Enter')
  expect(card.textContent).toContain('Which colors?')
  expect(calls.answers).toHaveLength(0)

  await press(card, ' ')
  await press(card, 'ArrowDown')
  await press(card, ' ')
  expect(markerText(optionRows(card)[0]!)).toBe('✓')
  expect(markerText(optionRows(card)[1]!)).toBe('✓')

  await press(card, 'Enter')
  expect(card.textContent).toContain('Which code style?')
  await press(card, 'ArrowDown')
  await press(card, 'ArrowDown')
  const third = optionRows(card)[2]!
  expect(third.getAttribute('data-ask-active')).toBe('true')
  expect(third.textContent).toContain('Ternary')
  expect(card.textContent).toContain('use a ternary')

  await press(card, 'Enter')
  expect(card.textContent).toContain('Custom response?')
  expect(calls.answers).toHaveLength(0)
})

test('mouse clicks accumulate multiple selections', async () => {
  const { card } = await mountFlow(MULTI)
  const rows = optionRows(card)
  await act(async () => {
    rows[0]!.click()
  })
  await act(async () => {
    rows[1]!.click()
  })
  expect(markerText(optionRows(card)[0]!)).toBe('✓')
  expect(markerText(optionRows(card)[1]!)).toBe('✓')
})

test('two toggles inside ONE task both survive', async () => {
  // The test above clicks in two separate `act()` calls, so React re-rendered
  // between them and each toggle read a fresh draft. Batched into one task —
  // a double-click, a key repeat — both handlers used to read the SAME closed-over
  // draft and the second overwrote the first, leaving one selection instead of two.
  const { card } = await mountFlow(MULTI)
  const rows = optionRows(card)
  await act(async () => {
    rows[0]!.click()
    rows[1]!.click()
  })
  expect(markerText(optionRows(card)[0]!)).toBe('✓')
  expect(markerText(optionRows(card)[1]!)).toBe('✓')
})

test('a chosen option stays chosen when the cursor moves off it', async () => {
  // The live failure: the cursor tint outranked the chosen tint, so moving the
  // pointer to the next row visibly dimmed the answer just picked and the card
  // read as not selectable at all. Chosen and cursor are now two channels —
  // `aria-checked` plus a filled marker for chosen, the row tint for cursor.
  const { card } = await mountFlow(MULTI)
  await act(async () => {
    optionRows(card)[0]!.click()
  })
  await press(card, 'ArrowDown')

  const rows = optionRows(card)
  expect(rows[1]!.getAttribute('data-ask-active')).toBe('true')
  expect(rows[0]!.getAttribute('data-ask-active')).toBe(null)
  // The cursor moved; the answer did not.
  expect(checkedState(rows[0]!)).toBe('true')
  expect(markerText(rows[0]!)).toBe('✓')
  expect(checkedState(rows[1]!)).toBe('false')
  expect(markerText(rows[1]!)).toBe('')
})

test('the multi-select row control is a checkbox and the single-select one a radio', async () => {
  // The only wordless answer to "may I pick more than one?" — a square outline
  // against a round one. A filled digit chip said neither.
  const multi = await mountFlow(MULTI)
  expect(optionRows(multi.card)[0]!.getAttribute('role')).toBe('checkbox')
  await multi.tree.unmount()

  const single = await mountFlow(SINGLE)
  expect(optionRows(single.card)[0]!.getAttribute('role')).toBe('radio')
})

test('the multi-select count tracks what is selected', async () => {
  // The second channel: the operator could not tell a click had registered.
  const { card } = await mountFlow(MULTI)
  expect(card.textContent).toContain('Pick as many as you like')
  await act(async () => {
    optionRows(card)[0]!.click()
  })
  expect(card.textContent).toContain('1 selected')
  await act(async () => {
    optionRows(card)[1]!.click()
  })
  expect(card.textContent).toContain('2 selected')
  expect(card.textContent).not.toContain('Pick as many as you like')
})

test('the count includes a freeform answer, which is drawn as chosen too', async () => {
  const { card } = await mountFlow(MULTI)
  await act(async () => {
    optionRows(card)[0]!.click()
  })
  await press(card, 'o')
  const input = card.querySelector('input') as HTMLInputElement
  await act(async () => {
    // React installs a value tracker on the node, so assigning `.value`
    // directly is deduped away and `onChange` never fires. Go through the
    // prototype setter the way a real keystroke does.
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set
    setValue?.call(input, 'something else')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(card.textContent).toContain('2 selected')
})

test('Tab-focusing a row moves the cursor onto it', async () => {
  // Otherwise the focus ring and the cursor ring sit on different rows, and
  // space toggles the one the user is not looking at.
  const { card } = await mountFlow(MULTI)
  const rows = optionRows(card)
  await focusIn(rows[1]!)
  expect(rows[1]!.getAttribute('data-ask-active')).toBe('true')
  expect(optionRows(card)[0]!.getAttribute('data-ask-active')).toBe(null)
})

test('the card takes focus from the composer when it appears', async () => {
  const composer = document.createElement('textarea')
  document.body.appendChild(composer)
  composer.focus()
  const { calls, card } = await mountFlow()
  expect(document.activeElement).toBe(card)

  await press(card, 'Enter')
  expect(calls.answers).toEqual([[{ optionIndices: [0] }]])
  composer.remove()
})

test('the card does not take focus from behind an open modal', async () => {
  // A docked card sits BEHIND a dialog's scrim. Taking the keyboard there let
  // digits and Enter answer a question the user cannot see while they are
  // looking at the dialog.
  const dialog = document.createElement('div')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.tabIndex = -1
  document.body.appendChild(dialog)
  await focusIn(dialog)

  const { card } = await mountFlow()
  expect(document.activeElement).toBe(dialog)
  expect(document.activeElement).not.toBe(card)
  dialog.remove()
})

test('unmounting hands the keyboard back to whatever had it', async () => {
  // `document.activeElement === node` is false by the time passive cleanup
  // runs: React detaches the host node first, which resets activeElement to
  // <body>. Checking only that restored nothing, so answering a question left
  // the keyboard on <body>.
  const before = document.createElement('button')
  document.body.appendChild(before)
  await focusIn(before)

  const calls = { answers: [] as AskUserQuestionAnswer[][], cancels: 0 }
  const tree = await harness.mount(
    <AskQuestionFlow
      isActivePane
      onAnswer={answers => calls.answers.push(answers)}
      onCancel={() => {
        calls.cancels += 1
      }}
      questions={SINGLE}
      requestId="perm-1"
    />,
  )
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  expect(document.activeElement).toBe(
    tree.container.querySelector('section') as HTMLElement,
  )

  await tree.unmount()
  expect(document.activeElement).toBe(before)
  before.remove()
})
