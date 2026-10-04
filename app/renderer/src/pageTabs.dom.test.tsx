import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { App } from './App.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { sessionDescriptor as fixture } from './sessionDescriptorFixture.js'
import { WORKSPACE_LAYOUT_STORAGE_KEY } from './workspaceLayout.js'
import type { HostEvent, SessionDescriptor } from '../../shared/hostApi.js'
import { PROTOCOL_VERSION, type CatCodeBridge, type ServerFrame, type TranscriptCache, type SessionCatalogEntry } from '../../shared/protocol.js'

let harness: DomTestHarness
let previousBridge: CatCodeBridge
beforeAll(async () => { harness = await createDomTestHarness(); previousBridge = window.catcode })
afterEach(async () => { await harness.unmountAll(); window.catcode = previousBridge })
afterAll(async () => { await harness.teardown() })

function sessionDescriptor(id: string, overrides: Partial<SessionDescriptor> = {}) {
  return fixture(id, { title: id, ...overrides })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function catalogEntry(id: string, overrides: Partial<SessionCatalogEntry> = {}): SessionCatalogEntry {
  return { sessionId: id, cwd: '/tmp/history', cwdExists: true, title: 'History chat', transcriptTitle: null, forked: false, modifiedAtMs: 1, createdAtMs: 1, messageCount: 2, gitBranch: null, tag: null, mode: null, agentSetting: null, prNumber: null, prRepository: null, ...overrides }
}

function ready(id: string): ServerFrame {
  return { kind: 'ready', protocolVersion: PROTOCOL_VERSION, sessionId: id, engineSessionId: `engine-${id}`,
    payload: { type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: false, abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [] } }
}

async function mountApp(sessions: SessionDescriptor[] = [], split = false, savedActiveIndex = 0) {
  window.localStorage.clear()
  if (split) window.localStorage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, JSON.stringify({ version: 1, panels: ['a', 'b'], widths: [35, 65], activeIndex: savedActiveIndex }))
  let hostListener: (event: HostEvent) => void = () => {}
  let frameListener: (frames: ServerFrame[]) => void = () => {}
  const lifecycle: string[] = []
  const visible: string[][] = []
  const inventoryCwds: (string | null)[] = []
  const bridge: Partial<CatCodeBridge> = {
    subscribe: listener => { frameListener = listener; return () => {} },
    subscribeHost: listener => { hostListener = listener; return () => {} },
    listSessions: async () => sessions, readProjectRoutes: async () => [], readSessionsCatalog: async () => null,
    rendererReady: () => {}, recordRenderCommit: () => {},
    reportVisibleSessions: ids => { visible.push([...ids]) },
    previewSession: async () => null,
    listWorkspaceBranches: async () => ({ ok: true, value: { current: null, branches: [], dirty: false } }),
    readSettingsInventory: async cwd => { inventoryCwds.push(cwd); return { ok: true, inventory: { cwd: cwd ?? '/synthetic-home', extensions: { mcp: [], plugins: [], skills: [], hooks: [] }, agents: { definitions: [], failedFiles: [], availableMcpServers: [] }, settings: null, memory: null } } },
    closeSession: async id => { lifecycle.push(`close:${id}`); return { ok: true, value: undefined } },
    restoreSession: async id => { lifecycle.push(`restore:${id}`); return { ok: true, value: sessionDescriptor(id) } },
    createManagedChat: async () => { lifecycle.push('create'); return { ok: true, value: sessionDescriptor('created') } },
  }
  window.catcode = bridge as CatCodeBridge
  const tree = await harness.mount(<App />)
  const host = async (event: HostEvent) => { await act(async () => { hostListener(event) }) }
  const frames = async (...frames: ServerFrame[]) => { await act(async () => { frameListener(frames) }) }
  await host({ type: 'accounts-pool', pool: { accounts: [], signedOutProfiles: [], activeAccountId: null, readyCount: 0, poolCount: 0, initialized: true, anthropicAccounts: [], anthropicActiveAccountId: null, anthropicReadyCount: 0, anthropicPoolCount: 0, anthropicInitialized: true, anthropicRouteAvailable: true } })
  await frames(...sessions.filter(s => !s.restorable).map(s => ready(s.appSessionId)))
  const click = async (label: string) => {
    const element = [...tree.container.querySelectorAll<HTMLElement>('button,[role="tab"],[role="option"],[role="button"]')].find(el => el.getAttribute('aria-label') === label || el.textContent?.trim() === label || el.getAttribute('title') === label)
    if (!element) throw new Error(`missing ${label}`)
    await act(async () => {
      if (element.getAttribute('role') === 'option') element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      else element.click()
    })
  }
  const key = async (key: string) => { await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true })) }) }
  const tabs = () => [...tree.container.querySelectorAll<HTMLElement>('[role="tab"]')]
  const selected = () => tabs().filter(t => t.getAttribute('aria-selected') === 'true').map(t => t.getAttribute('aria-label'))
  return { tree, host, frames, click, key, tabs, selected, lifecycle, visible, inventoryCwds }
}

