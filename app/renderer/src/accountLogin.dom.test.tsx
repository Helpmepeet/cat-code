import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { App } from './App.js'
import { ToastContext } from './toastContext.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { PROTOCOL_VERSION, type CatCodeBridge, type AccountVerbMessage, type ServerFrame } from '../../shared/protocol.js'
import type { HostEvent } from '../../shared/hostApi.js'
import type { LidModeCommand, LidModeView } from '../../shared/lidClosed.js'
import { sessionDescriptor } from './sessionDescriptorFixture.js'
import { selectFocusableElements } from './overlayFocus.js'

let harness: DomTestHarness
let previous: CatCodeBridge
beforeAll(async () => { harness = await createDomTestHarness(); previous = window.catcode })
afterEach(async () => { await harness.unmountAll(); window.catcode = previous })
afterAll(async () => { await harness.teardown() })

async function mountAccountsApp(refusedVerbs: AccountVerbMessage['type'][] = [], recovery = false) {
  window.localStorage.clear()
  const calls: AccountVerbMessage[] = []
  const lifecycleCalls: string[] = []
  const toasts: string[] = []
  let hostEvent: (event: HostEvent) => void = () => {}
  let frames: (frames: ServerFrame[]) => void = () => {}
  let lidUpdate: (view: LidModeView) => void = () => {}
  const lidCommands: LidModeCommand[] = []
  const lidView: LidModeView = { phase: 'unresolved', allowance: 15, remainingSeconds: 0, installed: true, sleepRequested: false, error: 'Synthetic restoration failure' }
  const bridge: Partial<CatCodeBridge> = {
    subscribe: listener => { frames = listener; return () => {} },
    subscribeHost: listener => { hostEvent = listener; return () => {} },
    listSessions: async () => recovery ? [sessionDescriptor('recovery-chat')] : [],
    readProjectRoutes: async () => [],
    readSessionsCatalog: async () => null,
    rendererReady: () => {}, recordRenderCommit: () => {}, reportVisibleSessions: () => {},
    refreshUsageDashboard: () => {},
    ...(recovery ? { lidClosed: {
      read: async () => lidView,
      subscribe: (listener: (view: LidModeView) => void) => { lidUpdate = listener; return () => {} },
      command: async (command: LidModeCommand) => { lidCommands.push(command); return lidView },
    } } : {}),
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
  return { calls, lifecycleCalls, toasts, tree, click, pool, hostEvent: (event: HostEvent) => hostEvent(event),
    frames: (values: ServerFrame[]) => frames(values), lidCommands,
    lidUpdate: (view: Partial<LidModeView>) => lidUpdate({ ...lidView, ...view }) }
}

test.each(['trust', 'first-run', 'add-account', 'orphan'] as const)(
  'machine-wide recovery warning and Retry survive %s and page navigation',
  async surface => {
    const app = await mountAccountsApp([], true)
    if (surface === 'trust') {
      await act(async () => {
        app.frames([{ kind: 'workspace-trust.snapshot', protocolVersion: PROTOCOL_VERSION, sessionId: 'recovery-chat',
          workspaceTrust: { trusted: false, trustRoot: '/tmp/recovery-chat', detectedRepo: null } }])
      })
    } else if (surface === 'add-account') {
      await app.click('Accounts')
      await app.click('+ Add account')
    } else if (surface === 'orphan') {
      await act(async () => {
        app.hostEvent({ type: 'accounts-pool', pool: { ...app.pool, anthropicRouteAvailable: true } })
        app.hostEvent({ type: 'account-oauth', provider: 'openai', progress: { state: 'waiting_for_login', url: 'https://example.test/login' } })
      })
    }
    const assertRecovery = () => {
      const notice = app.tree.container.querySelector<HTMLElement>('.lid-notice')!
      expect(notice?.textContent).toContain("Couldn't restore normal sleep")
      expect(notice?.textContent).toContain('Synthetic restoration failure')
      const retry = [...notice.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry')!
      expect(retry.disabled).toBe(false)
      expect(notice.querySelector('[aria-label="Dismiss"]')).toBeNull()
      // Absolute startup overlays are confined to the sibling below the notice,
      // not the notice's own containing block.
      const dialog = app.tree.container.querySelector('[role="dialog"]')
      if (dialog) {
        expect(notice.nextElementSibling?.contains(dialog)).toBe(true)
        expect(notice.nextElementSibling?.classList.contains('relative')).toBe(true)
      }
      return retry
    }
    expect(app.tree.container.querySelector('[role="dialog"]')?.getAttribute('aria-label'))
      .toBe(surface === 'trust' ? 'Workspace trust' : 'Sign in')
    const tab = async (shiftKey = false) => {
      await act(async () => {
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true }))
      })
    }
    const dialogControls = () => selectFocusableElements(app.tree.container.querySelector<HTMLElement>('[role="dialog"]')!)
    const retry = assertRecovery()
    let controls = dialogControls()
    await act(async () => { controls.at(-1)!.focus() })
    await tab()
    expect(document.activeElement).toBe(retry)
    await tab()
    expect(document.activeElement).toBe(controls[0])
    await tab(true)
    expect(document.activeElement).toBe(retry)
    await tab(true)
    expect(document.activeElement).toBe(controls.at(-1)!)
    // No sidebar, page-tab, or underlying account control joins the loop.
    await act(async () => { retry.focus() })
    for (const expected of [...controls, retry]) {
      await tab()
      expect(document.activeElement).toBe(expected)
    }
    await act(async () => { assertRecovery().click() })
    expect(app.lidCommands).toEqual([{ action: 'retry' }])
    await app.click('Goals')
    assertRecovery()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', metaKey: true, bubbles: true }))
    })
    assertRecovery()
    await act(async () => { app.lidUpdate({ recovering: true }) })
    expect(app.tree.container.querySelector<HTMLButtonElement>('.lid-notice button')?.disabled).toBe(true)
    controls = dialogControls()
    await act(async () => { controls.at(-1)!.focus() })
    await tab()
    expect(document.activeElement).toBe(controls[0])
    await act(async () => { app.lidUpdate({ phase: 'off', error: undefined }) })
    expect(app.tree.container.querySelector('.lid-notice')).toBeNull()
    controls = dialogControls()
    await act(async () => { controls.at(-1)!.focus() })
    await tab()
    expect(document.activeElement).toBe(controls[0])
    await tab(true)
    expect(document.activeElement).toBe(controls.at(-1)!)
  },
)

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
