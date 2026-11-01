import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { App } from './App.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { PROTOCOL_VERSION, type ServerFrame, type CatCodeBridge } from '../../shared/protocol.js'
import type { HostEvent, SessionDescriptor } from '../../shared/hostApi.js'
import { PROMPT_DRAFTS_STORAGE_KEY } from './promptDraftPersistence.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll(); Reflect.deleteProperty(window, 'catcode'); window.localStorage.clear() })
afterAll(async () => { await harness.teardown() })
const session: SessionDescriptor = { appSessionId: 'existing', engineSessionId: null, cwd: '/fixture', title: 'Fixture chat', forked: false, titleUpdatedAt: null, status: 'ready', restorable: false, parked: false, createdAt: 1, lastAttachedAt: 1, lastMessageSentAt: null, binding: { kind: 'project' } }
function bridge() {
  let receiveHost!: (event: HostEvent) => void
  let receiveFrames!: (frames: ServerFrame[]) => void
  window.catcode = {
    subscribe: listener => { receiveFrames = listener; return () => {} }, subscribeHost: listener => { receiveHost = listener; return () => {} }, rendererReady: () => {},
    listSessions: async () => [session], listProjects: async () => [], readProjectRoutes: async () => [], readSessionsCatalog: async () => null,
    reportVisibleSessions: () => {}, recordRenderCommit: () => {}, getSessionFolderState: async () => ({ ok: true, value: 'available' }),
    listWorkspaceBranches: async () => ({ ok: true, value: { current: null, branches: [], dirty: false } }),
    readRoutingStorageHealth: async () => ({ status: 'healthy', code: null }),
    revalidateRoutingStorage: async () => ({ status: 'healthy', code: null }), inspectRoutingStorage: async () => ({ ok: true, value: undefined }),
  } satisfies Partial<CatCodeBridge> as unknown as CatCodeBridge
  return { receive: (event: HostEvent) => receiveHost(event), frames: (frames: ServerFrame[]) => receiveFrames(frames) }
}

test('App protects full 20,001-character text before reload and labels the recovered last-good copy afterward', async () => {
  bridge()
  const saved = 'x'.repeat(20000)
  window.localStorage.setItem(PROMPT_DRAFTS_STORAGE_KEY, JSON.stringify({ version: 1, drafts: { existing: saved } }))
  const tree = await harness.mount(<App />)
  expect(tree.container.textContent).toContain('Recovered last-good draft copies')
  const composer = tree.container.querySelector<HTMLElement>('[contenteditable="true"][role="textbox"]')!
  expect(composer).not.toBeNull()
  await act(async () => { composer.textContent = saved + 'y'; composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'y' })) })
  expect(tree.container.textContent).toContain('Your latest draft is not saved.')
  expect(tree.container.querySelector('textarea')!.value).toBe(saved + 'y')
  await act(async () => { window.dispatchEvent(new Event('pagehide')) })
  expect(JSON.parse(window.localStorage.getItem(PROMPT_DRAFTS_STORAGE_KEY)!).drafts.existing).toBe(saved)
  await tree.unmount()
  const reloaded = await harness.mount(<App />)
  expect(reloaded.container.textContent).toContain('Recovered last-good draft copies')
  expect(reloaded.container.querySelector('[role="textbox"]')!.textContent).toBe(saved)
})

test('global routing health recovery is visible without a session route and clears only after revalidation', async () => {
  const host = bridge()
  const tree = await harness.mount(<App />)
  await act(async () => { host.receive({ type: 'routing-storage-health', health: { status: 'blocked', code: 'routing_storage_unreadable' } }) })
  expect(tree.container.querySelector('[aria-label="Saved message recovery"]')).not.toBeNull()
  const check = [...tree.container.querySelectorAll('button')].find(button => button.textContent === 'Check repaired file')!
  await act(async () => { check.click() })
  expect(tree.container.querySelector('[aria-label="Saved message recovery"]')).toBeNull()
})

