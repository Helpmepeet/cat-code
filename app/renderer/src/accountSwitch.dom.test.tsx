import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { App } from './App.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { sessionDescriptor } from './sessionDescriptorFixture.js'
import type { HostEvent } from '../../shared/hostApi.js'
import {
  PROTOCOL_VERSION,
  type AccountSwitchMessage,
  type AccountsSnapshot,
  type CatCodeBridge,
  type RunControlProvider,
  type ServerFrame,
  type SubmitPrompt,
} from '../../shared/protocol.js'

let harness: DomTestHarness
let previous: CatCodeBridge
beforeAll(async () => { harness = await createDomTestHarness(); previous = window.catcode })
afterEach(async () => { await harness.unmountAll(); window.catcode = previous })
afterAll(async () => { await harness.teardown() })

const pool: AccountsSnapshot = {
  accounts: ['limited', 'replacement'].map((id, index) => ({
    id, credentialGeneration: 0, alias: id, status: index === 0 ? 'capped' : 'healthy',
    statusReason: null, availability: index === 0 ? 'blocked' : 'available',
    availabilityLabel: index === 0 ? 'Limit reached' : 'Ready', isDefault: index === 0,
    hasVaultProfile: true, source: 'vault', usagePrimary: index === 0 ? 100 : 10,
    usageWeekly: 10, usageLimitReached: index === 0, usageResetAt: null,
    lastRefreshIso: null, lastError: null, planType: null, switchable: index !== 0,
  })),
  signedOutProfiles: [], activeAccountId: 'limited', readyCount: 1, poolCount: 2, initialized: true,
  anthropicAccounts: [], anthropicActiveAccountId: null, anthropicReadyCount: 0,
  anthropicPoolCount: 0, anthropicInitialized: true, anthropicRouteAvailable: true,
}

async function mountApp(provider: RunControlProvider = 'openai', status: 'ready' | 'exited' | 'none' = 'ready') {
  window.localStorage.clear()
  let host: (event: HostEvent) => void = () => {}
  let frames: (values: ServerFrame[]) => void = () => {}
  const sessionSwitches: { sessionId: string; verb: AccountSwitchMessage }[] = []
  const managed: unknown[] = []
  const submits: { sessionId: string; prompt: SubmitPrompt }[] = []
  const lifecycle: string[] = []
  const sessions = status === 'none' ? [] : [
    sessionDescriptor('limited-chat', { title: 'limited-chat', status, restorable: status === 'exited' }),
    sessionDescriptor('other-chat', { title: 'other-chat' }),
  ]
  const bridge: Partial<CatCodeBridge> = {
    subscribe: listener => { frames = listener; return () => {} },
    subscribeHost: listener => { host = listener; return () => {} },
    listSessions: async () => sessions, readProjectRoutes: async () => [], readSessionsCatalog: async () => null,
    rendererReady: () => {}, recordRenderCommit: () => {}, reportVisibleSessions: () => {},
    refreshAccountsPool: () => {},
    previewSession: async () => null,
    listWorkspaceBranches: async () => ({ ok: true, value: { current: null, branches: [], dirty: false } }),
    manageAccount: async verb => {
      managed.push(verb)
      return { kind: 'account.result', protocolVersion: PROTOCOL_VERSION, sessionId: '', requestId: verb.requestId, verb: verb.type, ok: true, message: 'Switched' }
    },
    accountVerb: (sessionId, verb) => { sessionSwitches.push({ sessionId, verb }) },
    submit: (sessionId, prompt) => { submits.push({ sessionId, prompt }) },
    closeSession: async id => { lifecycle.push(`close:${id}`); return { ok: true, value: undefined } },
    restoreSession: async id => { lifecycle.push(`restore:${id}`); return { ok: true, value: sessionDescriptor(id) } },
  }
  window.catcode = bridge as CatCodeBridge
  const tree = await harness.mount(<App />)
  const emit = async (...values: ServerFrame[]) => { await act(async () => { frames(values) }) }
  await act(async () => { host({ type: 'accounts-pool', pool }) })
  if (status === 'ready') {
    await emit(...sessions.map(session => ({
      kind: 'ready' as const, protocolVersion: PROTOCOL_VERSION, sessionId: session.appSessionId,
      engineSessionId: `engine-${session.appSessionId}`,
      payload: { type: 'app.ready' as const, protocolVersion: 1 as const, inputEnabled: true, activeTurn: false, abort: { status: 'idle' as const }, goalSnapshot: null, pendingPermissionRequests: [] },
    })), {
      kind: 'run-controls.snapshot', protocolVersion: PROTOCOL_VERSION, sessionId: 'limited-chat', runControls: {
        model: { current: 'gpt-6.1-sol', currentLabel: 'GPT-6.1 Sol', contextWindow: 372000, selected: 'gpt-6.1-sol', provider, providerSwitchLocked: true, options: [] },
        effort: { current: 'high', selected: 'high', supported: true, options: ['high'] },
        fast: { active: false, supportedByModel: false, available: false, unavailableReason: null },
        autoCompact: { enabled: true, threshold: null, warningThreshold: null },
      },
    })
  }
  const click = async (label: string) => {
    const button = [...tree.container.querySelectorAll<HTMLElement>('button,[role="tab"]')].find(item =>
      item.textContent?.trim() === label || item.getAttribute('aria-label') === label || item.getAttribute('title') === label)
    if (!button) throw new Error(`missing ${label}; tabs: ${[...tree.container.querySelectorAll('[role="tab"]')].map(tab => tab.getAttribute('aria-label')).join(', ')}`)
    await act(async () => { button.click() })
  }
  const emitPool = async (value: AccountsSnapshot) => {
    await act(async () => { host({ type: 'accounts-pool', pool: value }) })
  }
  return { tree, click, emit, emitPool, sessionSwitches, managed, submits, lifecycle }
}

