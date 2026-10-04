import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { App } from './App.js'
import { ToastContext } from './toastContext.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { PROTOCOL_VERSION, type CatCodeBridge, type AccountVerbMessage } from '../../shared/protocol.js'
import type { HostEvent } from '../../shared/hostApi.js'

let harness: DomTestHarness
let previous: CatCodeBridge
beforeAll(async () => { harness = await createDomTestHarness(); previous = window.catcode })
afterEach(async () => { await harness.unmountAll(); window.catcode = previous })
afterAll(async () => { await harness.teardown() })

async function mountAccountsApp(refusedVerbs: AccountVerbMessage['type'][] = []) {
  window.localStorage.clear()
  const calls: AccountVerbMessage[] = []
  const lifecycleCalls: string[] = []
  const toasts: string[] = []
  let hostEvent: (event: HostEvent) => void = () => {}
  const bridge: Partial<CatCodeBridge> = {
    subscribe: () => () => {},
    subscribeHost: listener => { hostEvent = listener; return () => {} },
    listSessions: async () => [],
    readProjectRoutes: async () => [],
    readSessionsCatalog: async () => null,
    rendererReady: () => {}, recordRenderCommit: () => {}, reportVisibleSessions: () => {},
    manageAccount: async verb => {
      calls.push(verb)
      return { kind: 'account.result', protocolVersion: PROTOCOL_VERSION, sessionId: '', requestId: verb.requestId, verb: verb.type, ok: !refusedVerbs.includes(verb.type), message: verb.type === 'account.oauthPasteCode' ? 'That code was refused.' : verb.type === 'account.oauthAlias' ? 'That name is taken.' : 'Done' }
    },
    accountVerb: () => { throw new Error('login borrowed a session') },
    createSession: () => {
      lifecycleCalls.push('createSession')
      throw new Error('login created a chat')
    },
    closeSession: () => {
      lifecycleCalls.push('closeSession')
      throw new Error('page navigation closed a session')
    },
  }
  window.catcode = bridge as CatCodeBridge
  const tree = await harness.mount(<ToastContext.Provider value={message => toasts.push(message)}><App /></ToastContext.Provider>)
  const pool = {
    accounts: [], signedOutProfiles: [], activeAccountId: null, readyCount: 0, poolCount: 0, initialized: true,
    anthropicAccounts: [], anthropicActiveAccountId: null, anthropicReadyCount: 0, anthropicPoolCount: 0, anthropicInitialized: true, anthropicRouteAvailable: false,
  }
  await act(async () => { hostEvent({ type: 'accounts-pool', pool }) })
  const click = async (label: string) => {
    const button = [...tree.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === label || button.getAttribute('aria-label') === label || button.getAttribute('title') === label)
    if (!button) throw new Error(`missing button ${label}`)
    await act(async () => { button.click() })
  }
  return { calls, lifecycleCalls, toasts, tree, click, pool, hostEvent: (event: HostEvent) => hostEvent(event) }
}

test('sidebar pages open unique mixed tabs and page closing never calls session lifecycle', async () => {
  const { lifecycleCalls, tree, click } = await mountAccountsApp()
  await click('Goals')
  await click('Accounts')
  expect(tree.container.querySelector('main h1')?.textContent).toBe('Accounts')
  await click('Goals')
  expect(tree.container.querySelector('main h1')?.textContent).toBe('Goals')

  const pageTabs = () => [
    ...tree.container.querySelectorAll<HTMLElement>('[role="tab"][aria-label$="page"]'),
  ]
  expect(pageTabs().map(tab => tab.getAttribute('aria-label'))).toEqual([
    'Goals page',
    'Accounts page',
  ])
  expect(pageTabs().map(tab => tab.getAttribute('aria-selected'))).toEqual(['true', 'false'])
  await act(async () => {
    pageTabs()[0]?.querySelector<HTMLButtonElement>('[aria-label="Close Goals page"]')?.click()
  })
  expect(pageTabs().map(tab => tab.getAttribute('aria-label'))).toEqual(['Accounts page'])
  expect(pageTabs()[0]?.getAttribute('aria-selected')).toBe('true')
  await click('Goals')
  expect(pageTabs().map(tab => tab.getAttribute('aria-label'))).toEqual([
    'Accounts page',
    'Goals page',
  ])
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', ctrlKey: true, bubbles: true }))
  })
  expect(pageTabs().map(tab => tab.getAttribute('aria-selected'))).toEqual(['true', 'false'])
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '2', metaKey: true, bubbles: true }))
  })
  expect(pageTabs().map(tab => tab.getAttribute('aria-selected'))).toEqual(['false', 'true'])
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', metaKey: true, bubbles: true }))
  })
  expect(pageTabs().map(tab => tab.getAttribute('aria-label'))).toEqual(['Accounts page'])
  expect(pageTabs()[0]?.getAttribute('aria-selected')).toBe('true')
  await act(async () => {
    pageTabs()[0]?.querySelector<HTMLButtonElement>('[aria-label="Close Accounts page"]')?.click()
  })
  expect(pageTabs()).toHaveLength(0)
  expect(tree.container.textContent).toContain('Claude subscription')
  expect(tree.container.textContent).not.toContain('Welcome back')
  expect(lifecycleCalls).toEqual([])
})

