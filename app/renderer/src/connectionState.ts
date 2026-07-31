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
