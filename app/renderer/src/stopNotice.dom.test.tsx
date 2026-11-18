import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { App } from './App.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { sessionDescriptor as fixture } from './sessionDescriptorFixture.js'
import type { HostEvent, HostResult, SessionDescriptor } from '../../shared/hostApi.js'
import { PROTOCOL_VERSION, type CatCodeBridge, type ServerFrame } from '../../shared/protocol.js'
import type { NotificationVisibilityBridge } from '../../shared/notificationVisibility.js'

let harness: DomTestHarness
let previousBridge: CatCodeBridge
beforeAll(async () => { harness = await createDomTestHarness(); previousBridge = window.catcode })
afterEach(async () => { await harness.unmountAll(); window.catcode = previousBridge })
afterAll(async () => { await harness.teardown() })

const UNCONFIRMED: HostResult<void> = {
  ok: false, error: { code: 'stop_unconfirmed', message: 'Stop is not confirmed. Open the chat to review it or retry stop.' },
}
const WARNING = 'Couldn\'t confirm "a" stopped.'

function session(id: string, overrides: Partial<SessionDescriptor> = {}) {
  return fixture(id, { title: id, ...overrides })
}

function ready(id: string): ServerFrame {
  return { kind: 'ready', protocolVersion: PROTOCOL_VERSION, sessionId: id, engineSessionId: `engine-${id}`,
    payload: { type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: false, abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [] } }
}

async function mountApp(sessions: SessionDescriptor[]) {
  window.localStorage.clear()
  let hostListener: (event: HostEvent) => void = () => {}
  let frameListener: (frames: ServerFrame[]) => void = () => {}
  const closes: Array<(result: HostResult<void>) => void> = []
  const bridge: Partial<CatCodeBridge> & NotificationVisibilityBridge = {
    subscribe: listener => { frameListener = listener; return () => {} },
    subscribeHost: listener => { hostListener = listener; return () => {} },
    listSessions: async () => sessions, readProjectRoutes: async () => [], readSessionsCatalog: async () => null,
    rendererReady: () => {}, recordRenderCommit: () => {}, refreshUsageDashboard: () => {},
    reportNotificationVisibility: () => {}, previewSession: async () => null,
    listWorkspaceBranches: async () => ({ ok: true, value: { current: null, branches: [], dirty: false } }),
    readSettingsInventory: async cwd => ({ ok: true, inventory: { cwd: cwd ?? '/synthetic-home', extensions: { mcp: [], plugins: [], skills: [], hooks: [] }, agents: { definitions: [], failedFiles: [], availableMcpServers: [] }, settings: null, memory: null } }),
    closeSession: () => new Promise(resolve => { closes.push(resolve) }),
    restoreSession: async id => ({ ok: true, value: session(id) }),
  }
  window.catcode = bridge as CatCodeBridge
  const tree = await harness.mount(<App />)
  const host = async (event: HostEvent) => { await act(async () => { hostListener(event) }) }
  await host({ type: 'accounts-pool', pool: { accounts: [], signedOutProfiles: [], activeAccountId: null, readyCount: 0, poolCount: 0, initialized: true, anthropicAccounts: [], anthropicActiveAccountId: null, anthropicReadyCount: 0, anthropicPoolCount: 0, anthropicInitialized: true, anthropicRouteAvailable: true } })
  await act(async () => { frameListener(sessions.map(s => ready(s.appSessionId))) })
  const click = async (label: string) => {
    const element = [...tree.container.querySelectorAll<HTMLElement>('button,[role="tab"]')]
      .find(el => el.getAttribute('aria-label') === label || el.textContent?.trim() === label)
    if (!element) throw new Error(`missing ${label}`)
    await act(async () => { element.click() })
  }
  const answerClose = async (result: HostResult<void>) => {
    const resolve = closes.shift()
    if (!resolve) throw new Error('no close in flight')
    await act(async () => { resolve(result) })
  }
  const text = () => tree.container.textContent ?? ''
  const tabs = () => [...tree.container.querySelectorAll<HTMLElement>('[role="tab"]')].map(tab => tab.getAttribute('aria-label'))
  const notices = () => tree.container.querySelectorAll('[role="region"][aria-label="Notices"] [role="status"]').length
  return { host, click, answerClose, text, tabs, notices, closes }
}

test('a normal close shows no stop warning while it runs or after it succeeds', async () => {
  const app = await mountApp([session('a'), session('b')])
  await app.click('Close session a')
  expect(app.closes).toHaveLength(1)
  expect(app.notices()).toBe(0)
  expect(app.text()).not.toContain('confirm')
  await app.answerClose({ ok: true, value: undefined })
  await app.host({ type: 'session-status', session: session('a', { status: 'exited', restorable: true }) })
  expect(app.notices()).toBe(0)
})

test('an unconfirmed stop shows one closable bar; a failed retry shows it again', async () => {
  const app = await mountApp([session('a'), session('b')])
  await app.click('Close session a')
  await app.answerClose(UNCONFIRMED)
  expect(app.text()).toContain(WARNING)
  // The bar is the only report: nothing is written to the shell error line.
  expect(app.text()).not.toContain('stop_unconfirmed')
  expect(app.text()).not.toContain('Stop is not confirmed')

  await app.click('Retry stop')
  expect(app.text()).not.toContain(WARNING)
  await app.answerClose(UNCONFIRMED)
  expect(app.text()).toContain(WARNING)

  await app.click(`Dismiss: ${WARNING}`)
  expect(app.text()).not.toContain(WARNING)
})

test('a late exit clears the bar, and a refusal says why', async () => {
  const app = await mountApp([session('a'), session('b')])
  await app.click('Close session a')
  await app.answerClose(UNCONFIRMED)
  expect(app.text()).toContain(WARNING)
  await app.host({ type: 'session-status', session: session('a', { status: 'exited', restorable: true }) })
  expect(app.text()).not.toContain(WARNING)

  await app.click('Close session b')
  await app.answerClose({ ok: false, error: { code: 'session_unreachable', message: 'This Chat is moving' } })
  expect(app.text()).toContain('Couldn\'t stop "b".')
  expect(app.text()).toContain('This Chat is moving')
})

test('Open chat reopens the closed chat and removes its bar', async () => {
  const app = await mountApp([session('a'), session('b')])
  await app.click('Close session a')
  await app.answerClose(UNCONFIRMED)
  expect(app.tabs()).not.toContain('Session a, live')
  await app.click('Open chat')
  expect(app.text()).not.toContain(WARNING)
  expect(app.tabs()).toContain('Session a, live')
})
