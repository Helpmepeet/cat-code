/**
 * Mounted proof of the Welcome usage-region replacement. The pool presentation
 * hook is covered separately; this suite drives its derived boolean through the
 * screen so it can observe the DOM branch that replaces the neutral rail.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import type { ReactElement } from 'react'

import { createDomTestHarness, type DomTestHarness, type MountedTree } from './domTestHarness.js'
import { WelcomeScreen } from './WelcomeScreen.js'
import type { AccountsSnapshot, AccountStatus } from '../../shared/protocol.js'

let harness: DomTestHarness

beforeAll(async () => {
  harness = await createDomTestHarness()
})

afterEach(async () => {
  await harness.unmountAll()
})

afterAll(async () => {
  await harness.teardown()
})

function account(over: Partial<AccountStatus> = {}): AccountStatus {
  return {
    id: 'fixture',
    alias: 'fixture',
    status: 'healthy',
    statusReason: null,
    availability: 'available',
    availabilityLabel: 'Ready',
    isDefault: true,
    hasVaultProfile: true,
    source: 'vault',
    usagePrimary: null,
    usageWeekly: null,
    usagePrimaryWindowSeconds: null,
    usageSecondaryWindowSeconds: null,
    usageLimitReached: false,
    usageResetAt: null,
    usageWeeklyResetAt: null,
    lastRefreshIso: null,
    lastError: null,
    planType: 'plus',
    switchable: false,
    ...over,
  }
}

function pool(accounts: AccountStatus[]): AccountsSnapshot {
  return {
    accounts,
    activeAccountId: accounts.find(a => a.isDefault)?.id ?? null,
    readyCount: accounts.filter(a => a.status === 'healthy' && !a.usageLimitReached).length,
    poolCount: accounts.length,
    initialized: true,
    anthropicAccounts: [],
    anthropicActiveAccountId: null,
    anthropicReadyCount: 0,
    anthropicPoolCount: 0,
    anthropicInitialized: true,
    anthropicRouteAvailable: false,
  }
}

function screen(
  accounts: AccountsSnapshot,
  accountsUsagePending: boolean,
): ReactElement {
  return (
    <WelcomeScreen
      recents={[]}
      accounts={accounts}
      accountsUsagePending={accountsUsagePending}
      onOpenRecent={() => {}}
      onOpenFolder={() => {}}
    />
  )
}

function usageState(tree: MountedTree): string | null {
  return tree.container
    .querySelector('[data-welcome-usage-state]')
    ?.getAttribute('data-welcome-usage-state') ?? null
}

function usageRegion(tree: MountedTree): HTMLElement | null {
  return tree.container.querySelector('[data-welcome-usage-region="true"]')
}

test('pending without a recognized window changes to one animated full-width track', async () => {
  const blank = pool([account()])
  const oneWindow = pool([account({ usagePrimary: 38, usagePrimaryWindowSeconds: 18_000 })])
  const tree = await harness.mount(screen(blank, true))

  expect(usageState(tree)).toBe('pending')
  expect(usageRegion(tree)?.className).toBe('grid min-w-0')

  await tree.render(screen(oneWindow, false))

  expect(usageState(tree)).toBe('real')
  expect(usageRegion(tree)?.className).toBe('grid min-w-0')
  expect(tree.container.querySelector('[data-welcome-usage-state="real"]')?.className)
    .toContain('animate-toast-in')
  expect(tree.container.querySelectorAll('[role="progressbar"]')).toHaveLength(1)
  expect(tree.container.textContent).toContain('5h')
  expect(tree.container.textContent).not.toContain('7d')
})

test('pending without a recognized window changes to split animated tracks', async () => {
  const blank = pool([account()])
  const twoWindows = pool([account({
    usagePrimary: 12,
    usagePrimaryWindowSeconds: 18_000,
    usageWeekly: 63,
    usageSecondaryWindowSeconds: 604_800,
  })])
  const tree = await harness.mount(screen(blank, true))

  await tree.render(screen(twoWindows, false))

  expect(usageState(tree)).toBe('real')
  expect(tree.container.querySelectorAll('[role="progressbar"]')).toHaveLength(2)
  expect(tree.container.textContent).toContain('5h')
  expect(tree.container.textContent).toContain('7d')
  expect(tree.container.querySelector('[aria-label="5-hour usage: 12%"]')).toBeTruthy()
  expect(tree.container.querySelector('[aria-label="Weekly usage: 63%"]')).toBeTruthy()
})

test('the presentation deadline removes a pending rail without fabricating usage', async () => {
  const blank = pool([account()])
  const tree = await harness.mount(screen(blank, true))

  expect(usageState(tree)).toBe('pending')

  await tree.render(screen(blank, false))

  expect(usageState(tree)).toBeNull()
  expect(tree.container.querySelector('[role="progressbar"]')).toBeNull()
  expect(tree.container.textContent).not.toContain('5h')
  expect(tree.container.textContent).not.toContain('7d')
})

test('loaded-without-usage can later render usage without returning to pending', async () => {
  const blank = pool([account()])
  const weekly = pool([account({ usagePrimary: 44, usagePrimaryWindowSeconds: 604_800 })])
  const tree = await harness.mount(screen(blank, false))

  expect(usageState(tree)).toBeNull()

  await tree.render(screen(weekly, false))

  expect(usageState(tree)).toBe('real')
  expect(tree.container.querySelector('[data-welcome-usage-state="pending"]')).toBeNull()
  expect(tree.container.querySelector('[aria-label="Weekly usage: 44%"]')).toBeTruthy()
})

test('recognized fallback usage never renders a loading rail', async () => {
  const fallback = pool([account({ usagePrimary: 18, usagePrimaryWindowSeconds: 604_800 })])
  const tree = await harness.mount(screen(fallback, true))

  expect(usageState(tree)).toBe('real')
  expect(tree.container.querySelector('[data-welcome-usage-state="pending"]')).toBeNull()
  expect(tree.container.querySelector('[aria-label="Weekly usage: 18%"]')).toBeTruthy()
})