test('all sidebar pages share a unique strip and empty close restores the credential-ready welcome', async () => {
  const app = await mountApp()
  for (const title of ['Goals', 'Accounts', 'Analytics', 'Settings']) {
    await app.click(title)
    expect(app.selected()).toEqual([`${title} page`])
    expect(app.tree.container.querySelector('main')?.textContent).toContain(title)
  }
  await app.click('Goals')
  expect(app.tabs().map(t => t.getAttribute('aria-label'))).toEqual(['Goals page', 'Accounts page', 'Analytics page', 'Settings page'])
  await app.click('Close Analytics page')
  expect(app.selected()).toEqual(['Goals page'])
  const close = app.tree.container.querySelector<HTMLElement>('[aria-label="Close Goals page"]')!
  await act(async () => {
    close.focus()
    close.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', metaKey: true, bubbles: true }))
  })
  expect(app.tabs()).toHaveLength(2)
  for (let i = 0; i < 2; i++) await app.key('w')
  expect(app.tabs()).toHaveLength(0)
  expect(app.tree.container.textContent).toContain('Welcome back')
  expect(app.lifecycle).toEqual([])
})

test('page close and numeric selection focus the matching conversation instead of retained context', async () => {
  const app = await mountApp([sessionDescriptor('a'), sessionDescriptor('b')])
  await app.key('2')
  await app.click('Goals')
  await app.key('1')
  expect(app.visible.at(-1)).toEqual(['a'])
  await app.key('3')
  for (const [key, label] of [['ArrowLeft', 'Session b,'], ['Home', 'Session a,'], ['End', 'Goals page']]) {
    const selected = app.tabs().find(t => t.getAttribute('aria-selected') === 'true')!
    await act(async () => { selected.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) })
    expect(app.selected()[0]).toContain(label!)
    expect(app.tabs().filter(t => t.tabIndex === 0)).toHaveLength(1)
  }
  await app.key('w')
  expect(app.selected()[0]).toContain('Session b,')
  expect(app.visible.at(-1)).toEqual(['b'])
})

test('session close waits for success, chooses a page neighbor, and late close preserves newer selection', async () => {
  const app = await mountApp([sessionDescriptor('a')])
  await app.click('Goals')
  await app.host({ type: 'session-added', session: sessionDescriptor('b') })
  await app.frames(ready('b'))
  await app.key('3')
  const closing = deferred<Awaited<ReturnType<CatCodeBridge['closeSession']>>>()
  window.catcode.closeSession = async () => closing.promise
  await app.key('w')
  expect(app.selected()[0]).toContain('Session b,')
  await act(async () => { closing.resolve({ ok: false, error: { code: 'session_unreachable', message: 'Synthetic close refusal' } }) })
  expect(app.selected()[0]).toContain('Session b,')
  const retry = deferred<Awaited<ReturnType<CatCodeBridge['closeSession']>>>()
  window.catcode.closeSession = async () => retry.promise
  await app.key('w')
  await act(async () => { retry.resolve({ ok: true, value: undefined }) })
  expect(app.selected()).toEqual(['Goals page'])
  const background = deferred<Awaited<ReturnType<CatCodeBridge['closeSession']>>>()
  window.catcode.closeSession = async () => background.promise
  await app.key('1')
  await app.key('w')
  await app.click('Settings')
  await act(async () => { background.resolve({ ok: true, value: undefined }) })
  expect(app.selected()).toEqual(['Settings page'])
})