test('Accounts shows the retained chat selection while keeping global inventory fresh', async () => {
  const app = await mountApp()
  await app.emit({
    kind: 'accounts.snapshot', protocolVersion: PROTOCOL_VERSION,
    sessionId: 'limited-chat',
    accounts: {
      ...pool,
      activeAccountId: 'replacement',
      accounts: pool.accounts.map(account => ({
        ...account, isDefault: account.id === 'replacement',
        status: 'healthy', availability: 'available', availabilityLabel: 'Ready',
        usageLimitReached: false, switchable: true,
      })),
    },
  })
  await app.click('Accounts')
  expect(app.tree.container.textContent).toContain('changes your current chat')
  // Global inventory still reports the old account capped, so it cannot be
  // switched to. The healthy current selection must not offer a redundant switch.
  expect([...app.tree.container.querySelectorAll('button')].filter(
    button => button.textContent?.trim() === 'Switch',
  )).toHaveLength(0)
  await app.emitPool({
    ...pool,
    accounts: pool.accounts.map(account => ({
      ...account, status: 'healthy', availability: 'available',
      availabilityLabel: 'Ready', usageLimitReached: false, switchable: !account.isDefault,
    })),
  })
  await app.click('Account actions')
  expect(app.tree.container.textContent).not.toContain('Switch to this account')
  await app.click('Sign out')
  expect(app.tree.container.querySelector('[role="dialog"]')?.textContent)
    .toContain('The default account for new chats will not change.')
  await app.click('Cancel')
  const menus = app.tree.container.querySelectorAll<HTMLButtonElement>(
    'button[aria-label="Account actions"]',
  )
  await act(async () => { menus[1]!.click() })
  await app.click('Switch to this account')
  expect(app.sessionSwitches).toEqual([{
    sessionId: 'limited-chat',
    verb: expect.objectContaining({ accountId: 'limited' }),
  }])
  expect(app.managed).toEqual([])
})

