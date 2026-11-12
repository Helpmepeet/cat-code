import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { act } from 'react'
import type {
  AccountResultFrame,
  AccountsSnapshot,
  AccountVerbMessage,
  CatCodeBridge,
} from '../../shared/protocol.js'
import { PROTOCOL_VERSION } from '../../shared/protocol.js'
import { AccountsPage } from './AccountsPage.js'
import { ACCOUNTS_POOL_PRESENTATION_TIMEOUT_MS } from './accountsState.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })

const emptySnapshot: AccountsSnapshot = {
  accounts: [], signedOutProfiles: [], activeAccountId: null,
  readyCount: 0, poolCount: 0, initialized: true,
  anthropicAccounts: [], anthropicActiveAccountId: null,
  anthropicReadyCount: 0, anthropicPoolCount: 0,
  anthropicInitialized: true, anthropicRouteAvailable: false,
}

const claudeSnapshot: AccountsSnapshot = {
  ...emptySnapshot,
  anthropicAccounts: [{ id: 'claude', alias: 'Personal', email: 'claude@example.com',
    status: 'healthy', isDefault: false, hasVaultProfile: true, subscriptionType: 'pro', loginGeneration: 7,
    organizationName: 'Workspace', usageWeeklyOpus: 42, usageWeeklySonnet: 12,
    extraUsage: { usedCredits: 2, monthlyLimit: 20, isEnabled: true }, usageStale: true }],
  anthropicPoolCount: 1, anthropicReadyCount: 1,
}

function buttonIn(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find(item => item.textContent === label)
  expect(button).toBeDefined()
  return button!
}

test('Claude menu emits provider-aware generation-bound actions and correlates results', async () => {
  for (const action of ['Rename', 'Delete', 'Sign out', 'Check sign-in', 'Make default for new chats']) {
    const sent: AccountVerbMessage[] = []
    const onVerb = (verb: AccountVerbMessage) => sent.push(verb)
    const tree = await harness.mount(<AccountsPage snapshot={claudeSnapshot} lastResult={null} onVerb={onVerb} />)
    expect(tree.container.textContent).toContain('Personal')
    expect(tree.container.textContent).toContain('Workspace')
    expect(tree.container.textContent).toContain('42%')
    expect(tree.container.textContent).toContain('Extra usage: 2 / 20 credits')
    expect(tree.container.textContent).toContain('Usage may be out of date')
    expect(tree.container.textContent).not.toContain('Reconnect this chat')
    await act(async () => { buttonIn(tree.container, '⋯').click() })
    await act(async () => { buttonIn(tree.container, action).click() })
    const hasDialog = ['Rename', 'Delete', 'Sign out'].includes(action)
    if (hasDialog) await act(async () => { buttonIn(tree.container, action === 'Delete' ? 'Delete account' : action).click() })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ provider: 'anthropic', accountId: 'claude' })
    expect(sent[0]!.requestId).toBeTruthy()
    if (action === 'Delete' || action === 'Sign out') expect(sent[0]).toHaveProperty('expectedCredentialGeneration', 7)
    if (hasDialog) {
      expect(tree.container.querySelector('[role="dialog"]')).not.toBeNull()
      if (action === 'Delete' || action === 'Sign out') {
        expect(tree.container.querySelector('[role="dialog"]')!.textContent).toContain('Close older Cat Code versions before signing out or deleting accounts.')
      }
      const result: AccountResultFrame = { kind: 'account.result', protocolVersion: PROTOCOL_VERSION, sessionId: '', requestId: 'other', verb: sent[0]!.type, ok: true, message: 'Done' }
      await tree.render(<AccountsPage snapshot={claudeSnapshot} lastResult={result} onVerb={onVerb} />)
      expect(tree.container.querySelector('[role="dialog"]')).not.toBeNull()
      await tree.render(<AccountsPage snapshot={claudeSnapshot} lastResult={{ ...result, requestId: sent[0]!.requestId }} onVerb={onVerb} />)
      expect(tree.container.querySelector('[role="dialog"]')).toBeNull()
    }
    await harness.unmountAll()
  }
})

