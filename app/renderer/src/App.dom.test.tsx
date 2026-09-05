/**
 * Behavioural cover for the two App-owned keyboards.
 *
 * `App.test.tsx` is a `renderToStaticMarkup` suite, so the facts below used to
 * be pinned there as source text with an apology attached: no key could be
 * pressed and no focus moved, so the assertions could only say that a named
 * branch still existed. `domTestHarness.ts` removed that limit for anything
 * mountable without the preload bridge, which both surfaces here are.
 *
 * What moved:
 *  - the permission card's `document` keydown listener and its focus guard
 *    (was: source greps over `PermissionPrompt.tsx` and
 *    `permissionPromptModel.ts`, App.test.tsx `FIX-5 keyboard tripwire`);
 *  - the composer's own keydown branches for recall, history, interrupt,
 *    newline, and the paste pill's remove button (was: `D1b: ↑ takes waiting
 *    messages back…` and `the composer authors newlines, drops, and pill
 *    removal itself`).
 *
 * What did NOT move, and stays in `App.test.tsx`: everything inside `App`
 * itself. `App` reads `window.catcode` from its first effect, so mounting it
 * would mean standing up a whole fake preload bridge, which is a bigger machine
 * than the tripwires it would replace.
 */

import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { useState } from 'react'
import type { ComponentProps } from 'react'

import { SessionPane } from './App.js'
import { PermissionPrompt } from './PermissionPrompt.js'
import { PERMISSION_KEY_HOST_ATTR } from './permissionPromptModel.js'
import type { PermissionRequest } from './permissionState.js'
import { createDomTestHarness } from './domTestHarness.js'
import type { DomTestHarness, MountedTree } from './domTestHarness.js'
import { idleSessionPaneProps } from './sessionPaneTestProps.js'
import { formatPasteRef, type PasteEntry } from './composerState.js'

let harness: DomTestHarness

beforeAll(async () => {
  harness = await createDomTestHarness()
})

afterEach(async () => {
  await harness.unmountAll()
})

afterAll(async () => {
  await harness.teardown()
})

async function press(
  target: EventTarget,
  init: KeyboardEventInit & { key: string },
): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))
  })
}

/* ── the permission card's keyboard ────────────────────────────────────────── */

const REQUEST: PermissionRequest = {
  requestId: 'perm-1',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'Bash',
    input: { command: 'date' },
    tool_use_id: 'toolu-1',
  },
}

type Answers = { allow: number[][]; deny: number }

function answers(): Answers {
  return { allow: [], deny: 0 }
}

async function mountCard(
  recorded: Answers,
  over: Partial<ComponentProps<typeof PermissionPrompt>> = {},
): Promise<MountedTree> {
  const tree = await harness.mount(
    <PermissionPrompt
      keyboardTarget
      onAllow={indexes => recorded.allow.push(indexes)}
      onDeny={() => {
        recorded.deny += 1
      }}
      request={REQUEST}
      {...over}
    />,
  )
  // The card takes the keyboard from a `setTimeout(0)` so the focus lands after
  // the commit that produced it. Everything below depends on that having run.
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  })
  return tree
}

function cardOf(tree: MountedTree): HTMLElement {
  const card = tree.container.querySelector<HTMLElement>('[role="alertdialog"]')
  if (!card) throw new Error('no permission card in the mounted tree')
  return card
}

function optionButtons(tree: MountedTree): HTMLButtonElement[] {
  return [
    ...tree.container.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Response options"] button',
    ),
  ]
}

test('a key with nothing focused confirms the row the cursor is on', async () => {
  const recorded = answers()
  const tree = await mountCard(recorded)

  await press(harness.document, { key: 'Enter' })

  expect(recorded.allow).toHaveLength(1)
  expect(recorded.deny).toBe(0)
  // The cursor starts on row 1, so this is the row the card paints as current.
  expect(optionButtons(tree)[0]?.getAttribute('aria-current')).toBe('true')
})

test('Enter aimed at a control on the card never answers as an allow', async () => {
  // The regression: the guard tested `tagName === 'INPUT'`, so Enter on the
  // card's Refuse button reached the document listener, was answered as an
  // ALLOW, and `preventDefault()` suppressed the browser's Enter-to-click that
  // would have refused. Focus is deliberately NOT moved here: that isolates the
  // event-target guard from the separate `keysLive` one, so this fails if the
  // target guard alone is removed.
  const recorded = answers()
  const tree = await mountCard(recorded)
  const rows = optionButtons(tree)
  expect(rows.length).toBeGreaterThan(1)

  for (const row of rows) await press(row, { key: 'Enter' })

  expect(recorded.allow).toEqual([])
  expect(recorded.deny).toBe(0)
})

