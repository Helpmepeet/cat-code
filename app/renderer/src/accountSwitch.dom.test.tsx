import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { App } from './App.js'
import { AccountSwitcherPanel } from './ComposerActionsBar.js'
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

test('a sole active Claude account has a deliberate reconnect action, not a clickable active row', async () => {
  const active = {
    id: 'claude-main', alias: 'Claude account', email: 'claude@example.test',
    status: 'healthy' as const, isDefault: true, hasVaultProfile: true, subscriptionType: 'max',
  }
  const switches: unknown[] = []
  const tree = await harness.mount(
    <AccountSwitcherPanel active={active} pool={[]} anthropicPool={[active]}
      provider="anthropic" onSwitch={(id, provider) => switches.push({ id, provider })} />,
  )
  const buttons = [...tree.container.querySelectorAll<HTMLButtonElement>('button')]
  const row = buttons.find(button => button.textContent?.includes('Claude account'))!
  expect(row.getAttribute('aria-disabled')).toBe('true')
  await act(async () => { row.click() })
  expect(switches).toEqual([])
  const reconnect = buttons.find(button => button.textContent?.trim() === 'Reconnect this chat')!
  expect(reconnect).toBeDefined()
  await act(async () => { reconnect.click() })
  expect(switches).toEqual([{ id: 'claude-main', provider: 'anthropic' }])
})

test.each(['persistence_pending', 'refresh_uncertain', 'sign_in_required', 'ready'] as const)(
  'composer exposes actionable Claude health and only reconnects a valid login: %s',
  async credentialHealth => {
    const active = {
      id: 'claude-main', alias: 'Claude account', email: 'claude@example.test',
      status: 'healthy' as const, isDefault: true, hasVaultProfile: true, subscriptionType: 'max',
      credentialHealth, loginGeneration: 2, boundLoginGeneration: 1,
    }
    const tree = await harness.mount(
      <AccountSwitcherPanel active={active} pool={[]} anthropicPool={[active]}
        provider="anthropic" onSwitch={() => {}} onManage={() => {}} />,
    )
    const text = tree.container.textContent!
    expect(text).toContain(credentialHealth === 'ready' ? 'Account is signed in.' : 'Sign in again')
    expect(text.includes('Reconnect this chat') || text.includes('Reconnect this chat'.toLowerCase())).toBe(credentialHealth === 'ready')
    expect(text).toContain('Manage accounts')
  },
)

