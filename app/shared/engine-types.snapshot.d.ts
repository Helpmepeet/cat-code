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
 * Canonical sources at commit 234da9e (AppSessionEvent re-synced 2026-08-02 for
 * `turn.status`; AppClientMessage re-synced 2026-08-09 for image prompts;
 * ThreadGoal re-synced 2026-08-24 for the durable goal state machine, real
 * usage accounting, and revision fencing):
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

type ThreadGoalStatus =
  | 'active'
  | 'waiting'
  | 'paused'
  | 'blocked'
  | 'stalled'
  | 'budget_limited'
  | 'usage_limited'
  | 'failed'
  | 'complete'

type ThreadGoalStatusReason =
  | 'created'
  | 'user_paused'
  | 'user_resumed'
  | 'dependency_resolved'
  | 'user_replaced'
  | 'turn_aborted'
  | 'agent_reported_blocked'
  | 'agent_reported_complete'
  | 'no_progress'
  | 'token_budget_exhausted'
  | 'turn_budget_exhausted'
  | 'time_budget_exhausted'
  | 'subagent_budget_exhausted'
  | 'provider_usage_limit'
  | 'runtime_error'
  | 'verification_unavailable'
  | 'required_gate_failed'
  | 'waiting_on_dependency'
  | 'dependency_timeout'
  | 'unresolved_workers'

type ThreadGoalUsageBreakdown = {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  responseCount: number
}

type ThreadGoalWakeTrigger =
  | 'idle'
  | 'budget-wrap-up'
  | 'task-completed'
  | 'process-exited'
  | 'timer'
  | 'user-resumed'

type ThreadGoalAttempt = {
  attemptId: string
  goalRevision: number
  trigger: ThreadGoalWakeTrigger
  wakeKey: string
  status: 'pending' | 'claimed' | 'running' | 'settled'
  claimedBy: string | null
  leaseEpoch: number
  leaseExpiresAtMs: number
  createdAtMs: number
  updatedAtMs: number
}

type ThreadGoalCriterion = {
  id: string
  description: string
  required: boolean
  verifyCommand?: string
}

type ThreadGoalContract = {
  criteria: ThreadGoalCriterion[]
  constraints: string[]
  boundaries: string[]
  stopConditions: string[]
}

type ThreadGoalEvidence = {
  evidenceId: string
  source: 'command' | 'artifact' | 'worker'
  sourceDigest: string
  label: string
  sessionId: string
  contractDigest: string
  workspaceFingerprint: string
  outcome: 'pass' | 'fail'
  exitCode?: number
  outputDigest: string
  recordedAtMs: number
  coversCriterionIds: string[]
}

type ThreadGoalWait = {
  waitId: string
  kind: 'task' | 'process' | 'worker' | 'approval' | 'child-session' | 'timer'
  subjectId: string
  label: string
  startedAtMs: number
  deadlineMs: number
  timeoutDisposition: 'blocked' | 'stalled' | 'failed'
}

type ThreadGoal = {
  schemaVersion: number
  threadId: string
  goalId: string
  revision: number
  objective: string
  status: ThreadGoalStatus
  statusReason: ThreadGoalStatusReason
  statusChangedAtMs: number
  tokenBudget?: number
  maxContinuationTurns: number
  maxConsecutiveFailures: number
  maxNoProgressTurns: number
  maxWallClockSeconds: number
  maxChildAgents: number
  tokensUsed: number
  usageBreakdown: ThreadGoalUsageBreakdown
  contextGrowthTokens: number
  chargedResponseIds: string[]
  continuationTurns: number
  consecutiveNoProgressTurns: number
  consecutiveFailures: number
  pendingAttempt: ThreadGoalAttempt | null
  recentWakeKeys: string[]
  contract: ThreadGoalContract
  evidence: ThreadGoalEvidence[]
  wait: ThreadGoalWait | null
  callHistory: string[]
  childAgentIds: string[]
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
  | {
      type: 'turn.status'
      activeTurn: boolean
    }

/* --- src/web/appSessionProtocol.ts (the 4 allowlisted client message types) --- */

export type AppSubmitPrompt =
  | string
  | Array<
      | {
          type: 'image'
          source: {
            type: 'base64'
            media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
            data: string
          }
        }
      | {
          type: 'text'
          text: string
        }
    >

export type AppSubmitMessage = {
  type: 'app.submit'
  requestId: string
  prompt: AppSubmitPrompt
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
