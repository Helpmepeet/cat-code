import { randomUUID } from 'crypto'

/**
 * Attempt identity, wake idempotency, and scheduler leases.
 *
 * Three separate problems that all look like "start the next turn":
 *
 * 1. IDENTITY. A continuation is decided at one instant and runs for minutes.
 *    Whatever it does at the end must be attributable to the goal state it was
 *    decided against, so an attempt carries the goal revision it saw.
 *
 * 2. IDEMPOTENCY. The same logical wake can arrive twice (an idle signal that
 *    re-fires, a task completion delivered on two paths, a restart between
 *    deciding and enqueuing). A wake key collapses those into one attempt.
 *
 * 3. OWNERSHIP. Only one scheduler may run a goal's attempt at a time. A lease
 *    with an epoch makes a second owner's claim fail rather than produce a
 *    duplicate turn.
 *
 * This module is pure. It performs no IO and holds no module state, so the
 * terminal, desktop, web, and headless runtimes share one implementation and
 * the durable record lives on the goal.
 */

/** What caused the scheduler to consider starting a turn. */
export type ThreadGoalWakeTrigger =
  | 'idle'
  | 'budget-wrap-up'
  | 'task-completed'
  | 'process-exited'
  | 'timer'
  | 'user-resumed'

export type ThreadGoalAttemptStatus =
  | 'pending'
  | 'claimed'
  | 'running'
  | 'settled'

export type ThreadGoalAttempt = {
  attemptId: string
  /**
   * The goal revision this attempt was decided against. Any durable goal
   * mutation bumps the revision, which is what makes an attempt decided before
   * a pause, edit, or replacement detectably stale.
   */
  goalRevision: number
  trigger: ThreadGoalWakeTrigger
  /** Collapses duplicate deliveries of one logical wake into one attempt. */
  wakeKey: string
  status: ThreadGoalAttemptStatus
  /** Scheduler that owns this attempt, or null while it is only pending. */
  claimedBy: string | null
  /**
   * Monotonic per-attempt claim counter. A claim that presents an older epoch
   * loses, so two owners cannot both believe they hold the same lease.
   */
  leaseEpoch: number
  leaseExpiresAtMs: number
  createdAtMs: number
  updatedAtMs: number
}

/**
 * How long a claim is good for.
 *
 * Long enough that an ordinary long turn does not lose its lease mid-flight,
 * short enough that a scheduler killed without settling does not wedge the
 * goal until the user notices. A live owner renews.
 */
export const THREAD_GOAL_LEASE_MS = 5 * 60 * 1000

/**
 * How many recent wake keys a goal remembers.
 *
 * Only needs to cover redeliveries of the same logical event, not the goal's
 * whole history.
 */
export const MAX_REMEMBERED_WAKE_KEYS = 64

/**
 * Build a wake key.
 *
 * The key must be identical for two deliveries of the SAME logical event and
 * different for genuinely separate events. It therefore never includes a
 * timestamp or a random value: those are what make duplicate suppression fail.
 *
 * It also deliberately excludes the goal revision. Charging a finished turn
 * bumps the revision, so a revision-keyed wake would stop matching its own
 * redelivery precisely when suppression is needed. Revision is a FENCING
 * input, checked by claimThreadGoalAttempt and isThreadGoalAttemptValid; it is
 * not part of an event's identity.
 *
 * `sourceId` is the caller's stable id for the thing that woke the goal: a
 * task id, a process id, a timer id, or a monotonic idle sequence number.
 * Genuinely separate events must carry genuinely different source ids.
 */
export function buildThreadGoalWakeKey({
  goalId,
  trigger,
  sourceId,
}: {
  goalId: string
  trigger: ThreadGoalWakeTrigger
  sourceId: string
}): string {
  return `${goalId}:${trigger}:${sourceId}`
}

export type ThreadGoalAttemptRecord = {
  pendingAttempt: ThreadGoalAttempt | null
  recentWakeKeys: string[]
}

export const EMPTY_THREAD_GOAL_ATTEMPT_RECORD: ThreadGoalAttemptRecord = {
  pendingAttempt: null,
  recentWakeKeys: [],
}

export type RecordWakeResult =
  | { outcome: 'created'; record: ThreadGoalAttemptRecord }
  | { outcome: 'duplicate'; record: ThreadGoalAttemptRecord }
  | { outcome: 'busy'; record: ThreadGoalAttemptRecord }

