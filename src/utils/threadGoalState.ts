/**
 * Durable goal status vocabulary, transition authority, and classification.
 *
 * Split out of threadGoal.ts so the state machine has one owner: the schema,
 * formatting, and accounting helpers in threadGoal.ts consume this module, and
 * nothing here imports back.
 *
 * Two rules drive the shape of this file:
 *
 * 1. A scheduler stop must be representable durably. The pre-existing loop
 *    could return a `stalled` decision while the persisted goal stayed
 *    `active`, so a restart resumed a loop the scheduler had already given up
 *    on. Every stop reason therefore has a status here, not an in-memory ref.
 *
 * 2. Authority is separated. The working model may only ever report `complete`
 *    or `blocked`; pause/resume belong to the user; budget, usage-limit,
 *    stall, wait, and error transitions belong to the runtime. Encoding that
 *    in the transition table means a prompt change cannot widen it.
 */

export type ThreadGoalStatus =
  | 'active'
  | 'waiting'
  | 'paused'
  | 'blocked'
  | 'stalled'
  | 'budget_limited'
  | 'usage_limited'
  | 'failed'
  | 'complete'

/**
 * Closed reason vocabulary. Deliberately not free text: a reason reaches the
 * terminal footer, the desktop goal snapshot, and headless report output, and
 * model-authored prose must never reach those surfaces.
 */
export type ThreadGoalStatusReason =
  | 'created'
  | 'user_paused'
  | 'user_resumed'
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

/**
 * Who is permitted to request a transition. The working model is `agent`; a
 * human control action is `user`; scheduler/accounting/provider effects are
 * `runtime`.
 */
export type ThreadGoalActor = 'user' | 'agent' | 'runtime'

/**
 * Lifecycle class of a status.
 *
 * - `running`: the scheduler may own an attempt (`active`) or is parked on an
 *   external signal (`waiting`).
 * - `stopped`: no automatic work happens, but the user may resume.
 * - `terminal`: only `complete`. Terminal until the goal is cleared or
 *   replaced; it is never re-entered by resume.
 */
export type ThreadGoalLifecycleClass = 'running' | 'stopped' | 'terminal'

const LIFECYCLE_CLASS: Record<ThreadGoalStatus, ThreadGoalLifecycleClass> = {
  active: 'running',
  waiting: 'running',
  paused: 'stopped',
  blocked: 'stopped',
  stalled: 'stopped',
  budget_limited: 'stopped',
  usage_limited: 'stopped',
  failed: 'stopped',
  complete: 'terminal',
}

export const THREAD_GOAL_STATUSES = Object.keys(
  LIFECYCLE_CLASS,
) as ThreadGoalStatus[]

export function getThreadGoalLifecycleClass(
  status: ThreadGoalStatus,
): ThreadGoalLifecycleClass {
  return LIFECYCLE_CLASS[status]
}

/**
 * Success is `complete` and nothing else. Every serializer, footer, snapshot,
 * and report consults this rather than testing `!== 'active'`, so a stopped
 * goal can never render as an achieved one.
 */
export function isSuccessfulThreadGoalStatus(status: ThreadGoalStatus): boolean {
  return status === 'complete'
}

export function isTerminalThreadGoalStatus(status: ThreadGoalStatus): boolean {
  return LIFECYCLE_CLASS[status] === 'terminal'
}

/**
 * A resumable status is one `/goal resume` may legally leave. `complete` is
 * excluded because it is terminal, and the two running statuses are excluded
 * because there is nothing to resume.
 */
export function isResumableThreadGoalStatus(status: ThreadGoalStatus): boolean {
  return LIFECYCLE_CLASS[status] === 'stopped'
}

/**
 * True when the scheduler may claim an automatic continuation attempt. Only
 * `active` qualifies: `waiting` is parked on an external wake and must not
 * spend a turn asking whether the wake happened yet.
 */
export function isSchedulableThreadGoalStatus(
  status: ThreadGoalStatus,
): boolean {
  return status === 'active'
}

type TransitionRule = {
  to: ThreadGoalStatus
  actors: readonly ThreadGoalActor[]
}

/**
 * Allowed transitions keyed by origin status.
 *
 * Absent pairs are forbidden and must leave durable state untouched, which is
 * what makes "a red gate cannot be talked past" a harness guarantee instead of
 * a prompt convention.
 */
