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

/**
 * Turn boundary. `AppReadyPayload.activeTurn` reports this same flag, but only
 * at attach — a client that learns it once can never tell a running turn from
 * an idle session again. Emitted on every change, exactly like `abort.status`,
 * so "a turn is running" is a live fact rather than a handshake artifact.
 */
export type AppSessionTurnStatusEvent = {
  type: 'turn.status'
  activeTurn: boolean
}

export type AppSessionEvent =
  | AppSessionMessageEvent
  | AppSessionGoalSnapshotEvent
  | AppSessionPermissionRequestedEvent
  | AppSessionPermissionResolvedEvent
  | AppSessionAbortStatusEvent
  | AppSessionTurnStatusEvent

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

export function createTurnStatusEvent(
  activeTurn: boolean,
): AppSessionTurnStatusEvent {
  return {
    type: 'turn.status',
    activeTurn,
  }
}
