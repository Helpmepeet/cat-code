/**
 * Real-DOM proof for the composer paste boundary.
 *
 * `SessionPane` owns the form-level paste handler while `ComposerInput` keeps a
 * plain controlled draft in an imperatively maintained contentEditable. A
 * native rich paste must therefore be canceled before the browser can put the
 * clipboard's HTML into that field.
 *
 * The nested-target case is intentional: a contentEditable can have a
 * descendant at the caret, and the event still belongs to the composer. The
 * form must not confuse that descendant with the composer action bar, which is
 * also inside the form.
 */

import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, createElement, useRef, useState } from 'react'

import { SessionPane } from './App.js'
import { createDomTestHarness } from './domTestHarness.js'
import type { DomTestHarness, MountedTree } from './domTestHarness.js'
import {
  countNewlines,
  formatPasteRef,
  type ImageAttachment,
  type PasteEntry,
} from './composerState.js'
import {
  PASTE_TOKEN_ATTR,
  readComposerText,
} from './composerDom.js'
import { idleSessionPaneProps } from './sessionPaneTestProps.js'

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

type PasteObservation = {
  drafts: string[]
  collapsed: Array<{
    content: string
    start: number
    end: number
  }>
  images: Array<Omit<ImageAttachment, 'id'>>
  imageAttached: Promise<void>
  resolveImageAttached: () => void
}

/**
 * Keep the SessionPane controlled like the shipped App, while exposing only
 * state transitions this test needs to observe.
 */
function ControlledPane({
  initialPrompt,
  observation,
}: {
  initialPrompt: string
  observation: PasteObservation
}) {
  const [prompt, setPrompt] = useState(initialPrompt)
  const [pastes, setPastes] = useState<PasteEntry[]>([])
  const [images, setImages] = useState<ImageAttachment[]>([])
  const nextPasteId = useRef(1)
  const base = idleSessionPaneProps()

  return createElement(SessionPane, {
    ...base,
    images,
    onAttachImage: attachment => {
      observation.images.push(attachment)
      observation.resolveImageAttached()
      setImages(current => [
        ...current,
        { ...attachment, id: current.length + 1 },
      ])
    },
    onPaste: (content, start, end) => {
      const pasteStart = start ?? prompt.length
      const pasteEnd = end ?? prompt.length
      observation.collapsed.push({
        content,
        start: pasteStart,
        end: pasteEnd,
      })
      const id = nextPasteId.current++
      const numLines = countNewlines(content)
      const token = formatPasteRef(id, numLines)
      setPastes(current => [...current, { id, content, numLines }])
      const next = `${prompt.slice(0, pasteStart)}${token}${prompt.slice(pasteEnd)}`
      observation.drafts.push(next)
      setPrompt(next)
    },
    pastes,
    prompt,
    setPrompt: next => {
      observation.drafts.push(next)
      setPrompt(next)
    },
  })
}

function composerOf(tree: MountedTree): HTMLDivElement {
  const composer = tree.container.querySelector<HTMLDivElement>(
    '[contenteditable="true"]',
  )
  if (!composer) throw new Error('no contentEditable composer in the mounted pane')
  return composer
}

function textNodeOf(root: Node): Text {
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === 3) return child as Text
    const nested = textNodeOf(child)
    if (nested) return nested
  }
  throw new Error('no text node in composer')
}

function selectText(root: Node, start: number, end: number): void {
  const text = textNodeOf(root)
  const range = document.createRange()
  range.setStart(text, start)
  range.setEnd(text, end)
  const selection = window.getSelection()
  if (!selection) throw new Error('no document selection in the DOM harness')
  selection.removeAllRanges()
  selection.addRange(range)
}

function clipboardPaste({
  text,
  html,
  files = [],
}: {
  text?: string
  html?: string
  files?: File[]
}): ClipboardEvent {
  const clipboardData = new DataTransfer()
  if (text !== undefined) clipboardData.setData('text/plain', text)
  if (html !== undefined) clipboardData.setData('text/html', html)
  for (const file of files) clipboardData.items.add(file)
  return new ClipboardEvent('paste', {
    bubbles: true,
    cancelable: true,
    clipboardData,
  })
}

async function dispatchPaste(
  target: EventTarget,
  event: ClipboardEvent,
): Promise<void> {
  await act(async () => {
    target.dispatchEvent(event)
  })
}

/**
 * happy-dom does not implement the browser's paste editing default action.
 * Apply that action only when the event was not canceled, so a test failure
 * leaves the same rich DOM a browser would have inserted.
 */
