import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, useState } from 'react'
import { SessionPane } from './SessionPane.js'
import { SlashCommandPicker } from './SlashCommandPicker.js'
import { createDomTestHarness, type DomTestHarness, type MountedTree } from './domTestHarness.js'
import { idleSessionPaneProps } from './sessionPaneTestProps.js'
import { composerCaretOnEdgeRow, composerSelectionOffsets, placeComposerSelection } from './composerDom.js'
import { EMPTY_HISTORY_NAV, type HistoryNav } from './composerState.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })

function fieldOf(tree: MountedTree): HTMLDivElement {
  return tree.container.querySelector<HTMLDivElement>('[aria-label="Prompt"]')!
}

async function key(field: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    field.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))
  })
}

/** This DOM has no layout, so wrap a single text node every `perRow` characters. */
async function withWrappedRows(perRow: number, run: () => Promise<void>): Promise<void> {
  const original = Range.prototype.getClientRects
  Range.prototype.getClientRects = function (this: Range) {
    const text = this.commonAncestorContainer.textContent ?? ''
    const start = this.startContainer.nodeType === Node.TEXT_NODE ? this.startOffset : 0
    const end = this.endContainer.nodeType === Node.TEXT_NODE ? this.endOffset : text.length
    if (end <= start) return [] as unknown as DOMRectList
    const rects: { top: number; bottom: number; height: number }[] = []
    for (let row = Math.floor(start / perRow); row <= Math.floor((end - 1) / perRow); row++) {
      rects.push({ top: row * 20, bottom: row * 20 + 20, height: 20 })
    }
    return rects as unknown as DOMRectList
  }
  try {
    await run()
  } finally {
    Range.prototype.getClientRects = original
  }
}

test('arrow up on a wrapped row moves the caret, and recalls history only from the top row', async () => {
  const draft = 'a'.repeat(10) + 'b'.repeat(10) + 'c'.repeat(10)
  function Pane() {
    const [prompt, setPrompt] = useState(draft)
    const [nav, setNav] = useState<HistoryNav>(EMPTY_HISTORY_NAV)
    return <SessionPane {...idleSessionPaneProps()} prompt={prompt} setPrompt={setPrompt}
      history={['older prompt']} historyNav={nav} onHistoryNavChange={setNav} />
  }
  const tree = await harness.mount(<Pane />)
  const field = fieldOf(tree)
  field.focus()
  await withWrappedRows(10, async () => {
    placeComposerSelection(field, 15, 15)
    await key(field, 'ArrowUp')
    expect(field.textContent).toBe(draft)
    placeComposerSelection(field, 5, 5)
    await key(field, 'ArrowUp')
    expect(field.textContent).toBe('older prompt')
  })
})

test('edge-row detection covers every row and resolves a wrap point away from the edge', async () => {
  const tree = await harness.mount(<SessionPane {...idleSessionPaneProps()}
    prompt={'a'.repeat(30)} setPrompt={() => {}} />)
  const field = fieldOf(tree)
  field.focus()
  await withWrappedRows(10, async () => {
    const onEdge = (caret: number, direction: 'up' | 'down') => {
      placeComposerSelection(field, caret, caret)
      return composerCaretOnEdgeRow(field, direction)
    }
    expect([0, 5, 9, 10, 15, 29].map(caret => onEdge(caret, 'up')))
      .toEqual([true, true, true, false, false, false])
    expect([0, 15, 20, 21, 25, 30].map(caret => onEdge(caret, 'down')))
      .toEqual([false, false, false, true, true, true])
  })
})

test('accepting a mention leaves the caret after its name and separator', async () => {
  function Pane() {
    const [prompt, setPrompt] = useState('@ex')
    return <SessionPane {...idleSessionPaneProps()} prompt={prompt} setPrompt={setPrompt}
      mentionItems={[{ label: 'explore' }]} />
  }
  const tree = await harness.mount(<Pane />)
  const field = fieldOf(tree)
  field.focus()
  placeComposerSelection(field, 3, 3)
  await key(field, 'Enter')
  expect(field.textContent).toBe('@explore ')
  expect(composerSelectionOffsets(field)).toEqual({ start: 9, end: 9 })
  expect(document.activeElement).toBe(field)
})

const SKILL_CATALOG = [
  { name: 'eli5', description: 'Explain simply.' },
  { name: 'review', description: 'Review code.' },
]