test('hidden conversation keeps draft, receives messages and permission attention through App', async () => {
  const app = await mountApp([sessionDescriptor('a')])
  const composer = app.tree.container.querySelector<HTMLElement>('[role="textbox"]')!
  expect(composer).not.toBeNull()
  await act(async () => {
    composer.textContent = 'my unsent draft'
    composer.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await app.click('Accounts')
  await app.frames({ kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: 'a', event: { type: 'permission.requested', request: { requestId: 'perm', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'date' }, tool_use_id: 'tool' } } } },
    { kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: 'a', event: { type: 'message', message: { type: 'assistant', uuid: 'message-1', message: { role: 'assistant', content: [{ type: 'text', text: 'arrived while hidden' }] } } } } as ServerFrame)
  expect(app.tabs()[0]?.getAttribute('aria-label')).toContain('permission request waiting')
  expect(app.visible.at(-1)).toEqual([])
  await app.key('1')
  expect(app.selected()[0]).toContain('Session a,')
  expect(app.tree.container.textContent).toContain('arrived while hidden')
  expect(app.tree.container.querySelector<HTMLElement>('[role="textbox"]')?.textContent).toBe('my unsent draft')
})

test.each(['preview', 'restore', 'create', 'history'] as const)('late %s completion opens membership without stealing page selection', async operation => {
  const dead = sessionDescriptor('dead', { status: 'exited', restorable: true })
  const app = await mountApp(operation === 'preview' || operation === 'restore' ? [dead] : [])
  const pending = deferred<TranscriptCache | SessionDescriptor>()
  if (operation === 'preview') window.catcode.previewSession = async () => {
    const cache = await pending.promise
    if (!('header' in cache)) throw new Error('expected preview cache')
    return cache
  }
  const opened = async () => {
    const descriptor = await pending.promise
    if ('header' in descriptor) throw new Error('expected session descriptor')
    return { ok: true as const, value: descriptor }
  }
  if (operation === 'restore') window.catcode.restoreSession = opened
  if (operation === 'create') window.catcode.createManagedChat = opened
  if (operation === 'history') {
    window.catcode.openHistorySession = opened
    await app.host({ type: 'sessions-catalog', catalog: { capturedAtMs: 1, truncated: false, entries: [catalogEntry('history-engine')] } })
  }
  await app.click('Pin sidebar open')
  await act(async () => {
    for (const header of app.tree.container.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"][aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"]')) header.click()
  })
  if (operation === 'create') await app.key('t')
  else if (operation === 'history') {
    const row = [...app.tree.container.querySelectorAll<HTMLElement>('[role="button"]')].find(b => b.getAttribute('aria-label')?.includes('History chat'))!
    expect(row).not.toBeUndefined()
    await act(async () => { row.click() })
  }
  else {
    const row = [...app.tree.container.querySelectorAll<HTMLElement>('[role="button"]')].find(b => b.getAttribute('aria-label')?.includes('dead'))
    if (!row) throw new Error('missing restore row')
    await act(async () => { row.click() })
  }
  await app.click('Goals')
  if (operation === 'preview') {
    const cache: TranscriptCache = { header: { appSessionId: 'dead', engineSessionId: 'engine-dead', protocolVersion: PROTOCOL_VERSION, appVersion: 'test', guardVersion: 1, writtenAt: 0 }, frames: [] }
    await act(async () => { pending.resolve(cache) })
  } else {
    const id = operation === 'restore' ? 'dead' : 'new'
    await app.host({ type: 'session-added', session: sessionDescriptor(id) })
    await act(async () => { pending.resolve(sessionDescriptor(id)) })
    await app.frames(ready(id))
  }
  expect(app.selected()).toEqual(['Goals page'])
  expect(app.tabs()).toHaveLength(2)
  if (operation === 'preview') {
    await app.host({ type: 'session-added', session: sessionDescriptor('dead') })
    await app.frames(ready('dead'))
    expect(app.tabs()).toHaveLength(2)
    expect(app.selected()).toEqual(['Goals page'])
    expect(app.lifecycle).toEqual([])
  }
})

test('page navigation preserves saved splits and Settings loses removed session context', async () => {
  const app = await mountApp([sessionDescriptor('a'), sessionDescriptor('b')], true)
  const before = JSON.parse(window.localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY)!)
  await app.click('Settings')
  await app.click('General')
  await app.click('Project: a')
  expect(app.inventoryCwds.at(-1)).toBe('/tmp/a')
  expect(app.visible.at(-1)).toEqual([])
  expect(app.tree.container.querySelector('[aria-label="Split view"]')).toBeNull()
  await app.key('2')
  expect(app.visible.at(-1)).toEqual(['a', 'b'])
  expect(JSON.parse(window.localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY)!).widths).toEqual(before.widths)
  const panel = app.tree.container.querySelector<HTMLElement>('section[aria-label^="Panel 1 session a"]')!
  await act(async () => { panel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
  expect(app.selected()[0]).toContain('Session a,')
  await app.click('Settings')
  await app.host({ type: 'session-removed', appSessionId: 'a' })
  await app.host({ type: 'session-removed', appSessionId: 'b' })
  expect(app.selected()).toEqual(['Settings page'])
  expect(app.inventoryCwds.at(-1)).toBeNull()
})


