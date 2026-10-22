import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, createElement } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { CommandPalette } from './CommandPalette.js'
import { TasksDialog } from './TasksDialog.js'
import { FilePathActionsMenu } from './FilePathActionsMenu.js'
import type { PaletteItem } from './commandPaletteModel.js'
import type { TasksSnapshot } from '../../shared/protocol.js'

let harness: DomTestHarness
const noop = () => {}

beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })

const tasks: TasksSnapshot = {
  items: [
    { id: 'task-a', type: 'local_bash', status: 'running', label: 'Build', startTime: 2 },
    { id: 'task-b', type: 'local_bash', status: 'running', label: 'Check', startTime: 1 },
    { id: 'task-done', type: 'local_bash', status: 'completed', label: 'Finished', startTime: 0 },
  ],
}

function paletteItem(id: string, run: () => void): PaletteItem {
  return { id, kind: 'action', group: 'Actions', label: id, ariaLabel: id, keywords: id, run }
}

function key(target: HTMLElement, value: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

// happy-dom does not synthesize keyboard Click default actions. Apply the
// browser's button activation only when the component did not cancel the key.
function activateButton(button: HTMLButtonElement, value: 'Enter' | ' '): void {
  const event = key(button, value)
  if (!event.defaultPrevented) button.click()
}

test('task shortcuts yield to the palette and resume after it closes', async () => {
  const stopped: string[] = []
  const taskTree = await harness.mount(createElement(TasksDialog, {
    open: true, onClose: noop, snapshot: tasks, hasActiveSession: true,
    onStopTask: id => stopped.push(id),
  }))
  await harness.nextFrame()
  const palette = await harness.mount(createElement(CommandPalette, {
    open: true, onClose: noop, items: [paletteItem('Back', noop)],
  }))
  await harness.nextFrame()
  const search = palette.container.querySelector<HTMLInputElement>('input')!
  expect(document.activeElement).toBe(search)
  let typed: KeyboardEvent | undefined
  await act(async () => { typed = key(search, 'k') })
  expect(stopped).toEqual([])
  expect(typed?.defaultPrevented).toBe(false)

  await palette.unmount()
  const task = taskTree.container.querySelector<HTMLElement>('[role="option"]')!
  await act(async () => { task.focus(); key(task, 'k') })
  expect(stopped).toEqual(['task-a'])
})

test('clicking a task selects it and K stops that task', async () => {
  const stopped: string[] = []
  const tree = await harness.mount(createElement(TasksDialog, {
    open: true, onClose: noop, snapshot: tasks, hasActiveSession: true,
    onStopTask: id => stopped.push(id),
  }))
  const options = tree.container.querySelectorAll<HTMLElement>('[role="option"]')
  const scrollRequests: (boolean | ScrollIntoViewOptions | undefined)[] = []
  options[1]!.scrollIntoView = options => { scrollRequests.push(options) }
  await act(async () => options[1]!.click())
  expect(options[0]!.getAttribute('aria-selected')).toBe('false')
  expect(options[1]!.getAttribute('aria-selected')).toBe('true')
  expect(options[1]!.tabIndex).toBeGreaterThanOrEqual(0)
  expect(scrollRequests).toEqual([{ block: 'nearest' }])
  await act(async () => key(options[1]!, 'k'))
  expect(stopped).toEqual(['task-b'])
  await act(async () => key(options[1]!, 'ArrowUp'))
  expect(options[0]!.getAttribute('aria-selected')).toBe('true')
  expect(document.activeElement === options[0]).toBe(true)
})

test('task Stop buttons address their row and omit finished tasks', async () => {
  const stopped: string[] = []
  const tree = await harness.mount(createElement(TasksDialog, {
    open: true, onClose: noop, snapshot: tasks, hasActiveSession: true,
    onStopTask: id => stopped.push(id),
  }))
  const options = tree.container.querySelectorAll<HTMLElement>('[role="option"]')
  const stop = options[1]!.querySelector<HTMLButtonElement>('button')
  expect(stop).not.toBeNull()
  await act(async () => stop!.click())
  expect(stopped).toEqual(['task-b'])
  expect(options[2]!.querySelector('button')).toBeNull()
})

test('focused palette results activate through Click and synchronize selection', async () => {
  const runs: string[] = []
  const tree = await harness.mount(createElement(CommandPalette, {
    open: true, onClose: noop,
    items: [paletteItem('First', () => runs.push('first')), paletteItem('Second', () => runs.push('second'))],
  }))
  const options = tree.container.querySelectorAll<HTMLButtonElement>('[role="option"]')
  await act(async () => options[1]!.focus())
  await act(async () => options[1]!.click())
  expect(runs).toEqual(['second'])
  expect(options[0]!.getAttribute('aria-selected')).toBe('false')
  expect(options[1]!.getAttribute('aria-selected')).toBe('true')
})

test('file flyout keyboard choices copy the selected child, not the host default', async () => {
  const copied: string[] = []
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true, value: { writeText: async (text: string) => { copied.push(text) } },
  })
  try {
    for (const [label, value, expected] of [
      ['Relative path', 'Enter', 'src/foo.ts'],
      ['Filename', ' ', 'foo.ts'],
    ] as const) {
      const tree = await harness.mount(createElement(FilePathActionsMenu, {
        anchor: { type: 'pointer', x: 100, y: 150 }, rawPath: 'src/foo.ts',
        cwd: '/repo', sessionId: 'synthetic-session', onClose: noop,
      }))
      const host = tree.container.querySelector<HTMLElement>('[aria-haspopup="menu"]')!
      await act(async () => { host.focus(); key(host, 'ArrowRight') })
      await harness.nextFrame()
      const child = Array.from(tree.container.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent?.trim() === label)!
      await act(async () => { child.focus(); activateButton(child, value) })
      expect(copied.at(-1)).toBe(expected)
      await tree.unmount()
    }
  } finally {
    if (original) Object.defineProperty(navigator, 'clipboard', original)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})

test('file flyout Left returns focus to its host before removing the child', async () => {
  const tree = await harness.mount(createElement(FilePathActionsMenu, {
    anchor: { type: 'pointer', x: 100, y: 150 }, rawPath: 'src/foo.ts',
    cwd: '/repo', sessionId: 'synthetic-session', onClose: noop,
  }))
  const host = tree.container.querySelector<HTMLElement>('[aria-haspopup="menu"]')!
  await act(async () => { host.focus(); key(host, 'ArrowRight') })
  await harness.nextFrame()
  const child = tree.container.querySelector<HTMLButtonElement>('button')!
  child.focus()
  await act(async () => key(child, 'ArrowLeft'))
  expect(document.activeElement === host).toBe(true)
  expect(host.getAttribute('aria-expanded')).toBe('false')
})

