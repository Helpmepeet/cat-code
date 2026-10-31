import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { act } from 'react'
import { CreateProjectDialog, type CreateProjectDialogBridge } from './CreateProjectDialog.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import type { PickProjectResult } from '../../shared/projects.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll(); document.body.innerHTML = '' })
afterAll(async () => { await harness.teardown() })
const selected = (name = 'sample', trustRoot = `/work/${name}`): PickProjectResult => ({ kind: 'selected', folder: { cwd: `/work/${name}`, name, trustRoot } })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function setup(overrides: Partial<CreateProjectDialogBridge> = {}) {
  const bridge = {
    beginProjectDraft: mock(async () => 'draft-id'),
    pickProjectFolder: mock(async (): Promise<PickProjectResult> => selected()),
    createProject: mock(async () => ({ ok: true as const, project: { id: 'p', name: 'sample', cwd: '/work/sample', createdAt: 1 } })),
    cancelProjectDraft: mock(async (_id: string) => {}),
    ...overrides,
  }
  const onClose = mock(() => {})
  const onCreated = mock(() => {})
  const tree = await harness.mount(<CreateProjectDialog bridge={bridge} onClose={onClose} onCreated={onCreated} />)
  const button = (text: string) => Array.from(tree.container.querySelectorAll('button')).find(item => item.textContent === text)!
  const name = tree.container.querySelector('input')!
  const type = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, value)
      name.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const click = async (text: string) => { await act(async () => { button(text).click() }) }
  return { bridge, tree, button, name, type, click, onClose, onCreated }
}

test('requires a trimmed name and a selected folder, submits only draft, name and trust choice, blocks duplicate pending create', async () => {
  const pending = deferred<Awaited<ReturnType<CreateProjectDialogBridge['createProject']>>>()
  const createProject = mock((_input: Parameters<CreateProjectDialogBridge['createProject']>[0]) => pending.promise)
  const s = await setup({ createProject })
  expect(s.button('Create project').disabled).toBe(true)
  expect(s.name.maxLength).toBe(160)
  await s.type('  custom  ')
  expect(s.button('Create project').disabled).toBe(true)
  await s.click('Choose folder…')
  expect(s.name.value).toBe('  custom  ')
  await s.type('   ')
  expect(s.button('Create project').disabled).toBe(true)
  await s.type('  custom  ')
  await s.click('Create project')
  expect(createProject.mock.calls).toEqual([[{ draftId: 'draft-id', name: 'custom', trustFolder: false }]])
  expect(s.button('Create project').disabled).toBe(true)
  await s.click('Create project')
  expect(createProject).toHaveBeenCalledTimes(1)
  expect(s.button('Cancel').disabled).toBe(true)
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
  expect(s.onClose).not.toHaveBeenCalled()
  const project = { id: 'p', name: 'custom', cwd: '/work/sample', createdAt: 1 }
  await act(async () => { pending.resolve({ ok: true, project }) })
  expect(s.onCreated).toHaveBeenCalledWith(project)
})

test('autofills only an empty name, changes folder, and retains selection and custom name on picker cancel', async () => {
  const pickProjectFolder = mock(async (): Promise<PickProjectResult> => selected())
  const s = await setup({ pickProjectFolder })
  await s.click('Choose folder…')
  expect(s.name.value).toBe('sample')
  await s.type('mine')
  pickProjectFolder.mockResolvedValueOnce(selected('other'))
  await s.click('Change')
  expect(s.name.value).toBe('mine')
  expect(s.tree.container.textContent).toContain('/work/other')
  pickProjectFolder.mockResolvedValueOnce({ kind: 'cancelled' })
  await s.click('Change')
  expect(s.name.value).toBe('mine')
  expect(s.tree.container.textContent).toContain('/work/other')
  expect(s.button('Create project').disabled).toBe(false)
  await s.type('')
  await s.click('Change')
  expect(s.name.value).toBe('sample')
})

test('picker and create failures are visible alerts and allow retry', async () => {
  const pickProjectFolder = mock(async (): Promise<PickProjectResult> => ({ kind: 'error', error: 'Cannot choose folder' }))
  const s = await setup({ pickProjectFolder, createProject: async () => ({ ok: false, error: 'Cannot save project' }) })
  await s.click('Choose folder…')
  expect(s.tree.container.querySelector('[role="alert"]')?.textContent).toBe('Cannot choose folder')
  pickProjectFolder.mockResolvedValueOnce(selected())
  await s.click('Choose folder…')
  await s.click('Create project')
  expect(s.tree.container.querySelector('[role="alert"]')?.textContent).toBe('Cannot save project')
  expect(s.button('Create project').disabled).toBe(false)
})

