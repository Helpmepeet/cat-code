import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, Profiler, useState } from 'react'
import { ComposerInput } from './ComposerInput.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })

function Fixture({ editable = true, attach = async (_file: File) => {} }) {
  const [value, setValue] = useState('hello')
  return <main className="session-pane"><ComposerInput
    windowDropEnabled ariaLabel="Prompt" disabled={false} readOnly={!editable}
    onCompositionEnd={() => {}} onCompositionStart={() => {}} onFocus={() => {}}
    onPointerDown={() => {}} onRemovePaste={() => {}} onValueChange={setValue}
    onAttachImageFile={attach} pastes={[]} placeholder="Message" value={value}
  /><output>{value}</output></main>
}

async function drag(type: string, target: EventTarget = window, options: {
  files?: File[]; types?: string[]; text?: string; relatedTarget?: EventTarget | null
} = {}) {
  const files = options.files ?? []
  const transfer = {
    files, items: files.map(file => ({ kind: 'file', type: file.type })),
    types: options.types ?? (files.length ? ['Files'] : ['text/plain']),
    getData: () => options.text ?? '', dropEffect: 'uninitialized',
  }
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    dataTransfer: { value: transfer }, relatedTarget: { value: options.relatedTarget ?? null },
  })
  await act(async () => { target.dispatchEvent(event) })
  return { event, transfer }
}

test('window text drop focuses the composer and uses its saved caret; repeated dragover does not render', async () => {
  let renders = 0
  const tree = await harness.mount(<Profiler id="drop" onRender={() => { renders++ }}><Fixture /></Profiler>)
  const field = tree.container.querySelector<HTMLElement>('[role="textbox"]')!
  await act(async () => {
    const range = document.createRange()
    range.setStart(field.firstChild!, 2)
    range.collapse(true)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    field.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }))
  })
  await drag('dragover')
  expect(tree.container.querySelector('.window-drop-title')?.textContent).toBe('Drop to add text')
  const before = renders
  for (let index = 0; index < 20; index++) await drag('dragover')
  expect(renders).toBe(before)
  await drag('dragleave', tree.container.querySelector('output')!, { relatedTarget: tree.container.querySelector('main') })
  expect(tree.container.querySelector('.window-drop-veil')).not.toBeNull()
  const result = await drag('drop', window, { text: 'world' })
  expect(result.event.defaultPrevented).toBe(true)
  expect(tree.container.querySelector('output')?.textContent).toBe('heworldllo')
  expect(document.activeElement?.getAttribute('role')).toBe('textbox')
  expect(tree.container.querySelector('.window-drop-veil')).toBeNull()
})

test('images prepare sequentially and skip other files even over the field', async () => {
  const calls: string[] = []
  let active = 0
  const attach = async (file: File) => {
    expect(active).toBe(0)
    active++
    await Promise.resolve()
    calls.push(file.name)
    active--
  }
  const tree = await harness.mount(<Fixture attach={attach} />)
  const files = [new File(['a'], 'a.png', { type: 'image/png' }), new File(['b'], 'b.pdf', { type: 'application/pdf' }), new File(['c'], 'c.jpg', { type: 'image/jpeg' })]
  await drag('dragover', window, { files })
  expect(tree.container.querySelector('.window-drop-detail')?.textContent).toBe('2 images · Other files are skipped')
  await drag('drop', tree.container.querySelector('[role="textbox"]')!, { files })
  expect(calls).toEqual(['a.png', 'c.jpg'])
})

test('text on the field uses the pointer position rather than the saved caret', async () => {
  const tree = await harness.mount(<Fixture />)
  const field = tree.container.querySelector<HTMLElement>('[role="textbox"]')!
  const previous = Object.getOwnPropertyDescriptor(document, 'caretRangeFromPoint')
  Object.defineProperty(document, 'caretRangeFromPoint', { configurable: true, value: () => {
    const range = document.createRange()
    range.setStart(field.firstChild!, 3)
    return range
  } })
  try {
    await drag('drop', field, { text: 'X' })
    expect(tree.container.querySelector('output')?.textContent).toBe('helXlo')
  } finally {
    if (previous) Object.defineProperty(document, 'caretRangeFromPoint', previous)
    else Reflect.deleteProperty(document, 'caretRangeFromPoint')
  }
})

test('text over another field is left to that field', async () => {
  const tree = await harness.mount(<><input aria-label="Search sessions" /><Fixture /></>)
  const search = tree.container.querySelector('input')!
  const over = await drag('dragover', search, { text: 'world' })
  expect(over.event.defaultPrevented).toBe(false)
  expect(tree.container.querySelector('.window-drop-veil')).toBeNull()
  const dropped = await drag('drop', search, { text: 'world' })
  expect(dropped.event.defaultPrevented).toBe(false)
  expect(tree.container.querySelector('output')?.textContent).toBe('hello')
  const file = new File(['a'], 'a.png', { type: 'image/png' })
  expect((await drag('dragover', search, { files: [file] })).event.defaultPrevented).toBe(true)
})

test('disabled composers reject drops without a veil', async () => {
  const tree = await harness.mount(<Fixture editable={false} />)
  const result = await drag('dragover')
  expect(result.transfer.dropEffect).toBe('none')
  expect(tree.container.querySelector('.window-drop-veil')).toBeNull()
  await drag('drop', window, { text: 'ignored' })
  expect(tree.container.querySelector('output')?.textContent).toBe('hello')
})

test('unsupported files are blocked, sidebar drags are ignored, and all exit paths clear feedback', async () => {
  const tree = await harness.mount(<Fixture />)
  const file = new File(['a'], 'a.pdf', { type: 'application/pdf' })
  expect((await drag('dragover', window, { files: [file] })).transfer.dropEffect).toBe('none')
  expect(tree.container.querySelector('.window-drop-no')).not.toBeNull()
  expect((await drag('drop', window, { files: [file] })).event.defaultPrevented).toBe(true)
  await drag('dragover', window, { types: ['text/workspace-cwd', 'text/plain'] })
  expect(tree.container.querySelector('.window-drop-veil')).toBeNull()
  for (const type of ['dragleave', 'dragend', 'blur', 'keydown']) {
    await drag('dragover')
    await act(async () => {
      window.dispatchEvent(type === 'keydown' ? new KeyboardEvent(type, { key: 'Escape' }) : new Event(type))
    })
    expect(tree.container.querySelector('.window-drop-veil')).toBeNull()
  }
})
