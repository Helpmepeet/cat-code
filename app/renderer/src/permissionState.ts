import type { AppSessionEvent } from '@cat-code/engine/session-events'
import type {
  PermissionResponseInput,
  ServerFrame,
} from '../../shared/protocol.js'

export type PermissionRequest = Extract<
  AppSessionEvent,
  { type: 'permission.requested' }
>['request']

export type PermissionState = {
  pending: PermissionRequest[]
  dismissedRequestIds: string[]
}

export type PermissionAction =
  | { type: 'frame'; frame: ServerFrame }
  | { type: 'decided'; requestId: string }
  | { type: 'dismissed'; requestId: string }

export function createPermissionState(): PermissionState {
  return {
    pending: [],
    dismissedRequestIds: [],
  }
}

export function reducePermissionState(
  state: PermissionState,
  action: PermissionAction,
): PermissionState {
  if (action.type === 'decided') {
    return removeRequest(state, action.requestId)
  }

  if (action.type === 'dismissed') {
    return state.dismissedRequestIds.includes(action.requestId)
      ? state
      : {
          ...state,
          dismissedRequestIds: [
            ...state.dismissedRequestIds,
            action.requestId,
          ],
        }
  }

  const { frame } = action
  if (frame.kind === 'ready') {
    const pendingIds = new Set(
      frame.payload.pendingPermissionRequests.map(request => request.requestId),
    )
    return {
      pending: frame.payload.pendingPermissionRequests,
      dismissedRequestIds: state.dismissedRequestIds.filter(requestId =>
        pendingIds.has(requestId),
      ),
    }
  }

  if (frame.kind !== 'event') return state

  if (frame.event.type === 'permission.requested') {
    const request = frame.event.request
    return {
      pending: [
        ...state.pending.filter(
          candidate => candidate.requestId !== request.requestId,
        ),
        request,
      ],
      dismissedRequestIds: state.dismissedRequestIds.filter(
        requestId => requestId !== request.requestId,
      ),
    }
  }

  if (frame.event.type === 'permission.resolved') {
    return removeRequest(state, frame.event.request.requestId)
  }

  return state
}

export function selectVisiblePermission(
  state: PermissionState,
): PermissionRequest | null {
  return (
    state.pending.find(
      request => !state.dismissedRequestIds.includes(request.requestId),
    ) ?? null
  )
}

export function buildAllowResponse(
  request: PermissionRequest,
): Extract<PermissionResponseInput, { behavior: 'allow' }> {
  return {
    behavior: 'allow',
    updatedInput: request.request.input,
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

function removeRequest(
  state: PermissionState,
  requestId: string,
): PermissionState {
  return {
    pending: state.pending.filter(request => request.requestId !== requestId),
    dismissedRequestIds: state.dismissedRequestIds.filter(
      dismissedId => dismissedId !== requestId,
    ),
  }
}
