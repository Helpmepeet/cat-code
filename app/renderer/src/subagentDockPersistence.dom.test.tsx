import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { memoryStorage } from './viewPreferenceStorageFixture.js'
import { SUBAGENT_DOCK_COLLAPSED_STORAGE_KEY, readSubagentDockCollapsedFromStorage, useSubagentDockCollapsedPreference } from './subagentDockPersistence.js'
import type { ViewPreferenceStorage } from './viewPreference.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })

function Pane({ storage, name }: { storage: ViewPreferenceStorage; name: string }) {
  const [collapsed, setCollapsed] = useSubagentDockCollapsedPreference(storage)
  return <button aria-label={name} aria-pressed={collapsed} onClick={() => setCollapsed(!collapsed)}>{collapsed ? 'chip' : 'panel'}</button>
}

// A codec round trip cannot expose React callers holding isolated pane states.
test('collapsing one pane updates every pane and survives a fresh mount', async () => {
  const storage = memoryStorage()
  const tree = await harness.mount(<><Pane storage={storage} name="a" /><Pane storage={storage} name="b" /></>)
  const buttons = [...tree.container.querySelectorAll('button')]
  expect(buttons.map(button => button.textContent)).toEqual(['panel', 'panel'])
  await act(async () => { buttons[0]!.click() })
  expect(buttons.map(button => button.getAttribute('aria-pressed'))).toEqual(['true', 'true'])
  expect(readSubagentDockCollapsedFromStorage(storage)).toBe(true)
  await harness.unmountAll()
  const remount = await harness.mount(<Pane storage={memoryStorage(Object.fromEntries(storage.map))} name="reloaded" />)
  expect(remount.container.querySelector('button')?.textContent).toBe('chip')
})


test('the shared preference accepts other-window updates and reloads a removed preference as the default', async () => {
  const storage = memoryStorage()
  const tree = await harness.mount(<Pane storage={storage} name="pane" />)
  storage.setItem(SUBAGENT_DOCK_COLLAPSED_STORAGE_KEY, JSON.stringify({ version: 1, collapsed: true }))
  await act(async () => { window.dispatchEvent(new StorageEvent('storage', { key: SUBAGENT_DOCK_COLLAPSED_STORAGE_KEY })) })
  expect(tree.container.querySelector('button')?.textContent).toBe('chip')
  await harness.unmountAll()
  storage.removeItem(SUBAGENT_DOCK_COLLAPSED_STORAGE_KEY)
  const remount = await harness.mount(<Pane storage={storage} name="pane" />)
  expect(remount.container.querySelector('button')?.textContent).toBe('panel')
})
