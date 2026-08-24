/**
 * Parking a goal on real external work.
 *
 * Without this, a goal whose next step depends on something still running has
 * exactly one move: spend a turn asking whether it finished. That is the waste
 * the loop was supposed to remove, and it is also how a goal burns its turn
 * ceiling on nothing.
 *
 * A parked goal sits in `waiting`, which is not schedulable, so it consumes no
 * model turns at all. It leaves that state when the thing it waited on
 * completes, when the user acts, or when its deadline passes.
 *
 * Pure module: no IO, no timers, no subscriptions. The runtime owns the actual
 * wake signals and calls in here to decide what they mean, which is what lets
 * every runtime share one wait semantics.
 */

export type ThreadGoalWaitKind =
  | 'task'
  | 'process'
  | 'worker'
  | 'approval'
  | 'child-session'
  | 'timer'

/**
 * What a wait becomes if its deadline passes.
 *
 * Never `complete`, and deliberately not a free choice: a timeout is a
 * non-success outcome, and the only question is which non-success one.
 */
export type ThreadGoalWaitTimeoutDisposition = 'blocked' | 'stalled' | 'failed'

export type ThreadGoalWait = {
  waitId: string
  kind: ThreadGoalWaitKind
  /**
   * Stable id of the thing being waited on. This is the wake key's source id,
   * so a completion event for this subject wakes exactly this wait.
   */
  subjectId: string
  /** Short, runtime-authored label. Never model prose. */
  label: string
  startedAtMs: number
  /**
   * Absolute deadline. A timer wait is the FALLBACK: event-driven completion
   * is preferred, and the deadline exists so a wake that never arrives cannot
   * park a goal forever.
   */
  deadlineMs: number
  timeoutDisposition: ThreadGoalWaitTimeoutDisposition
}

/**
 * Default ceiling on a park.
 *
 * Generous, because the work being waited on is often long. The point is not
 * to time work out; it is to guarantee that a lost completion signal surfaces
 * as an honest stopped state rather than a goal that looks alive forever.
 */
export const DEFAULT_THREAD_GOAL_WAIT_MS = 30 * 60 * 1000

export type ThreadGoalWaitResolution =
  | { type: 'continue' }
  | { type: 'still-waiting' }
  | { type: 'timed-out'; disposition: ThreadGoalWaitTimeoutDisposition }

/**
 * What a wake event means for the current wait.
 *
 * `subjectId` is the thing that just completed. A wake for a different subject
 * leaves the goal parked: an unrelated task finishing is not evidence that
 * this goal's dependency did.
 */
export function resolveThreadGoalWait({
  wait,
  completedSubjectId,
  nowMs,
}: {
  wait: ThreadGoalWait
  completedSubjectId: string | null
  nowMs: number
}): ThreadGoalWaitResolution {
  if (completedSubjectId !== null && completedSubjectId === wait.subjectId) {
    return { type: 'continue' }
  }
  // The deadline is checked AFTER a matching completion, so a wake that
  // arrives in the same moment the deadline passes is treated as the work
  // finishing rather than as a timeout.
  if (nowMs >= wait.deadlineMs) {
    return { type: 'timed-out', disposition: wait.timeoutDisposition }
  }
  return { type: 'still-waiting' }
}

export type ThreadGoalDependency = {
  kind: ThreadGoalWaitKind
  subjectId: string
  label: string
}

/**
 * Choose what to park on, given everything currently unresolved.
 *
 * Returns null when there is nothing to wait for, which is the signal to run
 * an ordinary continuation instead. When several dependencies are outstanding
 * the FIRST is chosen and the goal re-parks on the next one after it wakes:
 * waiting on one thing at a time keeps the wake unambiguous, and the goal has
 * to take a turn between them anyway to decide what to do next.
 */
export function selectThreadGoalWait({
  dependencies,
  nowMs,
  waitMs = DEFAULT_THREAD_GOAL_WAIT_MS,
  timeoutDisposition = 'stalled',
  createWaitId,
}: {
  dependencies: readonly ThreadGoalDependency[]
  nowMs: number
  waitMs?: number
  timeoutDisposition?: ThreadGoalWaitTimeoutDisposition
  createWaitId: () => string
}): ThreadGoalWait | null {
  const first = dependencies[0]
  if (!first) return null

  return {
    waitId: createWaitId(),
    kind: first.kind,
    subjectId: first.subjectId,
    label: first.label,
    startedAtMs: nowMs,
    deadlineMs: nowMs + waitMs,
    timeoutDisposition,
  }
}

const WAIT_KINDS: readonly ThreadGoalWaitKind[] = [
  'task',
  'process',
  'worker',
  'approval',
  'child-session',
  'timer',
]

const TIMEOUT_DISPOSITIONS: readonly ThreadGoalWaitTimeoutDisposition[] = [
  'blocked',
  'stalled',
  'failed',
]

/**
 * Parse a persisted wait.
 *
 * Returns null for anything unreadable rather than a partial wait: a wait with
 * a missing deadline would park the goal with no way out, which is strictly
 * worse than not being parked at all.
 */
export function parseThreadGoalWait(input: unknown): ThreadGoalWait | null {
  if (!input || typeof input !== 'object') return null
  const c = input as Record<string, unknown>
  if (
    typeof c.waitId !== 'string' ||
    c.waitId.length === 0 ||
    typeof c.subjectId !== 'string' ||
    c.subjectId.length === 0 ||
    !(WAIT_KINDS as readonly unknown[]).includes(c.kind) ||
    !(TIMEOUT_DISPOSITIONS as readonly unknown[]).includes(
      c.timeoutDisposition,
    ) ||
    !Number.isInteger(c.startedAtMs) ||
    !Number.isInteger(c.deadlineMs)
  ) {
    return null
  }
  return {
    waitId: c.waitId,
    kind: c.kind as ThreadGoalWaitKind,
    subjectId: c.subjectId,
    label: typeof c.label === 'string' ? c.label : '',
    startedAtMs: c.startedAtMs as number,
    deadlineMs: c.deadlineMs as number,
    timeoutDisposition: c.timeoutDisposition as ThreadGoalWaitTimeoutDisposition,
  }
}

/** Reason paired with each timeout disposition, for the durable status write. */
export function threadGoalWaitTimeoutReason(
  disposition: ThreadGoalWaitTimeoutDisposition,
): 'dependency_timeout' {
  void disposition
  return 'dependency_timeout'
}
