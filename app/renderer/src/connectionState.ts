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
