import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { Sidebar } from './Sidebar.js'
import { selectMergedSessionRows } from './sessionsCatalogState.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { memoryStorage } from './viewPreferenceStorageFixture.js'
import { writeHiddenWorkspacesToStorage } from './sidebarHiddenWorkspaces.js'
import type { SessionDescriptor } from '../../shared/hostApi.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })
const project = { id: 'ed420661-65eb-408e-bf2b-899f2cfb249e', cwd: '/work/folder', name: 'Custom identity', createdAt: 1 }
const noop = () => {}
const props = { activeSessionId: null, activeView: 'chat' as const, onSelectView: noop, onSelectLive: noop, onRestore: noop,
  onOpenHistory: noop, onNewProjectSession: noop, menuActive: true }

function byText(root: HTMLElement, text: string) {
  const result = [...root.querySelectorAll('button')].find(button => button.textContent?.trim() === text)
  if (!result) throw new Error(`Missing button ${text}`)
  return result
}

test('hiding an empty project survives a sidebar remount and Show hidden restores its zero-count group', async () => {
  const storage = memoryStorage()
  const render = () => <Sidebar {...props} rows={[]} projects={[project]} storage={storage} />
  let tree = await harness.mount(render())
  await act(async () => { tree.container.querySelector<HTMLButtonElement>('[aria-label="Project actions for Custom identity"]')!.click() })
  await act(async () => { byText(tree.container, 'Hide project').click() })
  expect(tree.container.textContent).not.toContain('Custom identity')
  expect(tree.container.textContent).toContain('Show 1 hidden project')
  await tree.unmount()
  tree = await harness.mount(render())
  expect(tree.container.textContent).not.toContain('Custom identity')
  await act(async () => { byText(tree.container, 'Show 1 hidden project').click() })
  const label = byText(tree.container, 'Custom identity')
  expect(label.parentElement?.querySelector('span[aria-hidden="true"]')?.textContent).toBe('0')
})

test('creating a project reveals it even if an older hide mark outlived its former sessions', async () => {
  const storage = memoryStorage()
  writeHiddenWorkspacesToStorage(storage, [{ cwd: project.cwd, hiddenAt: 100 }])
  const tree = await harness.mount(<Sidebar {...props} rows={[]} projects={[{ ...project, createdAt: 200 }]} storage={storage} />)
  expect(tree.container.textContent).toContain('Custom identity')
  expect(tree.container.textContent).not.toContain('Show 1 hidden project')
})

test('searching a chosen project name keeps its sessions and empty named projects are searchable', async () => {
  const descriptor: SessionDescriptor = { appSessionId: 'session', engineSessionId: null, cwd: project.cwd, title: 'Unrelated session title',
    forked: false, titleUpdatedAt: null, status: 'ready', restorable: false, parked: false, createdAt: 1, lastAttachedAt: 1, lastMessageSentAt: null }
  const rows = selectMergedSessionRows([descriptor], null)
  const tree = await harness.mount(<Sidebar {...props} rows={rows} projects={[project]} storage={null} />)
  const search = tree.container.querySelector<HTMLInputElement>('[aria-label="Search sessions"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'custom identity')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(tree.container.textContent).toContain('Custom identity')
  expect(tree.container.textContent).toContain('Unrelated session title')
  await tree.render(<Sidebar {...props} rows={[]} projects={[project]} storage={null} />)
  expect(tree.container.textContent).toContain('Custom identity')
})
