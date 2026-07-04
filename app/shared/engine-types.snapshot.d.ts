/**
 * TYPE-ONLY SNAPSHOT — re-synced for P1-0 (2026-07-02) against commit 234da9e.
 *
 * Why a snapshot and not a direct source alias: TypeScript follows the engine
 * source modules into the broad Bun runtime graph (engine-only globals,
 * unresolved modules), which an isolated renderer/main/supervisor tsconfig
 * cannot check (P0-3 finding). The sidecar, which genuinely runs engine code
 * under Bun, imports the real modules directly; the NON-engine app processes use
 * this snapshot for types only.
 *
 * Canonical sources at commit 234da9e (re-verified in sync 2026-07-02):
 *   SDKMessage:        src/entrypoints/agentSdkTypes.ts
 *   AppSessionEvent:   src/app-runtime/sessionEvents.ts
 *   AppClientMessage + AppReadyPayload: src/web/appSessionProtocol.ts
 */
import type {
  PermissionUpdate,
  SDKControlPermissionRequest,
  SDKMessage,
} from './sdk-types.snapshot.js'

export type { PermissionUpdate, SDKControlPermissionRequest, SDKMessage }

type ThreadGoal = {
  threadId: string
  goalId: string
  objective: string
  status: 'active' | 'paused' | 'budget_limited' | 'complete'
  tokenBudget?: number
  tokensUsed: number
  timeUsedSeconds: number
  createdAtMs: number
  updatedAtMs: number
}

type AppGoalSnapshot = ThreadGoal | null

type AppPermissionRequest = {
  requestId: string
  request: SDKControlPermissionRequest
}

type AppPermissionResponse =
  | {
      behavior: 'allow'
      updatedInput: Record<string, unknown>
      updatedPermissions?: PermissionUpdate[]
      toolUseID?: string
      decisionClassification?:
        | 'user_temporary'
        | 'user_permanent'
        | 'user_reject'
    }
  | {
      behavior: 'deny'
      message: string
      interrupt?: boolean
      toolUseID?: string
      decisionClassification?:
        | 'user_temporary'
        | 'user_permanent'
        | 'user_reject'
    }

type AppSessionAbortState =
  | { status: 'idle' }
  | { status: 'requested'; reason?: string }
  | { status: 'aborted'; reason?: string }

export type AppSessionEvent =
  | {
      type: 'message'
      message: SDKMessage
    }
  | {
      type: 'goal.snapshot'
      snapshot: AppGoalSnapshot
    }
  | {
      type: 'permission.requested'
      request: AppPermissionRequest
    }
  | {
      type: 'permission.resolved'
      request: AppPermissionRequest
      response: AppPermissionResponse
    }
  | {
      type: 'abort.status'
      abort: AppSessionAbortState
    }

/* --- src/web/appSessionProtocol.ts (the 4 allowlisted client message types) --- */

export type AppSubmitMessage = {
  type: 'app.submit'
  requestId: string
  prompt: string
  options?: {
    uuid?: string
    isMeta?: boolean
    goalSnapshot?: unknown
  }
}

type AppAbortMessage = {
  type: 'app.abort'
  requestId: string
  reason?: string
}

export type PermissionResponseMessage = {
  type: 'permission.response'
  requestId: string
  response: AppPermissionResponse
}

type AppPingMessage = {
  type: 'app.ping'
  nonce: string
}

export type AppClientMessage =
  | AppSubmitMessage
  | AppAbortMessage
  | PermissionResponseMessage
  | AppPingMessage

export type AppReadyPayload = {
  type: 'app.ready'
  protocolVersion: 1
  inputEnabled: boolean
  activeTurn: boolean
  abort: AppSessionAbortState
  goalSnapshot: AppGoalSnapshot
  pendingPermissionRequests: AppPermissionRequest[]
}
