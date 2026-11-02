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
function bridge(sessions: SessionDescriptor[] = [session]) {
  let receiveHost!: (event: HostEvent) => void
  let receiveFrames!: (frames: ServerFrame[]) => void
  window.catcode = {
    subscribe: listener => { receiveFrames = listener; return () => {} }, subscribeHost: listener => { receiveHost = listener; return () => {} }, rendererReady: () => {},
    listSessions: async () => sessions, listProjects: async () => [], readProjectRoutes: async () => [], readSessionsCatalog: async () => null,
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
  const restored = tree.container.querySelector('[aria-label="Restored draft"]')!
  expect(restored.textContent).toContain('Saved draft restored.')
  expect(restored.closest('[data-window-panel]')).not.toBeNull()
  const composer = tree.container.querySelector<HTMLElement>('[contenteditable="true"][role="textbox"]')!
  expect(composer).not.toBeNull()
  await act(async () => { composer.textContent = saved + 'y'; composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'y' })) })
  expect(tree.container.querySelector('[aria-label="Restored draft"]')).toBeNull()
  expect(tree.container.textContent).toContain('Your latest draft is not saved.')
  expect(tree.container.querySelector('.unsaved-text-protection')!.closest('[data-window-panel]')).not.toBeNull()
  expect(tree.container.querySelector('textarea')!.value).toBe(saved + 'y')
  await act(async () => { window.dispatchEvent(new Event('pagehide')) })
  expect(JSON.parse(window.localStorage.getItem(PROMPT_DRAFTS_STORAGE_KEY)!).drafts.existing).toBe(saved)
  await tree.unmount()
  const reloaded = await harness.mount(<App />)
  expect(reloaded.container.textContent).toContain('Saved draft restored.')
  expect(reloaded.container.querySelector('[role="textbox"]')!.textContent).toBe(saved)
})

test('drafts from old chats do not show a global recovery warning', async () => {
  bridge()
  window.localStorage.setItem(PROMPT_DRAFTS_STORAGE_KEY, JSON.stringify({ version: 1, drafts: { 'old-chat': 'old saved draft' } }))
  const tree = await harness.mount(<App />)
  expect(tree.container.querySelector('[aria-label="Restored draft"]')).toBeNull()
  expect(tree.container.textContent).not.toContain('Recovered last-good draft copies')
  expect(tree.container.textContent).not.toContain('I have checked my drafts')
  expect(JSON.parse(window.localStorage.getItem(PROMPT_DRAFTS_STORAGE_KEY)!).drafts['old-chat']).toBe('old saved draft')
})

test('restored draft notice can be dismissed without deleting the saved text', async () => {
  bridge()
  window.localStorage.setItem(PROMPT_DRAFTS_STORAGE_KEY, JSON.stringify({ version: 1, drafts: { existing: 'saved draft' } }))
  const tree = await harness.mount(<App />)
  await act(async () => { tree.container.querySelector<HTMLButtonElement>('[aria-label="Restored draft"] button')!.click() })
  expect(tree.container.querySelector('[aria-label="Restored draft"]')).toBeNull()
  expect(tree.container.querySelector('[role="textbox"]')!.textContent).toBe('saved draft')
  expect(JSON.parse(window.localStorage.getItem(PROMPT_DRAFTS_STORAGE_KEY)!).drafts.existing).toBe('saved draft')
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

function ready(sessionId: string): ServerFrame {
  return { kind: 'ready', protocolVersion: PROTOCOL_VERSION, sessionId, engineSessionId: `engine-${sessionId}`, payload: { type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: false, abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [] } }
}
async function sessionsPage(tree: Awaited<ReturnType<DomTestHarness['mount']>>, host: ReturnType<typeof bridge>) {
  await act(async () => { host.frames([{ kind: 'slash-catalog.snapshot', protocolVersion: PROTOCOL_VERSION, sessionId: 'existing', commands: [{ name: 'resume', description: 'Open history' }] }]) })
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })) })
  await act(async () => { tree.container.querySelector<HTMLElement>('[aria-label="Navigate with /resume"]')!.click() })
}

