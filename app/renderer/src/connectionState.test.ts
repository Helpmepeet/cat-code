import { expect, test } from 'bun:test'
import {
  connectionHasEngine,
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
  parked: true,
}
const ALL_STATUSES = Object.keys(
  STATUS_COVERAGE,
) as ConnectionSnapshot['status'][]

const validReady = {
  kind: 'ready',
  protocolVersion: 2,
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
    protocolVersion: 2,
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
    protocolVersion: 2,
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
    protocolVersion: 2,
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
    protocolVersion: 2,
    sessionId: 'session-3',
    code: 'session_not_found',
    message: 'session is gone',
    retryable: false,
  })
  expect(selectConnection(state, 'session-3').status).toBe('dead')

  state = reduceConnectionState(state, {
    kind: 'error',
    protocolVersion: 2,
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

/* ------------------------------------------------------------------------- *
 * IDLE-PARK — an intentional park is not a crash (decisions/IDLE-PARK.md)
 * ------------------------------------------------------------------------- */

function parkExitFrame(sessionId: string): ServerFrame {
  return {
    kind: 'lifecycle',
    protocolVersion: 2,
    sessionId,
    status: 'exited',
    // PARKED_EXIT_CODE — the sidecar's gated self-exit code, the same signal the
    // host classifies on. Written literally so a silent change to the shared
    // constant has to be re-stated here rather than sliding through.
    exit: { code: 5, signal: null },
  } as ServerFrame
}

test('an intentional park is read off the exit code, not treated as a crash', () => {
  let state = reduceConnectionState(
    createConnectionState(),
    validReady as ServerFrame,
  )
  state = reduceConnectionState(state, parkExitFrame('session-1'))

  expect(selectConnection(state, 'session-1')).toEqual({
    status: 'parked',
    inputEnabled: false,
  })
  // The three things the operator rejected, all absent.
  expect(isTerminalConnectionStatus('parked')).toBe(false)
  expect(connectionTone('parked')).toBe('neutral')
  expect(connectionRecoveryMessage('parked')).toBeNull()
})

test('only the park exit code is a park; every other death stays honest', () => {
  const readyFor = (sessionId: string): ServerFrame =>
    ({ ...validReady, sessionId }) as ServerFrame
  const exitWith = (sessionId: string, code: number | null): ServerFrame =>
    ({
      kind: 'lifecycle',
      protocolVersion: 2,
      sessionId,
      status: 'exited',
      exit: { code, signal: null },
    }) as ServerFrame

  let state = createConnectionState()
  for (const sessionId of ['crash', 'resume-failed', 'signalled', 'clean']) {
    state = reduceConnectionState(state, readyFor(sessionId))
  }
  // A real crash, the RESUME_FAILED_EXIT_CODE death of an unloadable transcript,
  // a signal kill, and a plain zero exit are all still `exited` — the honest
  // "this stopped" reading with its danger tone and recovery sentence.
  state = reduceConnectionState(state, exitWith('crash', 1))
  state = reduceConnectionState(state, exitWith('resume-failed', 4))
  state = reduceConnectionState(state, exitWith('signalled', null))
  state = reduceConnectionState(state, exitWith('clean', 0))

  for (const sessionId of ['crash', 'resume-failed', 'signalled', 'clean']) {
    expect(selectConnection(state, sessionId).status).toBe('exited')
  }
  expect(connectionTone('exited')).toBe('danger')
  expect(connectionRecoveryMessage('exited')).toBe(
    'This session stopped unexpectedly. Restart it to keep working.',
  )
})

test('a park exit code cannot smuggle a park reading into a non-exit lifecycle status', () => {
  // `disconnected` / `failed` are transport and spawn failures with no exit
  // behind them. Reclassifying on the code alone would let a socket death that
  // happened to carry one read as a deliberate park.
  for (const status of ['disconnected', 'failed'] as const) {
    const state = reduceConnectionState(createConnectionState(), {
      kind: 'lifecycle',
      protocolVersion: 2,
      sessionId: 'session-1',
      status,
      exit: { code: 5, signal: null },
    } as ServerFrame)
    expect(selectConnection(state, 'session-1').status).toBe(status)
  }
})

test('parked is the first status where "not terminal" stops meaning "reachable"', () => {
  // The trap this predicate exists for: before `parked`, every non-terminal
  // status had a process behind it, so a caller could ask "is it terminal?" and
  // mean "can I send to it?". A verb sent to a parked session comes back
  // `session_not_found`, which the reducer maps to `dead` — a false failure over
  // a healthy session (the context-breakdown popover bug, once already).
  expect(isTerminalConnectionStatus('parked')).toBe(false)
  expect(connectionHasEngine('parked')).toBe(false)

  for (const status of ALL_STATUSES) {
    if (status === 'parked') continue
    expect(connectionHasEngine(status)).toBe(!isTerminalConnectionStatus(status))
  }
})

test('a parked session holds its queued prompt and asks for its engine back', () => {
  // The whole point of the non-terminal classification: `release` would put the
  // text back in the composer and demand a manual Restart, which is the
  // behaviour being removed. `restore` re-spawns and keeps holding.
  expect(
    resolvePendingSubmit({ status: 'parked', inputEnabled: false }),
  ).toBe('restore')
})

test('restoring a parked session leaves the parked reading behind', () => {
  let state = reduceConnectionState(
    createConnectionState(),
    validReady as ServerFrame,
  )
  state = reduceConnectionState(state, parkExitFrame('session-1'))
  expect(selectConnection(state, 'session-1').status).toBe('parked')

  // The resumed sidecar's own ready frame is the generation change; nothing
  // sticky may survive it.
  state = reduceConnectionState(state, validReady as ServerFrame)
  expect(selectConnection(state, 'session-1')).toEqual({
    status: 'ready',
    inputEnabled: true,
  })
  expect(resolvePendingSubmit(selectConnection(state, 'session-1'))).toBe('send')
})

test('a stray verb from a parked pane cannot turn the park back into a crash', () => {
  // The composer is deliberately LIVE on a parked session, so a control that
  // dispatches to the engine is reachable. `supervisor.send` answers
  // `session_disconnected` for the tombstone record (or `session_not_found` once
  // deregistered), and mapping either one would have restored the entire defect
  // in a single click: danger banner, Restart button, read-only composer, and a
  // released prompt. Neither reply carries news — we reclaimed the engine on
  // purpose.
  for (const code of ['session_disconnected', 'session_not_found'] as const) {
    let state = reduceConnectionState(
      createConnectionState(),
      validReady as ServerFrame,
    )
    state = reduceConnectionState(state, parkExitFrame('session-1'))
    expect(selectConnection(state, 'session-1').status).toBe('parked')

    state = reduceConnectionState(state, {
      kind: 'error',
      protocolVersion: 2,
      sessionId: 'session-1',
      code,
      message: 'no engine',
      retryable: false,
    } as ServerFrame)

    expect(selectConnection(state, 'session-1').status).toBe('parked')
    expect(connectionTone(selectConnection(state, 'session-1').status)).toBe(
      'neutral',
    )
  }
})

test('the unpark in progress is still allowed to move a parked session', () => {
  // `session_not_ready` is minted ONLY while a child is genuinely spawning, so
  // for a parked session it means the restore is under way. Absorbing it too
  // would have made `'parked'` sticky and hidden a spawn that then failed.
  let state = reduceConnectionState(
    createConnectionState(),
    validReady as ServerFrame,
  )
  state = reduceConnectionState(state, parkExitFrame('session-1'))
  state = reduceConnectionState(state, {
    kind: 'error',
    protocolVersion: 2,
    sessionId: 'session-1',
    code: 'session_not_ready',
    message: 'still spawning',
    retryable: true,
  } as ServerFrame)

  expect(selectConnection(state, 'session-1').status).toBe('starting')
})

test('a session that never parked still reports a send failure honestly', () => {
  // The guard is keyed on the session ALREADY being parked; it must not soften
  // the ordinary transport-failure path.
  let state = reduceConnectionState(
    createConnectionState(),
    validReady as ServerFrame,
  )
  state = reduceConnectionState(state, {
    kind: 'error',
    protocolVersion: 2,
    sessionId: 'session-1',
    code: 'session_disconnected',
    message: 'gone',
    retryable: false,
  } as ServerFrame)

  expect(selectConnection(state, 'session-1').status).toBe('disconnected')
  expect(isTerminalConnectionStatus('disconnected')).toBe(true)
})

test('a restore that dies after a park is reported, not hidden by the park', () => {
  // The failure mode a "once parked, stay parked" latch would have created: a
  // re-spawn that fails must still reach the user honestly.
  let state = reduceConnectionState(
    createConnectionState(),
    validReady as ServerFrame,
  )
  state = reduceConnectionState(state, parkExitFrame('session-1'))
  state = reduceConnectionState(state, {
    kind: 'lifecycle',
    protocolVersion: 2,
    sessionId: 'session-1',
    status: 'failed',
  } as ServerFrame)

  expect(selectConnection(state, 'session-1').status).toBe('failed')
  expect(connectionTone('failed')).toBe('danger')
  expect(resolvePendingSubmit(selectConnection(state, 'session-1'))).toBe(
    'release',
  )
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
    protocolVersion: 2,
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
    protocolVersion: 2,
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

test('session removal drops the connection entry', () => {
  const state = { sessions: { gone: { status: 'ready' as const, inputEnabled: true } } }
  expect(reduceConnectionState(state, { type: 'session-removed', sessionId: 'gone' })).toEqual({ sessions: {} })
})
