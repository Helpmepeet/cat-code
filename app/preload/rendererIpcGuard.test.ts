import { expect, test } from 'bun:test'

import {
  MAX_DIAGNOSTIC_FRAMES_PER_WINDOW,
  MAX_FRAME_BYTES,
  MAX_FRAMES_PER_WINDOW,
  RATE_WINDOW_MS,
} from '../shared/limits.js'
import { createRendererIpcGuard } from './rendererIpcGuard.js'

test('rejects renderer IPC payloads over the shared frame byte limit', () => {
  const guard = createRendererIpcGuard()

  expect(() => guard.assertAllowed('x'.repeat(MAX_FRAME_BYTES + 1))).toThrow(
    `renderer IPC payload exceeds ${MAX_FRAME_BYTES} bytes`,
  )
})

test('counts all fixed-channel sends in one shared rate window', () => {
  let now = 1_000
  const guard = createRendererIpcGuard({ now: () => now })

  for (let index = 0; index < MAX_FRAMES_PER_WINDOW; index++) {
    guard.assertAllowed({ index })
  }
  expect(() => guard.assertAllowed({ overflow: true })).toThrow(
    `renderer IPC rate exceeds ${MAX_FRAMES_PER_WINDOW} frames per ${RATE_WINDOW_MS}ms`,
  )

  now += RATE_WINDOW_MS
  expect(() => guard.assertAllowed({ nextWindow: true })).not.toThrow()
})

test('rejects values that cannot be serialized without reaching Electron IPC', () => {
  const guard = createRendererIpcGuard()
  const cyclic: { self?: unknown } = {}
  cyclic.self = cyclic

  expect(() => guard.assertAllowed(cyclic)).toThrow(
    'renderer IPC payload is not serializable',
  )
})

test('saturated diagnostics still leaves the window open to control traffic', () => {
  // The whole point of IPC-RATE-BUDGET: on 2026-08-09 delivery acknowledgements
  // spent the shared window and a user action arriving next would have been
  // rejected. Diagnostics now hit their sub-cap first, with the remainder of the
  // total still available to whatever the user is waiting on.
  let now = 1_000
  const guard = createRendererIpcGuard({ now: () => now })

  for (let index = 0; index < MAX_DIAGNOSTIC_FRAMES_PER_WINDOW; index++) {
    guard.assertAllowed({ index }, 'diagnostics')
  }
  expect(() => guard.assertAllowed({ overflow: true }, 'diagnostics')).toThrow(
    `renderer IPC diagnostics rate exceeds ${MAX_DIAGNOSTIC_FRAMES_PER_WINDOW} frames per ${RATE_WINDOW_MS}ms`,
  )

  for (let index = 0; index < MAX_FRAMES_PER_WINDOW - MAX_DIAGNOSTIC_FRAMES_PER_WINDOW; index++) {
    expect(() => guard.assertAllowed({ submit: index })).not.toThrow()
  }
})

test('the sub-cap sits inside the total rather than beside it', () => {
  // A second independent budget would double the inbound ceiling, which is the
  // one thing T7 exists to bound. Control traffic alone must still hit 120.
  let now = 1_000
  const guard = createRendererIpcGuard({ now: () => now })

  for (let index = 0; index < MAX_FRAMES_PER_WINDOW; index++) {
    guard.assertAllowed({ index })
  }
  expect(() => guard.assertAllowed({ overflow: true }, 'diagnostics')).toThrow(
    `renderer IPC rate exceeds ${MAX_FRAMES_PER_WINDOW} frames per ${RATE_WINDOW_MS}ms`,
  )

  now += RATE_WINDOW_MS
  expect(() => guard.assertAllowed({ nextWindow: true }, 'diagnostics')).not.toThrow()
})

test('control traffic is not sub-capped', () => {
  let now = 1_000
  const guard = createRendererIpcGuard({ now: () => now })

  for (let index = 0; index < MAX_FRAMES_PER_WINDOW; index++) {
    expect(() => guard.assertAllowed({ index })).not.toThrow()
  }
})
