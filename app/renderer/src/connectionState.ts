import type {
  LifecycleFrame,
  ReadyFrame,
  ServerFrame,
  SessionId,
} from '../../shared/protocol.js'

export type ConnectionSnapshot = {
  status:
    | 'connecting'
    | 'starting'
    | 'ready'
    | 'dead'
    | LifecycleFrame['status']
  inputEnabled: boolean
}

export type ConnectionState = {
  sessions: Record<SessionId, ConnectionSnapshot>
}

const CONNECTING: ConnectionSnapshot = {
  status: 'connecting',
  inputEnabled: false,
}

export function createConnectionState(): ConnectionState {
  return { sessions: {} }
}

export function selectConnection(
  state: ConnectionState,
  sessionId: SessionId | null,
): ConnectionSnapshot {
  return sessionId ? (state.sessions[sessionId] ?? CONNECTING) : CONNECTING
}

/**
 * Terminal vs transient for the connection union — the partition a recovery
 * affordance must read before it calls a session failed.
 *
 * `starting` is TRANSIENT, not a spawn-lifecycle failure. It is projected below
 * from an `error` frame carrying `session_not_ready`, which the supervisor mints
 * only while the child is still `spawning`/`connecting`
 * (`sendFailureCodeForStatus`, `app/supervisor/supervisor.ts:509`) and which is
 * the single send-failure code the wire marks `retryable: true`
 * (`SidecarSendError.retryable`, `supervisor.ts:127`; `ErrorFrame.retryable`,
 * `app/shared/protocol.ts:564`). The spawn has not failed, it has not finished.
 * The other two codes are non-retryable and map to `dead` / `disconnected`.
 *
 * This partition must agree with `resolvePendingSubmit` (`composerState.ts`),
 * which splits the SAME union for parked prompts: everything terminal here is
 * exactly what it `release`s. `connectionState.test.ts` pins that agreement.
 */
export function isTerminalConnectionStatus(
  status: ConnectionSnapshot['status'],
): boolean {
  switch (status) {
    case 'connecting':
    case 'starting':
    case 'ready':
      return false
    case 'dead':
    case 'disconnected':
    case 'failed':
    case 'exited':
      return true
    default: {
      const exhaustive: never = status
      return exhaustive
    }
  }
}

/**
 * The connection tone grammar (24b ruling): exactly two tones, and the transient
 * one is the ABSENCE of a failure presentation, not a second style.
 *
 * Derived from `isTerminalConnectionStatus` rather than from a second switch, so
 * a status can never be transient for the recovery guard and danger for its
 * paint. A member added to the union has to be classified once, above, and
 * inherits its tone here — which is the whole point: the next transient state
 * cannot present as a failure because its author picked a colour.
 */
export type ConnectionTone = 'neutral' | 'danger'

export function connectionTone(
  status: ConnectionSnapshot['status'],
): ConnectionTone {
  return isTerminalConnectionStatus(status) ? 'danger' : 'neutral'
}

/**
 * What a `danger` connection says to the user, in place of the engine's own
 * discriminant (`Session dead.` was the literal prior copy).
 *
 * Transient statuses have no sentence because they mount no bar;
 * `connectionState.test.ts` pins the null-vs-sentence split to the tone so the
 * two lists cannot drift, and pins that no sentence contains its own status word.
 */
export function connectionRecoveryMessage(
  status: ConnectionSnapshot['status'],
): string | null {
  switch (status) {
    case 'connecting':
    case 'starting':
    case 'ready':
      return null
    case 'dead':
      return 'This session is no longer available. Restart it to keep working.'
    case 'disconnected':
      return 'This session lost its connection. Restart it to reconnect.'
    case 'failed':
      return 'This session could not start. Restart it to try again.'
    case 'exited':
      return 'This session stopped unexpectedly. Restart it to keep working.'
    default: {
      const exhaustive: never = status
      return exhaustive
    }
  }
}

export function reduceConnectionState(
  state: ConnectionState,
  frame: ServerFrame,
): ConnectionState {
  if (isAppReadyFrame(frame)) {
    return {
      ...state,
      sessions: {
        ...state.sessions,
        [frame.sessionId]: {
          status: 'ready',
          inputEnabled: frame.payload.inputEnabled,
        },
      },
    }
  }
  if (frame.kind === 'lifecycle') {
    return {
      ...state,
      sessions: {
        ...state.sessions,
        [frame.sessionId]: {
          status: frame.status,
          inputEnabled: false,
        },
      },
    }
  }
  // The engine's live turn boundary (`AppSessionController.setActiveTurn`).
  // Without it `inputEnabled` would only ever hold the value the `ready`
  // handshake carried at attach, so a session that started a turn afterwards
  // still read as idle — which is what silently disabled the whole in-turn
  // activity surface (indicator, Stop, Esc, the mid-turn composer queue).
  //
  // Only `inputEnabled` moves: `status` stays whatever the lifecycle/error
  // frames last said, so a turn event can never resurrect a dead session.
  if (frame.kind === 'event' && frame.event.type === 'turn.status') {
    const existing = state.sessions[frame.sessionId]
    if (!existing) return state
    const inputEnabled = !frame.event.activeTurn
    if (existing.inputEnabled === inputEnabled) return state
    return {
      ...state,
      sessions: {
        ...state.sessions,
        [frame.sessionId]: { ...existing, inputEnabled },
      },
    }
  }

  if (frame.kind === 'error') {
    const status =
      frame.code === 'session_not_found'
        ? 'dead'
        : frame.code === 'session_not_ready'
          ? 'starting'
          : frame.code === 'session_disconnected'
            ? 'disconnected'
            : null
    if (!status) return state
    return {
      ...state,
      sessions: {
        ...state.sessions,
        [frame.sessionId]: {
          status,
          inputEnabled: false,
        },
      },
    }
  }
  return state
}

export function isAppReadyFrame(frame: unknown): frame is ReadyFrame {
  if (typeof frame !== 'object' || frame === null) return false
  const candidate = frame as {
    kind?: unknown
    sessionId?: unknown
    engineSessionId?: unknown
    payload?: { type?: unknown }
  }
  return (
    candidate.kind === 'ready' &&
    typeof candidate.sessionId === 'string' &&
    typeof candidate.engineSessionId === 'string' &&
    candidate.engineSessionId.length > 0 &&
    typeof candidate.payload === 'object' &&
    candidate.payload !== null &&
    candidate.payload.type === 'app.ready'
  )
}