/**
 * Record a wake, creating at most one attempt.
 *
 * - `duplicate`: this exact wake was already recorded. Nothing changes.
 * - `busy`: an attempt is already pending or running. Nothing changes, because
 *   a second concurrent attempt is exactly the duplicate turn to avoid.
 * - `created`: a new pending attempt now exists.
 */
export function recordThreadGoalWake({
  record,
  goalId,
  goalRevision,
  trigger,
  sourceId,
  nowMs,
  attemptId = randomUUID(),
}: {
  record: ThreadGoalAttemptRecord
  goalId: string
  goalRevision: number
  trigger: ThreadGoalWakeTrigger
  sourceId: string
  nowMs: number
  attemptId?: string
}): RecordWakeResult {
  const wakeKey = buildThreadGoalWakeKey({ goalId, trigger, sourceId })

  if (record.recentWakeKeys.includes(wakeKey)) {
    return { outcome: 'duplicate', record }
  }

  const pending = record.pendingAttempt
  if (pending && pending.status !== 'settled') {
    // An expired lease is not a live owner: the scheduler that held it is gone,
    // so the attempt is reclaimable rather than permanently blocking.
    const leaseIsLive =
      pending.status === 'pending' || pending.leaseExpiresAtMs > nowMs
    if (leaseIsLive) {
      return { outcome: 'busy', record }
    }
  }

  return {
    outcome: 'created',
    record: {
      pendingAttempt: {
        attemptId,
        goalRevision,
        trigger,
        wakeKey,
        status: 'pending',
        claimedBy: null,
        leaseEpoch: 0,
        leaseExpiresAtMs: 0,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      },
      recentWakeKeys: appendWakeKey(record.recentWakeKeys, wakeKey),
    },
  }
}

function appendWakeKey(keys: readonly string[], key: string): string[] {
  const next = [...keys, key]
  return next.length > MAX_REMEMBERED_WAKE_KEYS
    ? next.slice(next.length - MAX_REMEMBERED_WAKE_KEYS)
    : next
}

export type ClaimAttemptResult =
  | { outcome: 'claimed'; record: ThreadGoalAttemptRecord }
  | { outcome: 'missing' }
  | { outcome: 'stale' }
  | { outcome: 'held-by-other'; heldBy: string }

/**
 * Claim the pending attempt for one scheduler owner.
 *
 * Fails rather than overwriting when: there is no pending attempt, the goal has
 * moved on since the attempt was decided, or another owner holds a live lease.
 * That last case is the one that stops two runtimes observing the same idle
 * session from both starting a turn.
 */
export function claimThreadGoalAttempt({
  record,
  attemptId,
  ownerId,
  currentGoalRevision,
  nowMs,
  leaseMs = THREAD_GOAL_LEASE_MS,
}: {
  record: ThreadGoalAttemptRecord
  attemptId: string
  ownerId: string
  currentGoalRevision: number
  nowMs: number
  leaseMs?: number
}): ClaimAttemptResult {
  const pending = record.pendingAttempt
  if (!pending || pending.attemptId !== attemptId) {
    return { outcome: 'missing' }
  }
  if (pending.status === 'settled') {
    return { outcome: 'missing' }
  }
  if (pending.goalRevision !== currentGoalRevision) {
    return { outcome: 'stale' }
  }

  const heldByOther =
    pending.claimedBy !== null &&
    pending.claimedBy !== ownerId &&
    pending.leaseExpiresAtMs > nowMs
  if (heldByOther) {
    return { outcome: 'held-by-other', heldBy: pending.claimedBy! }
  }

  return {
    outcome: 'claimed',
    record: {
      ...record,
      pendingAttempt: {
        ...pending,
        status: 'claimed',
        claimedBy: ownerId,
        leaseEpoch: pending.leaseEpoch + 1,
        leaseExpiresAtMs: nowMs + leaseMs,
        updatedAtMs: nowMs,
      },
    },
  }
}

/**
 * Whether a claimed attempt may still start or finish work.
 *
 * Checked again at turn start and at turn end, because everything it guards
 * against can happen in between: the goal being paused, edited, replaced, or
 * cleared, and the lease being taken over after an expiry.
 */