function applyNativeRichPasteIfAllowed(
  root: HTMLElement,
  event: ClipboardEvent,
  html: string,
): void {
  if (event.defaultPrevented) return
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return
  const range = selection.getRangeAt(0)
  if (
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer)
  ) {
    return
  }
  const template = document.createElement('template')
  template.innerHTML = html
  range.deleteContents()
  range.insertNode(template.content)
}

function observation(): PasteObservation {
  let resolveImageAttached!: () => void
  const imageAttached = new Promise<void>(resolve => {
    resolveImageAttached = resolve
  })
  return {
    drafts: [],
    collapsed: [],
    images: [],
    imageAttached,
    resolveImageAttached,
  }
}

test('a rich paste from a nested composer target inserts only the selected plain text', async () => {
  const observed = observation()
  const initial = 'before selected after'
  const replacement = 'PASTED PLAIN'
  const richHtml =
    '<span class="transcript-bubble" style="font-weight:700"><strong>PASTED PLAIN</strong></span>'
  const tree = await harness.mount(
    createElement(ControlledPane, {
      initialPrompt: initial,
      observation: observed,
    }),
  )
  const composer = composerOf(tree)

  // Simulate an existing descendant editing target, as browsers can leave
  // behind around a caret in a contentEditable. Its text still matches the
  // controlled draft, so composerDom's drift guard would otherwise preserve it.
  composer.textContent = ''
  composer.append(
    document.createTextNode('before '),
    (() => {
      const wrapper = document.createElement('span')
      wrapper.className = 'existing-formatting'
      wrapper.style.fontWeight = '700'
      const strong = document.createElement('strong')
      strong.textContent = 'selected'
      wrapper.appendChild(strong)
      return wrapper
    })(),
    document.createTextNode(' after'),
  )
  const target = composer.querySelector('strong')
  if (!target) throw new Error('no nested composer target')
  selectText(target, 0, 'selected'.length)

  const event = clipboardPaste({ text: replacement, html: richHtml })
  await dispatchPaste(target, event)
  applyNativeRichPasteIfAllowed(composer, event, richHtml)
  await harness.nextFrame()

  expect(event.defaultPrevented).toBe(true)
  expect(observed.drafts.at(-1)).toBe('before PASTED PLAIN after')
  expect(readComposerText(composer)).toBe('before PASTED PLAIN after')
  expect(composer.textContent).toBe('before PASTED PLAIN after')
  expect(composer.querySelector('strong')).toBeNull()
  expect(composer.querySelector('[style], .transcript-bubble')).toBeNull()
})

test('a plain-text-only paste replaces the selected draft text', async () => {
  const observed = observation()
  const initial = 'keep selected text'
  const tree = await harness.mount(
    createElement(ControlledPane, {
      initialPrompt: initial,
      observation: observed,
    }),
  )
  const composer = composerOf(tree)
  selectText(composer, 'keep '.length, 'keep selected'.length)

  const event = clipboardPaste({ text: 'new text' })
  await dispatchPaste(composer, event)
  await harness.nextFrame()

  expect(event.defaultPrevented).toBe(true)
  expect(observed.drafts.at(-1)).toBe('keep new text text')
  expect(readComposerText(composer)).toBe('keep new text text')
  expect(composer.querySelector('*')).toBeNull()
})

test('an HTML-only paste is canceled without changing the controlled draft', async () => {
  const observed = observation()
  const initial = 'leave this alone'
  const richHtml = '<mark class="transcript-selection">foreign HTML</mark>'
  const tree = await harness.mount(
    createElement(ControlledPane, {
      initialPrompt: initial,
      observation: observed,
    }),
  )
  const composer = composerOf(tree)
  selectText(composer, initial.length, initial.length)

  const event = clipboardPaste({ html: richHtml })
  await dispatchPaste(composer, event)
  applyNativeRichPasteIfAllowed(composer, event, richHtml)
  await harness.nextFrame()

  expect(event.defaultPrevented).toBe(true)
  expect(observed.drafts).toEqual([])
  expect(readComposerText(composer)).toBe(initial)
  expect(composer.textContent).toBe(initial)
  expect(composer.querySelector('mark')).toBeNull()
})

test('a large paste still becomes one inline paste pill', async () => {
  const observed = observation()
  const initial = 'start END'
  const content = 'line one\nline two\nline three\nline four'
  const richHtml = `<pre class="transcript-code">${content}</pre>`
  const tree = await harness.mount(
    createElement(ControlledPane, {
      initialPrompt: initial,
      observation: observed,
    }),
  )
  const composer = composerOf(tree)
  selectText(composer, 'start '.length, initial.length)

  const event = clipboardPaste({ text: content, html: richHtml })
  await dispatchPaste(composer, event)
  await harness.nextFrame()

  const token = formatPasteRef(1, 3)
  expect(event.defaultPrevented).toBe(true)
  expect(observed.collapsed).toEqual([
    { content, start: 'start '.length, end: initial.length },
  ])
  expect(readComposerText(composer)).toBe(`start ${token}`)
  expect(composer.querySelector(`[${PASTE_TOKEN_ATTR}="${token}"]`)).not.toBeNull()
  expect(composer.querySelector('pre')).toBeNull()
})

