import { expect, test } from 'bun:test'
import { isAppReadyFrame } from './connectionState.js'

const validReady = {
  kind: 'ready',
  protocolVersion: 1,
  sessionId: 'session-1',
  payload: {
    type: 'app.ready',
    protocolVersion: 1,
    inputEnabled: true,
    activeTurn: false,
    abort: { status: 'idle' },
    goalSnapshot: null,
    pendingPermissionRequests: [],
  },
}

test('accepts only a ready frame carrying an app.ready payload', () => {
  expect(isAppReadyFrame(validReady)).toBe(true)
})

test('rejects unrelated and malformed frames', () => {
  expect(isAppReadyFrame({ ...validReady, kind: 'event' })).toBe(false)
  expect(
    isAppReadyFrame({
      ...validReady,
      payload: { ...validReady.payload, type: 'app.pong' },
    }),
  ).toBe(false)
  expect(isAppReadyFrame({ kind: 'ready' })).toBe(false)
  expect(isAppReadyFrame(null)).toBe(false)
})
