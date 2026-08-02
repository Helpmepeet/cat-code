import { expect, test } from 'bun:test'
import {
  connectionRecoveryMessage,
  connectionTone,
  createConnectionState,
  isAppReadyFrame,
  isTerminalConnectionStatus,
  reduceConnectionState,
  selectConnection,
} from './connectionState.js'
import type { ConnectionSnapshot } from './connectionState.js'
import { resolvePendingSubmit } from './composerState.js'
import type { ServerFrame } from '../../shared/protocol.js'

/** Adding a status to the union without listing it here is a compile error, so
 * the two assertions below can never silently stop covering a member. */
const STATUS_COVERAGE: Record<ConnectionSnapshot['status'], true> = {
  connecting: true,
  starting: true,
  ready: true,
  dead: true,
  disconnected: true,
  failed: true,
  exited: true,
}
const ALL_STATUSES = Object.keys(
  STATUS_COVERAGE,
) as ConnectionSnapshot['status'][]

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

test('classifies the spawn-in-flight statuses as transient and the rest as terminal', () => {
  const terminal = ALL_STATUSES.filter(status =>
    isTerminalConnectionStatus(status),
  )
  expect(terminal.sort()).toEqual(['dead', 'disconnected', 'exited', 'failed'])
})

test('the terminal partition agrees with the parked-prompt classifier', () => {
  for (const status of ALL_STATUSES) {
    // `release` is `resolvePendingSubmit`'s "this spawn will never complete"
    // arm. A second, divergent list is exactly what this pins shut.
    const releases =
      resolvePendingSubmit({ status, inputEnabled: false }) === 'release'
    expect(isTerminalConnectionStatus(status)).toBe(releases)
  }
})

test('the tone grammar has exactly two tones and reads danger only for terminal states', () => {
  const tones = new Set(ALL_STATUSES.map(status => connectionTone(status)))
  expect([...tones].sort()).toEqual(['danger', 'neutral'])

  for (const status of ALL_STATUSES) {
    // Pinned to the partition, not to a parallel list: a transient can never
    // acquire the failure tone, which is the whole 24b guarantee.
    expect(connectionTone(status)).toBe(
      isTerminalConnectionStatus(status) ? 'danger' : 'neutral',
    )
  }
})

test('every danger status has a sentence and no transient one does', () => {
  for (const status of ALL_STATUSES) {
    const message = connectionRecoveryMessage(status)
    if (connectionTone(status) === 'danger') {
      expect(typeof message).toBe('string')
      expect((message as string).length).toBeGreaterThan(0)
    } else {
      expect(message).toBeNull()
    }
  }
})

test('no recovery sentence prints the engine discriminant or an em dash', () => {
  for (const status of ALL_STATUSES) {
    const message = connectionRecoveryMessage(status)
    if (message === null) continue
    // The defect this replaces was literally `Session {status}.`, so every
    // status word is barred from every sentence, not just its own.
    for (const word of ALL_STATUSES) {
      expect(message.toLowerCase()).not.toContain(word)
    }
    expect(message).not.toContain('—')
  }
})

const turnStatus = (sessionId: string, activeTurn: boolean) =>
  ({
    kind: 'event',
    protocolVersion: 1,
    sessionId,
    event: { type: 'turn.status', activeTurn },
  }) as unknown as ServerFrame

test('a live turn closes and reopens input across the turn boundary', () => {
  // The regression this pins: `inputEnabled` used to come ONLY from the
  // `ready` handshake, so it held its attach-time value for the whole session
  // and `generating` (App.tsx) was false for the entire turn — the activity
  // indicator, Stop, Esc-to-interrupt and the mid-turn composer queue all
  // rendered as if nothing were running.
  let state = reduceConnectionState(
    createConnectionState(),
    validReady as ServerFrame,
  )
  expect(selectConnection(state, 'session-1').inputEnabled).toBe(true)

  state = reduceConnectionState(state, turnStatus('session-1', true))
  expect(selectConnection(state, 'session-1')).toEqual({
    status: 'ready',
    inputEnabled: false,
  })

  state = reduceConnectionState(state, turnStatus('session-1', false))
  expect(selectConnection(state, 'session-1')).toEqual({
    status: 'ready',
    inputEnabled: true,
  })
})

test('a turn boundary never revives a session the lifecycle already killed', () => {
  let state = reduceConnectionState(
    createConnectionState(),
    validReady as ServerFrame,
  )
  state = reduceConnectionState(state, {
    kind: 'lifecycle',
    protocolVersion: 1,
    sessionId: 'session-1',
    status: 'exited',
  } as ServerFrame)

  // A late turn frame may only move `inputEnabled`; the status it finds is the
  // one the lifecycle set, so a dead pane cannot read as ready again.
  state = reduceConnectionState(state, turnStatus('session-1', false))
  expect(selectConnection(state, 'session-1').status).toBe('exited')
  expect(isTerminalConnectionStatus(selectConnection(state, 'session-1').status)).toBe(
    true,
  )
})

test('a turn frame for an unknown session is a no-op', () => {
  const state = createConnectionState()
  expect(reduceConnectionState(state, turnStatus('ghost', true))).toBe(state)
})

test('a repeated turn value returns the identical state object', () => {
  const state = reduceConnectionState(
    createConnectionState(),
    validReady as ServerFrame,
  )
  // Reference equality, so a re-broadcast cannot churn a React render.
  expect(reduceConnectionState(state, turnStatus('session-1', false))).toBe(state)
})
