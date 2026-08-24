import {
  accountThreadGoalTurn,
  renderThreadGoalBudgetLimitPrompt,
  renderThreadGoalContinuationPrompt,
  type ThreadGoal,
  type ThreadGoalContinuationKind,
  type ThreadGoalTurnAccounting,
} from './threadGoal.js'
import {
  claimThreadGoalAttempt,
  isThreadGoalAttemptValid,
  markThreadGoalAttemptRunning,
  recordThreadGoalWake,
  settleThreadGoalAttempt,
  type ThreadGoalAttemptRecord,
  type ThreadGoalWakeTrigger,
} from './threadGoalAttempt.js'
import {
  isSchedulableThreadGoalStatus,
  isTerminalThreadGoalStatus,
} from './threadGoalState.js'

/**
 * The one continuation scheduler for a logical goal.
 *
 * Continuation used to be a React effect inside the terminal REPL, so the
 * desktop, web, and headless runtimes executed a submitted turn and returned
 * idle with no goal loop at all. This module is the loop, expressed against
 * ports rather than any runtime's internals, so every front end drives the
 * same semantics instead of reimplementing them.
 *
 * What it deliberately does NOT own: running the turn, persisting the goal, or
 * deciding permissions. Those stay with the host, which is what keeps this
 * testable without a session and stops it from becoming a second engine.
 */

export type ThreadGoalSchedulerHost = {
  /**
   * Stable id for this scheduler instance. Written into the attempt lease, so
   * two schedulers observing one session cannot both believe they own a turn.
   */
  ownerId: string
  now(): number

  /** Current durable goal, or null. Re-read at every decision point. */
  getGoal(): ThreadGoal | null

  /**
   * Persist scheduler bookkeeping (attempt record, accounting) for a goal the
   * caller has already confirmed is current. Must not bump `revision`.
   */
  saveGoal(goal: ThreadGoal): void

  /**
   * Whether a continuation may start right now. The host answers from its own
   * session state: no turn running, nothing queued from the user, no dialog
   * awaiting an answer, not in plan mode.
   */
  canStartAutomaticTurn(): boolean

  /**
   * True when something outside this scheduler already drives turns for the
   * session (an outer loop, an automation, a remote controller). Native goal
   * continuation then yields rather than creating a second scheduler.
   */
  hasExternalScheduler?(): boolean

  /**
   * Submit the continuation prompt. Returns false when the host declined, in
   * which case the attempt is released and nothing is charged.
   */
  startTurn(input: {
    prompt: string
    kind: ThreadGoalContinuationKind
    attemptId: string
  }): boolean | Promise<boolean>

  /** Agent Mode changes the continuation prompt's guidance. */
  isAgentMode?(): boolean

  /** Optional observability hook. Never user-visible text. */
  onDecision?(decision: ThreadGoalSchedulerDecision): void
}

export type ThreadGoalSchedulerDecision =
  | { type: 'started'; kind: ThreadGoalContinuationKind; attemptId: string }
  | {
      type: 'skipped'
      reason:
        | 'no-goal'
        | 'not-schedulable'
        | 'host-busy'
        | 'external-scheduler'
        | 'duplicate-wake'
        | 'attempt-in-flight'
        | 'stale-attempt'
        | 'host-declined'
    }

/** The handle a running turn carries so it can be validated when it ends. */
export type ThreadGoalRunningAttempt = {
  attemptId: string
  leaseEpoch: number
  goalId: string
  goalRevision: number
  kind: ThreadGoalContinuationKind
}

function readAttemptRecord(goal: ThreadGoal): ThreadGoalAttemptRecord {
  return {
    pendingAttempt: goal.pendingAttempt,
    recentWakeKeys: goal.recentWakeKeys,
  }
}

function withAttemptRecord(
  goal: ThreadGoal,
  record: ThreadGoalAttemptRecord,
): ThreadGoal {
  return {
    ...goal,
    pendingAttempt: record.pendingAttempt,
    recentWakeKeys: record.recentWakeKeys,
  }
}