const TRANSITIONS: Record<ThreadGoalStatus, readonly TransitionRule[]> = {
  active: [
    { to: 'waiting', actors: ['runtime'] },
    { to: 'paused', actors: ['user', 'runtime'] },
    { to: 'blocked', actors: ['agent', 'runtime'] },
    { to: 'stalled', actors: ['runtime'] },
    { to: 'budget_limited', actors: ['runtime'] },
    { to: 'usage_limited', actors: ['runtime'] },
    { to: 'failed', actors: ['runtime'] },
    { to: 'complete', actors: ['agent'] },
  ],
  waiting: [
    { to: 'active', actors: ['runtime', 'user'] },
    { to: 'paused', actors: ['user'] },
    { to: 'blocked', actors: ['runtime'] },
    { to: 'stalled', actors: ['runtime'] },
    { to: 'failed', actors: ['runtime'] },
    { to: 'budget_limited', actors: ['runtime'] },
    { to: 'usage_limited', actors: ['runtime'] },
  ],
  // Every stopped status resumes to `active` by explicit user action only.
  // The runtime never self-resumes: that is what stops a restart from
  // relaunching a loop the scheduler already abandoned.
  paused: [{ to: 'active', actors: ['user'] }],
  blocked: [{ to: 'active', actors: ['user'] }],
  stalled: [{ to: 'active', actors: ['user'] }],
  budget_limited: [
    { to: 'active', actors: ['user'] },
    // The bounded wrap-up turn is the one automatic turn a budget-exhausted
    // goal still gets. It may report completion, but it may not silently
    // return the goal to `active`.
    { to: 'complete', actors: ['agent'] },
    { to: 'blocked', actors: ['agent'] },
  ],
  usage_limited: [{ to: 'active', actors: ['user'] }],
  failed: [{ to: 'active', actors: ['user'] }],
  complete: [],
}

/**
 * Result of a legality check. A flat code rather than a discriminated union on
 * a boolean: the root tsconfig runs `strict: false`, where narrowing a
 * `{allowed: true} | {allowed: false, code}` union does not reliably expose
 * `code` to callers.
 */
export type ThreadGoalTransitionCheck = {
  allowed: boolean
  code: 'ok' | 'terminal' | 'forbidden' | 'unauthorized'
}

/**
 * Decide whether `actor` may move a goal from `from` to `to`.
 *
 * A same-status request is allowed so accounting writes that do not change
 * status stay on one code path.
 */
export function checkThreadGoalTransition({
  from,
  to,
  actor,
}: {
  from: ThreadGoalStatus
  to: ThreadGoalStatus
  actor: ThreadGoalActor
}): ThreadGoalTransitionCheck {
  if (from === to) return { allowed: true, code: 'ok' }
  if (isTerminalThreadGoalStatus(from)) {
    return { allowed: false, code: 'terminal' }
  }

  const rule = TRANSITIONS[from].find(candidate => candidate.to === to)
  if (!rule) return { allowed: false, code: 'forbidden' }
  if (!rule.actors.includes(actor)) {
    return { allowed: false, code: 'unauthorized' }
  }
  return { allowed: true, code: 'ok' }
}

export function isThreadGoalTransitionAllowed(input: {
  from: ThreadGoalStatus
  to: ThreadGoalStatus
  actor: ThreadGoalActor
}): boolean {
  return checkThreadGoalTransition(input).allowed
}

/**
 * The only two statuses `update_goal` may request. Enforced at the tool
 * boundary as well as here so a prompt regression cannot widen model
 * authority.
 */
export const AGENT_SETTABLE_THREAD_GOAL_STATUSES = [
  'complete',
  'blocked',
] as const satisfies readonly ThreadGoalStatus[]

export function isAgentSettableThreadGoalStatus(
  status: ThreadGoalStatus,
): boolean {
  return (AGENT_SETTABLE_THREAD_GOAL_STATUSES as readonly string[]).includes(
    status,
  )
}

export function isThreadGoalStatus(value: unknown): value is ThreadGoalStatus {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(LIFECYCLE_CLASS, value)
  )
}

const STATUS_REASONS: readonly ThreadGoalStatusReason[] = [
  'created',
  'user_paused',
  'user_resumed',
  'user_replaced',
  'turn_aborted',
  'agent_reported_blocked',
  'agent_reported_complete',
  'no_progress',
  'token_budget_exhausted',
  'turn_budget_exhausted',
  'time_budget_exhausted',
  'subagent_budget_exhausted',
  'provider_usage_limit',
  'runtime_error',
  'verification_unavailable',
  'required_gate_failed',
  'waiting_on_dependency',
  'dependency_timeout',
  'unresolved_workers',
]

export function isThreadGoalStatusReason(
  value: unknown,
): value is ThreadGoalStatusReason {
  return (
    typeof value === 'string' &&
    (STATUS_REASONS as readonly string[]).includes(value)
  )
}
