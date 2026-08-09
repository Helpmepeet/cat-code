import { describe, expect, test } from 'bun:test'
import {
  createSessionActionRuntimeState,
  reduceSessionActionRuntimeState,
  selectLatestSessionActionError,
  selectLatestSessionActionResult,
} from './sessionActionRuntimeState.js'
import {
  PROTOCOL_VERSION,
  type ServerFrame,
  type SessionId,
} from '../../shared/protocol.js'

const SESSION = 'sess-1' as SessionId
const OTHER = 'sess-2' as SessionId

function resultFrame(
  over: Partial<Extract<ServerFrame, { kind: 'session-action.result' }>> = {},
): ServerFrame {
  return {
    kind: 'session-action.result',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SESSION,
    requestId: 'r1',
    verb: 'rename',
    ok: true,
    message: 'Renamed.',
    ...over,
  }
}

describe('sessionActionRuntimeState', () => {
  test('records the latest result per session and selects it back', () => {
    let state = createSessionActionRuntimeState()
    state = reduceSessionActionRuntimeState(state, {
      type: 'frame',
      frame: resultFrame({ verb: 'export', exportText: 'HELLO' }),
    })

    const result = selectLatestSessionActionResult(state, SESSION)
    expect(result?.verb).toBe('export')
    expect(result?.exportText).toBe('HELLO')
    // An untracked session selects null.
    expect(selectLatestSessionActionResult(state, OTHER)).toBeNull()
    expect(selectLatestSessionActionResult(state, null)).toBeNull()
  })

  test('a newer result overwrites the prior one for the same session', () => {
    let state = createSessionActionRuntimeState()
    state = reduceSessionActionRuntimeState(state, {
      type: 'frame',
      frame: resultFrame({ requestId: 'r1', verb: 'rename', ok: true }),
    })
    state = reduceSessionActionRuntimeState(state, {
      type: 'frame',
      frame: resultFrame({ requestId: 'r2', verb: 'branch', ok: false, message: 'no' }),
    })

    const result = selectLatestSessionActionResult(state, SESSION)
    expect(result?.requestId).toBe('r2')
    expect(result?.verb).toBe('branch')
    expect(result?.ok).toBe(false)
  })

  test('discarding a latched export releases its payload without erasing a newer result', () => {
    let state = reduceSessionActionRuntimeState(createSessionActionRuntimeState(), {
      type: 'frame',
      frame: resultFrame({ requestId: 'export', verb: 'export', exportText: 'HELLO' }),
    })
    state = reduceSessionActionRuntimeState(state, {
      type: 'discard-result',
      sessionId: SESSION,
      requestId: 'export',
    })
    expect(selectLatestSessionActionResult(state, SESSION)).toBeNull()
    expect(state.lastBySession).not.toHaveProperty(SESSION)

    state = reduceSessionActionRuntimeState(state, {
      type: 'frame',
      frame: resultFrame({ requestId: 'newer', verb: 'rename' }),
    })
    const preserved = reduceSessionActionRuntimeState(state, {
      type: 'discard-result',
      sessionId: SESSION,
      requestId: 'export',
    })
    expect(preserved).toBe(state)
    expect(selectLatestSessionActionResult(preserved, SESSION)?.requestId).toBe('newer')
  })

  test('a lifecycle frame clears a tracked session, leaves untracked alone', () => {
    let state = createSessionActionRuntimeState()
    state = reduceSessionActionRuntimeState(state, {
      type: 'frame',
      frame: resultFrame(),
    })
    const before = state

    // Untracked session lifecycle → no change (same reference).
    state = reduceSessionActionRuntimeState(state, {
      type: 'frame',
      frame: {
        kind: 'lifecycle',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: OTHER,
        status: 'disconnected',
      } as unknown as ServerFrame,
    })
    expect(state).toBe(before)

    // Tracked session lifecycle → cleared.
    state = reduceSessionActionRuntimeState(state, {
      type: 'frame',
      frame: {
        kind: 'lifecycle',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: SESSION,
        status: 'disconnected',
      } as unknown as ServerFrame,
    })
    expect(selectLatestSessionActionResult(state, SESSION)).toBeNull()
  })

  test('records a correlated error separately from a verb result', () => {
    const state = reduceSessionActionRuntimeState(
      createSessionActionRuntimeState(),
      {
        type: 'frame',
        frame: {
          kind: 'error',
          protocolVersion: PROTOCOL_VERSION,
          sessionId: SESSION,
          requestId: 'export-request',
          code: 'session_disconnected',
          message: 'This session is disconnected.',
          retryable: true,
        },
      },
    )

    expect(selectLatestSessionActionResult(state, SESSION)).toBeNull()
    expect(selectLatestSessionActionError(state, SESSION)).toEqual({
      requestId: 'export-request',
      message: 'This session is disconnected.',
    })
  })

  test('an unrelated frame kind is ignored', () => {
    const state = createSessionActionRuntimeState()
    const next = reduceSessionActionRuntimeState(state, {
      type: 'frame',
      frame: { kind: 'pong', protocolVersion: PROTOCOL_VERSION, sessionId: SESSION, nonce: 'n' } as unknown as ServerFrame,
    })
    expect(next).toBe(state)
  })
})
