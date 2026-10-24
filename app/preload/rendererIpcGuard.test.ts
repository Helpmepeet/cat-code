import { expect, test } from 'bun:test'

import {
  MAX_DIAGNOSTIC_FRAMES_PER_WINDOW,
  MAX_FRAME_BYTES,
  MAX_FRAMES_PER_WINDOW,
  MAX_LARGE_SUBMIT_BYTES_PER_WINDOW,
  MAX_SUBMIT_FRAME_BYTES,
  RATE_WINDOW_MS,
} from '../shared/limits.js'
import { MAX_SUBMIT_IMAGE_BYTES, MAX_SUBMIT_TEXT_BYTES } from '../../src/app-runtime/appSubmitLimits.js'
import { createRendererIpcGuard, RendererIpcRejection } from './rendererIpcGuard.js'

const image = (data = 'AAAA') => ({
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data },
})

function expectRejection(action: () => void, reason: 'size' | 'rate'): void {
  let rejection: unknown
  try {
    action()
  } catch (error) {
    rejection = error
  }
  expect(rejection).toBeInstanceOf(RendererIpcRejection)
  expect((rejection as RendererIpcRejection).reason).toBe(reason)
}

test('rejects renderer IPC payloads over the shared frame byte limit', () => {
  const guard = createRendererIpcGuard()

  expect(() => guard.assertAllowed('x'.repeat(MAX_FRAME_BYTES + 1))).toThrow(
    'This request is too large. Try sending less text or fewer attachments.',
  )
})

test('two image attachments are accepted only on the submit channel', () => {
  const guard = createRendererIpcGuard()
  const payload = {
    sessionId: 'chat',
    prompt: [
      ...Array.from({ length: 2 }, () => ({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(90_000) },
      })),
      { type: 'text', text: 'Compare these images.' },
    ],
  }

  expect(() => guard.assertAllowed(payload, 'submit')).not.toThrow()
  expectRejection(() => guard.assertAllowed(payload), 'size')
  expectRejection(() => guard.assertAllowed(payload, 'diagnostics'), 'size')
})

test('accepts two maximum-sized encoded images and the full separate text allowance', () => {
  const payload = {
    sessionId: 'chat',
    prompt: [
      image('A'.repeat(MAX_SUBMIT_IMAGE_BYTES)),
      image('A'.repeat(MAX_SUBMIT_IMAGE_BYTES)),
      { type: 'text', text: '界'.repeat(MAX_SUBMIT_TEXT_BYTES / 3) },
    ],
  }
  expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(MAX_SUBMIT_FRAME_BYTES)
  expect(() => createRendererIpcGuard().assertAllowed(payload, 'submit')).not.toThrow()
})

test('rejects malformed and over-budget submit prompts with a size reason', () => {
  const guard = createRendererIpcGuard()
  for (const prompt of [
    [image('not base64!')],
    [image('A'.repeat(MAX_SUBMIT_IMAGE_BYTES - 1) + '!')],
    [image('A'.repeat(MAX_SUBMIT_IMAGE_BYTES + 4))],
    [image('A'.repeat(MAX_SUBMIT_IMAGE_BYTES)), image('A'.repeat(MAX_SUBMIT_IMAGE_BYTES)), image()],
    [image(), { type: 'text', text: '界'.repeat(MAX_SUBMIT_TEXT_BYTES / 3 + 1) }],
    'x'.repeat(MAX_SUBMIT_TEXT_BYTES + 1),
    [{ ...image(), extra: 'x'.repeat(MAX_FRAME_BYTES) }],
    [{ type: 'image', source: { ...image().source, media_type: 'x'.repeat(MAX_FRAME_BYTES) } }],
  ]) {
    expectRejection(() => guard.assertAllowed({ sessionId: 'chat', prompt }, 'submit'), 'size')
  }
})

test('image allowance cannot carry oversized metadata, non-image bodies or controls', () => {
  const guard = createRendererIpcGuard()
  expectRejection(() => guard.assertAllowed({
    prompt: [image()],
    options: { uuid: 'x'.repeat(MAX_FRAME_BYTES) },
  }, 'submit'), 'size')
  expectRejection(() => guard.assertAllowed({
    prompt: 'hello', metadata: 'x'.repeat(MAX_FRAME_BYTES),
  }, 'submit'), 'size')
  for (const kind of ['control', 'diagnostics'] as const) {
    expectRejection(() => guard.assertAllowed({ data: 'x'.repeat(MAX_FRAME_BYTES) }, kind), 'size')
  }
})

