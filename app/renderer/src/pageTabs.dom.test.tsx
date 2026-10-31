import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { StrictMode, act } from 'react'
import { collectRetainedUsage } from '../../../src/utils/statsUsage.js'
import { App } from './App.js'
import { disposeFilePaneSession, getFilePaneSession, registerFilePaneScroll, requestOpenFile } from './filePaneState.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { sessionDescriptor as fixture } from './sessionDescriptorFixture.js'
import type { HostEvent, SessionDescriptor, SwitchWorkspaceBranchResult } from '../../shared/hostApi.js'
import { PROTOCOL_VERSION, type CatCodeBridge, type ServerFrame, type TranscriptCache, type SessionCatalogEntry } from '../../shared/protocol.js'
import type { NotificationVisibility, NotificationVisibilityBridge } from '../../shared/notificationVisibility.js'

let harness: DomTestHarness
let previousBridge: CatCodeBridge
const previewSessions = new Set<string>()
beforeAll(async () => { harness = await createDomTestHarness(); previousBridge = window.catcode })
afterEach(async () => { await harness.unmountAll(); for (const id of previewSessions) disposeFilePaneSession(id); previewSessions.clear(); window.catcode = previousBridge })
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

async function mountApp(sessions: SessionDescriptor[] = [], strict = false) {
  window.localStorage.clear()
  let hostListener: (event: HostEvent) => void = () => {}
  let frameListener: (frames: ServerFrame[]) => void = () => {}
  const lifecycle: string[] = []
  const visible: string[][] = []
  const notificationVisibility: NotificationVisibility[] = []
  const inventoryCwds: (string | null)[] = []
  const usageRefreshes: string[] = []
  const bridge: Partial<CatCodeBridge> & NotificationVisibilityBridge = {
    subscribe: listener => { frameListener = listener; return () => {} },
    subscribeHost: listener => { hostListener = listener; return () => {} },
    listSessions: async () => sessions, readProjectRoutes: async () => [], readSessionsCatalog: async () => null,
    rendererReady: () => {}, recordRenderCommit: () => {},
    refreshUsageDashboard: () => { usageRefreshes.push('refresh') },
    reportVisibleSessions: ids => { visible.push([...ids]) },
    reportNotificationVisibility: value => { notificationVisibility.push(value) },
    previewSession: async () => null,
    listWorkspaceBranches: async () => ({ ok: true, value: { current: null, branches: [], dirty: false } }),
    readSettingsInventory: async cwd => { inventoryCwds.push(cwd); return { ok: true, inventory: { cwd: cwd ?? '/synthetic-home', extensions: { mcp: [], plugins: [], skills: [], hooks: [] }, agents: { definitions: [], failedFiles: [], availableMcpServers: [] }, settings: null, memory: null } } },
    closeSession: async id => { lifecycle.push(`close:${id}`); return { ok: true, value: undefined } },
    restoreSession: async id => { lifecycle.push(`restore:${id}`); return { ok: true, value: sessionDescriptor(id) } },
    createManagedChat: async () => {
      lifecycle.push('create')
      const session = sessionDescriptor('created')
      hostListener({ type: 'session-added', session })
      return { ok: true, value: session }
    },
  }
  window.catcode = bridge as CatCodeBridge
  const tree = await harness.mount(strict ? <StrictMode><App /></StrictMode> : <App />)
  const host = async (event: HostEvent) => { await act(async () => { hostListener(event) }) }
  const frames = async (...frames: ServerFrame[]) => { await act(async () => { frameListener(frames) }) }
  await host({ type: 'accounts-pool', pool: { accounts: [], signedOutProfiles: [], activeAccountId: null, readyCount: 0, poolCount: 0, initialized: true, anthropicAccounts: [], anthropicActiveAccountId: null, anthropicReadyCount: 0, anthropicPoolCount: 0, anthropicInitialized: true, anthropicRouteAvailable: true } })
  await frames(...sessions.filter(s => !s.restorable && s.status === 'ready').map(s => ready(s.appSessionId)))
  const click = async (label: string, scope: ParentNode = tree.container) => {
    const element = [...scope.querySelectorAll<HTMLElement>('button,[role="tab"],[role="option"],[role="button"]')].find(el => el.getAttribute('aria-label') === label || el.textContent?.trim() === label || el.getAttribute('title') === label)
    if (!element) throw new Error(`missing ${label}`)
    await act(async () => {
      element.click()
    })
  }
  const key = async (key: string) => { await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true })) }) }
  const tabs = () => [...tree.container.querySelectorAll<HTMLElement>('[role="tab"]')]
  const selected = () => tabs().filter(t => t.getAttribute('aria-selected') === 'true').map(t => t.getAttribute('aria-label'))
  return { tree, host, frames, click, key, tabs, selected, lifecycle, visible, notificationVisibility, inventoryCwds, usageRefreshes }
}

test('notification attention follows only the rendered transcript, never page tabs or startup gates', async () => {
  const app = await mountApp([sessionDescriptor('a'), sessionDescriptor('b')])
  expect(app.notificationVisibility.at(-1)?.sessionId).toBe('a')
  await app.click('Session b, live')
  expect(app.notificationVisibility.at(-1)?.sessionId).toBe('b')
  for (const page of ['Settings', 'Analytics', 'Accounts', 'Goals']) {
    await app.click(page)
    expect(app.notificationVisibility.at(-1)?.sessionId).toBeNull()
  }
  await app.click('Session a, live')
  expect(app.notificationVisibility.at(-1)?.sessionId).toBe('a')
  await app.frames({
    kind: 'workspace-trust.snapshot', protocolVersion: PROTOCOL_VERSION, sessionId: 'a',
    workspaceTrust: { trusted: false, trustRoot: '/tmp/a', detectedRepo: null },
  })
  expect(app.notificationVisibility.at(-1)?.sessionId).toBeNull()
})