test('Accounts retains the main failover identity after lease release without an accounts refresh', async () => {
  const app = await mountApp()
  const healthyPool: AccountsSnapshot = {
    ...pool,
    accounts: pool.accounts.map(account => ({
      ...account, status: 'healthy', availability: 'available',
      availabilityLabel: 'Ready', usageLimitReached: false,
      switchable: !account.isDefault,
    })),
  }
  await app.emitPool(healthyPool)
  await app.emit({
    kind: 'accounts.snapshot', protocolVersion: PROTOCOL_VERSION,
    sessionId: 'limited-chat', accounts: healthyPool,
  }, {
    kind: 'lease.snapshot', protocolVersion: PROTOCOL_VERSION,
    sessionId: 'limited-chat',
    leases: { strategy: 'spread', accounts: [], owners: [{
      leaseId: 'main', ownerId: 'main-thread', ownerType: 'main',
      ownerLabel: 'Main', accountId: 'replacement', accountAlias: 'replacement',
      strategy: 'spread', state: 'active', createdAt: 1, updatedAt: 2,
      failoverCount: 1, selectionKind: 'failover', selectionReason: 'Account unavailable',
    }] },
  })
  await app.emit({
    kind: 'lease.snapshot', protocolVersion: PROTOCOL_VERSION,
    sessionId: 'limited-chat',
    leases: { strategy: 'spread', accounts: [], owners: [] },
  })
  await app.click('Accounts')
  const menus = app.tree.container.querySelectorAll<HTMLButtonElement>(
    'button[aria-label="Account actions"]',
  )
  expect(menus[0]!.closest('[data-window-card]')?.textContent ??
    menus[0]!.parentElement?.parentElement?.textContent).toContain('replacementactive')
  await act(async () => { menus[0]!.click() })
  expect(app.tree.container.textContent).not.toContain('Switch to this account')
  await act(async () => { menus[0]!.click(); menus[1]!.click() })
  await app.click('Switch to this account')
  expect(app.sessionSwitches[0]?.verb.accountId).toBe('limited')
  expect(app.managed).toEqual([])
})

test('a ready chat with no selected account can switch to a healthy replacement', async () => {
  const app = await mountApp()
  await app.emit({
    kind: 'accounts.snapshot', protocolVersion: PROTOCOL_VERSION,
    sessionId: 'limited-chat',
    accounts: { ...pool, activeAccountId: null,
      accounts: pool.accounts.map(account => ({ ...account, isDefault: false })) },
  })
  await app.click('Accounts')
  await app.click('Switch')
  expect(app.sessionSwitches[0]?.verb.accountId).toBe('replacement')
  expect(app.managed).toEqual([])
})

test('Accounts switch after a usage limit changes the existing chat before continuing with a dot', async () => {
  const app = await mountApp()
  await app.emit({ kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: 'limited-chat', event: {
    type: 'message', message: { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Usage limit reached'], uuid: 'limited-result' },
  } } as ServerFrame)
  await app.click('Accounts')
  await app.click('Switch')
  expect(app.managed).toEqual([])
  expect(app.sessionSwitches).toEqual([{ sessionId: 'limited-chat', verb: expect.objectContaining({ type: 'account.switch', accountId: 'replacement', provider: 'openai' }) }])
  const { verb } = app.sessionSwitches[0]!
  await app.emit({ kind: 'account.result', protocolVersion: PROTOCOL_VERSION, sessionId: 'limited-chat', requestId: verb.requestId, verb: 'account.switch', ok: true, message: 'Switched to replacement' })
  await app.click('Session limited-chat, live, last turn failed')
  const composer = app.tree.container.querySelector<HTMLElement>('[contenteditable="true"]')!
  expect(composer).not.toBeNull()
  await act(async () => { composer.textContent = '.'; composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '.' })) })
  const send = app.tree.container.querySelector<HTMLButtonElement>('[aria-label="Send prompt"]')!
  expect(send.disabled).toBe(false)
  await app.click('Send prompt')
  expect(app.submits).toEqual([{ sessionId: 'limited-chat', prompt: '.' }])
  expect(app.lifecycle).toEqual([])
})

test.each(['none', 'exited'] as const)('Accounts switching stays session-independent with %s chat', async status => {
  const app = await mountApp('openai', status)
  await app.click('Accounts')
  await app.click('Switch')
  expect(app.sessionSwitches).toEqual([])
  expect(app.managed).toEqual([expect.objectContaining({ type: 'account.switch', accountId: 'replacement' })])
  expect(app.lifecycle).toEqual([])
})

test('Accounts switching another provider does not change the retained chat account', async () => {
  const app = await mountApp('anthropic')
  await app.click('Accounts')
  await app.click('Switch')
  expect(app.sessionSwitches).toEqual([])
  expect(app.managed).toEqual([expect.objectContaining({ type: 'account.switch', accountId: 'replacement' })])
  expect(app.lifecycle).toEqual([])
})
