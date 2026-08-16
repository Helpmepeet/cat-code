/**
 * Real-timer proof for the analytics section's third display state.
 *
 * The SSR suites can only ever observe the FIRST paint, where effects have not
 * run, so they cannot tell a spinner that resolves from one that never does.
 * That is the whole defect this state exists to remove, which makes a mounted
 * tree with real effects the only honest place to assert it.
 *
 * Timings are driven by passing a small `timeoutMs`; the production value lives
 * on `USAGE_STATS_PENDING_TIMEOUT_MS` and is asserted separately.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'

import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import {
  USAGE_STATS_PENDING_TIMEOUT_MS,
  useUsageStatsDisplayState,
} from './statsState.js'

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

function Probe({ hasStats }: { hasStats: boolean }) {
  return <span data-testid="state">{useUsageStatsDisplayState(hasStats, TIMEOUT_MS)}</span>
}

function readState(container: HTMLElement): string | null {
  return container.querySelector('[data-testid="state"]')?.textContent ?? null
}

/**
 * Let real time pass INSIDE `act`, so the state update the pending timer
 * schedules is flushed and asserted like any other. Outside act it still
 * happens, but React logs an unwrapped-update warning and the assertion races
 * the commit.
 */
async function settle(ms: number): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, ms))
  })
}

test('waiting starts as pending and becomes unavailable once the wait is spent', async () => {
  const tree = await harness.mount(<Probe hasStats={false} />)
  expect(readState(tree.container)).toBe('pending')

  await settle(TIMEOUT_MS * 3)
  expect(readState(tree.container)).toBe('unavailable')
})

test('data that arrives before the wait is spent never shows the failure', async () => {
  const tree = await harness.mount(<Probe hasStats={false} />)
  expect(readState(tree.container)).toBe('pending')

  await tree.render(<Probe hasStats />)
  expect(readState(tree.container)).toBe('loaded')

  // The pending timer must not fire against a tree that already has data.
  await settle(TIMEOUT_MS * 3)
  expect(readState(tree.container)).toBe('loaded')
})

test('a feed that recovers retracts the failure instead of staying failed', async () => {
  // `unavailable` is a statement about right now, not a latch. The host feed
  // retries on its own, so a page stuck reporting a failure it healed from
  // would be its own wrong answer.
  const tree = await harness.mount(<Probe hasStats={false} />)
  await settle(TIMEOUT_MS * 3)
  expect(readState(tree.container)).toBe('unavailable')

  await tree.render(<Probe hasStats />)
  expect(readState(tree.container)).toBe('loaded')
})

test('data present from the very first paint never schedules a failure', async () => {
  const tree = await harness.mount(<Probe hasStats />)
  expect(readState(tree.container)).toBe('loaded')
  await settle(TIMEOUT_MS * 3)
  expect(readState(tree.container)).toBe('loaded')
})

test('the shipped wait matches the worker budget it is reasoning about', () => {
  // Shorter than the worker's own 2-minute timeout would report failure while a
  // run was still legitimately in flight, then take it back.
  expect(USAGE_STATS_PENDING_TIMEOUT_MS).toBe(2 * 60 * 1000)
})