function slashOptions(tree: MountedTree): string[] {
  return Array.from(tree.container.querySelectorAll('[role="option"] button'))
    .map(button => button.getAttribute('aria-label')!.replace('Insert slash command ', ''))
}

function coloredCommands(field: HTMLElement): string[] {
  return Array.from(field.querySelectorAll('[data-composer-command]')).map(node => node.textContent!)
}

test('a slash command typed mid-message opens the picker and completes in place', async () => {
  function Pane() {
    const [prompt, setPrompt] = useState('explain this /el\nthanks')
    return <SessionPane {...idleSessionPaneProps()} prompt={prompt} setPrompt={setPrompt}
      slashCatalog={SKILL_CATALOG} />
  }
  const tree = await harness.mount(<Pane />)
  const field = fieldOf(tree)
  field.focus()
  expect(slashOptions(tree)).toEqual([])
  placeComposerSelection(field, 16, 16)
  await act(async () => {
    field.dispatchEvent(new KeyboardEvent('keyup', { key: 'l', bubbles: true }))
  })
  // Desktop-only commands such as /clear act only as a whole draft, so they are
  // not offered here.
  expect(slashOptions(tree)).toEqual(['/eli5'])
  await key(field, 'Enter')
  expect(field.textContent).toBe('explain this /eli5 \nthanks')
  expect(composerSelectionOffsets(field)).toEqual({ start: 19, end: 19 })
  expect(slashOptions(tree)).toEqual([])
  expect(coloredCommands(field)).toEqual(['/eli5'])
})

test('known slash commands are colored at the start and after whitespace only', async () => {
  const tree = await harness.mount(<SessionPane {...idleSessionPaneProps()}
    prompt={'/eli5\nuse /review and /nope, not a/eli5 or /new'} setPrompt={() => {}}
    slashCatalog={SKILL_CATALOG} />)
  const field = fieldOf(tree)
  expect(coloredCommands(field)).toEqual(['/eli5', '/review'])
  expect(field.textContent).toBe('/eli5\nuse /review and /nope, not a/eli5 or /new')
})

test('typing past a colored command moves the new text out of its color', async () => {
  function Pane() {
    const [prompt, setPrompt] = useState('/eli5')
    return <SessionPane {...idleSessionPaneProps()} prompt={prompt} setPrompt={setPrompt}
      slashCatalog={SKILL_CATALOG} />
  }
  const tree = await harness.mount(<Pane />)
  const field = fieldOf(tree)
  field.focus()
  const span = field.querySelector('[data-composer-command]')!
  // What the browser does when the caret sits at the end of the span: the typed
  // text joins the span's own text node.
  span.firstChild!.nodeValue = '/eli5 dogs'
  placeComposerSelection(field, 10, 10)
  await act(async () => {
    field.dispatchEvent(new InputEvent('input', { inputType: 'insertText', bubbles: true }))
  })
  expect(field.textContent).toBe('/eli5 dogs')
  expect(coloredCommands(field)).toEqual(['/eli5'])
  expect(composerSelectionOffsets(field)).toEqual({ start: 10, end: 10 })
})

test('slash options select through click activation while pointer down preserves editor focus', async () => {
  const picked: string[] = []
  const tree = await harness.mount(<SlashCommandPicker open query="he"
    commands={[{ name: 'help', description: '' }]} activeIndex={0}
    onPick={name => picked.push(name)} />)
  const button = tree.container.querySelector<HTMLButtonElement>('button')!
  button.focus()
  await act(async () => { button.click() })
  expect(picked).toEqual(['help'])
  const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
  await act(async () => { button.dispatchEvent(down); button.click() })
  expect(down.defaultPrevented).toBe(true)
  expect(picked).toEqual(['help', 'help'])
})