test('first-run completion waits for global availability', async () => {
  const { tree, pool, hostEvent } = await mountAccountsApp()
  const choice = [...tree.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Claude subscription'))!
  await act(async () => { choice.click() })
  await act(async () => { hostEvent({ type: 'account-oauth', provider: 'anthropic', progress: { state: 'success' } }) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1000)) })
  expect(tree.container.textContent).toContain('Signed in')
  // A credentialed global route arrives after the independent inventory read.
  await act(async () => { hostEvent({ type: 'accounts-pool', pool: { ...pool, anthropicRouteAvailable: true } }) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1000)) })
  expect(tree.container.textContent).not.toContain('Signed in')
  expect(tree.container.querySelector('[aria-label="Sign in"]')).toBeNull()
})

test('Settings remains accessible while first-run completion waits for inventory', async () => {
  const { tree, click, hostEvent } = await mountAccountsApp()
  window.catcode.readSettingsInventory = async () => ({
    ok: true,
    inventory: {
      cwd: '/synthetic-user', extensions: { mcp: [], plugins: [], skills: [], hooks: [] },
      agents: { definitions: [], failedFiles: [], availableMcpServers: [] }, settings: null, memory: null,
    },
  })
  const choice = [...tree.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Claude subscription'))!
  await act(async () => { choice.click() })
  await act(async () => { hostEvent({ type: 'account-oauth', provider: 'anthropic', progress: { state: 'success' } }) })
  await click('Settings')
  expect(tree.container.querySelector('nav[aria-label="Settings categories"]')).not.toBeNull()
  expect(tree.container.querySelector('[aria-label="Sign in"]')).toBeNull()
})

test('Accounts starts login, cancels, and reaches naming with no open sessions', async () => {
  const { calls, toasts, tree, click, hostEvent } = await mountAccountsApp()
  await click('Accounts')
  await click('+ Add account')
  expect(calls.map(verb => verb.type)).toEqual(['account.login'])
  expect(toasts).toEqual([])
  await click('Cancel')
  expect(calls.map(verb => verb.type)).toEqual(['account.login', 'account.oauthCancel'])
  await click('+ Add account')
  await act(async () => { hostEvent({ type: 'account-oauth', provider: 'openai', progress: { state: 'waiting_for_alias' } }) })
  expect(tree.container.querySelector('input[aria-label="Account name"]')).not.toBeNull()
  expect([...tree.container.querySelectorAll('button')].some(button => button.textContent === 'Cancel')).toBe(false)
  // No tab or sidecar frame was needed to reach the account-name step.
  await click('Skip')
  expect(calls.at(-1)?.type).toBe('account.oauthAlias')
})

test.each(['anthropic', 'openai'] as const)('%s sign-in receives the host link and shows refused code and alias results inline', async provider => {
  const { calls, tree, click, hostEvent } = await mountAccountsApp(['account.oauthPasteCode', 'account.oauthAlias'])
  if (provider === 'openai') {
    await click('Accounts')
    await click('+ Add account')
  } else {
    // Exercise the first-run mount as well as the in-app modal mount.
    const choice = [...tree.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Claude subscription'))!
    await act(async () => { choice.click() })
  }
  const dialog = () => tree.container.querySelector<HTMLElement>('[role="dialog"][aria-label="Sign in"]')!
  expect(dialog().classList.contains('bg-scrim')).toBe(provider === 'openai')
  expect(dialog().querySelector<HTMLButtonElement>('button')!.disabled).toBe(true)
  expect(dialog().textContent).toContain('Preparing link')
  const url = 'https://example.test/authorize?state=synthetic'
  await act(async () => { hostEvent({ type: 'account-oauth', provider, progress: { state: 'waiting_for_login', url } }) })
  const copy = dialog().querySelector<HTMLButtonElement>('button')!
  expect(copy.disabled).toBe(false)
  expect(copy.textContent).toContain('Copy sign-in link')
  expect(document.activeElement).toBe(copy)
  expect(dialog().querySelector('a')?.getAttribute('href')).toBe(url)
  expect(dialog().textContent).not.toContain(url)
  const details = dialog().querySelector('details')
  if (provider === 'openai') {
    expect(details?.open).toBe(false)
    expect(details?.querySelector('summary')?.textContent).toContain("Approved, but the page didn't load?")
    details!.open = true
  } else {
    expect(details).toBeNull()
  }
  const code = dialog().querySelector<HTMLInputElement>('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(code, 'synthetic-code')
    code.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click('Continue')
  expect(calls.at(-1)?.type).toBe('account.oauthPasteCode')
  expect(dialog().querySelector('[role="alert"]')?.textContent).toBe('That code was refused.')
  expect(code.getAttribute('aria-invalid')).toBe('true')
  await act(async () => { hostEvent({ type: 'account-oauth', provider, progress: { state: 'waiting_for_alias' } }) })
  await click('Skip')
  expect(calls.at(-1)?.type).toBe('account.oauthAlias')
  expect(dialog().querySelector('[role="alert"]')?.textContent).toBe('That name is taken.')
  expect(dialog().querySelector('input[aria-label="Account name"]')?.getAttribute('aria-invalid')).toBe('true')
  expect([...dialog().querySelectorAll('button')].map(button => button.textContent)).toEqual(['Skip', 'Save'])
  if (provider === 'openai') {
    await click('Analytics')
    expect(dialog().classList.contains('bg-scrim')).toBe(true)
    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe('That name is taken.')
  }
})