test('every control that owns the key holds it, and only the marked card is exempt', async () => {
  // The selector behind `permissionKeysAreLive`, asserted by making each owner
  // the real event target rather than by reading the selector's text.
  const recorded = answers()
  await mountCard(recorded)

  const owners: Array<[string, Record<string, string>]> = [
    ['button', {}],
    ['input', {}],
    ['textarea', {}],
    ['div', { role: 'menuitem' }],
    ['div', { role: 'menuitemradio' }],
    // An unmarked dialog: the card's own section carries this role, so the
    // exemption has to come from the marker and not from the role.
    ['div', { role: 'alertdialog' }],
  ]
  for (const [tag, attributes] of owners) {
    const owner = harness.document.createElement(tag)
    for (const [name, value] of Object.entries(attributes)) {
      owner.setAttribute(name, value)
    }
    harness.document.body.appendChild(owner)
    await press(owner, { key: 'Enter' })
    owner.remove()
  }

  expect(recorded.allow).toEqual([])
})

test('the marked card hosts the keys instead of owning them', async () => {
  const recorded = answers()
  const tree = await mountCard(recorded)
  const card = cardOf(tree)
  expect(card.hasAttribute(PERMISSION_KEY_HOST_ATTR)).toBe(true)

  await press(card, { key: 'Enter' })

  expect(recorded.allow).toHaveLength(1)
})

test('an answered card refuses a second decision from the keyboard', async () => {
  const recorded = answers()
  const tree = await mountCard(recorded)

  await press(harness.document, { key: 'Enter' })
  expect(recorded.allow).toHaveLength(1)

  // What App does the moment an answer is sent: the rows go disabled, and the
  // keyboard must not fire a second decision before the resolve lands.
  await tree.render(
    <PermissionPrompt
      keyboardTarget
      onAllow={indexes => recorded.allow.push(indexes)}
      onDeny={() => {
        recorded.deny += 1
      }}
      request={REQUEST}
      submitted
    />,
  )
  await press(harness.document, { key: 'Enter' })
  await press(harness.document, { key: 'Escape' })

  expect(recorded.allow).toHaveLength(1)
  expect(recorded.deny).toBe(0)
})

test('a card the shortcuts do not act on registers no listener at all', async () => {
  // This is what replaces App's old explicit dedicated-flow and activeView
  // guards: a background pane's card, or any card while AskQuestionFlow holds
  // the keyboard, is simply not the target.
  const recorded = answers()
  await mountCard(recorded, { keyboardTarget: false })

  await press(harness.document, { key: 'Enter' })
  await press(harness.document, { key: 'Escape' })

  expect(recorded.allow).toEqual([])
  expect(recorded.deny).toBe(0)
})

/* ── the composer's keyboard ───────────────────────────────────────────────── */

type ComposerLog = {
  drafts: string[]
  recalls: number
  removals: Array<{ entry: PasteEntry; at: number }>
}

function composerLog(): ComposerLog {
  return { drafts: [], recalls: 0, removals: [] }
}

/**
 * The pane, controlled the way App controls it: `prompt` is state here, so a
 * draft the keydown handler writes is really applied and read back.
 */
function ControlledPane({
  log,
  initialPrompt = '',
  over = {},
}: {
  log: ComposerLog
  initialPrompt?: string
  over?: Partial<ComponentProps<typeof SessionPane>>
}) {
  const [prompt, setPrompt] = useState(initialPrompt)
  return (
    <SessionPane
      {...idleSessionPaneProps()}
      {...over}
      prompt={prompt}
      setPrompt={next => {
        log.drafts.push(next)
        setPrompt(next)
      }}
    />
  )
}

function composerOf(tree: MountedTree): HTMLElement {
  const composer = tree.container.querySelector<HTMLElement>(
    '[contenteditable="true"]',
  )
  if (!composer) throw new Error('no contentEditable composer in the mounted pane')
  return composer
}

/** Put the caret at `offset` in the composer's first text node. */
function placeCaret(root: Node, offset: number): void {
  const walk = (node: Node): Text | null => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) return child as Text
      const nested = walk(child)
      if (nested) return nested
    }
    return null
  }
  const text = walk(root)
  if (!text) throw new Error('no text node in composer')
  const range = harness.document.createRange()
  range.setStart(text, offset)
  range.setEnd(text, offset)
  const selection = globalThis.window.getSelection()
  if (!selection) throw new Error('no document selection in the DOM harness')
  selection.removeAllRanges()
  selection.addRange(range)
}

test('ArrowUp takes waiting messages back before it walks history', async () => {
  // The ORDER is the whole behaviour: a ↑ that reached history first would swap
  // the draft for a history entry while messages sat waiting, and the take-back
  // would be unreachable from the keyboard.
  const log = composerLog()
  const tree = await harness.mount(
    <ControlledPane
      log={log}
      over={{
        history: ['an older prompt'],
        queuedPrompts: [{ id: 'q-1', text: 'one' }],
        onRecallQueuedPrompts: () => {
          log.recalls += 1
        },
      }}
    />,
  )

  await press(composerOf(tree), { key: 'ArrowUp' })

  expect(log.recalls).toBe(1)
  expect(log.drafts).toEqual([])
})

