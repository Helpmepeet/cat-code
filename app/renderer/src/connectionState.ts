import type {
  LifecycleFrame,
  ReadyFrame,
  ServerFrame,
  SessionId,
} from '../../shared/protocol.js'

export type ConnectionSnapshot = {
  status: 'connecting' | 'ready' | LifecycleFrame['status']
  inputEnabled: boolean
}

export type ConnectionState = {
  activeSessionId: SessionId | null
  sessions: Record<SessionId, ConnectionSnapshot>
}

const CONNECTING: ConnectionSnapshot = {
  status: 'connecting',
  inputEnabled: false,
}

export function createConnectionState(): ConnectionState {
  return { activeSessionId: null, sessions: {} }
}

export function selectConnection(
  state: ConnectionState,
  sessionId: SessionId | null = state.activeSessionId,
): ConnectionSnapshot {
  return sessionId ? (state.sessions[sessionId] ?? CONNECTING) : CONNECTING
}

export function reduceConnectionState(
  state: ConnectionState,
  frame: ServerFrame,
): ConnectionState {
  if (isAppReadyFrame(frame)) {
    return {
      activeSessionId: frame.sessionId,
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
  return state
}

export function isAppReadyFrame(frame: unknown): frame is ReadyFrame {
  if (typeof frame !== 'object' || frame === null) return false
  const candidate = frame as {
    kind?: unknown
    payload?: { type?: unknown }
  }
  return (
    candidate.kind === 'ready' &&
    typeof candidate.payload === 'object' &&
    candidate.payload !== null &&
    candidate.payload.type === 'app.ready'
  )
}
