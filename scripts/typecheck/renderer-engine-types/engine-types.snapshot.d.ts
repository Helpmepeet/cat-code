/**
 * TYPE-ONLY SNAPSHOT — re-sync before P1-0 adoption.
 *
 * Canonical sources at commit 234da9e:
 *   SDKMessage: src/entrypoints/agentSdkTypes.ts
 *   AppSessionEvent: src/app-runtime/sessionEvents.ts
 */
import type {
  PermissionUpdate,
  SDKControlPermissionRequest,
  SDKMessage,
} from './sdk-types.snapshot.js'

export type { SDKMessage }

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
