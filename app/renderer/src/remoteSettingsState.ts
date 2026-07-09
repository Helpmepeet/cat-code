import type {
  RemoteSettingsResultFrame,
  RemoteSettingsSnapshot,
  ServerFrame,
  SessionId,
} from '../../shared/protocol.js'

/**
 * Renderer projection of the P4-13 RemoteSettings read-seam (D3 cut scope).
 * Same shape as `accountsState.ts`: kept per session (uniform with the other
 * domains), the panel reads the ACTIVE session's snapshot. `lastResult` carries
 * the most recent `remoteSettings.result` so the panel can toast on the verb's
 * real outcome — never an optimistic guess.
 */
export type RemoteSettingsState = {
  sessions: Record<SessionId, RemoteSettingsSnapshot | null>
  lastResult: RemoteSettingsResultFrame | null
}

export type RemoteSettingsAction = { type: 'frame'; frame: ServerFrame }

export function createRemoteSettingsState(): RemoteSettingsState {
  return { sessions: {}, lastResult: null }
}

export function reduceRemoteSettingsState(
  state: RemoteSettingsState,
  action: RemoteSettingsAction,
): RemoteSettingsState {
  const { frame } = action

  if (frame.kind === 'remoteSettings.snapshot') {
    return {
      ...state,
      sessions: { ...state.sessions, [frame.sessionId]: frame.remoteSettings },
    }
  }

  if (frame.kind === 'remoteSettings.result') {
    return { ...state, lastResult: frame }
  }

  if (frame.kind === 'lifecycle') {
    if (!(frame.sessionId in state.sessions)) return state
    return {
      ...state,
      sessions: { ...state.sessions, [frame.sessionId]: null },
    }
  }

  return state
}

export function selectRemoteSettingsSnapshot(
  state: RemoteSettingsState,
  sessionId: SessionId | null,
): RemoteSettingsSnapshot | null {
  const snapshot = sessionId ? state.sessions[sessionId] : undefined
  return snapshot ?? null
}