test('ArrowUp walks history once nothing is waiting', async () => {
  const log = composerLog()
  const tree = await harness.mount(
    <ControlledPane
      log={log}
      over={{
        history: ['an older prompt'],
        queuedPrompts: [],
        onRecallQueuedPrompts: () => {
          log.recalls += 1
        },
      }}
    />,
  )

  await press(composerOf(tree), { key: 'ArrowUp' })

  expect(log.recalls).toBe(0)
  expect(log.drafts).toEqual(['an older prompt'])
})

test('Escape interrupts a running turn instead of taking the queue back', async () => {
  // Terminal parity: a running turn takes Escape as the interrupt and leaves the
  // queue alone (`useCancelRequest.ts` `handleCancel`, priority 1).
  const aborted: string[] = []
  const previous = Object.getOwnPropertyDescriptor(globalThis.window, 'catcode')
  Object.defineProperty(globalThis.window, 'catcode', {
    configurable: true,
    value: {
      abort: (sessionId: string) => aborted.push(sessionId),
    } as unknown as typeof globalThis.window.catcode,
  })

  try {
    const log = composerLog()
    const tree = await harness.mount(
      <ControlledPane
        log={log}
        over={{
          activeConnection: { status: 'ready', inputEnabled: false },
          queuedPrompts: [{ id: 'q-1', text: 'one' }],
          onRecallQueuedPrompts: () => {
            log.recalls += 1
          },
        }}
      />,
    )

    await press(composerOf(tree), { key: 'Escape' })

    expect(aborted).toEqual(['session-1'])
    expect(log.recalls).toBe(0)
  } finally {
    if (previous) Object.defineProperty(globalThis.window, 'catcode', previous)
    else Reflect.deleteProperty(globalThis.window, 'catcode')
  }
})

test('a modified Enter writes the newline into the draft itself', async () => {
  // Left to the browser, a contentEditable answers Alt/Meta+Enter with a block
  // container rather than the <br> the serializer reads, so the line break
  // rendered once and then vanished from the draft.
  for (const modifier of ['shiftKey', 'altKey', 'metaKey'] as const) {
    const log = composerLog()
    const tree = await harness.mount(
      <ControlledPane initialPrompt="ab" log={log} />,
    )
    const composer = composerOf(tree)
    placeCaret(composer, 1)

    await press(composer, { key: 'Enter', [modifier]: true })

    expect(log.drafts).toEqual(['a\nb'])
    await tree.unmount()
  }
})

test('a plain Enter submits instead of writing a newline', async () => {
  const log = composerLog()
  let submits = 0
  const tree = await harness.mount(
    <ControlledPane
      initialPrompt="ab"
      log={log}
      over={{
        submit: () => {
          submits += 1
        },
      }}
    />,
  )
  const composer = composerOf(tree)
  placeCaret(composer, 1)

  await press(composer, { key: 'Enter' })

  expect(log.drafts).toEqual([])
  expect(submits).toBe(1)
})

test('a paste pill is removed at the position it holds right now', async () => {
  // The pill's remove listener is attached once, when the pill node is built,
  // and survives every edit after it. Both halves of that are the bug: a
  // callback captured at build time is the render's stale one, and a position
  // captured at build time points at the wrong text as soon as anything is
  // typed before the pill.
  const log = composerLog()
  const entry: PasteEntry = { id: 1, content: 'a large paste', numLines: 0 }
  const token = formatPasteRef(entry.id, entry.numLines)
  const stale = composerLog()

  const paneWith = (prompt: string, sink: ComposerLog) => (
    <SessionPane
      {...idleSessionPaneProps()}
      pastes={[entry]}
      prompt={prompt}
      onRemovePaste={(removed, at) => sink.removals.push({ entry: removed, at })}
      setPrompt={next => sink.drafts.push(next)}
    />
  )

  const tree = await harness.mount(paneWith(token, stale))
  // The draft grows in front of the pill, and the handler is replaced. Neither
  // rebuilds the listener the button already carries.
  await tree.render(paneWith(`hello ${token}`, log))

  const remove = tree.container.querySelector<HTMLButtonElement>(
    `button[aria-label="Remove pasted text ${entry.id}"]`,
  )
  if (!remove) throw new Error('no paste pill remove control in the mounted pane')
  await act(async () => {
    remove.click()
  })

  expect(stale.removals).toEqual([])
  expect(log.removals).toEqual([{ entry, at: 'hello '.length }])
})