test.each(['committed', 'wrong-account', 'wrong-provider', 'pending', 'wrong-request', 'legacy', 'chat-account-changed'] as const)(
  'combined Claude sign-in reconnects only the originating chat with a matching committed receipt: %s',
  async outcome => {
    const app = await mountApp('anthropic')
    const inventory: AccountsSnapshot = {
      ...pool, anthropicAccounts: [{
        id: 'claude-main', alias: 'Claude account', email: 'claude@example.test',
        status: 'dead', isDefault: true, hasVaultProfile: true, subscriptionType: 'max',
      }],
      anthropicActiveAccountId: 'claude-main', anthropicPoolCount: 1,
    }
    await app.emitPool(inventory)
    await app.emit({
      kind: 'accounts.snapshot', protocolVersion: PROTOCOL_VERSION,
      sessionId: 'limited-chat', accounts: inventory,
    })
    // Host inventory may have forgotten the signed-out selection entirely.
    await app.emitPool({ ...inventory, anthropicAccounts: [], anthropicPoolCount: 0 })
    const trigger = app.tree.container.querySelector<HTMLButtonElement>('[data-composer-face="account"]')!
    expect(trigger).not.toBeNull()
    await act(async () => { trigger.click() })
    await act(async () => { await harness.nextFrame() })
    const reconnect = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] button')]
      .find(button => button.textContent?.trim() === 'Sign in again & reconnect')!
    expect(reconnect).toBeDefined()
    await act(async () => { reconnect.click() })
    const login = app.managed[0] as { requestId: string }
    expect(login.requestId).toBeTruthy()
    expect(app.managed[0]).toEqual(expect.objectContaining({ makeDefault: false }))
    // Completion must not consult the tab that happens to be active now.
    const otherTab = [...app.tree.container.querySelectorAll<HTMLElement>('[role="tab"]')]
      .find(tab => tab.getAttribute('aria-label')?.includes('other-chat'))!
    expect(otherTab).toBeDefined()
    await act(async () => { otherTab.click() })
    if (outcome === 'chat-account-changed') {
      await app.emit({
        kind: 'accounts.snapshot', protocolVersion: PROTOCOL_VERSION,
        sessionId: 'limited-chat', accounts: {
          ...inventory, anthropicAccounts: inventory.anthropicAccounts.map(account => ({
            ...account, id: 'another-chat-selection',
          })),
        },
      })
    }
    await app.emitHost({
      type: 'account-oauth', provider: outcome === 'wrong-provider' ? 'openai' : 'anthropic',
      progress: outcome === 'legacy' ? { state: 'success' } : {
        state: 'success',
        loginRequestId: outcome === 'wrong-request' ? 'unrelated' : login.requestId,
        receipt: {
          provider: outcome === 'wrong-provider' ? 'openai' : 'anthropic',
          accountId: outcome === 'wrong-account' ? 'another-account' : 'claude-main',
          operationId: 'installed-operation', loginGeneration: 2,
          outcome: outcome === 'pending' ? 'persistence_pending' : 'committed',
        },
      },
    })
    expect(app.sessionSwitches).toEqual(outcome === 'committed' ? [{
      sessionId: 'limited-chat',
      verb: expect.objectContaining({ type: 'account.switch', provider: 'anthropic', accountId: 'claude-main', expectedLoginGeneration: 2 }),
    }] : [])
    expect(app.submits).toEqual([])
    expect(app.lifecycle).toEqual([])
  },
)

async function mountApp(
  provider: RunControlProvider = 'openai',
  status: 'ready' | 'exited' | 'none' = 'ready',
  providerSwitchLocked = true,
) {
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
    rendererReady: () => {}, recordRenderCommit: () => {},
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
        model: { current: 'gpt-6.1-sol', currentLabel: 'GPT-6.1 Sol', contextWindow: 372000, selected: 'gpt-6.1-sol', provider, providerSwitchLocked, options: [] },
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
  return { tree, click, emit, emitPool,
    emitHost: async (event: HostEvent) => { await act(async () => { host(event) }) },
    sessionSwitches, managed, submits, lifecycle }
}

test.each([false, true])(
  'the GPT composer allows a Claude account only before the provider lock: %s',
  async locked => {
    const app = await mountApp('openai', 'ready', locked)
    const inventory: AccountsSnapshot = {
      ...pool,
      anthropicAccounts: [{
        id: 'claude-main', alias: 'Claude account', email: 'claude@example.test',
        status: 'healthy', isDefault: true, hasVaultProfile: true, subscriptionType: 'max',
      }],
      anthropicActiveAccountId: 'claude-main', anthropicReadyCount: 1, anthropicPoolCount: 1,
    }
    await app.emitPool(inventory)
    await app.emit({
      kind: 'accounts.snapshot', protocolVersion: PROTOCOL_VERSION,
      sessionId: 'limited-chat', accounts: inventory,
    })
    const trigger = app.tree.container.querySelector<HTMLButtonElement>('[data-composer-face="account"]')!
    expect(trigger).not.toBeNull()
    await act(async () => { trigger.click() })
    await act(async () => { await harness.nextFrame() })
    const menu = document.querySelector('[role="menu"][aria-label="Accounts"]')!
    const claude = [...menu.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.includes('Claude account'))!
    expect(claude.getAttribute('aria-disabled')).toBe(String(locked))
    await act(async () => { claude.click() })
    expect(app.sessionSwitches).toEqual(locked ? [] : [{
      sessionId: 'limited-chat',
      verb: expect.objectContaining({
        type: 'account.switch', provider: 'anthropic', accountId: 'claude-main',
      }),
    }])
    expect(app.managed).toEqual([])
    expect(app.submits).toEqual([])
    expect(app.lifecycle).toEqual([])
  },
)