test.each(['session', 'page'] as const)('deferred saved split restoration preserves newer %s selection', async selection => {
  const app = await mountApp([
    sessionDescriptor('a'),
    sessionDescriptor('b', { status: 'exited', restorable: true }),
  ], true, 1)
  const pending = deferred<TranscriptCache | null>()
  window.catcode.previewSession = () => pending.promise
  await app.click('Pin sidebar open')
  await act(async () => {
    for (const header of app.tree.container.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"][aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"]')) header.click()
  })
  const row = [...app.tree.container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(element => element.getAttribute('aria-label')?.startsWith('session b,'))!
  expect(row).not.toBeUndefined()
  await act(async () => { row.click() })
  if (selection === 'session') await app.key('1')
  else await app.click('Goals')
  const cache: TranscriptCache = {
    header: { appSessionId: 'b', engineSessionId: 'engine-b', protocolVersion: PROTOCOL_VERSION, appVersion: 'test', guardVersion: 1, writtenAt: 0 },
    frames: [],
  }
  await act(async () => { pending.resolve(cache) })
  const saved = JSON.parse(window.localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY)!)
  expect(saved.panels).toEqual(['a', 'b'])
  expect(saved.widths).toEqual([35, 65])
  if (selection === 'page') {
    expect(app.selected()).toEqual(['Goals page'])
    expect(app.visible.at(-1)).toEqual([])
    await app.key('1')
  }
  expect(app.selected()[0]).toContain('Session a,')
  const panels = [...app.tree.container.querySelectorAll('section[aria-label^="Panel "]')]
    .map(element => element.getAttribute('aria-label'))
  expect(panels).toEqual(['Panel 1 session a, live, active', 'Panel 2 session b, closed, inactive'])
  expect(JSON.parse(window.localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY)!).activeIndex).toBe(0)
})

test('catalog exclusions and background park, crash, and restart never replace the selected page', async () => {
  const app = await mountApp([sessionDescriptor('a'), sessionDescriptor('sdk')])
  await app.click('Goals')
  await app.frames({ kind: 'workspace-trust.snapshot', protocolVersion: PROTOCOL_VERSION, sessionId: 'sdk', workspaceTrust: { trusted: false, trustRoot: '/tmp/sdk', detectedRepo: null } })
  await app.host({ type: 'sessions-catalog', catalog: { capturedAtMs: 1, truncated: false, entries: [catalogEntry('engine-sdk', { isInteractive: false })] } })
  expect(app.tabs()).toHaveLength(2)
  await app.key('2')
  expect(app.selected()).toEqual(['Goals page'])
  for (const descriptor of [
    sessionDescriptor('a', { status: 'disconnected', restorable: true, parked: true }),
    sessionDescriptor('a', { status: 'disconnected', restorable: true }),
    sessionDescriptor('a', { status: 'spawning' }),
    sessionDescriptor('a'),
  ]) {
    await app.host({ type: 'session-status', session: descriptor })
    expect(app.selected()).toEqual(['Goals page'])
    expect(app.tabs()).toHaveLength(2)
  }
  await app.host({ type: 'session-removed', appSessionId: 'a' })
  await app.click('Settings')
  await app.click('General')
  expect([...app.tree.container.querySelectorAll('button')].some(button => button.textContent?.startsWith('Project:'))).toBe(false)
  await app.key('w')
  await app.key('w')
  expect(app.tabs()).toHaveLength(0)
  expect(app.tree.container.textContent).toContain('Welcome back')
  expect(app.lifecycle).toEqual([])
})