export type ThreadGoalScheduler = {
  /**
   * Consider starting a turn because something woke the goal.
   *
   * `sourceId` must be stable for one logical event and different for genuinely
   * separate ones: it is what makes a redelivered wake produce no second turn.
   */
  wake(input: {
    trigger: ThreadGoalWakeTrigger
    sourceId: string
  }): Promise<ThreadGoalSchedulerDecision>

  /** The attempt currently running, or null. */
  getRunningAttempt(): ThreadGoalRunningAttempt | null

  /**
   * Charge and settle a finished turn, automatic or user-driven.
   *
   * `attempt` is null for a turn the user drove; that is the only difference,
   * and it keeps ONE place that charges a goal. `goalId` is the goal the turn
   * started against, so a turn that outlived a replacement charges nothing.
   *
   * Returns the goal that was persisted, or null when nothing was charged.
   */
  settle(input: {
    attempt: ThreadGoalRunningAttempt | null
    goalId: string
    accounting: Omit<ThreadGoalTurnAccounting, 'wasAutomaticContinuation'>
  }): ThreadGoal | null

  /** Release an attempt without charging it (host declined, turn never ran). */
  release(attemptId: string): void
}

export function createThreadGoalScheduler(
  host: ThreadGoalSchedulerHost,
): ThreadGoalScheduler {
  let running: ThreadGoalRunningAttempt | null = null

  function report(
    decision: ThreadGoalSchedulerDecision,
  ): ThreadGoalSchedulerDecision {
    host.onDecision?.(decision)
    return decision
  }

  async function wake({
    trigger,
    sourceId,
  }: {
    trigger: ThreadGoalWakeTrigger
    sourceId: string
  }): Promise<ThreadGoalSchedulerDecision> {
    // Yielding to an outer scheduler is checked FIRST. If something else owns
    // turn creation for this session, even recording a wake would leave an
    // attempt this scheduler never runs.
    if (host.hasExternalScheduler?.()) {
      return report({ type: 'skipped', reason: 'external-scheduler' })
    }
    if (running) {
      return report({ type: 'skipped', reason: 'attempt-in-flight' })
    }

    const goal = host.getGoal()
    if (!goal) return report({ type: 'skipped', reason: 'no-goal' })

    // `budget_limited` gets exactly one wrap-up turn; every other non-active
    // status is unschedulable, which is how a stalled, blocked, failed, paused,
    // waiting, or complete goal stops the loop without a separate flag.
    const kind: ThreadGoalContinuationKind | null =
      isSchedulableThreadGoalStatus(goal.status)
        ? 'active'
        : goal.status === 'budget_limited' && trigger === 'budget-wrap-up'
          ? 'budget-wrap-up'
          : null
    if (!kind) return report({ type: 'skipped', reason: 'not-schedulable' })

    // Asked AFTER the durable checks and again below, because the human can
    // queue input or open a dialog at any point in this sequence.
    if (!host.canStartAutomaticTurn()) {
      return report({ type: 'skipped', reason: 'host-busy' })
    }

    const nowMs = host.now()
    const woken = recordThreadGoalWake({
      record: readAttemptRecord(goal),
      goalId: goal.goalId,
      goalRevision: goal.revision,
      trigger,
      sourceId,
      nowMs,
    })
    if (woken.outcome !== 'created') {
      return report({
        type: 'skipped',
        reason:
          woken.outcome === 'duplicate' ? 'duplicate-wake' : 'attempt-in-flight',
      })
    }

    const attemptId = woken.record.pendingAttempt!.attemptId
    const claimed = claimThreadGoalAttempt({
      record: woken.record,
      attemptId,
      ownerId: host.ownerId,
      currentGoalRevision: goal.revision,
      nowMs,
    })
    if (claimed.outcome !== 'claimed') {
      return report({ type: 'skipped', reason: 'stale-attempt' })
    }

    const claimedRecord = markThreadGoalAttemptRunning({
      record: claimed.record,
      attemptId,
      nowMs,
    })
    const leaseEpoch = claimedRecord.pendingAttempt!.leaseEpoch

    // Persist the claim BEFORE the turn starts. A crash after this point leaves
    // a claimed attempt whose lease expires and is reclaimed; a crash before it
    // leaves no attempt at all. Neither duplicates a turn.
    host.saveGoal(withAttemptRecord(goal, claimedRecord))

    const attempt: ThreadGoalRunningAttempt = {
      attemptId,
      leaseEpoch,
      goalId: goal.goalId,
      goalRevision: goal.revision,
      kind,
    }
    running = attempt

    const prompt =
      kind === 'budget-wrap-up'
        ? renderThreadGoalBudgetLimitPrompt(goal)
        : renderThreadGoalContinuationPrompt(goal, {
            agentMode: host.isAgentMode?.() ?? false,
          })

    let accepted = false
    try {
      accepted = await host.startTurn({ prompt, kind, attemptId })
    } catch {
      accepted = false
    }

    if (!accepted) {
      running = null
      releaseAttempt(attemptId)
      return report({ type: 'skipped', reason: 'host-declined' })
    }

    return report({ type: 'started', kind, attemptId })
  }

  function releaseAttempt(attemptId: string): void {
    const goal = host.getGoal()
    if (!goal || goal.pendingAttempt?.attemptId !== attemptId) return
    host.saveGoal(
      withAttemptRecord(
        goal,
        settleThreadGoalAttempt({
          record: readAttemptRecord(goal),
          attemptId,
          nowMs: host.now(),
        }),
      ),
    )
  }

  return {
    wake,

    getRunningAttempt() {
      return running
    },

    release(attemptId: string) {
      if (running?.attemptId === attemptId) running = null
      releaseAttempt(attemptId)
    },

    settle({ attempt, goalId, accounting }) {
      if (attempt && running?.attemptId === attempt.attemptId) running = null

      const goal = host.getGoal()
      // A turn that started against a goal the user has since replaced or
      // cleared must not charge whatever goal now occupies the session.
      if (!goal || goal.goalId !== goalId) return null

      const nowMs = host.now()

      // A user-driven turn has no attempt to fence: the human was present for
      // the whole turn, so there is no stale decision to guard against. It is
      // still refused on a terminal goal.
      if (!attempt) {
        if (isTerminalThreadGoalStatus(goal.status)) return null
        const { goal: charged } = accountThreadGoalTurn(
          goal,
          { ...accounting, wasAutomaticContinuation: false },
          nowMs,
        )
        host.saveGoal(charged)
        return charged
      }

      // `goal.revision` is the LIVE revision, not the one remembered on the
      // attempt: comparing the attempt against itself would always pass and
      // fence nothing. Any durable goal mutation during the turn (a pause, an
      // edit, an update_goal) therefore voids this attempt's charge. That
      // loses the last turn's usage on a goal the model just blocked, which is
      // the safe direction: the alternative is writing accounting derived from
      // state the turn was not decided against.
      const stillValid = isThreadGoalAttemptValid({
        record: readAttemptRecord(goal),
        attemptId: attempt.attemptId,
        ownerId: host.ownerId,
        leaseEpoch: attempt.leaseEpoch,
        currentGoalRevision: goal.revision,
        nowMs,
      })

      const settledRecord = settleThreadGoalAttempt({
        record: readAttemptRecord(goal),
        attemptId: attempt.attemptId,
        nowMs,
      })

      // The goal moved on (paused, edited, replaced) or the lease was taken
      // over. Retire the attempt, but charge nothing and derive no stop from
      // it: the state it would act on is not the state it was decided against.
      if (!stillValid) {
        host.saveGoal(withAttemptRecord(goal, settledRecord))
        return null
      }

      // A goal completed mid-turn is terminal. Recording usage against it would
      // be the one write that can reopen a finished goal.
      if (isTerminalThreadGoalStatus(goal.status)) {
        host.saveGoal(withAttemptRecord(goal, settledRecord))
        return null
      }

      const { goal: accounted } = accountThreadGoalTurn(
        withAttemptRecord(goal, settledRecord),
        { ...accounting, wasAutomaticContinuation: true },
        nowMs,
      )
      host.saveGoal(accounted)
      return accounted
    },
  }
}
