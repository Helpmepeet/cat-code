import type {
  RemoteSettingsResultFrame,
  RemoteSettingsSnapshot,
  RemoteVerbMessage,
  ServerFrame,
  SessionId,
} from '../../shared/protocol.js'

export type RemoteSettingsOutcome = RemoteSettingsResultFrame & { delivery?: 'refused' | 'unknown' }
type RemoteRequest = { sessionId: SessionId; verb: RemoteVerbMessage['type'] }
/**
 * Renderer projection of the P4-13 RemoteSettings read-seam (D3 cut scope).
 * Same shape as `accountsState.ts`: kept per session (uniform with the other
 * domains), the panel reads the ACTIVE session's snapshot. `lastResult` carries
 * the most recent `remoteSettings.result` so the panel can toast on the verb's
 * real outcome — never an optimistic guess.
 */
export type RemoteSettingsState = {
  sessions: Record<SessionId, RemoteSettingsSnapshot | null>
  lastResult: RemoteSettingsOutcome | null
  pendingByRequestId: Record<string, RemoteRequest>
  outcomesByRequestId: Record<string, RemoteSettingsOutcome>
}

export type RemoteSettingsAction =
  | { type: 'frame'; frame: ServerFrame }
  | { type: 'request'; sessionId: SessionId; verb: RemoteVerbMessage }

export function createRemoteSettingsState(): RemoteSettingsState {
  return { sessions: {}, lastResult: null, pendingByRequestId: {}, outcomesByRequestId: {} }
}

function rememberOutcome(state: RemoteSettingsState, outcome: RemoteSettingsOutcome): RemoteSettingsState {
  const outcomesByRequestId = { ...state.outcomesByRequestId, [outcome.requestId]: outcome }
  for (const id of Object.keys(outcomesByRequestId).slice(0, -64)) delete outcomesByRequestId[id]
  return { ...state, lastResult: outcome, outcomesByRequestId }
}

export function reduceRemoteSettingsState(
  state: RemoteSettingsState,
  action: RemoteSettingsAction,
): RemoteSettingsState {
  if (action.type === 'request') {
    const pendingByRequestId = Object.fromEntries(Object.entries(state.pendingByRequestId).filter(([, request]) =>
      request.sessionId !== action.sessionId || request.verb !== action.verb.type,
    ))
    pendingByRequestId[action.verb.requestId] = { sessionId: action.sessionId, verb: action.verb.type }
    for (const id of Object.keys(pendingByRequestId).slice(0, -64)) delete pendingByRequestId[id]
    return { ...state, pendingByRequestId }
  }
  const { frame } = action

  if (frame.kind === 'remoteSettings.snapshot') {
    return {
      ...state,
      sessions: { ...state.sessions, [frame.sessionId]: frame.remoteSettings },
    }
  }

  if (frame.kind === 'remoteSettings.result') {
    const request = state.pendingByRequestId[frame.requestId]
    if (request && (request.sessionId !== frame.sessionId || request.verb !== frame.verb)) return state
    const pendingByRequestId = { ...state.pendingByRequestId }
    delete pendingByRequestId[frame.requestId]
    return rememberOutcome({ ...state, pendingByRequestId }, frame)
  }

  if (frame.kind === 'error' && frame.requestId) {
    const request = state.pendingByRequestId[frame.requestId]
    if (!request || request.sessionId !== frame.sessionId) return state
    // Only these codes are issued before supervisor.socket.write. bad_request
    // also wraps arbitrary write exceptions, so it cannot release a mutation.
    const refused = frame.code === 'session_not_found' || frame.code === 'session_not_ready' || frame.code === 'session_disconnected'
    const pendingByRequestId = { ...state.pendingByRequestId }
    if (refused) delete pendingByRequestId[frame.requestId]
    return rememberOutcome({ ...state, pendingByRequestId }, {
      kind: 'remoteSettings.result', protocolVersion: frame.protocolVersion,
      sessionId: frame.sessionId, requestId: frame.requestId, verb: request.verb,
      ok: false, delivery: refused ? 'refused' : 'unknown',
      message: refused ? 'The request was not sent. Check the session before trying again.' : 'Delivery is unknown. Wait for the session status before making another change.',
    })
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