test('inline account actions preserve provider routing and wait for snapshots to change defaults', async () => {
  const codex = {
    id: 'codex', alias: 'Backup', credentialGeneration: 4, status: 'healthy' as const,
    statusReason: null, availability: 'available' as const, availabilityLabel: 'Ready',
    isDefault: false, hasVaultProfile: true, source: 'vault' as const,
    usagePrimary: 0, usageWeekly: null, usagePrimaryWindowSeconds: 18_000,
    usageLimitReached: false, usageResetAt: null, lastRefreshIso: null,
    lastError: null, planType: 'plus', switchable: true,
  }
  const sent: AccountVerbMessage[] = []
  const onVerb = (verb: AccountVerbMessage) => { sent.push(verb) }
  const snapshot = { ...claudeSnapshot, accounts: [codex] }
  const tree = await harness.mount(<AccountsPage snapshot={snapshot} lastResult={null} onVerb={onVerb} />)
  const claude = tree.container.querySelector<HTMLElement>('section[aria-label="Claude accounts"]')!
  const openai = tree.container.querySelector<HTMLElement>('section[aria-label="Codex accounts"]')!
  await act(async () => { buttonIn(claude, 'Make default').click() })
  expect(sent[0]).toMatchObject({ type: 'account.switch', provider: 'anthropic', accountId: 'claude' })
  expect(claude.querySelector('.accounts-default-tag')).toBeNull()
  await act(async () => { buttonIn(openai, 'Make default').click() })
  expect(sent[1]).toMatchObject({ type: 'account.switch', provider: 'openai', accountId: 'codex' })
  expect(openai.querySelector('.accounts-default-tag')).toBeNull()
  expect(openai.querySelector('progress[aria-label="5h usage"]')?.getAttribute('aria-valuetext')).toBe('0%')
  expect(openai.querySelector('progress[aria-label="wk usage"]')?.getAttribute('aria-valuetext')).toBe('Usage unavailable')

  await tree.render(<AccountsPage snapshot={{ ...snapshot,
    accounts: [{ ...codex, status: 'dead', switchable: false }],
    anthropicAccounts: [{ ...claudeSnapshot.anthropicAccounts[0]!, status: 'dead' }],
  }} lastResult={null} onVerb={onVerb} />)
  expect(claude.textContent).toContain('Sign-in expired')
  expect(openai.textContent).toContain('Sign-in expired')
  for (const [section, provider] of [[claude, 'anthropic'], [openai, 'openai']] as const) {
    await act(async () => { buttonIn(section, 'Sign in again').click() })
    await act(async () => { buttonIn(tree.container, 'Sign in').click() })
    expect(sent.at(-1)).toMatchObject({ type: 'account.login', provider, makeDefault: false })
  }
})

