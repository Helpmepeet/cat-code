import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { FilePaneFiles } from './FilePaneFiles.js'
import { disposeFilePaneSession, updateFilePaneSession } from './filePaneState.js'
import { disposeWorkspaceFileAvailability } from './workspaceFileAvailabilityQueue.js'

let harness: DomTestHarness
let bridge: PropertyDescriptor | undefined
const sessionId = 'file-chooser-regression'
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => {
  await harness.unmountAll()
  disposeFilePaneSession(sessionId)
  disposeWorkspaceFileAvailability(sessionId)
  if (bridge) Object.defineProperty(window, 'catcode', bridge)
  else Reflect.deleteProperty(window, 'catcode')
})
afterAll(async () => harness.teardown())

test('Files keeps the previous file active across discoveries, ignores IME Enter, and restores focus on failure', async () => {
  const calls: string[] = []
  bridge = Object.getOwnPropertyDescriptor(window, 'catcode')
  Object.defineProperty(window, 'catcode', { configurable: true, value: {
    openWorkspaceFile: async (_id: string, path: string) => { calls.push(path); return false },
  } })
  const opened = new Map([
    ['/repo/previous.zip', { path: '/repo/previous.zip', scroll: { x: 0, y: 0 }, aliases: ['/repo/previous.zip'] }],
    ['/repo/current.md', { path: '/repo/current.md', scroll: { x: 0, y: 0 }, aliases: ['/repo/current.md'] }],
  ])
  updateFilePaneSession(sessionId, { opened })
  const tree = await harness.mount(<aside className="file-pane"><FilePaneFiles appSessionId={sessionId} cwd="/repo" currentPath="/repo/current.md" /></aside>)
  const trigger = tree.container.querySelector<HTMLButtonElement>('button[aria-label="Files"]')!
  await act(async () => trigger.click())
  const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!
  expect(document.activeElement).toBe(input)
  expect(document.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain('previous.zip')
  const next = new Map(opened)
  next.set('/repo/new.md', { path: '/repo/new.md', scroll: { x: 0, y: 0 }, aliases: ['/repo/new.md'] })
  await act(async () => updateFilePaneSession(sessionId, { opened: next }))
  expect(document.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain('previous.zip')
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })))
  expect(calls).toEqual([])
  expect(document.querySelector('[role="listbox"]')).not.toBeNull()
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(calls).toEqual(['/repo/previous.zip'])
  expect(document.querySelector('[role="listbox"]')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  await act(async () => trigger.click())
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  await act(async () => document.querySelector('[role="combobox"]')!.dispatchEvent(escape))
  expect(escape.defaultPrevented).toBe(true)
  expect(document.querySelector('[role="listbox"]')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})
