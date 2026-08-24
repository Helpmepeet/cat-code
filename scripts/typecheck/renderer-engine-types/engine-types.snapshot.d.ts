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
