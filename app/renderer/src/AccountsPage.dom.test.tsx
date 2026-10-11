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
    await act(async () => { button('+ Add Anthropic').click() })
    expect(sent[0]).toMatchObject({ type: 'account.login', provider: 'anthropic' })
    await act(async () => { button('+ Add account').click() })
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
