/**
 * Mounted, real-timer coverage for the renderer-only Welcome presentation
 * state. This does not execute a worker or App effect.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, StrictMode, useEffect } from 'react'

import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import {
  ACCOUNTS_POOL_PRESENTATION_TIMEOUT_MS,
  useAccountsPoolPresentationState,
  hasCompleteAccountsUsage,
} from './accountsState.js'
import type { AccountsSnapshot, AccountStatus } from '../../shared/protocol.js'
import { useAccountUsageWindows } from './welcomeUsage.js'

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

const TIMEOUT_MS = 30

function Probe({
  hasGlobalPool,
  onState,
}: {
  hasGlobalPool: boolean
  onState?: (state: string) => void
}) {
  const state = useAccountsPoolPresentationState(hasGlobalPool, TIMEOUT_MS)
  useEffect(() => {
    onState?.(state)
  }, [onState, state])
  return <span data-testid="state">{state}</span>
}

function readState(container: HTMLElement): string | null {
  return container.querySelector('[data-testid="state"]')?.textContent ?? null
}

async function settle(ms: number): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, ms))
  })
}

test('starts pending while the renderer awaits its first global pool event', async () => {
  const tree = await harness.mount(<Probe hasGlobalPool={false} />)
  expect(readState(tree.container)).toBe('pending')
})

test('global arrival changes pending to loaded', async () => {
  const tree = await harness.mount(<Probe hasGlobalPool={false} />)
  await tree.render(<Probe hasGlobalPool />)
  expect(readState(tree.container)).toBe('loaded')
})

test('the presentation deadline changes pending to unavailable', async () => {
  const tree = await harness.mount(<Probe hasGlobalPool={false} />)
  await settle(TIMEOUT_MS * 3)
  expect(readState(tree.container)).toBe('unavailable')
})

test('the shipped value is a two-minute presentation deadline', () => {
  expect(ACCOUNTS_POOL_PRESENTATION_TIMEOUT_MS).toBe(2 * 60 * 1000)
})

test('loaded does not re-enter pending in the same mounted hook instance', async () => {
  const tree = await harness.mount(<Probe hasGlobalPool={false} />)
  await tree.render(<Probe hasGlobalPool />)
  expect(readState(tree.container)).toBe('loaded')

  await tree.render(<Probe hasGlobalPool={false} />)
  await settle(TIMEOUT_MS * 3)
  expect(readState(tree.container)).toBe('loaded')
})

test('an unavailable presentation becomes loaded when a global snapshot arrives later', async () => {
  const tree = await harness.mount(<Probe hasGlobalPool={false} />)
  await settle(TIMEOUT_MS * 3)
  expect(readState(tree.container)).toBe('unavailable')

  await tree.render(<Probe hasGlobalPool />)
  expect(readState(tree.container)).toBe('loaded')
})

test('a remount creates a fresh pending presentation instance', async () => {
  const first = await harness.mount(<Probe hasGlobalPool={false} />)
  await settle(TIMEOUT_MS * 3)
  expect(readState(first.container)).toBe('unavailable')
  await first.unmount()

  const second = await harness.mount(<Probe hasGlobalPool={false} />)
  expect(readState(second.container)).toBe('pending')
})

test('unmount clears the presentation deadline', async () => {
  const states: string[] = []
  const tree = await harness.mount(<Probe hasGlobalPool={false} onState={state => states.push(state)} />)
  await tree.unmount()
  await settle(TIMEOUT_MS * 3)

  expect(states).toEqual(['pending'])
})

test('StrictMode cleanup prevents a late duplicate presentation transition', async () => {
  const states: string[] = []
  const tree = await harness.mount(
    <StrictMode>
      <Probe hasGlobalPool={false} onState={state => states.push(state)} />
    </StrictMode>,
  )

  await tree.render(
    <StrictMode>
      <Probe hasGlobalPool onState={state => states.push(state)} />
    </StrictMode>,
  )
  await settle(TIMEOUT_MS * 3)

  expect(readState(tree.container)).toBe('loaded')
  expect(states).not.toContain('unavailable')
})

test('partial cached startup stays pending until every row has a reading', async () => {
  const snapshot = {
    accounts: [
      { usagePrimary: 42, usageWeekly: null, usageStale: true },
      { usagePrimary: null, usageWeekly: null },
    ],
    anthropicAccounts: [],
  } as unknown as AccountsSnapshot
  const tree = await harness.mount(
    <Probe hasGlobalPool={hasCompleteAccountsUsage(snapshot)} />,
  )
  expect(readState(tree.container)).toBe('pending')
  snapshot.accounts[1]!.usagePrimary = 20
  await tree.render(<Probe hasGlobalPool={hasCompleteAccountsUsage(snapshot)} />)
  expect(readState(tree.container)).toBe('loaded')
})

test('a mounted fresh usage snapshot expires at reset without another publication', async () => {
  const reset = (Date.now() + 150) / 1000
  const account = {
    usagePrimary: 42, usageResetAt: reset, usagePrimaryWindowSeconds: 18_000,
    usageWeekly: null, usageWeeklyResetAt: null, usageSecondaryWindowSeconds: null,
    usageStale: false,
  } as AccountStatus
  function UsageProbe() {
    const windows = useAccountUsageWindows(account)
    return <span data-testid="state">{windows.fiveHour?.percent ?? 'expired'}</span>
  }
  const tree = await harness.mount(<UsageProbe />)
  expect(readState(tree.container)).toBe('42')
  await settle(250)
  expect(readState(tree.container)).toBe('expired')
})
