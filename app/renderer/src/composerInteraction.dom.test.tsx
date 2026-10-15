import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, useState } from 'react'
import { SessionPane } from './SessionPane.js'
import { SlashCommandPicker } from './SlashCommandPicker.js'
import { createDomTestHarness, type DomTestHarness, type MountedTree } from './domTestHarness.js'
import { idleSessionPaneProps } from './sessionPaneTestProps.js'
import { composerSelectionOffsets, placeComposerSelection } from './composerDom.js'
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