test('palette page routes reuse their tabs and hide actions for the retained session', async () => {
  const app = await mountApp([sessionDescriptor('a')])
  await app.frames({ kind: 'slash-catalog.snapshot', protocolVersion: PROTOCOL_VERSION, sessionId: 'a', commands: [{ name: 'resume', description: 'Open history' }, { name: 'accounts', description: 'Manage accounts' }] })
  await app.click('Accounts')
  await app.key('k')
  expect(app.tree.container.querySelector('[aria-label="Close active session"]')).toBeNull()
  await app.click('Navigate with /resume')
  expect(app.selected()).toEqual(['Sessions page'])
  await app.key('k')
  await app.click('Navigate with /accounts')
  expect(app.selected()).toEqual(['Accounts page'])
  expect(app.tabs()).toHaveLength(3)
  expect(app.lifecycle).toEqual([])
})

test('a newer restore request keeps its focus claim when an older preview arrives first', async () => {
  const app = await mountApp([sessionDescriptor('old', { status: 'exited', restorable: true }), sessionDescriptor('new', { status: 'exited', restorable: true })])
  const old = deferred<TranscriptCache | null>()
  const newer = deferred<TranscriptCache | null>()
  window.catcode.previewSession = id => id === 'old' ? old.promise : newer.promise
  await app.click('Pin sidebar open')
  await act(async () => {
    for (const header of app.tree.container.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"][aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"]')) header.click()
  })
  const rows = () => [...app.tree.container.querySelectorAll<HTMLElement>('[role="button"]')]
  for (const id of ['old', 'new']) {
    const row = rows().find(row => row.getAttribute('aria-label')?.startsWith(`session ${id},`))!
    await act(async () => { row.click() })
  }
  const cache = (id: string): TranscriptCache => ({ header: { appSessionId: id, engineSessionId: `engine-${id}`, protocolVersion: PROTOCOL_VERSION, appVersion: 'test', guardVersion: 1, writtenAt: 0 }, frames: [] })
  await act(async () => { old.resolve(cache('old')) })
  await act(async () => { newer.resolve(cache('new')) })
  expect(app.selected()[0]).toContain('Session new,')
  expect(app.tabs()).toHaveLength(2)
})

test('composer management and account-health action focus the same Accounts tab', async () => {
  const app = await mountApp([sessionDescriptor('a')])
  const account = {
    id: 'synthetic-account', credentialGeneration: 0, alias: 'Synthetic', status: 'healthy' as const,
    statusReason: null, availability: 'available' as const, availabilityLabel: 'Ready', isDefault: true,
    hasVaultProfile: true, source: 'vault' as const, usagePrimary: null, usageWeekly: null,
    usageLimitReached: false, usageResetAt: null, lastRefreshIso: null, lastError: null, planType: null, switchable: true,
  }
  const pool = { accounts: [account], signedOutProfiles: [], activeAccountId: account.id, readyCount: 1, poolCount: 1, initialized: true,
    anthropicAccounts: [], anthropicActiveAccountId: null, anthropicReadyCount: 0, anthropicPoolCount: 0, anthropicInitialized: true, anthropicRouteAvailable: true }
  await app.host({ type: 'accounts-pool', pool })
  await app.frames({ kind: 'run-controls.snapshot', protocolVersion: PROTOCOL_VERSION, sessionId: 'a', runControls: {
    model: { current: 'gpt-5.6-terra', currentLabel: 'GPT-5.6 Terra', contextWindow: 372000, selected: 'gpt-5.6-terra', provider: 'openai', providerSwitchLocked: false, options: [] },
    effort: { current: 'low', selected: 'low', supported: true, options: ['low'] },
    fast: { active: false, supportedByModel: false, available: false, unavailableReason: null },
    autoCompact: { enabled: true, threshold: null, warningThreshold: null },
  } })
  await app.frames({ kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: 'a', event: { type: 'message', message: { type: 'assistant', uuid: 'synthetic-reply', message: { role: 'assistant', content: [{ type: 'text', text: 'Conversation ready' }] } } } } as ServerFrame)
  window.catcode.refreshAccountsPool = () => {}
  await app.click('Accounts')
  await app.key('1')
  await app.click('Active account: Synthetic · Ready')
  await app.click('Manage accounts →')
  expect(app.selected()).toEqual(['Accounts page'])
  expect(app.tabs()).toHaveLength(2)
  await app.key('1')
  await app.host({ type: 'accounts-pool', pool: { ...pool, readyCount: 0, accounts: [{ ...account, status: 'dead', availability: 'blocked', availabilityLabel: 'Needs sign-in', switchable: false }] } })
  await app.click('Open Accounts')
  expect(app.selected()).toEqual(['Accounts page'])
  expect(app.tabs()).toHaveLength(2)
  expect(app.lifecycle).toEqual([])
})