test('large submit byte budget exhausts independently, leaves control room and resets', () => {
  let now = 1_000
  const guard = createRendererIpcGuard({ now: () => now })
  const payload = {
    prompt: [image('A'.repeat(MAX_SUBMIT_IMAGE_BYTES)), image('A'.repeat(MAX_SUBMIT_IMAGE_BYTES))],
  }
  const bytes = Buffer.byteLength(JSON.stringify(payload))
  const accepted = Math.floor(MAX_LARGE_SUBMIT_BYTES_PER_WINDOW / bytes)
  expect(MAX_LARGE_SUBMIT_BYTES_PER_WINDOW).toBe(2 * MAX_SUBMIT_FRAME_BYTES)
  expect(accepted).toBe(2)
  for (let index = 0; index < accepted; index++) {
    expect(() => guard.assertAllowed(payload, 'submit')).not.toThrow()
  }
  expectRejection(() => guard.assertAllowed(payload, 'submit'), 'rate')
  for (let index = accepted; index < MAX_FRAMES_PER_WINDOW; index++) {
    expect(() => guard.assertAllowed({ type: 'app.abort', requestId: String(index) })).not.toThrow()
  }
  expectRejection(() => guard.assertAllowed({ overflow: true }), 'rate')
  now += RATE_WINDOW_MS
  expect(() => guard.assertAllowed(payload, 'submit')).not.toThrow()
  expect(() => guard.assertAllowed(payload, 'submit')).not.toThrow()
  expectRejection(() => guard.assertAllowed(payload, 'submit'), 'rate')
  expect(() => guard.assertAllowed({ type: 'app.abort', requestId: 'after-reset' })).not.toThrow()
})

test('counts all fixed-channel sends in one shared rate window', () => {
  let now = 1_000
  const guard = createRendererIpcGuard({ now: () => now })

  for (let index = 0; index < MAX_FRAMES_PER_WINDOW; index++) {
    guard.assertAllowed({ index })
  }
  expect(() => guard.assertAllowed({ overflow: true })).toThrow(
    'Too many requests at once. Wait a moment and try again.',
  )

  now += RATE_WINDOW_MS
  expect(() => guard.assertAllowed({ nextWindow: true })).not.toThrow()
})

test('rejects values that cannot be serialized without reaching Electron IPC', () => {
  const guard = createRendererIpcGuard()
  const cyclic: { self?: unknown } = {}
  cyclic.self = cyclic

  expect(() => guard.assertAllowed(cyclic)).toThrow(
    'Could not send this request. Try again.',
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
    'Too many requests at once. Wait a moment and try again.',
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
    'Too many requests at once. Wait a moment and try again.',
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

test('the diagnostics sub-cap resets with the window, not once per process', () => {
  // Without the counter reset the guard still passes every other test here, and
  // diagnostics would be throttled after the first 80 for the life of the
  // process while control traffic looked healthy.
  let now = 1_000
  const guard = createRendererIpcGuard({ now: () => now })

  for (let index = 0; index < MAX_DIAGNOSTIC_FRAMES_PER_WINDOW; index++) {
    guard.assertAllowed({ index }, 'diagnostics')
  }
  expect(() => guard.assertAllowed({ overflow: true }, 'diagnostics')).toThrow(
    'Too many requests at once. Wait a moment and try again.',
  )

  now += RATE_WINDOW_MS
  expect(() => guard.assertAllowed({ nextWindow: true }, 'diagnostics')).not.toThrow()
})

test('a backward wall-clock jump opens a fresh bounded rate window', () => {
  let now = 100_000
  const guard = createRendererIpcGuard({ now: () => now })
  for (let index = 0; index < MAX_FRAMES_PER_WINDOW; index++) {
    guard.assertAllowed({ index })
  }
  expect(() => guard.assertAllowed({ overflow: true })).toThrow(RendererIpcRejection)

  now = 10
  now += RATE_WINDOW_MS * 2
  expect(() => guard.assertAllowed({ afterRollback: true })).not.toThrow()
})

test('a rejection says whether it can clear on its own', () => {
  // The acknowledgement queue retries a rate rejection and drops anything else.
  // Without the distinction a size or serialization rejection would re-reject
  // identical bytes every tick forever and the queue would never drain.
  let now = 1_000
  const guard = createRendererIpcGuard({ now: () => now })

  const oversized = (() => {
    try {
      guard.assertAllowed('x'.repeat(MAX_FRAME_BYTES + 1))
    } catch (error) {
      return error
    }
  })()
  expect(oversized).toBeInstanceOf(RendererIpcRejection)
  expect((oversized as RendererIpcRejection).reason).toBe('size')

  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  try {
    guard.assertAllowed(cyclic)
  } catch (error) {
    expect((error as RendererIpcRejection).reason).toBe('serialization')
  }

  for (let index = 0; index < MAX_FRAMES_PER_WINDOW; index++) guard.assertAllowed({ index })
  try {
    guard.assertAllowed({ overflow: true })
  } catch (error) {
    expect((error as RendererIpcRejection).reason).toBe('rate')
  }
})