test('routing recovery copies the current full draft rather than its last-good persisted copy', async () => {
  const host = bridge()
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  const copied: string[] = []
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text) } } })
  try {
    const tree = await harness.mount(<App />)
    const composer = tree.container.querySelector<HTMLElement>('[contenteditable="true"][role="textbox"]')!
    const full = 'unsaved routing draft '.repeat(1100)
    await act(async () => {
      composer.textContent = full
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: full }))
      host.receive({ type: 'routing-storage-health', health: { status: 'blocked', code: 'routing_storage_unreadable' } })
    })
    const recovery = tree.container.querySelector('[aria-label="Saved message recovery"]')!
    const copy = [...recovery.querySelectorAll('button')].find(button => button.textContent === 'Copy draft')!
    await act(async () => { copy.click() })
    expect(copied).toEqual([full])
  } finally {
    if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})

test('committed project with cleanup warning is adopted and closes creation without offering failed retry', async () => {
  bridge()
  const { ToastHost } = await import('./ToastHost.js')
  let creates = 0
  window.catcode.beginProjectDraft = async () => 'fixture-draft'
  window.catcode.cancelProjectDraft = async () => {}
  window.catcode.pickProjectFolder = async () => ({ kind: 'selected', folder: { cwd: '/fixture/project', name: 'Saved project', trustRoot: '/fixture/project' } })
  window.catcode.createProject = async () => {
    creates++
    return { ok: true, project: { id: 'project-id', name: 'Saved project', cwd: '/fixture/project', createdAt: 1 }, warning: 'Project saved. Could not release the project lock.' }
  }
  const tree = await harness.mount(<ToastHost><App /></ToastHost>)
  await act(async () => { tree.container.querySelector<HTMLButtonElement>('[aria-label="Pin sidebar open"]')!.click() })
  await act(async () => { tree.container.querySelector<HTMLButtonElement>('[aria-label="Add project"]')!.click() })
  const button = (text: string) => [...tree.container.querySelectorAll('button')].find(button => button.textContent === text)!
  await act(async () => { button('Choose folder…').click() })
  await act(async () => { button('Create project').click() })
  expect(creates).toBe(1)
  expect(tree.container.querySelector('[role="dialog"][aria-label="Create project"]')).toBeNull()
  expect(button('Saved project')).toBeDefined()
  expect(tree.container.textContent).toContain('Project saved. Could not release the project lock.')
})

test('connected export local refusal settles the initiating dialog instead of remaining pending', async () => {
  const host = bridge()
  let sends = 0
  window.catcode.sessionActionVerb = () => { sends++; throw new Error('Too many requests at once. Wait a moment and try again.') }
  const tree = await harness.mount(<App />)
  await act(async () => { host.frames([{ kind: 'ready', protocolVersion: PROTOCOL_VERSION, sessionId: 'existing', engineSessionId: 'fixture-engine', payload: { type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: false, abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [] } }]) })
  await act(async () => { tree.container.querySelector<HTMLButtonElement>('[aria-label="Pin sidebar open"]')!.click() })
  await act(async () => { host.frames([{ kind: 'slash-catalog.snapshot', protocolVersion: PROTOCOL_VERSION, sessionId: 'existing', commands: [{ name: 'resume', description: 'Open history' }] }]) })
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })) })
  await act(async () => { tree.container.querySelector<HTMLElement>('[aria-label="Navigate with /resume"]')!.click() })
  await act(async () => { tree.container.querySelector<HTMLButtonElement>('[aria-label="Session actions"]')!.click() })
  const exportButton = [...tree.container.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Export…')!
  expect(exportButton).toBeDefined()
  await act(async () => { exportButton.click() })
  expect(sends).toBe(1)
  expect(tree.container.textContent).toContain('Could not send the export request. Try again.')
  expect(tree.container.textContent).not.toContain('Rendering this session')
})