test('an image paste is prevented from entering the text draft', async () => {
  const observed = observation()
  const initial = 'keep this text'
  const tree = await harness.mount(
    createElement(ControlledPane, {
      initialPrompt: initial,
      observation: observed,
    }),
  )
  const composer = composerOf(tree)
  selectText(composer, initial.length, initial.length)
  const event = clipboardPaste({
    text: 'ignored text',
    html: '<strong>ignored rich text</strong>',
    files: [new File(['png bytes'], 'pasted.png', { type: 'image/png' })],
  })

  await dispatchPaste(composer, event)
  await act(async () => {
    await observed.imageAttached
  })
  await harness.nextFrame()

  expect(event.defaultPrevented).toBe(true)
  expect(observed.drafts).toEqual([])
  expect(readComposerText(composer)).toBe(initial)
  expect(observed.images).toEqual([
    {
      mediaType: 'image/png',
      data: 'cG5nIGJ5dGVz',
      name: 'pasted.png',
    },
  ])
})

/**
 * The DROP half of the same transfer boundary (CC-84). It shares every piece of
 * scaffolding above — the controlled pane, the composer lookup, the draft
 * observation — so it lives here rather than in a second file that would copy
 * all of it.
 *
 * The bug: `handleDrop` read only `dataTransfer.getData('text')` and returned
 * when it was empty. A Finder drag puts its payload on `dataTransfer.files` and
 * leaves `text/plain` empty, so dropping an image on the composer did nothing at
 * all, with no feedback.
 */
function fileDrop({
  text,
  files = [],
}: {
  text?: string
  files?: File[]
}): Event {
  const dataTransfer = new DataTransfer()
  if (text !== undefined) dataTransfer.setData('text/plain', text)
  for (const file of files) dataTransfer.items.add(file)
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    configurable: true,
    value: dataTransfer,
  })
  // The composer places a text drop at the pointer and falls back to the caret
  // when the point resolves to nothing, which is the happy-dom case.
  Object.defineProperty(event, 'clientX', { configurable: true, value: 0 })
  Object.defineProperty(event, 'clientY', { configurable: true, value: 0 })
  return event
}

test('an image dropped on the composer is attached, not ignored', async () => {
  const observed = observation()
  const initial = 'keep this text'
  const tree = await harness.mount(
    createElement(ControlledPane, {
      initialPrompt: initial,
      observation: observed,
    }),
  )
  const composer = composerOf(tree)

  await act(async () => {
    composer.dispatchEvent(
      fileDrop({
        files: [new File(['png bytes'], 'dropped.png', { type: 'image/png' })],
      }),
    )
  })
  await act(async () => {
    await observed.imageAttached
  })
  await harness.nextFrame()

  expect(observed.images).toEqual([
    {
      mediaType: 'image/png',
      data: 'cG5nIGJ5dGVz',
      name: 'dropped.png',
    },
  ])
  // The image never becomes text, and the draft is untouched.
  expect(observed.drafts).toEqual([])
  expect(readComposerText(composer)).toBe(initial)
})

test('a text drop still lands in the draft', async () => {
  const observed = observation()
  const initial = 'start'
  const tree = await harness.mount(
    createElement(ControlledPane, {
      initialPrompt: initial,
      observation: observed,
    }),
  )
  const composer = composerOf(tree)

  await act(async () => {
    composer.dispatchEvent(fileDrop({ text: 'dropped words' }))
  })
  await harness.nextFrame()

  expect(observed.drafts.at(-1)).toContain('dropped words')
  expect(observed.images).toEqual([])
})

// Scope is strictly images: turning a dropped file into a path the engine reads
// would make the renderer the author of a filesystem path (HC1).
test('a dropped non-image file changes nothing', async () => {
  const observed = observation()
  const initial = 'keep this text'
  const tree = await harness.mount(
    createElement(ControlledPane, {
      initialPrompt: initial,
      observation: observed,
    }),
  )
  const composer = composerOf(tree)

  await act(async () => {
    composer.dispatchEvent(
      fileDrop({
        files: [new File(['%PDF'], 'report.pdf', { type: 'application/pdf' })],
      }),
    )
  })
  await harness.nextFrame()

  expect(observed.images).toEqual([])
  expect(observed.drafts).toEqual([])
  expect(readComposerText(composer)).toBe(initial)
})