test('cancel creates nothing and cancels the draft on unmount', async () => {
  const s = await setup()
  await s.click('Choose folder…')
  await s.click('Cancel')
  expect(s.onClose).toHaveBeenCalledTimes(1)
  expect(s.bridge.createProject).not.toHaveBeenCalled()
  await s.tree.unmount()
  expect(s.bridge.cancelProjectDraft).toHaveBeenCalledWith('draft-id')
})

test('focus is trapped, Escape closes, and unmount restores the trigger', async () => {
  const trigger = document.createElement('button')
  document.body.appendChild(trigger)
  trigger.focus()
  const s = await setup()
  await act(async () => { await harness.nextFrame() })
  expect(document.activeElement).toBe(s.name)
  await act(async () => {
    s.button('Cancel').focus()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
  })
  expect(document.activeElement).toBe(s.name)
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
  expect(s.onClose).toHaveBeenCalledTimes(1)
  await s.tree.unmount()
  expect(document.activeElement).toBe(trigger)
})

test('ignores a stale picker after close and unmount', async () => {
  const pending = deferred<PickProjectResult>()
  const s = await setup({ pickProjectFolder: () => pending.promise })
  await s.click('Choose folder…')
  await s.click('Cancel')
  await s.tree.unmount()
  await act(async () => { pending.resolve(selected('late')) })
  expect(s.onCreated).not.toHaveBeenCalled()
  expect(s.bridge.createProject).not.toHaveBeenCalled()
})

test('cancels a draft that finishes opening after unmount', async () => {
  const pending = deferred<string>()
  const s = await setup({ beginProjectDraft: () => pending.promise })
  await s.tree.unmount()
  await act(async () => { pending.resolve('late-draft') })
  expect(s.bridge.cancelProjectDraft).toHaveBeenCalledWith('late-draft')
})

test('a long-open dialog keeps the same draft without a cwd token or session API', async () => {
  const s = await setup()
  await s.tree.render(<CreateProjectDialog bridge={{ ...s.bridge }} onClose={s.onClose} onCreated={s.onCreated} />)
  await s.click('Choose folder…')
  await s.click('Create project')
  expect(s.bridge.beginProjectDraft).toHaveBeenCalledTimes(1)
  expect(s.bridge.pickProjectFolder).toHaveBeenCalledWith('draft-id')
  expect(s.bridge.createProject).toHaveBeenCalledWith({ draftId: 'draft-id', name: 'sample', trustFolder: false })
})

test('trust starts unticked, has no plain-folder helper, and sends only the boolean choice', async () => {
  const s = await setup()
  const checkbox = s.tree.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  expect(checkbox.checked).toBe(false)
  expect(checkbox.disabled).toBe(true)
  expect(checkbox.closest('label')?.textContent).toBe('Trust this folder')
  await s.click('Choose folder…')
  expect(checkbox.disabled).toBe(false)
  expect(s.tree.container.querySelector('.create-project-trust-scope')).toBeNull()
  await act(async () => { checkbox.click() })
  await s.click('Create project')
  expect(s.bridge.createProject).toHaveBeenCalledWith({ draftId: 'draft-id', name: 'sample', trustFolder: true })
})

test('discloses an engine-supplied wider root and resets consent only when a folder selection succeeds', async () => {
  const pickProjectFolder = mock(async (): Promise<PickProjectResult> => selected('nested', '/work'))
  const s = await setup({ pickProjectFolder })
  await s.click('Choose folder…')
  expect(s.tree.container.querySelector('.create-project-trust-scope')?.textContent).toContain('Approving saves trust for /work and covers every folder under it, including sibling projects.')
  const checkbox = s.tree.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  await act(async () => { checkbox.click() })
  pickProjectFolder.mockResolvedValueOnce({ kind: 'cancelled' })
  await s.click('Change')
  expect(checkbox.checked).toBe(true)
  pickProjectFolder.mockResolvedValueOnce(selected('other'))
  await s.click('Change')
  expect(checkbox.checked).toBe(false)
  expect(s.tree.container.querySelector('.create-project-trust-scope')).toBeNull()
})
