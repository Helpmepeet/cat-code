import { expect, test } from 'bun:test'

import { createVisibilityGatedRefresh } from './refreshActivityGate.js'

test('recurring worker stays cold while all windows are hidden and refreshes on return', async () => {
  let visible = false
  let starts = 0
  const gated = createVisibilityGatedRefresh(async () => { starts++ }, () => visible)

  await gated.run() // Immediate launch still populates a cold app.
  await gated.run() // A timer tick while the app is away does not start a worker.
  expect(starts).toBe(1)
  expect(gated.takeSkippedInterval()).toBe(true)
  expect(gated.takeSkippedInterval()).toBe(false)

  visible = true
  await gated.run() // The driver's focus event requests the fresh read.
  expect(starts).toBe(2)
})

test('visible unfocused windows keep cadence and explicit refresh can run while hidden', async () => {
  let visible = true
  let starts = 0
  const gated = createVisibilityGatedRefresh(async () => { starts++ }, () => visible)
  await gated.run()
  // Losing focus while the window remains visible must not suspend the 60 s cadence.
  await gated.run()
  expect(starts).toBe(2)
  expect(gated.takeSkippedInterval()).toBe(false)
  visible = false
  await gated.run()
  expect(gated.takeSkippedInterval()).toBe(true)
  gated.allowNextRun()
  await gated.run()
  expect(starts).toBe(3)
})