export function isThreadGoalAttemptValid({
  record,
  attemptId,
  ownerId,
  leaseEpoch,
  currentGoalRevision,
}: {
  record: ThreadGoalAttemptRecord
  attemptId: string
  ownerId: string
  leaseEpoch: number
  currentGoalRevision: number
}): boolean {
  const pending = record.pendingAttempt
  // Deliberately does NOT check lease expiry.
  //
  // The lease exists so a scheduler that died without settling cannot wedge
  // the goal forever; that job belongs to recordThreadGoalWake's reclaim path,
  // which is the only place expiry is a question. Checking it HERE made expiry
  // mean "this turn ran too long", and a turn that runs a test suite or a
  // subagent fan-out routinely exceeds five minutes. The turn then failed its
  // own validity check at settle, so accounting never ran and every ceiling
  // silently stopped applying to exactly the long turns that most need them.
  //
  // Takeover is still caught: a reclaim bumps `leaseEpoch`, so the previous
  // owner fails the epoch comparison below.
  return (
    pending !== null &&
    pending.attemptId === attemptId &&
    pending.status !== 'settled' &&
    pending.claimedBy === ownerId &&
    pending.leaseEpoch === leaseEpoch &&
    pending.goalRevision === currentGoalRevision
  )
}

export function markThreadGoalAttemptRunning({
  record,
  attemptId,
  nowMs,
}: {
  record: ThreadGoalAttemptRecord
  attemptId: string
  nowMs: number
}): ThreadGoalAttemptRecord {
  const pending = record.pendingAttempt
  if (!pending || pending.attemptId !== attemptId) return record
  return {
    ...record,
    pendingAttempt: { ...pending, status: 'running', updatedAtMs: nowMs },
  }
}

export function settleThreadGoalAttempt({
  record,
  attemptId,
  nowMs,
}: {
  record: ThreadGoalAttemptRecord
  attemptId: string
  nowMs: number
}): ThreadGoalAttemptRecord {
  const pending = record.pendingAttempt
  if (!pending || pending.attemptId !== attemptId) return record
  return {
    ...record,
    pendingAttempt: {
      ...pending,
      status: 'settled',
      updatedAtMs: nowMs,
    },
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0
}

const WAKE_TRIGGERS: readonly ThreadGoalWakeTrigger[] = [
  'idle',
  'budget-wrap-up',
  'task-completed',
  'process-exited',
  'timer',
  'user-resumed',
]

const ATTEMPT_STATUSES: readonly ThreadGoalAttemptStatus[] = [
  'pending',
  'claimed',
  'running',
  'settled',
]

/**
 * Parse a persisted attempt.
 *
 * Returns null for anything unreadable rather than a partly-filled attempt: an
 * attempt with a wrong epoch or revision is worse than no attempt, because the
 * scheduler would treat it as a live claim.
 */
export function parseThreadGoalAttempt(
  input: unknown,
): ThreadGoalAttempt | null {
  if (!input || typeof input !== 'object') return null
  const c = input as Record<string, unknown>
  if (
    typeof c.attemptId !== 'string' ||
    c.attemptId.length === 0 ||
    typeof c.wakeKey !== 'string' ||
    c.wakeKey.length === 0 ||
    !isNonNegativeInteger(c.goalRevision) ||
    !isNonNegativeInteger(c.leaseEpoch) ||
    !isNonNegativeInteger(c.leaseExpiresAtMs) ||
    !isNonNegativeInteger(c.createdAtMs) ||
    !isNonNegativeInteger(c.updatedAtMs) ||
    !(WAKE_TRIGGERS as readonly unknown[]).includes(c.trigger) ||
    !(ATTEMPT_STATUSES as readonly unknown[]).includes(c.status) ||
    !(c.claimedBy === null || typeof c.claimedBy === 'string')
  ) {
    return null
  }

  return {
    attemptId: c.attemptId,
    goalRevision: c.goalRevision,
    trigger: c.trigger as ThreadGoalWakeTrigger,
    wakeKey: c.wakeKey,
    status: c.status as ThreadGoalAttemptStatus,
    claimedBy: c.claimedBy as string | null,
    leaseEpoch: c.leaseEpoch,
    leaseExpiresAtMs: c.leaseExpiresAtMs,
    createdAtMs: c.createdAtMs,
    updatedAtMs: c.updatedAtMs,
  }
}

export function parseThreadGoalAttemptRecord(
  pendingAttempt: unknown,
  recentWakeKeys: unknown,
): ThreadGoalAttemptRecord {
  return {
    pendingAttempt: parseThreadGoalAttempt(pendingAttempt),
    recentWakeKeys: Array.isArray(recentWakeKeys)
      ? recentWakeKeys
          .filter((k): k is string => typeof k === 'string')
          .slice(-MAX_REMEMBERED_WAKE_KEYS)
      : [],
  }
}