test('a peer-opened tab is marked until opened, and again when a peer reopens it after the user closed it', async () => {
  const app = await mountApp([sessionDescriptor('a')])
  const peerTab = () => app.tabs().find(tab => tab.getAttribute('aria-label')?.startsWith('Session p,'))
  const titleClass = () => peerTab()?.querySelector('.truncate')?.className
  const peer = sessionDescriptor('p', { createdBy: 'a', peerOpenedAt: 100 })

  await app.host({ type: 'session-added', session: peer })
  await app.frames(ready('p'))
  expect(peerTab()?.getAttribute('aria-label')).toContain('not opened yet')
  expect(titleClass()).toContain('text-accent')

  // Viewing it is what clears the mark, and looking away does not bring it back.
  await app.click('Session p, live, not opened yet')
  expect(peerTab()?.getAttribute('aria-label')).not.toContain('not opened yet')
  await app.click('Session a, live')
  expect(titleClass()).not.toContain('text-accent')

  await app.click('Close session p')
  await app.host({ type: 'session-status', session: { ...peer, status: 'exited', restorable: true } })
  expect(peerTab()).toBeUndefined()

  await app.host({ type: 'session-status', session: { ...peer, peerOpenedAt: 200, status: 'spawning', lastAttachedAt: 2 } })
  await app.host({ type: 'session-status', session: { ...peer, peerOpenedAt: 200, lastAttachedAt: 2 } })
  await app.frames(ready('p'))
  expect(peerTab()?.getAttribute('aria-label')).toContain('not opened yet')
  expect(titleClass()).toContain('text-accent')
  expect(app.tree.container.textContent).not.toContain('Stop not confirmed')
  expect(app.selected()).toEqual(['Session a, live'])
})

test('Analytics activation requests one collection per App document, including with retained results', async () => {
  const app = await mountApp()
  expect(app.usageRefreshes).toEqual([])
  const snapshot = await collectRetainedUsage([], '2026-10-15T00:00:00.000Z')
  await app.host({ type: 'usage-dashboard', result: { type: 'usage', version: 1, snapshot } })
  await app.click('Analytics')
  expect(app.usageRefreshes).toHaveLength(1)
  await app.click('Refresh analytics')
  expect(app.usageRefreshes).toHaveLength(2)
  await app.click('Goals')
  await app.click('Analytics')
  expect(app.usageRefreshes).toHaveLength(2)
  await harness.unmountAll()
  const newWindow = await mountApp()
  await newWindow.host({ type: 'usage-dashboard', result: { type: 'usage', version: 1, snapshot } })
  await newWindow.click('Analytics')
  expect(newWindow.usageRefreshes).toHaveLength(1)
})

test('StrictMode replay does not send a second Analytics activation', async () => {
  const app = await mountApp([], true)
  await app.click('Analytics')
  expect(app.usageRefreshes).toHaveLength(1)
})

test('all sidebar pages share a unique strip and closing pages returns to the chat', async () => {
  const app = await mountApp()
  for (const title of ['Goals', 'Accounts', 'Analytics', 'Settings']) {
    await app.click(title)
    expect(app.selected()).toEqual([`${title} page`])
    expect(app.tree.container.querySelector('main')?.textContent).toContain(title)
  }
  await app.click('Goals')
  expect(app.tabs().map(t => t.getAttribute('aria-label'))).toEqual(['Session created, live', 'Goals page', 'Accounts page', 'Analytics page', 'Settings page'])
  await app.click('Close Analytics page')
  expect(app.selected()).toEqual(['Goals page'])
  const close = app.tree.container.querySelector<HTMLElement>('[aria-label="Close Goals page"]')!
  await act(async () => {
    close.focus()
    close.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', metaKey: true, bubbles: true }))
  })
  expect(app.tabs()).toHaveLength(3)
  await app.click('Close Accounts page')
  await app.click('Close Settings page')
  expect(app.tabs()).toHaveLength(1)
  expect(app.tree.container.querySelector('[aria-label="Prompt"]')).not.toBeNull()
  expect(app.lifecycle).toEqual(['create'])
})

test('Settings owns Cmd K for search without opening the shell command palette', async () => {
  const app = await mountApp()
  await app.click('Settings')
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))
  })
  expect(app.tree.container.querySelector('[aria-label="Command palette"]')).toBeNull()
  expect(document.activeElement?.getAttribute('placeholder')).toBe('Search all settings')
})

