import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type { SDKControlPermissionRequest } from '../entrypoints/sdk/coreTypes.generated.js'
import type { Output as PermissionToolOutput } from '../utils/permissions/PermissionPromptToolResultSchema.js'
import type { ThreadGoal } from '../utils/threadGoal.js'

export type AppGoalSnapshot = ThreadGoal | null

export type AppPermissionRequest = {
  requestId: string
  request: SDKControlPermissionRequest
}

export type AppPermissionResponse = PermissionToolOutput

export type AppSessionAbortState =
  | { status: 'idle' }
  | { status: 'requested'; reason?: string }
  | { status: 'aborted'; reason?: string }

export type AppSessionMessageEvent = {
  type: 'message'
  message: SDKMessage
}

export type AppSessionGoalSnapshotEvent = {
  type: 'goal.snapshot'
  snapshot: AppGoalSnapshot
}

export type AppSessionPermissionRequestedEvent = {
  type: 'permission.requested'
  request: AppPermissionRequest
}

export type AppSessionPermissionResolvedEvent = {
  type: 'permission.resolved'
  request: AppPermissionRequest
  response: AppPermissionResponse
}

export type AppSessionAbortStatusEvent = {
  type: 'abort.status'
  abort: AppSessionAbortState
}

export type AppSessionEvent =
  | AppSessionMessageEvent
  | AppSessionGoalSnapshotEvent
  | AppSessionPermissionRequestedEvent
  | AppSessionPermissionResolvedEvent
  | AppSessionAbortStatusEvent

export function createMessageEvent(message: SDKMessage): AppSessionMessageEvent {
  return {
    type: 'message',
    message,
  }
}

export function createGoalSnapshotEvent(
  snapshot: AppGoalSnapshot,
): AppSessionGoalSnapshotEvent {
  return {
    type: 'goal.snapshot',
    snapshot,
  }
}

export function createPermissionRequest(
  request: AppPermissionRequest,
): AppPermissionRequest {
  return request
}

export function createPermissionRequestedEvent(
  request: AppPermissionRequest,
): AppSessionPermissionRequestedEvent {
  return {
    type: 'permission.requested',
    request,
  }
}

export function createPermissionResolvedEvent(
  request: AppPermissionRequest,
  response: AppPermissionResponse,
): AppSessionPermissionResolvedEvent {
  return {
    type: 'permission.resolved',
    request,
    response,
  }
}

export function createAbortStatusEvent(
  abort: AppSessionAbortState,
): AppSessionAbortStatusEvent {
  return {
    type: 'abort.status',
    abort,
  }
}