test('page defaults ignore chat scope and sign-in defaults are opt-in', async () => {
  const sent: AccountVerbMessage[] = []
  const tree = await harness.mount(<AccountsPage snapshot={{ ...claudeSnapshot,
    anthropicSavedDefaultAccountId: 'missing', anthropicEffectiveDefaultAccountId: 'claude',
  }} switchScope={{ provider: 'anthropic', accountId: 'other' }} lastResult={null} onVerb={v => sent.push(v)} />)
  expect(tree.container.textContent).toContain('Saved default: missing; New chats: Personal')
  await act(async () => { buttonIn(tree.container, '⋯').click() })
  await act(async () => { buttonIn(tree.container, 'Make default for new chats').click() })
  expect(sent.pop()).toMatchObject({ type: 'account.switch', provider: 'anthropic', accountId: 'claude' })
  await act(async () => { tree.container.querySelector<HTMLButtonElement>('[aria-label="Add Claude account"]')!.click() })
  expect(sent).toHaveLength(0)
  expect((tree.container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false)
  await act(async () => { (tree.container.querySelector('input[type="checkbox"]') as HTMLInputElement).click() })
  await act(async () => { buttonIn(tree.container, 'Sign in').click() })
  expect(sent[0]).toMatchObject({ type: 'account.login', provider: 'anthropic', makeDefault: true })
  await act(async () => { tree.container.querySelector<HTMLButtonElement>('[aria-label="Add Codex account"]')!.click() })
  await act(async () => { buttonIn(tree.container, 'Sign in').click() })
  expect(sent[1]).toMatchObject({ type: 'account.login', provider: 'openai', makeDefault: false })
  await act(async () => { buttonIn(tree.container, 'Check sign-ins').click() })
  expect(sent[2]).toMatchObject({ type: 'account.touchAll', provider: 'anthropic' })
  expect(sent[2]).not.toHaveProperty('accountId')
})

test('signed-out Claude profiles keep their names and delete with login generation', async () => {
  const sent: AccountVerbMessage[] = []
  const snapshot = { ...emptySnapshot, anthropicSignedOutProfiles: [{ id: 'old', alias: 'Home', email: 'home@example.com', loginGeneration: 9 }] }
  const tree = await harness.mount(<AccountsPage snapshot={snapshot} lastResult={null} onVerb={v => sent.push(v)} />)
  expect(tree.container.textContent).toContain('Home')
  expect(tree.container.textContent).toContain('home@example.com')
  await act(async () => { buttonIn(tree.container, '⋯').click() })
  await act(async () => { buttonIn(tree.container.querySelector('[role="menu"]')! as HTMLElement, 'Sign in again').click() })
  await act(async () => { buttonIn(tree.container, 'Sign in').click() })
  expect(sent[0]).toMatchObject({ type: 'account.login', provider: 'anthropic', makeDefault: false })
  await act(async () => { buttonIn(tree.container, '⋯').click() })
  await act(async () => { buttonIn(tree.container, 'Delete account').click() })
  await act(async () => { buttonIn(tree.container, 'Delete account').click() })
  expect(sent[1]).toMatchObject({ type: 'account.delete', provider: 'anthropic', accountId: 'old', expectedCredentialGeneration: 9, confirm: true })
  expect(tree.container.querySelector('[role="dialog"]')).not.toBeNull()
})

test('Claude rename rejects aliases held by a signed-out Codex profile', async () => {
  const sent: AccountVerbMessage[] = []
  const tree = await harness.mount(<AccountsPage snapshot={{ ...claudeSnapshot,
    signedOutProfiles: [{ id: 'codex', alias: 'Reserved', state: 'signed_out', credentialGeneration: 1,
      lifecycleGeneration: 1, credentialGenerationState: 'lifecycle_bound', lifecycleState: 'signed_out', lifecycleReadStatus: 'valid' }],
  }} lastResult={null} onVerb={v => sent.push(v)} />)
  await act(async () => { buttonIn(tree.container, '⋯').click() })
  await act(async () => { buttonIn(tree.container, 'Rename').click() })
  await act(async () => {
    const input = tree.container.querySelector('input')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'reserved')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(tree.container.textContent).toContain('That alias is already in use')
  expect(buttonIn(tree.container, 'Rename').disabled).toBe(true)
  expect(sent).toHaveLength(0)
})

test('effective Codex fallback can be explicitly selected as the saved default', async () => {
  const sent: AccountVerbMessage[] = []
  const tree = await harness.mount(<AccountsPage snapshot={{ ...emptySnapshot,
    savedDefaultAccountId: 'missing', effectiveDefaultAccountId: 'fallback', activeAccountId: 'fallback',
    accounts: [{ id: 'fallback', alias: 'Backup', credentialGeneration: 1, status: 'healthy',
      statusReason: null, availability: 'available', availabilityLabel: 'Ready',
      isDefault: true, hasVaultProfile: true, source: 'vault', usagePrimary: null, usageWeekly: null,
      usageLimitReached: false, usageResetAt: null, lastRefreshIso: null, lastError: null,
      planType: null, switchable: false }],
  }} lastResult={null} onVerb={v => sent.push(v)} />)
  expect(tree.container.textContent).toContain('Saved default: missing; New chats: Backup')
  await act(async () => { buttonIn(tree.container, '⋯').click() })
  await act(async () => { buttonIn(tree.container, 'Make default for new chats').click() })
  expect(sent[0]).toMatchObject({ type: 'account.switch', provider: 'openai', accountId: 'fallback' })
  expect(sent[0]!.requestId).toBeTruthy()
  expect(tree.container.textContent).toContain('Saved default: missing; New chats: Backup')
})

test('Claude tiers and Codex recovery reasons are readable without internal codes', async () => {
  const tree = await harness.mount(<AccountsPage snapshot={{ ...claudeSnapshot,
    anthropicAccounts: [{ ...claudeSnapshot.anthropicAccounts[0]!, rateLimitTier: 'default_claude_max_20x' }],
    signedOutProfiles: [{ id: 'codex', alias: 'Work', state: 'recovery_required', recoveryReason: 'generation_mismatch',
      credentialGeneration: 1, lifecycleGeneration: 1, credentialGenerationState: 'lifecycle_bound',
      lifecycleState: 'reauth_required', lifecycleReadStatus: 'valid' }],
  }} lastResult={null} onVerb={() => {}} />)
  expect(tree.container.textContent).toContain('Max 20x')
  expect(tree.container.textContent).toContain('Saved sign-in changed')
  expect(tree.container.querySelector('[title^="The saved sign-in has changed."]')).not.toBeNull()
  expect(tree.container.innerHTML).not.toContain('default_claude_max_20x')
  expect(tree.container.innerHTML).not.toContain('generation_mismatch')
})

test('Refresh all shows the matched failure and retries before displaying new results', async () => {
  const sent: AccountVerbMessage[] = []
  const onVerb = (verb: AccountVerbMessage) => { sent.push(verb) }
  const tree = await harness.mount(
    <AccountsPage snapshot={emptySnapshot} lastResult={null} onVerb={onVerb} />,
  )
  const button = (label: string) => [...tree.container.querySelectorAll('button')]
    .find(item => item.textContent === label)!
  await act(async () => { button('Refresh all').click() })
  const first = sent[0]!
  const failed: AccountResultFrame = {
    kind: 'account.result', protocolVersion: PROTOCOL_VERSION, sessionId: '',
    requestId: first.requestId, verb: 'account.touchAll', ok: false,
    message: 'Could not refresh accounts. Try again.',
  }
  await tree.render(<AccountsPage snapshot={emptySnapshot} lastResult={{ ...failed, requestId: 'unrelated' }} onVerb={onVerb} />)
  expect(tree.container.querySelector('[role="dialog"]')?.textContent).toContain('Refreshing…')
  await tree.render(<AccountsPage snapshot={emptySnapshot} lastResult={failed} onVerb={onVerb} />)
  const dialog = () => tree.container.querySelector('[role="dialog"]')!
  expect(dialog().textContent).toContain(failed.message)
  expect(dialog().textContent).not.toContain('No unlocked vault accounts were refreshed.')

  await act(async () => { button('Try again').click() })
  expect(sent).toHaveLength(2)
  expect(sent[1]!.requestId).not.toBe(first.requestId)
  expect(dialog().textContent).toContain('Refreshing…')
  expect(dialog().textContent).not.toContain(failed.message)
  await tree.render(<AccountsPage snapshot={emptySnapshot} lastResult={{
    ...failed, requestId: sent[1]!.requestId, ok: true,
    message: 'Refresh complete.', touchAllResults: [{ alias: 'fixture', result: 'OK' }],
  }} onVerb={onVerb} />)
  expect(dialog().textContent).toContain('fixtureOK')
})

test('unloaded accounts expose sign-in, a bounded failure and a working retry', async () => {
  const deadlines: Array<() => void> = []
  const schedule = globalThis.setTimeout
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((...timerArgs: Parameters<typeof setTimeout>) => {
    const [callback, delay, ...args] = timerArgs
    if (delay === ACCOUNTS_POOL_PRESENTATION_TIMEOUT_MS && typeof callback === 'function') {
      deadlines.push(() => { callback(...args) })
      return schedule(() => {}, delay)
    }
    return schedule(callback, delay, ...args)
  }) as typeof setTimeout)
  const oldBridge = window.catcode
  let refreshes = 0
  window.catcode = { refreshAccountsPool: () => { refreshes++ } } as CatCodeBridge
  const sent: AccountVerbMessage[] = []
  const onVerb = (verb: AccountVerbMessage) => { sent.push(verb) }
  try {
    const tree = await harness.mount(<AccountsPage snapshot={null} lastResult={null} onVerb={onVerb} />)
    expect(tree.container.textContent).toContain('Loading accounts…')
    const button = (label: string) => [...tree.container.querySelectorAll('button')]
      .find(item => item.textContent === label)!
    await act(async () => { button('+ Add Claude account').click() })
    await act(async () => { button('Sign in').click() })
    expect(sent[0]).toMatchObject({ type: 'account.login', provider: 'anthropic' })
    await act(async () => { button('+ Add Codex account').click() })
    await act(async () => { button('Sign in').click() })
    expect(sent[1]).toMatchObject({ type: 'account.login', provider: 'openai' })
    expect(deadlines).toHaveLength(1)
    await act(async () => { deadlines[0]!() })
    expect(tree.container.textContent).toContain('Accounts could not be loaded.')
    await act(async () => { button('Try again').click() })
    expect(refreshes).toBe(1)
    expect(tree.container.textContent).toContain('Loading accounts…')
    expect(deadlines).toHaveLength(2)
    await tree.render(<AccountsPage snapshot={emptySnapshot} lastResult={null} onVerb={onVerb} />)
    expect(tree.container.textContent).not.toContain('Loading accounts…')
    expect(tree.container.textContent).not.toContain('Accounts could not be loaded.')
    expect(tree.container.textContent).toContain('No Codex accounts are signed in.')
  } finally {
    window.catcode = oldBridge
    timer.mockRestore()
  }
})