test('bulk export retains a completed leg while another session renders and rename replaces the latest result', async () => {
  const app = await mountApp([sessionDescriptor('a', { cwd: '/tmp/shared' }), sessionDescriptor('b', { cwd: '/tmp/shared' })])
  await app.host({ type: 'sessions-catalog', catalog: { capturedAtMs: 1, truncated: false, entries: [] } })
  const requests: Array<{ sessionId: string; requestId: string }> = []
  const saved: string[] = []
  window.catcode.sessionActionVerb = (sessionId, verb) => {
    if (verb.type === 'session.export') requests.push({ sessionId, requestId: verb.requestId })
  }
  window.catcode.saveTextToFile = async request => { saved.push(request.text); return { ok: true, saved: true } }
  await app.frames({ kind: 'slash-catalog.snapshot', protocolVersion: PROTOCOL_VERSION, sessionId: 'a', commands: [{ name: 'resume', description: 'Open history' }] })
  await app.key('k')
  await app.click('Navigate with /resume')
  const selectionButtons = [...app.tree.container.querySelectorAll<HTMLButtonElement>('[aria-label="Select session"]')]
  expect(selectionButtons).toHaveLength(2)
  for (const button of selectionButtons) await act(async () => { button.click() })
  await app.click('Export')
  expect(requests).toHaveLength(2)
  const first = requests[0]!
  const second = requests[1]!
  await app.frames({ kind: 'session-action.result', protocolVersion: PROTOCOL_VERSION, ...first, verb: 'export', ok: true, message: 'Exported', exportText: 'first transcript' })
  expect(saved).toEqual([])
  await app.frames({ kind: 'session-action.result', protocolVersion: PROTOCOL_VERSION, sessionId: first.sessionId, requestId: 'rename-later', verb: 'rename', ok: true, message: 'Renamed' })
  await app.frames({ kind: 'session-action.result', protocolVersion: PROTOCOL_VERSION, ...second, verb: 'export', ok: true, message: 'Exported', exportText: 'second transcript' })
  expect(saved).toHaveLength(1)
  expect(saved[0]).toContain('first transcript')
  expect(saved[0]).toContain('second transcript')
})

test('pending single export fails after engine exit while an already-rendered export remains readable', async () => {
  const app = await mountApp([sessionDescriptor('a')])
  let requestId = ''
  window.catcode.sessionActionVerb = (_sessionId, verb) => { requestId = verb.requestId }
  await app.host({ type: 'sessions-catalog', catalog: { capturedAtMs: 1, truncated: false, entries: [] } })
  await app.frames({ kind: 'slash-catalog.snapshot', protocolVersion: PROTOCOL_VERSION, sessionId: 'a', commands: [{ name: 'resume', description: 'Open history' }] })
  await app.key('k')
  await app.click('Navigate with /resume')
  await app.click('Session actions')
  await app.click('Export…')
  expect(requestId).not.toBe('')
  await app.frames({ kind: 'lifecycle', protocolVersion: PROTOCOL_VERSION, sessionId: 'a', status: 'exited' })
  expect(app.tree.container.textContent).not.toContain('Rendering this session, one moment.')
  expect(app.tree.container.textContent).toContain('The session ended before its transcript could be exported.')
  await app.click('Close dialog')
  await app.frames(ready('a'))
  await app.click('Session actions')
  await app.click('Export…')
  await app.frames({ kind: 'session-action.result', protocolVersion: PROTOCOL_VERSION, sessionId: 'a', requestId, verb: 'export', ok: true, message: 'Exported', exportText: 'completed export' })
  await app.frames({ kind: 'lifecycle', protocolVersion: PROTOCOL_VERSION, sessionId: 'a', status: 'exited' })
  expect(app.tree.container.textContent).toContain('completed export')
  expect(app.tree.container.textContent).not.toContain('The session ended before its transcript could be exported.')
})

