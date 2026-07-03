import type { AppSessionEvent } from '@cat-code/engine/session-events'
import type {
  PermissionResponseInput,
  ServerFrame,
  SessionId,
} from '../../shared/protocol.js'

export type PermissionRequest = Extract<
  AppSessionEvent,
  { type: 'permission.requested' }
>['request']

type SessionPermissionState = {
  pending: PermissionRequest[]
  dismissedRequestIds: string[]
  submittedRequestIds: string[]
}

export type PermissionState = {
  activeSessionId: SessionId | null
  sessions: Record<SessionId, SessionPermissionState>
}

export type PermissionAction =
  | { type: 'frame'; frame: ServerFrame }
  | { type: 'submitted'; sessionId: SessionId; requestId: string }
  | { type: 'submissionFailed'; sessionId: SessionId; requestId: string }
  | { type: 'dismissed'; sessionId: SessionId; requestId: string }

export function createPermissionState(): PermissionState {
  return {
    activeSessionId: null,
    sessions: {},
  }
}

function createSessionPermissionState(): SessionPermissionState {
  return {
    pending: [],
    dismissedRequestIds: [],
    submittedRequestIds: [],
  }
}

export function reducePermissionState(
  state: PermissionState,
  action: PermissionAction,
): PermissionState {
  if (action.type === 'submitted' || action.type === 'dismissed') {
    const session = state.sessions[action.sessionId]
    if (!session) return state
    const field =
      action.type === 'submitted'
        ? 'submittedRequestIds'
        : 'dismissedRequestIds'
    if (session[field].includes(action.requestId)) return state
    return updateSession(state, action.sessionId, {
      ...session,
      [field]: [...session[field], action.requestId],
    })
  }

  if (action.type === 'submissionFailed') {
    const session = state.sessions[action.sessionId]
    if (!session?.submittedRequestIds.includes(action.requestId)) return state
    return updateSession(state, action.sessionId, {
      ...session,
      submittedRequestIds: session.submittedRequestIds.filter(
        requestId => requestId !== action.requestId,
      ),
    })
  }

  const { frame } = action
  if (frame.kind === 'ready') {
    const previous =
      state.sessions[frame.sessionId] ?? createSessionPermissionState()
    const pendingIds = new Set(
      frame.payload.pendingPermissionRequests.map(request => request.requestId),
    )
    return {
      activeSessionId: frame.sessionId,
      sessions: {
        ...state.sessions,
        [frame.sessionId]: {
          pending: frame.payload.pendingPermissionRequests,
          dismissedRequestIds: previous.dismissedRequestIds.filter(requestId =>
            pendingIds.has(requestId),
          ),
          submittedRequestIds: previous.submittedRequestIds.filter(requestId =>
            pendingIds.has(requestId),
          ),
        },
      },
    }
  }

  const session = state.sessions[frame.sessionId]
  if (!session) return state

  if (frame.kind === 'lifecycle') {
    return updateSession(
      state,
      frame.sessionId,
      createSessionPermissionState(),
    )
  }

  if (frame.kind === 'error' && frame.requestId) {
    if (!session.submittedRequestIds.includes(frame.requestId)) return state
    return updateSession(state, frame.sessionId, {
      ...session,
      submittedRequestIds: session.submittedRequestIds.filter(
        requestId => requestId !== frame.requestId,
      ),
    })
  }

  if (frame.kind !== 'event') return state

  if (frame.event.type === 'permission.requested') {
    const request = frame.event.request
    return updateSession(state, frame.sessionId, {
      pending: [
        ...session.pending.filter(
          candidate => candidate.requestId !== request.requestId,
        ),
        request,
      ],
      dismissedRequestIds: session.dismissedRequestIds.filter(
        requestId => requestId !== request.requestId,
      ),
      submittedRequestIds: session.submittedRequestIds.filter(
        requestId => requestId !== request.requestId,
      ),
    })
  }

  if (frame.event.type === 'permission.resolved') {
    return updateSession(
      state,
      frame.sessionId,
      removeRequest(session, frame.event.request.requestId),
    )
  }

  return state
}

export function selectVisiblePermission(
  state: PermissionState,
  sessionId: SessionId | null = state.activeSessionId,
): PermissionRequest | null {
  const session = sessionId ? state.sessions[sessionId] : undefined
  if (!session) return null
  return (
    session.pending.find(
      request =>
        !session.dismissedRequestIds.includes(request.requestId) &&
        !session.submittedRequestIds.includes(request.requestId),
    ) ?? null
  )
}

export function buildAllowResponse(
  _request: PermissionRequest,
): Extract<PermissionResponseInput, { behavior: 'allow' }> {
  return {
    behavior: 'allow',
    // The sidecar substitutes its engine-owned gated input for this sentinel.
    // Do not echo potentially huge or renderer-mutated input across IPC.
    updatedInput: {},
  }
}

export function buildDenyResponse(): Extract<
  PermissionResponseInput,
  { behavior: 'deny' }
> {
  return {
    behavior: 'deny',
    message: 'Denied by user',
  }
}

function updateSession(
  state: PermissionState,
  sessionId: SessionId,
  session: SessionPermissionState,
): PermissionState {
  return {
    ...state,
    sessions: { ...state.sessions, [sessionId]: session },
  }
}

function removeRequest(
  state: SessionPermissionState,
  requestId: string,
): SessionPermissionState {
  return {
    pending: state.pending.filter(request => request.requestId !== requestId),
    dismissedRequestIds: state.dismissedRequestIds.filter(
      dismissedId => dismissedId !== requestId,
    ),
    submittedRequestIds: state.submittedRequestIds.filter(
      submittedId => submittedId !== requestId,
    ),
  }
}
