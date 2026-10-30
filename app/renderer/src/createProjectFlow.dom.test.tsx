import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { act } from 'react'
import { App } from './App.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import type { CatCodeBridge } from '../../shared/protocol.js'
import type { SessionDescriptor } from '../../shared/hostApi.js'
import type { DesktopProject } from '../../shared/projects.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll(); Reflect.deleteProperty(window, 'catcode'); window.localStorage.clear() })
afterAll(async () => { await harness.teardown() })

const project: DesktopProject = { id: '076b5800-b71d-4a86-a976-7f33397cd91a', name: 'sample', cwd: '/work/sample', createdAt: 1 }
const session: SessionDescriptor = { appSessionId: 'existing', engineSessionId: null, cwd: '/legacy', title: 'Existing chat',
  forked: false, titleUpdatedAt: null, status: 'ready', restorable: false, parked: false,
  createdAt: 1, lastAttachedAt: 1, lastMessageSentAt: null, binding: { kind: 'project' } }

async function setup(projects: DesktopProject[] = []) {
  const createManagedChat = mock(async () => ({ ok: true as const, value: session }))
  const createSession = mock(async () => ({ ok: true as const, value: session }))
  const createProjectSession = mock(async (_id: string) => ({ ok: true as const, value: session }))
  const pickDirectory = mock(async () => null)
  const pickProjectFolder = mock(async () => ({ kind: 'selected' as const, folder: { cwd: project.cwd, name: project.name } }))
  const createProject = mock(async (_input: { draftId: string; name: string }) => ({ ok: true as const, project }))
  const cancelProjectDraft = mock(async (_id: string) => {})
  window.catcode = {
    subscribe: () => () => {}, subscribeHost: () => () => {}, rendererReady: () => {},
    listSessions: async () => [session], listProjects: async () => projects,
    readProjectRoutes: async () => [], readSessionsCatalog: async () => null,
    reportVisibleSessions: () => {}, recordRenderCommit: () => {},
    getSessionFolderState: async () => ({ ok: true, value: 'available' }),
    listWorkspaceBranches: async () => ({ ok: false, error: { code: 'invalid_cwd', message: 'No repository in this fixture' } }),
    beginProjectDraft: async () => 'draft', pickProjectFolder, createProject, cancelProjectDraft,
    createManagedChat, createSession, createProjectSession, pickDirectory,
  } satisfies Partial<CatCodeBridge> as unknown as CatCodeBridge
  const tree = await harness.mount(<App />)
  await act(async () => { tree.container.querySelector<HTMLButtonElement>('[aria-label="Pin sidebar open"]')!.click() })
  return { tree, createManagedChat, createSession, createProjectSession, pickDirectory, pickProjectFolder, createProject, cancelProjectDraft }
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(button => button.textContent === text)
  if (!found) throw new Error(`Missing button ${text}`)
  return found
}

test('Projects plus opens the dialog, creation adds a zero-session group, and only its plus starts a session', async () => {
  const s = await setup()
  await act(async () => { s.tree.container.querySelector<HTMLButtonElement>('[aria-label="Add project"]')!.click() })
  expect(s.tree.container.querySelector('[role="dialog"][aria-label="Create project"]')).not.toBeNull()
  expect(s.pickDirectory).not.toHaveBeenCalled()
  expect(s.pickProjectFolder).not.toHaveBeenCalled()
  await act(async () => { button(s.tree.container, 'Choose folder…').click() })
  await act(async () => { button(s.tree.container, 'Create project').click() })
  expect(s.createProject).toHaveBeenCalledWith({ draftId: 'draft', name: 'sample' })
  expect(s.createSession).not.toHaveBeenCalled()
  expect(s.createManagedChat).not.toHaveBeenCalled()
  expect(s.createProjectSession).not.toHaveBeenCalled()
  expect(s.tree.container.querySelector('[role="dialog"]')).toBeNull()
  const label = button(s.tree.container, 'sample')
  expect(label.parentElement?.querySelector('span[aria-hidden="true"]')?.textContent).toBe('0')
  await act(async () => { label.parentElement!.querySelector<HTMLButtonElement>('[aria-label="New session in this workspace"]')!.click() })
  expect(s.createProjectSession).toHaveBeenCalledWith(project.id)
})

test('persisted empty projects hydrate without a session and closing a selected draft creates nothing', async () => {
  const s = await setup([project])
  expect(button(s.tree.container, 'sample')).not.toBeNull()
  await act(async () => { s.tree.container.querySelector<HTMLButtonElement>('[aria-label="Add project"]')!.click() })
  await act(async () => { button(s.tree.container, 'Choose folder…').click() })
  await act(async () => { s.tree.container.querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')!.click() })
  expect(s.createProject).not.toHaveBeenCalled()
  expect(s.createSession).not.toHaveBeenCalled()
  expect(s.createProjectSession).not.toHaveBeenCalled()
  expect(s.cancelProjectDraft).toHaveBeenCalledWith('draft')
})
