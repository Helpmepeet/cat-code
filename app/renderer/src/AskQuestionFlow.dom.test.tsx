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
  // The option rows are the buttons carrying a numbered/checked marker; the
  // footer's Submit and Cancel are the last two buttons in the card.
  return Array.from(card.querySelectorAll<HTMLButtonElement>('button')).filter(
    button => button.querySelector('span.font-mono') !== null,
  )
}

function buttonWithText(card: HTMLElement, text: string): HTMLButtonElement {
  const match = Array.from(
    card.querySelectorAll<HTMLButtonElement>('button'),
  ).find(button => button.textContent?.trim().startsWith(text))
  if (!match) throw new Error(`no button starting with ${text}`)
  return match
}

function markerText(row: HTMLElement): string {
  return row.querySelector('span.font-mono')?.textContent?.trim() ?? ''
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
  expect(markerText(optionRows(card)[0]!)).toBe('1')
  expect(calls.answers).toHaveLength(0)
})

test('Enter with focus on the card itself advances and submits', async () => {
  const { card, calls } = await mountFlow()
  await press(card, '1')
  const enter = await press(card, 'Enter')
  expect(enter.defaultPrevented).toBe(true)
  expect(calls.answers).toHaveLength(1)
  expect(calls.answers[0]).toEqual([{ optionIndices: [0] }])
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

  await press(card, '1')
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