for (const ok of [true, false]) test(`unknown single export is reconciled by exact authoritative ok=${ok}`, async () => {
  const host = bridge()
  let requestId = ''
  window.catcode.sessionActionVerb = (_id, verb) => { requestId = verb.requestId; throw new Error('Socket outcome unknown') }
  const tree = await harness.mount(<App />)
  await act(async () => { host.frames([ready('existing')]) })
  await sessionsPage(tree, host)
  await act(async () => { tree.container.querySelector<HTMLButtonElement>('[aria-label="Session actions"]')!.click() })
  await act(async () => { [...tree.container.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Export…')!.click() })
  expect(tree.container.textContent).toContain('Export delivery is unknown')
  const result = { kind: 'session-action.result', protocolVersion: PROTOCOL_VERSION, sessionId: 'existing', requestId, verb: 'export', ok, message: 'Authoritative export failure', ...(ok ? { exportText: 'AUTHORITATIVE TRANSCRIPT' } : {}) } as const
  await act(async () => { host.frames([{ ...result, requestId: 'old-request' }]) })
  expect(tree.container.textContent).toContain('Export delivery is unknown')
  await act(async () => { host.frames([result]) })
  expect(tree.container.textContent).toContain(ok ? 'AUTHORITATIVE TRANSCRIPT' : 'Authoritative export failure')
  expect(tree.container.textContent).not.toContain('Export delivery is unknown')
})

test('two-leg bulk export preserves successful section when the other leg is refused locally while connected', async () => {
  const host = bridge([session, { ...session, appSessionId: 'second', title: 'Second chat' }])
  const sent: Array<{ id: string; requestId: string }> = []
  const saved: string[] = []
  window.catcode.sessionActionVerb = (id, verb) => {
    sent.push({ id, requestId: verb.requestId })
    if (id === 'existing') throw new Error('Too many requests at once. Wait a moment and try again.')
  }
  window.catcode.saveTextToFile = async request => { saved.push(request.text); return { ok: true, saved: true } }
  const tree = await harness.mount(<App />)
  await act(async () => { host.frames([ready('existing'), ready('second')]) })
  await sessionsPage(tree, host)
  await act(async () => { tree.container.querySelectorAll<HTMLButtonElement>('[aria-label="Select session"]').forEach(button => button.click()) })
  await act(async () => { [...tree.container.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Export')!.click() })
  expect(sent).toHaveLength(2)
  const successful = sent.find(item => item.id === 'second')!
  await act(async () => { host.frames([{ kind: 'session-action.result', protocolVersion: PROTOCOL_VERSION, sessionId: 'second', requestId: successful.requestId, verb: 'export', ok: true, message: 'Exported', exportText: 'SUCCESSFUL SECOND SECTION' }]) })
  expect(saved).toHaveLength(1)
  expect(saved[0]).toContain('SUCCESSFUL SECOND SECTION')
  expect(saved[0]).not.toContain('Too many requests')
  expect(sent).toHaveLength(2)
})

for (const code of ['session_not_ready', 'session_not_found', 'session_disconnected', 'bad_request'] as const) test(`asynchronous remote ${code} is correlated and never blindly repeats a mutation`, async () => {
  const host = bridge()
  let requestId = ''
  let writes = 0
  window.catcode.remoteSettingsVerb = (_id, verb) => { requestId = verb.requestId; writes++ }
  const tree = await harness.mount(<App />)
  await act(async () => { host.frames([ready('existing'), { kind: 'remoteSettings.snapshot', protocolVersion: PROTOCOL_VERSION, sessionId: 'existing', remoteSettings: { bridge: { enabled: false, error: null, transport: 'v1' }, commandFilter: { skillSafe: [], optIn: [], blocked: [] } } }]) })
  await act(async () => { tree.container.querySelector<HTMLButtonElement>('[aria-label="Settings"]')!.click() })
  await act(async () => { [...tree.container.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Remote')!.click() })
  const start = () => [...tree.container.querySelectorAll('button')].find(button => button.textContent === 'Start bridge')!
  await act(async () => { start().click() })
  expect(writes).toBe(1)
  expect(start().disabled).toBe(true)
  const error = { kind: 'error', protocolVersion: PROTOCOL_VERSION, sessionId: 'existing', requestId, code, message: 'Synthetic forwarding refusal', retryable: false } as const
  await act(async () => { host.frames([{ ...error, requestId: 'stale-request' }, { ...error, sessionId: 'wrong-session' }]) })
  expect(start().disabled).toBe(true)
  await act(async () => { host.frames([error]) })
  expect(start().disabled).toBe(code === 'bad_request')
  expect(writes).toBe(1)
  if (code === 'bad_request') {
    expect(tree.container.textContent).toContain('Delivery is unknown')
    await act(async () => { start().click() })
    expect(writes).toBe(1)
    await act(async () => { host.frames([{ kind: 'remoteSettings.result', protocolVersion: PROTOCOL_VERSION, sessionId: 'existing', requestId, verb: 'remoteSettings.bridgeToggle', ok: true, message: 'Authoritative bridge result' }]) })
    expect(start().disabled).toBe(false)
  }
})

test('batched asynchronous remote refusals settle both exact controls without losing either result', async () => {
  const host = bridge()
  const requests: Array<{ requestId: string; type: string }> = []
  window.catcode.remoteSettingsVerb = (_id, verb) => { requests.push(verb) }
  const tree = await harness.mount(<App />)
  await act(async () => { host.frames([ready('existing'), { kind: 'remoteSettings.snapshot', protocolVersion: PROTOCOL_VERSION, sessionId: 'existing', remoteSettings: { bridge: { enabled: false, error: null, transport: 'v1' }, commandFilter: { skillSafe: [], optIn: [], blocked: [] } } }]) })
  await act(async () => { tree.container.querySelector<HTMLButtonElement>('[aria-label="Settings"]')!.click() })
  await act(async () => { [...tree.container.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Remote')!.click() })
  const start = [...tree.container.querySelectorAll('button')].find(button => button.textContent === 'Start bridge')!
  const input = tree.container.querySelector<HTMLInputElement>('#remote-server-url')!
  await act(async () => {
    start.click()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'wss://fixture.example.test')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  expect(requests).toHaveLength(2)
  expect(start.disabled).toBe(true)
  expect(input.disabled).toBe(true)
  await act(async () => { host.frames(requests.map(request => ({ kind: 'error', protocolVersion: PROTOCOL_VERSION, sessionId: 'existing', requestId: request.requestId, code: 'session_not_ready', message: 'Synthetic pre-send refusal', retryable: true }))) })
  expect(start.disabled).toBe(false)
  expect(input.disabled).toBe(false)
  expect(input.value).toBe('wss://fixture.example.test')
  expect(requests).toHaveLength(2)
})

test('unknown bulk export shows one waiting notice, retains successful text, and completes once on the exact late result', async () => {
  const host = bridge([session, { ...session, appSessionId: 'second', title: 'Second chat' }])
  const sent: Array<{ id: string; requestId: string }> = []
  const saved: string[] = []
  window.catcode.sessionActionVerb = (id, verb) => {
    sent.push({ id, requestId: verb.requestId })
    if (id === 'existing') throw new Error('Socket write outcome unknown')
  }
  window.catcode.saveTextToFile = async request => { saved.push(request.text); return { ok: true, saved: true } }
  const tree = await harness.mount(<App />)
  await act(async () => { host.frames([ready('existing'), ready('second')]) })
  await sessionsPage(tree, host)
  await act(async () => { tree.container.querySelectorAll<HTMLButtonElement>('[aria-label="Select session"]').forEach(button => button.click()) })
  const exportButton = () => [...tree.container.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Export')!
  await act(async () => { exportButton().click() })
  expect(sent).toHaveLength(2)
  const unknown = sent.find(item => item.id === 'existing')!
  const successful = sent.find(item => item.id === 'second')!
  const result = (id: string, requestId: string, text: string): ServerFrame => ({ kind: 'session-action.result', protocolVersion: PROTOCOL_VERSION, sessionId: id, requestId, verb: 'export', ok: true, message: 'Exported', exportText: text })
  await act(async () => { host.frames([result('second', successful.requestId, 'SUCCESSFUL SECOND SECTION')]) })
  expect(tree.container.querySelectorAll('[aria-label="Bulk export status"]')).toHaveLength(1)
  expect(tree.container.textContent).toContain('Export delivery is unknown')
  expect(tree.container.textContent).toContain('Wait for the session results before exporting again')
  expect(saved).toHaveLength(0)
  // SessionsPage clears selection at dispatch. Selecting again must not replace
  // the still-unknown batch or send another set of requests.
  await act(async () => { tree.container.querySelectorAll<HTMLButtonElement>('[aria-label="Select session"]').forEach(button => button.click()) })
  await act(async () => { exportButton().click(); host.frames([result('existing', 'stale-export-request', 'STALE TRANSCRIPT')]) })
  expect(sent).toHaveLength(2)
  expect(saved).toHaveLength(0)
  expect(tree.container.querySelectorAll('[aria-label="Bulk export status"]')).toHaveLength(1)
  await act(async () => { host.frames([result('existing', unknown.requestId, 'LATE FIRST SECTION')]) })
  expect(saved).toHaveLength(1)
  expect(saved[0]).toContain('LATE FIRST SECTION')
  expect(saved[0]).toContain('SUCCESSFUL SECOND SECTION')
  expect(saved[0]).not.toContain('STALE TRANSCRIPT')
  expect(tree.container.querySelector('[aria-label="Bulk export status"]')).toBeNull()
  await act(async () => { host.frames([result('existing', unknown.requestId, 'DUPLICATE LATE RESULT')]) })
  expect(saved).toHaveLength(1)
  expect(sent).toHaveLength(2)
})
