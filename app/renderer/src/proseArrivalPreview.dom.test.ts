/**
 * DOM proof that the preview's clock is actually connected.
 *
 * This deliberately asserts ONE weak thing: mounting the preview eventually
 * changes what it renders. The loop's real behaviour — which chunk is delivered
 * on which tick, what is marked, when it holds and wraps — is enumerated without
 * timers in `proseArrivalPreviewModel.test.ts`, because that is a pure function
 * of one integer.
 *
 * The split exists because the first attempt at this file asserted the whole
 * loop through a wall clock. It passed alone and failed inside the 256-file
 * suite twice, once because fixed sample offsets landed in the hold and once
 * under load: at that point it was measuring how busy the machine was. What is
 * left here is the only claim a static render genuinely cannot make.
 *
 * No JSX: keeping the file `.ts` keeps it outside the `lint:fast-refresh`
 * component-boundary rule that governs `renderer/src/**.tsx`.
 */

import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, createElement } from 'react'
import { createDomTestHarness } from './domTestHarness.js'
import type { DomTestHarness } from './domTestHarness.js'
import { ProseArrivalPreview } from './ProseArrivalPreview.js'
import { ProseArrivalContext } from './proseArrival.js'
import { PROSE_PREVIEW_CHUNK_MS } from './proseArrivalPreviewModel.js'

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

test('mounting the preview starts a clock that changes what it renders', async () => {
  const tree = await harness.mount(
    createElement(
      ProseArrivalContext.Provider,
      { value: { arrival: 'instant', setArrival: () => {} } },
      createElement(ProseArrivalPreview),
    ),
  )
  const read = (): string => tree.container.textContent ?? ''
  const start = read()

  // Generous, and exits the moment it sees any change: a healthy loop moves on
  // the first tick, so this normally costs one tick rather than the whole budget.
  // `instant` on purpose, the option with no animation, where a dead loop is
  // invisible by eye and has to be caught by assertion.
  // The wait goes INSIDE `act`. The harness sets `IS_REACT_ACT_ENVIRONMENT`, so
  // an update from a bare `setInterval` is queued rather than flushed: without
  // this the DOM simply never changes, however long the poll runs. That is what
  // the "not wrapped in act(...)" warnings were reporting, and why an earlier
  // version passed alone and failed in the suite rather than failing outright.
  let moved = false
  for (let step = 0; step < 12 && !moved; step += 1) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, PROSE_PREVIEW_CHUNK_MS))
    })
    moved = read() !== start
  }
  expect(moved).toBe(true)
}, 30_000)