test('a delayed Edit reply preserves typing added while the message action was pending', async () => {
  const app = await mountApp([sessionDescriptor('a')])
  let requestId = ''
  window.catcode.sessionActionVerb = (_sessionId, verb) => { requestId = verb.requestId }
  await app.frames({ kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: 'a', event: { type: 'message', message: { type: 'user', uuid: '00000000-0000-4000-8000-000000000001', message: { role: 'user', content: 'original sent prompt' } } } } as ServerFrame)
  await app.click('Edit from here')
  const composer = app.tree.container.querySelector<HTMLElement>('[role="textbox"]')!
  await act(async () => {
    composer.textContent = 'new unsent thought'
    composer.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await app.frames({ kind: 'session-action.result', protocolVersion: PROTOCOL_VERSION, sessionId: 'a', requestId, verb: 'editFromMessage', ok: true, message: 'Edited', selectedPrompt: { content: 'original sent prompt' } })
  expect(app.tree.container.querySelector<HTMLElement>('[role="textbox"]')?.textContent).toBe('original sent prompt\nnew unsent thought')
})

test('App keeps question progress through a page visit and clears it when the request resolves', async () => {
  const app = await mountApp([sessionDescriptor('a')])
  const request = { requestId: 'ask-progress', request: { subtype: 'can_use_tool' as const, tool_name: 'AskUserQuestion', tool_use_id: 'ask-tool', input: { questions: [
    { header: 'Library', question: 'Which library?', options: [{ label: 'Bun', description: '' }, { label: 'Node', description: '' }] },
    { header: 'Runtime', question: 'Which runtime?', options: [{ label: 'Local', description: '' }, { label: 'Remote', description: '' }] },
  ] } } }
  await app.frames({ kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: 'a', event: { type: 'permission.requested', request } })
  await act(async () => { app.tree.container.querySelector<HTMLButtonElement>('[data-ask-option]')!.click() })
  await act(async () => {
    [...app.tree.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Next question'))!.click()
  })
  expect(app.tree.container.textContent).toContain('Which runtime?')
  await app.click('Accounts')
  await app.key('1')
  expect(app.tree.container.textContent).toContain('Which runtime?')
  expect(app.tree.container.textContent).not.toContain('Which library?')
  await app.frames({ kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: 'a', event: { type: 'permission.resolved', request, response: { behavior: 'deny', message: 'Synthetic dismissal' } } })
  await app.frames({ kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: 'a', event: { type: 'permission.requested', request } })
  expect(app.tree.container.textContent).toContain('Which library?')
})

test('released held text merges with the original draft while browsing history and survives reload', async () => {
  const app = await mountApp([sessionDescriptor('a', { status: 'spawning' })])
  let submissions = 0
  window.catcode.submit = () => { submissions += 1 }
  const composer = () => app.tree.container.querySelector<HTMLElement>('[role="textbox"]')!
  const type = async (text: string) => {
    await act(async () => {
      composer().textContent = text
      composer().dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const press = async (key: string) => {
    await act(async () => {
      composer().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    })
  }
  await type('held never sent H')
  await press('Enter')
  expect(composer().textContent).toBe('')
  await type('live draft D')
  await press('ArrowUp')
  expect(composer().textContent).toBe('held never sent H')
  await app.frames({ kind: 'lifecycle', protocolVersion: PROTOCOL_VERSION, sessionId: 'a', status: 'exited' })
  expect(composer().textContent).toBe('held never sent H\nlive draft D')
  await act(async () => { window.dispatchEvent(new Event('pagehide')) })
  expect(JSON.parse(window.localStorage.getItem('catcode.promptDrafts.v1')!).drafts.a).toBe('held never sent H\nlive draft D')
  await app.tree.unmount()
  const restored = await harness.mount(<App />)
  await app.frames(ready('a'))
  expect(restored.container.querySelector<HTMLElement>('[role="textbox"]')?.textContent).toBe('held never sent H\nlive draft D')
  expect(submissions).toBe(0)
})

test.each(['refused', 'recalled'] as const)('%s text keeps the original draft while browsing history', async outcome => {
  const app = await mountApp([sessionDescriptor('a')])
  let submitId = ''
  let recallRequestId = ''
  window.catcode.submit = (_sessionId, _prompt, options) => { submitId = options?.submitId ?? '' }
  window.catcode.recallPrompts = (_sessionId, message) => { recallRequestId = message.requestId }
  const composer = () => app.tree.container.querySelector<HTMLElement>('[role="textbox"]')!
  const type = async (text: string) => {
    await act(async () => {
      composer().textContent = text
      composer().dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const press = async (key: string) => {
    await act(async () => { composer().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
  }
  await type('earlier submitted H')
  await press('Enter')
  expect(submitId).not.toBe('')
  await type('live draft D')
  await press('ArrowUp')
  expect(composer().textContent).toBe('earlier submitted H')
  let restoredText = 'earlier submitted H'
  if (outcome === 'refused') {
    await app.frames({ kind: 'submit.result', protocolVersion: PROTOCOL_VERSION, sessionId: 'a', submitId, accepted: false, code: 'session_not_found' })
  } else {
    restoredText = 'queued text Q'
    await app.frames({ kind: 'queued-prompts.snapshot', protocolVersion: PROTOCOL_VERSION, sessionId: 'a', prompts: [{ id: 'queued-q', text: restoredText }] })
    await app.click('Take back queued message')
    expect(recallRequestId).not.toBe('')
    await app.frames({ kind: 'prompt-recall.result', protocolVersion: PROTOCOL_VERSION, sessionId: 'a', requestId: recallRequestId, ok: true, message: 'Recalled', recalled: [{ id: 'queued-q', prompt: restoredText }], alreadyDelivered: 0 })
  }
  expect(composer().textContent).toBe(`${restoredText}\nlive draft D`)
  await act(async () => { window.dispatchEvent(new Event('pagehide')) })
  expect(JSON.parse(window.localStorage.getItem('catcode.promptDrafts.v1')!).drafts.a).toBe(`${restoredText}\nlive draft D`)
})

test.each(['ready', 'spawning'] as const)('unsent text survives pagehide and App remount from %s without replaying submit', async status => {
  const app = await mountApp([sessionDescriptor('a', { status })])
  const submissions: unknown[] = []
  window.catcode.submit = (_sessionId, prompt) => { submissions.push(prompt) }
  const composer = app.tree.container.querySelector<HTMLElement>('[role="textbox"]')!
  await act(async () => {
    composer.textContent = 'never sent before connection'
    composer.dispatchEvent(new Event('input', { bubbles: true }))
  })
  if (status === 'spawning') {
    await act(async () => { composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
  }
  expect(submissions).toEqual([])
  expect(app.tree.container.querySelector<HTMLElement>('[role="textbox"]')?.textContent).toBe(status === 'spawning' ? '' : 'never sent before connection')
  await act(async () => { window.dispatchEvent(new Event('pagehide')) })
  await app.tree.unmount()
  const restored = await harness.mount(<App />)
  await app.frames(ready('a'))
  expect(restored.container.querySelector<HTMLElement>('[role="textbox"]')?.textContent).toBe('never sent before connection')
  expect(submissions).toEqual([])
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

test('session close immediately selects a page neighbor, stays dismissed on refusal, and late close preserves newer selection', async () => {
  const app = await mountApp([sessionDescriptor('a')])
  await app.click('Goals')
  await app.host({ type: 'session-added', session: sessionDescriptor('b') })
  await app.frames(ready('b'))
  await app.key('3')
  const closing = deferred<Awaited<ReturnType<CatCodeBridge['closeSession']>>>()
  const closeRequests: string[] = []
  window.catcode.closeSession = async id => { closeRequests.push(id); return closing.promise }
  await app.key('w')
  expect(app.selected()).toEqual(['Goals page'])
  expect(app.tabs().some(tab => tab.getAttribute('aria-label')?.startsWith('Session b,'))).toBe(false)
  expect(app.visible.at(-1)).toEqual([])
  await act(async () => { closing.resolve({ ok: false, error: { code: 'session_unreachable', message: 'Synthetic close refusal' } }) })
  await app.host({ type: 'session-status', session: sessionDescriptor('b') })
  expect(app.selected()).toEqual(['Goals page'])
  expect(app.tabs().some(tab => tab.getAttribute('aria-label')?.startsWith('Session b,'))).toBe(false)
  const retry = deferred<Awaited<ReturnType<CatCodeBridge['closeSession']>>>()
  window.catcode.closeSession = async id => { closeRequests.push(id); return retry.promise }
  await app.click('Retry stop')
  expect(closeRequests).toEqual(['b', 'b'])
  expect(app.selected()).toEqual(['Goals page'])
  await act(async () => { retry.resolve({ ok: true, value: undefined }) })
  expect(app.selected()).toEqual(['Goals page'])
  expect(app.tabs().some(tab => tab.getAttribute('aria-label')?.startsWith('Session b,'))).toBe(false)
  const background = deferred<Awaited<ReturnType<CatCodeBridge['closeSession']>>>()
  window.catcode.closeSession = async () => background.promise
  await app.key('1')
  await app.key('w')
  expect(app.selected()).toEqual(['Goals page'])
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
  expect(app.tabs()[0]?.getAttribute('aria-label')).toContain('waiting for you')
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
  expect(app.tabs()).toHaveLength(3)
  if (operation === 'preview') {
    await app.host({ type: 'session-added', session: sessionDescriptor('dead') })
    await app.frames(ready('dead'))
    expect(app.tabs()).toHaveLength(3)
    expect(app.selected()).toEqual(['Goals page'])
    expect(app.lifecycle).toEqual(['create'])
  }
})

test('page navigation hides the pane and Settings loses removed session context', async () => {
  const app = await mountApp([sessionDescriptor('a'), sessionDescriptor('b')])
  await app.click('Settings')
  await app.click('General')
  await app.click('Project: a')
  expect(app.inventoryCwds.at(-1)).toBe('/tmp/a')
  expect(app.visible.at(-1)).toEqual([])
  await app.key('2')
  expect(app.selected()[0]).toContain('Session b,')
  expect(app.visible.at(-1)).toEqual(['b'])
  await app.click('Settings')
  await app.host({ type: 'session-removed', appSessionId: 'a' })
  await app.host({ type: 'session-removed', appSessionId: 'b' })
  expect(app.selected()).toEqual(['Settings page'])
  expect(app.inventoryCwds.at(-1)).toBeNull()
})

test('the tab bar offers no split view and session tabs are not draggable', async () => {
  const app = await mountApp([sessionDescriptor('a'), sessionDescriptor('b')])
  expect(app.selected()[0]).toContain('Session a,')
  expect(app.tree.container.querySelector('[aria-label="Split view"]')).toBeNull()
  expect(app.tree.container.querySelector('[aria-label="Unsplit"]')).toBeNull()
  expect(app.tabs().filter(tab => tab.hasAttribute('draggable'))).toEqual([])
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
  expect(app.tabs()).toHaveLength(1)
  expect(app.tree.container.querySelector('[aria-label="Prompt"]')).not.toBeNull()
  expect(app.lifecycle).toEqual(['create'])
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
  expect(app.tabs()).toHaveLength(3)
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
  const accountsMenu = document.querySelector('[role="menu"][aria-label="Accounts"]')
  expect(accountsMenu).not.toBeNull()
  await app.click('Manage accounts →', accountsMenu!)
  expect(app.selected()).toEqual(['Accounts page'])
  expect(app.tabs()).toHaveLength(2)
  await app.key('1')
  await app.host({ type: 'accounts-pool', pool: { ...pool, readyCount: 0, accounts: [{ ...account, status: 'dead', availability: 'blocked', availabilityLabel: 'Needs sign-in', switchable: false }] } })
  await app.click('Open Accounts')
  expect(app.selected()).toEqual(['Accounts page'])
  expect(app.tabs()).toHaveLength(2)
  expect(app.lifecycle).toEqual([])
})

test('a refused recalled prompt survives pagehide and renderer remount', async () => {
  const app = await mountApp([sessionDescriptor('a')])
  const submissions: Array<{ id: string; prompt: unknown }> = []
  window.catcode.submit = (_sessionId, prompt, options) => {
    submissions.push({ id: options?.submitId ?? '', prompt })
  }
  const composer = () => app.tree.container.querySelector<HTMLElement>('[role="textbox"]')!
  await act(async () => {
    composer().textContent = 'previously sent prompt'
    composer().dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { composer().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
  expect(submissions).toHaveLength(1)
  expect(composer().textContent).toBe('')
  await act(async () => { composer().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })) })
  expect(composer().textContent).toBe('previously sent prompt')
  await act(async () => { composer().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
  expect(submissions).toHaveLength(2)
  await app.frames({ kind: 'submit.result', protocolVersion: PROTOCOL_VERSION, sessionId: 'a', submitId: submissions[1]!.id, accepted: false, code: 'session_not_found' })
  expect(composer().textContent).toBe('previously sent prompt')
  await act(async () => { window.dispatchEvent(new Event('pagehide')) })
  const saved = JSON.parse(window.localStorage.getItem('catcode.promptDrafts.v1')!)
  expect(saved.drafts.a).toBe('previously sent prompt')
  await app.tree.unmount()
  const restored = await harness.mount(<App />)
  await app.frames(ready('a'))
  expect(restored.container.querySelector<HTMLElement>('[role="textbox"]')?.textContent).toBe('previously sent prompt')
})

async function branchDraft() {
  const app = await mountApp([sessionDescriptor('a'), sessionDescriptor('b')])
  await app.key('1')
  window.catcode.listWorkspaceBranches = async () => ({
    ok: true, value: { current: 'main', branches: ['main', 'topic'], dirty: false },
  })
  const composer = () => app.tree.container.querySelector<HTMLElement>('[role="textbox"]')!
  await act(async () => {
    composer().textContent = 'unsent draft '
    composer().dispatchEvent(new Event('input', { bubbles: true }))
  })
  const pasted = 'large pasted block\n'.repeat(60)
  await act(async () => {
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { files: [], getData: () => pasted } })
    composer().dispatchEvent(event)
  })
  window.catcode.pickAttachmentFile = async () => ({ kind: 'file', name: 'notes.txt', token: 'opaque-original-token' })
  await app.click('Add attachment')
  window.catcode.pickAttachmentFile = async () => ({
    kind: 'image', name: 'sketch.png', mediaType: 'image/png', bytes: new Uint8Array([104, 105]),
  })
  await app.click('Add attachment')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  expect(app.tree.container.querySelector('[aria-label="Remove pasted text 1"]')).not.toBeNull()
  expect(app.tree.container.textContent).toContain('notes.txt')
  expect(app.tree.container.querySelector('img[src="data:image/png;base64,aGk="]')).not.toBeNull()
  const pending = deferred<SwitchWorkspaceBranchResult>()
  const calls: string[][] = []
  window.catcode.switchWorkspaceBranch = (id, branch) => { calls.push([id, branch]); return pending.promise }
  const picker = app.tree.container.querySelector<HTMLButtonElement>('button[aria-label^="Choose Git branch"]')
  if (!picker) throw new Error('missing branch picker')
  await act(async () => { picker.click() })
  await app.click('topic')
  expect(calls).toEqual([['a', 'topic']])
  expect(app.tree.container.querySelector('form[aria-label="Composer"]')?.getAttribute('aria-busy')).toBe('true')
  const pendingPicker = app.tree.container.querySelector<HTMLButtonElement>('button[aria-label^="Choose Git branch"]')!
  expect(pendingPicker.textContent).toContain('topic')
  expect(pendingPicker.textContent).not.toContain('!')
  return { ...app, pending, pasted, composer }
}

test('branch handoff carries draft, paste IDs, unchanged image and file token in the same tab slot', async () => {
  const app = await branchDraft()
  await app.click('Goals')
  await app.host({ type: 'session-added', session: sessionDescriptor('replacement') })
  await app.host({ type: 'session-removed', appSessionId: 'a' })
  expect(app.tabs().map(tab => tab.getAttribute('aria-label'))).toEqual(['Session a, live', 'Session b, live', 'Goals page', 'Session replacement, live'])
  await act(async () => { app.pending.resolve({ ok: true, value: sessionDescriptor('replacement') }) })
  expect(app.tabs().map(tab => tab.getAttribute('aria-label'))).toEqual(['Session replacement, live', 'Session b, live', 'Goals page'])
  expect(app.selected()).toEqual(['Goals page'])
  await app.key('1')
  await app.frames(ready('replacement'))
  expect(app.composer().textContent).toContain('unsent draft ')
  expect(app.tree.container.querySelector('[aria-label="Remove pasted text 1"]')).not.toBeNull()
  expect(app.tree.container.querySelector('img[src="data:image/png;base64,aGk="]')).not.toBeNull()
  const submissions: unknown[][] = []
  window.catcode.submit = (...args) => { submissions.push(args) }
  await act(async () => { app.composer().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
  expect(JSON.stringify(submissions)).toContain('opaque-original-token')
  expect(JSON.stringify(submissions)).toContain('aGk=')
  expect(JSON.stringify(submissions)).toContain('large pasted block')
})

for (const branchChanged of [false, true]) {
  test(`failed branch handoff preserves source draft and all attachments (branchChanged=${branchChanged})`, async () => {
    const app = await branchDraft()
    if (branchChanged) {
      window.catcode.listWorkspaceBranches = async () => ({
        ok: true, value: { current: 'topic', branches: ['topic', 'main'], dirty: false },
      })
    }
    await act(async () => {
      app.pending.resolve({
        ok: false, ...(branchChanged ? { branchChanged: true as const } : {}),
        error: { code: 'spawn_failed', message: 'Synthetic handoff failed' },
      })
    })
    expect(app.selected()).toEqual(['Session a, live'])
    expect(app.composer().textContent).toContain('unsent draft ')
    expect(app.tree.container.querySelector('[aria-label="Remove pasted text 1"]')).not.toBeNull()
    expect(app.tree.container.textContent).toContain('notes.txt')
    expect(app.tree.container.querySelector('img[src="data:image/png;base64,aGk="]')).not.toBeNull()
    expect(app.tree.container.textContent).toContain('Synthetic handoff failed')
    expect(app.tree.container.querySelector('button[aria-label^="Choose Git branch"]')?.getAttribute('aria-label')).toContain(`Current branch: ${branchChanged ? 'topic' : 'main'}`)
    const submissions: unknown[][] = []
    window.catcode.submit = (...args) => { submissions.push(args) }
    await act(async () => { app.composer().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    expect(JSON.stringify(submissions)).toContain('opaque-original-token')
    expect(JSON.stringify(submissions)).toContain('aGk=')
    expect(JSON.stringify(submissions)).toContain('large pasted block')
  })
}

test('a cold cached conversation shows its mismatch through the read-only path without restoring an engine', async () => {
  const dead = sessionDescriptor('dead', { status: 'exited', restorable: true })
  const app = await mountApp([dead])
  const reads: unknown[][] = []
  window.catcode.listWorkspaceBranches = async (id: string, purpose?: 'readout') => {
    reads.push([id, purpose])
    return { ok: true, value: { current: 'external', recordedBranch: 'recorded', branches: [], dirty: false } }
  }
  window.catcode.previewSession = async () => ({
    header: { appSessionId: 'dead', engineSessionId: 'engine-dead', protocolVersion: PROTOCOL_VERSION, appVersion: 'test', guardVersion: 1, writtenAt: 0 },
    frames: [{
      kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: 'dead',
      event: { type: 'message', message: { type: 'assistant', uuid: 'cached-message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'A conversation from before restart' }] } } },
    }] as ServerFrame[],
  })
  await app.click('Pin sidebar open')
  await act(async () => {
    for (const header of app.tree.container.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"][aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"]')) header.click()
  })
  const row = [...app.tree.container.querySelectorAll<HTMLElement>('[role="button"]')].find(element => element.getAttribute('aria-label')?.includes('dead'))!
  expect(row !== undefined).toBe(true)
  await act(async () => row.click())
  expect(app.tree.container.textContent).toContain('A conversation from before restart')
  expect(app.tree.container.querySelector('.workspace-branch-changed')?.getAttribute('aria-label')).toBe('Checkout is on external. This chat was on recorded.')
  expect(reads).toEqual([['dead', 'readout']])
  expect(app.lifecycle).toEqual(['create'])
})


async function openAppFilePreview(sessionId: string) {
  previewSessions.add(sessionId)
  const releases: string[] = []
  const path = `/tmp/${sessionId}/notes.md`
  const descriptor = { id: `file-preview-${sessionId}`, appSessionId: sessionId, path, displayPath: path,
    kind: 'markdown' as const, url: `cat-preview://file-preview-${sessionId}/r1${path}`, revision: 1, markdown: '# Retained notes' }
  window.catcode.prepareFilePreview = async () => descriptor
  window.catcode.refreshFilePreview = async () => null
  window.catcode.commitFilePreview = async () => true
  window.catcode.releaseFilePreview = id => { releases.push(id) }
  window.catcode.subscribeFilePreview = () => () => {}
  window.catcode.getFilePreviewApplications = async () => ({ applications: [{ target: 'default', label: 'Default application' }], selected: 'default' })
  await act(async () => { expect((await requestOpenFile(sessionId, path)).ok).toBe(true) })
  await act(async () => { await harness.nextFrame(); await harness.nextFrame() })
  return { releases, descriptor }
}

test('confirmed session closure releases pane resources while a refused close preserves them', async () => {
  const app = await mountApp([sessionDescriptor('a'), sessionDescriptor('b')])
  const { releases, descriptor } = await openAppFilePreview('a')
  const pending = deferred<Awaited<ReturnType<CatCodeBridge['closeSession']>>>()
  window.catcode.closeSession = async () => pending.promise
  await app.key('w')
  expect(getFilePaneSession('a').lastPath).toBe(descriptor.path)
  expect(releases).toEqual([])
  await act(async () => { pending.resolve({ ok: false, error: { code: 'session_unreachable', message: 'Synthetic close refusal' } }) })
  expect(getFilePaneSession('a').lastPath).toBe(descriptor.path)
  const retry = deferred<Awaited<ReturnType<CatCodeBridge['closeSession']>>>()
  window.catcode.closeSession = async () => retry.promise
  await app.click('Retry stop')
  await act(async () => { retry.resolve({ ok: true, value: undefined }) })
  expect(releases).toEqual([descriptor.id])
  expect(getFilePaneSession('a')).toMatchObject({ open: false, file: null, committedFile: null, lastPath: null, worker: null, output: null })
})

test('actual session removal releases pane resources without treating an ordinary switch as closure', async () => {
  const app = await mountApp([sessionDescriptor('a'), sessionDescriptor('b')])
  const { releases, descriptor } = await openAppFilePreview('a')
  await app.click('Session b, live')
  expect(releases).toEqual([])
  expect(getFilePaneSession('a').lastPath).toBe(descriptor.path)
  await app.host({ type: 'session-removed', appSessionId: 'a' })
  expect(releases).toEqual([descriptor.id])
  expect(getFilePaneSession('a').lastPath).toBeNull()
})

test('sidebar preview selection captures the departing pane before unmounting its page', async () => {
  const app = await mountApp([sessionDescriptor('a'), sessionDescriptor('dead', { status: 'exited', restorable: true })])
  await openAppFilePreview('a')
  const scroll = deferred<{ x: number; y: number }>()
  const stopReading = registerFilePaneScroll('a', () => scroll.promise)
  window.catcode.previewSession = async () => ({ header: { appSessionId: 'dead', engineSessionId: 'engine-dead', protocolVersion: PROTOCOL_VERSION,
    appVersion: 'test', guardVersion: 1, writtenAt: 0 }, frames: [] })
  await app.click('Pin sidebar open')
  await act(async () => {
    for (const header of app.tree.container.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"][aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"]')) header.click()
  })
  const row = [...app.tree.container.querySelectorAll<HTMLElement>('[role="button"]')].find(element => element.getAttribute('aria-label')?.startsWith('session dead,'))!
  expect(row).toBeDefined()
  await act(async () => { row.click() })
  expect(app.selected()).toEqual(['Session a, live'])
  await act(async () => { scroll.resolve({ x: 7, y: 191 }) })
  expect(app.selected()[0]).toContain('Session dead,')
  expect(getFilePaneSession('a').scroll).toEqual({ x: 7, y: 191 })
  stopReading()
})

test('App forwards unhandled document web links through the closed host method without consuming pane, text, or frame clicks', async () => {
  const app = await mountApp([sessionDescriptor('a')], true)
  const opened: string[] = []
  window.catcode.openExternalUrl = async url => { opened.push(url); return true }
  const happy = window as unknown as { happyDOM: { settings: { navigation: { disableMainFrameNavigation: boolean; disableChildFrameNavigation: boolean; disableChildPageNavigation: boolean; disableFallbackToSetURL: boolean } } } }
  const navigation = happy.happyDOM.settings.navigation
  const original = { ...navigation }
  Object.assign(navigation, { disableMainFrameNavigation: true, disableChildFrameNavigation: true, disableChildPageNavigation: true, disableFallbackToSetURL: true })
  const fixture = document.createElement('div')
  app.tree.container.appendChild(fixture)
  try {
    await app.frames({ kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: 'a', event: { type: 'message', message: {
      type: 'assistant', uuid: 'external-link-reply', message: { role: 'assistant', content: [{ type: 'text', text: '[**Docs**](https://example.com/guide) [Local](http://localhost:4000/)' }] },
    } } } as ServerFrame)
    const link = app.tree.container.querySelector<HTMLAnchorElement>('a[href="https://example.com/guide"]')!
    expect(link).not.toBeNull()
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    await act(async () => { link.querySelector('strong')!.dispatchEvent(click) })
    expect(click.defaultPrevented).toBe(true)
    expect(opened).toEqual(['https://example.com/guide'])
    await act(async () => { link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true })) })
    expect(opened).toEqual(['https://example.com/guide', 'https://example.com/guide'])
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    await act(async () => { link.dispatchEvent(menu) })
    expect(menu.defaultPrevented).toBe(false)
    const selection = document.createRange()
    selection.selectNodeContents(link)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(selection)
    expect(window.getSelection()!.toString()).toBe('Docs')
    await act(async () => { link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    expect(opened).toHaveLength(2)
    window.getSelection()!.removeAllRanges()

    const localRequests: string[] = []
    const chosenApps: string[] = []
    window.catcode.prepareLocalhostPreview = async (_id, url) => {
      localRequests.push(url)
      return { ok: false, reason: 'unavailable', hostPort: 'localhost:4000' }
    }
    window.catcode.getFilePreviewApplications = async () => ({ applications: [{ target: 'chrome', label: 'Google Chrome' }], selected: 'chrome' })
    window.catcode.chooseFilePreviewApplication = async (_id, url, target) => { chosenApps.push(`${target}:${url}`); return true }
    const localButton = app.tree.container.querySelector<HTMLButtonElement>('button[aria-label="Open http://localhost:4000/"]')!
    expect(localButton).not.toBeNull()
    await act(async () => { localButton.click() })
    await act(async () => { localButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true })) })
    expect(localRequests).toEqual(['http://localhost:4000/'])
    expect(chosenApps).toEqual(['chrome:http://localhost:4000/'])
    expect(opened).toHaveLength(2)

    const handled = document.createElement('a')
    handled.href = 'http://localhost:4000/handled'
    handled.textContent = 'Handled by a pane controller'
    handled.addEventListener('click', event => event.preventDefault())
    fixture.appendChild(handled)
    await act(async () => { handled.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    expect(opened).toHaveLength(2)
    for (const href of ['#section', './local-file.md', 'file:///tmp/notes.md']) {
      const local = document.createElement('a')
      local.href = href
      fixture.appendChild(local)
      await act(async () => { local.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    }
    expect(opened).toHaveLength(2)

    const frame = document.createElement('iframe')
    fixture.appendChild(frame)
    const frameDocument = frame.contentDocument!
    expect(frameDocument).not.toBeNull()
    const frameLink = frameDocument.createElement('a')
    frameLink.href = 'https://example.com/from-iframe'
    const frameText = frameDocument.createElement('span')
    frameText.textContent = 'Untrusted frame link'
    frameLink.appendChild(frameText)
    frameDocument.body.appendChild(frameLink)
    const frameClick = new MouseEvent('click', { bubbles: true, cancelable: true })
    await act(async () => { frameText.dispatchEvent(frameClick) })
    expect(frameClick.defaultPrevented).toBe(false)
    expect(opened).toHaveLength(2)
    await act(async () => { link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    const middleClick = new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true })
    await act(async () => { link.dispatchEvent(middleClick) })
    expect(middleClick.defaultPrevented).toBe(true)
    expect(opened).toEqual(['https://example.com/guide', 'https://example.com/guide', 'https://example.com/guide', 'https://example.com/guide'])
    await app.tree.unmount()
    const afterUnmount = document.createElement('a')
    afterUnmount.href = 'https://example.com/after-unmount'
    document.body.appendChild(afterUnmount)
    try { await act(async () => { afterUnmount.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) }) }
    finally { afterUnmount.remove() }
    expect(opened).toHaveLength(4)
  } finally {
    window.getSelection()?.removeAllRanges()
    fixture.remove()
    Object.assign(navigation, original)
  }
})