test('the chat reports unsaved account authority until the host confirms recovery', async () => {
  const app = await mountApp()
  const message = 'Your account selection was not saved.'
  await app.emitHost({
    type: 'session-status',
    session: sessionDescriptor('limited-chat', { accountSelectionUnsaved: true }),
  })
  expect(app.tree.container.textContent).toContain(message)
  await app.emitHost({
    type: 'session-status',
    session: sessionDescriptor('limited-chat', { accountSelectionUnsaved: false }),
  })
  expect(app.tree.container.textContent).not.toContain(message)
})

test('Accounts ignores the retained chat selection and keeps global defaults', async () => {
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
  expect(app.tree.container.textContent).toContain("New chats use each provider's default account.")
  expect([...app.tree.container.querySelectorAll('button')].filter(
    button => button.textContent?.trim() === 'Switch',
  )).toHaveLength(1)
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
    .toContain('Sign out')
  await app.click('Cancel')
  const menus = app.tree.container.querySelectorAll<HTMLButtonElement>(
    'button[aria-label="Account actions"]',
  )
  await act(async () => { menus[1]!.click() })
  await app.click('Make default for new chats')
  expect(app.sessionSwitches).toEqual([])
  expect(app.managed).toEqual([expect.objectContaining({ accountId: 'replacement' })])
})

test('Accounts does not confuse a main failover identity with the default', async () => {
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
  // The released main-thread failover remains this chat's identity, not a
  // mutation of the saved new-chat default.
  expect(app.tree.container.querySelector('[data-composer-face="account"]')?.textContent)
    .toContain('replacement')
  await app.click('Accounts')
  const menus = app.tree.container.querySelectorAll<HTMLButtonElement>(
    'button[aria-label="Account actions"]',
  )
  expect(menus[0]!.closest('.accounts-row')?.textContent).toContain('limitedDefault')
  expect(menus[1]!.closest('.accounts-row')?.querySelector('.accounts-default-tag')).toBeNull()
  expect(app.tree.container.textContent).not.toContain('replacementNext chat')
  await act(async () => { menus[0]!.click() })
  expect(app.tree.container.textContent).not.toContain('Switch to this account')
  await act(async () => { menus[0]!.click(); menus[1]!.click() })
  await app.click('Make default for new chats')
  expect(app.sessionSwitches).toEqual([])
  expect(app.managed).toEqual([expect.objectContaining({ accountId: 'replacement' })])
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
  expect(app.sessionSwitches).toEqual([])
  expect(app.managed).toEqual([expect.objectContaining({ accountId: 'replacement' })])
})

test('a blocked chat does not change the sole healthy new-chat default on Accounts', async () => {
  const app = await mountApp()
  const replacement = { ...pool.accounts[1]!, isDefault: true, switchable: false }
  const global = { ...pool, accounts: [replacement], activeAccountId: replacement.id, poolCount: 1 }
  await app.emitPool(global)
  await app.emit({
    kind: 'accounts.snapshot', protocolVersion: PROTOCOL_VERSION,
    sessionId: 'limited-chat',
    accounts: {
      ...global, activeAccountId: null,
      accounts: [{ ...replacement, isDefault: false, switchable: true }],
    },
  })
  await app.click('Accounts')
  await app.click('Account actions')
  expect(app.tree.container.textContent).not.toContain('Make default for new chats')
  expect(app.sessionSwitches).toEqual([])
  expect(app.managed).toEqual([])
})

test('Accounts switch after a usage limit changes only the default, even with a focused chat', async () => {
  const app = await mountApp()
  await app.emit({ kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: 'limited-chat', event: {
    type: 'message', message: { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Usage limit reached'], uuid: 'limited-result' },
  } } as ServerFrame)
  await app.click('Accounts')
  await app.click('Switch')
  expect(app.managed).toEqual([expect.objectContaining({ type: 'account.switch', accountId: 'replacement', provider: 'openai' })])
  expect(app.sessionSwitches).toEqual([])
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