test('controlled history restores each session draft across pane remounts and abandons it after editing', async () => {
  let bind!: (sessionId: string, mount: number) => void
  function Owner() {
    const [binding, setBinding] = useState({ sessionId: 'a', mount: 0 })
    const [drafts, setDrafts] = useState<Record<string, string>>({ a: 'unsent a', b: 'unsent b' })
    const [navigation, setNavigation] = useState<Record<string, HistoryNav>>({})
    bind = (sessionId, mount) => setBinding({ sessionId, mount })
    const id = binding.sessionId
    return <SessionPane key={binding.mount} {...idleSessionPaneProps()} activeSessionId={id}
      prompt={drafts[id]} setPrompt={value => setDrafts(current => ({ ...current, [id]: value }))}
      history={[`past ${id}`]} historyNav={navigation[id] ?? EMPTY_HISTORY_NAV}
      onHistoryNavChange={nav => setNavigation(current => ({ ...current, [id]: nav }))} />
  }
  const tree = await harness.mount(<Owner />)
  let field = fieldOf(tree)
  field.focus()
  placeComposerSelection(field, 0, 0)
  await key(field, 'ArrowUp')
  expect(field.textContent).toBe('past a')
  await act(async () => { bind('b', 1) })
  field = fieldOf(tree)
  field.focus()
  placeComposerSelection(field, 0, 0)
  await key(field, 'ArrowUp')
  expect(field.textContent).toBe('past b')
  await act(async () => { bind('a', 2) })
  field = fieldOf(tree)
  field.focus()
  placeComposerSelection(field, field.textContent!.length, field.textContent!.length)
  await key(field, 'ArrowDown')
  expect(field.textContent).toBe('unsent a')
  await act(async () => { bind('b', 3) })
  field = fieldOf(tree)
  field.focus()
  placeComposerSelection(field, field.textContent!.length, field.textContent!.length)
  await key(field, 'ArrowDown')
  expect(field.textContent).toBe('unsent b')
  await key(field, 'ArrowUp')
  await act(async () => {
    field.textContent = 'edited recalled text'
    field.dispatchEvent(new InputEvent('input', { bubbles: true }))
  })
  await act(async () => { bind('b', 4) })
  field = fieldOf(tree)
  field.focus()
  placeComposerSelection(field, field.textContent!.length, field.textContent!.length)
  await key(field, 'ArrowDown')
  expect(field.textContent).toBe('edited recalled text')
})

async function editKey(field: HTMLElement, key: string, modifiers: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    field.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers }))
  })
}

async function pasteText(field: HTMLElement, text: string): Promise<void> {
  await act(async () => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', text)
    field.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }))
  })
}

test('paste replacement and newline undo/redo restore text and selection', async () => {
  function Pane() {
    const [prompt, setPrompt] = useState('fix login bug')
    return <SessionPane {...idleSessionPaneProps()} prompt={prompt} setPrompt={setPrompt} />
  }
  const tree = await harness.mount(<Pane />)
  const field = fieldOf(tree)
  field.focus()
  placeComposerSelection(field, 4, 9)
  await pasteText(field, 'logout')
  expect(field.textContent).toBe('fix logout bug')
  expect(composerSelectionOffsets(field)).toEqual({ start: 10, end: 10 })
  await editKey(field, 'z', { metaKey: true })
  expect(field.textContent).toBe('fix login bug')
  expect(composerSelectionOffsets(field)).toEqual({ start: 4, end: 9 })
  await editKey(field, 'z', { metaKey: true, shiftKey: true })
  expect(field.textContent).toBe('fix logout bug')
  expect(composerSelectionOffsets(field)).toEqual({ start: 10, end: 10 })
  await editKey(field, 'Enter', { shiftKey: true })
  expect(field.textContent).toBe('fix logout\n bug')
  await editKey(field, 'z', { ctrlKey: true })
  expect(field.textContent).toBe('fix logout bug')
  await editKey(field, 'y', { ctrlKey: true })
  expect(field.textContent).toBe('fix logout\n bug')
})

test('external clear and session rebind never undo into the old draft', async () => {
  let clear!: () => void
  let rebind!: () => void
  function Pane() {
    const [prompt, setPrompt] = useState('draft')
    const [sessionId, setSessionId] = useState('a')
    clear = () => setPrompt('')
    rebind = () => { setSessionId('b'); setPrompt('other draft') }
    return <SessionPane {...idleSessionPaneProps()} activeSessionId={sessionId} prompt={prompt} setPrompt={setPrompt} />
  }
  const tree = await harness.mount(<Pane />)
  let field = fieldOf(tree)
  field.focus()
  placeComposerSelection(field, 5, 5)
  await pasteText(field, ' edited')
  await act(async () => { clear() })
  await editKey(field, 'z', { metaKey: true })
  expect(field.textContent).toBe('')
  await act(async () => { rebind() })
  field = fieldOf(tree)
  field.focus()
  await editKey(field, 'z', { metaKey: true })
  expect(field.textContent).toBe('other draft')
})
