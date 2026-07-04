import { expect, test } from 'bun:test'
import {
  createConnectionState,
  isAppReadyFrame,
  reduceConnectionState,
  selectConnection,
} from './connectionState.js'
import type { ServerFrame } from '../../shared/protocol.js'

const validReady = {
  kind: 'ready',
  protocolVersion: 1,
  sessionId: 'session-1',
  engineSessionId: 'engine-session-1',
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
  expect(isAppReadyFrame({ ...validReady, engineSessionId: '' })).toBe(false)
  expect(
    isAppReadyFrame({
      ...validReady,
      engineSessionId: undefined,
    }),
  ).toBe(false)
  expect(isAppReadyFrame({ kind: 'ready' })).toBe(false)
  expect(isAppReadyFrame(null)).toBe(false)
})

test('tracks terminal supervisor lifecycle state and disables input', () => {
  let state = reduceConnectionState(
    createConnectionState(),
    validReady as ServerFrame,
  )
  expect(selectConnection(state, 'session-1')).toEqual({
    status: 'ready',
    inputEnabled: true,
  })

  state = reduceConnectionState(state, {
    kind: 'lifecycle',
    protocolVersion: 1,
    sessionId: 'session-1',
    status: 'disconnected',
  } as ServerFrame)
  expect(selectConnection(state, 'session-1')).toEqual({
    status: 'disconnected',
    inputEnabled: false,
  })
})

test('a lifecycle frame only disables its addressed session', () => {
  let state = createConnectionState()
  state = reduceConnectionState(state, validReady as ServerFrame)
  state = reduceConnectionState(state, {
    ...validReady,
    sessionId: 'session-2',
  } as ServerFrame)
  state = reduceConnectionState(state, {
    kind: 'lifecycle',
    protocolVersion: 1,
    sessionId: 'session-1',
    status: 'disconnected',
  })

  expect(selectConnection(state, 'session-2')).toEqual({
    status: 'ready',
    inputEnabled: true,
  })
  expect(selectConnection(state, 'session-1').status).toBe('disconnected')
})

test('typed forward failures update only the addressed session state', () => {
  let state = createConnectionState()
  state = reduceConnectionState(state, validReady as ServerFrame)
  state = reduceConnectionState(state, {
    ...validReady,
    sessionId: 'session-2',
    engineSessionId: 'engine-session-2',
  } as ServerFrame)

  state = reduceConnectionState(state, {
    kind: 'error',
    protocolVersion: 1,
    sessionId: 'session-2',
    code: 'session_not_ready',
    message: 'session is still spawning',
    retryable: true,
  })
  expect(selectConnection(state, 'session-2')).toEqual({
    status: 'starting',
    inputEnabled: false,
  })
  expect(selectConnection(state, 'session-1')).toEqual({
    status: 'ready',
    inputEnabled: true,
  })

  state = reduceConnectionState(state, {
    kind: 'error',
    protocolVersion: 1,
    sessionId: 'session-3',
    code: 'session_not_found',
    message: 'session is gone',
    retryable: false,
  })
  expect(selectConnection(state, 'session-3').status).toBe('dead')

  state = reduceConnectionState(state, {
    kind: 'error',
    protocolVersion: 1,
    sessionId: 'session-2',
    code: 'session_disconnected',
    message: 'sidecar exited',
    retryable: false,
  })
  expect(selectConnection(state, 'session-2').status).toBe('disconnected')
  expect(selectConnection(state, 'session-1').status).toBe('ready')
})
