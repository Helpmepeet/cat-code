/**
 * The headless end-of-turn wait loop, and the held-back result it protects.
 *
 * `runHeadlessStreaming` runs a turn, then polls until nothing is outstanding
 * before letting the run finish. When background agents are still working the
 * turn's `result` is held back and flushed once the poll decides things are
 * idle; the whole point of the poll is that the model gets a turn to read what
 * the agent found before the run's answer is chosen.
 *
 * This lives in its own module because that decision has no other seam:
 * `runHeadlessStreaming` is not exported, takes twelve collaborators, and its
 * loop is only reachable through a live model turn. Every bug the review found
 * in the 2026-08-27 handover fix was in this loop rather than in the tracker it
 * consumes, and the tracker's own tests could not see any of them.
 *
 * Collaborators are injected. Stable ones (state reads, output, session id)
 * are bound per streaming run; the ones that only exist inside `run()` in
 * print.ts (draining the command queue, peeking it, the goal loop) are passed
 * to `runWaitLoop()`.
 */

import { randomUUID } from 'crypto'
import { EMPTY_USAGE } from '../services/api/emptyUsage.js'
import type { StdoutMessage } from '../entrypoints/sdk/controlTypes.js'
import {
  createPendingTaskNotifications,
  type ObservedTask,
} from './pendingTaskNotifications.js'

// A background agent's status goes terminal long before its notification is
// enqueued — AgentTool.tsx:1714 flips it, then a full classifyHandoffIfNeeded
// API call and worktree cleanup run, and only :1756 enqueues. The wait loop
// below reads that window as idle (isBackgroundTask() is already false,
// queue still empty) and would flush heldBackResult as the run's answer.
// 120s comfortably exceeds a classifier round trip plus git cleanup; the
// window observed in the 2026-08-27 incident was one in-flight API call.
const UNDELIVERED_NOTIFICATION_DEADLINE_MS = 120_000

/**
 * One consistent read of AppState. Both predicates and the task projection come
 * from the same snapshot so a task cannot appear running to one and idle to the
 * other within a single poll.
 */
export type WaitLoopStateSnapshot = {
  /**
   * `isBackgroundTask(t) && t.type !== 'in_process_teammate'` over running
   * tasks. Governs whether the loop keeps polling.
   */
  hasRunningBackgroundWork: boolean
  /**
   * The narrower predicate that decides whether a turn's result is held back:
   * a running `local_agent`/`local_workflow` that is background work.
   */
  hasHoldbackAgents: boolean
  /** Every task in AppState, projected through `toObservedTask`. */
  tasks: readonly ObservedTask[]
}

export type HeadlessWaitLoopDeps = {
  readState: () => WaitLoopStateSnapshot
  /** `output.enqueue` — the single FIFO everything else writes to. */
  emit: (message: StdoutMessage) => void
  getSessionId: () => string
  /** Suggestion bookkeeping for a held result that is thrown away. */
  onHeldResultDiscarded: () => void
  /** Suggestion bookkeeping for a held result that is finally delivered. */
  onHeldResultFlushed: () => void
  now?: () => number
  deadlineMs?: number
}

export type HeadlessWaitLoopRunDeps = {
  drainCommandQueue: () => Promise<void>
  /** Drain the SDK event queue into the output stream. */
  flushSdkEvents: () => void
  /** `peek(isMainThread) !== undefined`. */
  hasMainThreadQueued: () => boolean
  /**
   * Ask the goal loop for a continuation and enqueue it; returns whether one
   * was enqueued. Null when this run has no goal loop.
   */
  requestGoalContinuation: (() => Promise<boolean>) | null
  isShuttingDown: () => boolean
  sleep: (ms: number) => Promise<void>
  setRunPhase: (phase: 'draining_commands' | 'waiting_for_agents') => void
}

export type WaitLoopOutcome =
  | { type: 'idle' }
  | { type: 'failed_closed'; undeliveredTaskIds: string[] }

export type HeadlessWaitLoop = {
  /** Hold the turn's result back while background agents are running. */
  onTurnResult(message: StdoutMessage): void
  /** Mid-turn observation for non-result messages. */
  observe(): void
  /** True while a result is being held for background agents. */
  isResultHeld(): boolean
  runWaitLoop(deps: HeadlessWaitLoopRunDeps): Promise<WaitLoopOutcome>
  _forTest: { trackedIds(): string[] }
}

export function createHeadlessWaitLoop(
  deps: HeadlessWaitLoopDeps,
): HeadlessWaitLoop {
  const now = deps.now ?? (() => Date.now())
  const pendingTaskNotifications = createPendingTaskNotifications(
    deps.deadlineMs ?? UNDELIVERED_NOTIFICATION_DEADLINE_MS,
  )
  let heldBackResult: StdoutMessage | null = null
  // Run-scoped, not per-turn: every `update()` can expire an entry, and an
  // expiry dropped on the floor is unrecoverable (the id is deleted from the
  // tracker, so no later poll can report it). Cleared when consumed.
  const undeliveredTaskIds: string[] = []

  const sweep = (snapshot: WaitLoopStateSnapshot) => {
    const result = pendingTaskNotifications.update(snapshot.tasks, now())
    undeliveredTaskIds.push(...result.expired)
    return result
  }

  return {
    onTurnResult(message) {
      const snapshot = deps.readState()
      // Hold-back: don't emit result while background agents are running
      if (snapshot.hasHoldbackAgents) {
        heldBackResult = message
        // Seed the tracker while those tasks are still running, so their ids
        // are known before any of them flips to terminal.
        sweep(snapshot)
      } else {
        heldBackResult = null
        deps.emit(message)
      }
    },

    observe() {
      sweep(deps.readState())
    },

    isResultHeld() {
      return heldBackResult !== null
    },

    async runWaitLoop(runDeps) {
      // Use a do-while loop to drain commands and then wait for any
      // background agents that are still running. When agents complete,
      // their notifications are enqueued and the loop re-drains.
      let waitingForAgents = false
      do {
        // Drain SDK events (task_started, task_progress) before command queue
        // so progress events precede task_notification on the stream.
        runDeps.flushSdkEvents()

        runDeps.setRunPhase('draining_commands')
        await runDeps.drainCommandQueue()

        // Check for running background tasks before exiting. `readState`
        // computes both predicates from one AppState read; see its type for
        // the in_process_teammate exclusion (gh-30008).
        waitingForAgents = false
        {
          const snapshot = deps.readState()
          const hasRunningBg = snapshot.hasRunningBackgroundWork
          // Terminal-but-unnotified background work. Without this the handover
          // window reads as idle: hasRunningBg is already false and the
          // notification has not reached the queue yet.
          const notificationSweep = sweep(snapshot)
          if (undeliveredTaskIds.length > 0) {
            // Stop here rather than at the bottom of the loop. Anything that
            // runs after this decision (a goal continuation, or a turn on a
            // late notification) spends quota producing an answer the
            // fail-closed branch below is about to discard. Tested against the
            // accumulator, not this sweep, so an expiry recorded mid-turn by
            // the observation in the message handler also stops the loop.
            waitingForAgents = false
            break
          }
          const hasPendingNotification = notificationSweep.pending.length > 0
          let hasMainThreadQueued = runDeps.hasMainThreadQueued()

          // Headless idle boundary: the queue has drained and nothing is
          // outstanding, which is where the terminal would consider a goal
          // continuation. Asked LAST so real queued input and running tasks
          // always outrank automatic continuation.
          // `isShuttingDown()` is load-bearing: SIGINT aborts the query and
          // ask() returns normally, so without this the drain completes, a
          // fresh continuation is enqueued, and Ctrl-C starts another model
          // turn instead of stopping.
          if (
            !hasRunningBg &&
            // A continuation enqueued during the handover window would race
            // the task notification that is about to arrive.
            !hasPendingNotification &&
            !hasMainThreadQueued &&
            runDeps.requestGoalContinuation &&
            !runDeps.isShuttingDown()
          ) {
            if (await runDeps.requestGoalContinuation()) {
              hasMainThreadQueued = true
            }
          }

          if (
            hasRunningBg ||
            // Not while shutting down: gracefulShutdown arms a force-exit, so
            // waiting here just eats the interrupted result.
            (hasPendingNotification && !runDeps.isShuttingDown()) ||
            hasMainThreadQueued
          ) {
            waitingForAgents = true
            if (!hasMainThreadQueued) {
              runDeps.setRunPhase('waiting_for_agents')
              // No commands ready yet, wait for tasks to complete
              await runDeps.sleep(100)
            }
            // Loop back to drain any newly queued commands
          }
        }
      } while (waitingForAgents)

      if (undeliveredTaskIds.length > 0) {
        // Fail closed. Resuming the normal flush here would emit the model's
        // pre-wait holding message as the run's answer and exit 0 — the exact
        // failure this patch exists to prevent. Drop it and report an error so
        // the process exits non-zero.
        heldBackResult = null
        deps.onHeldResultDiscarded()
        const expired = [...undeliveredTaskIds]
        deps.emit({
          type: 'result',
          subtype: 'error_during_execution',
          duration_ms: 0,
          duration_api_ms: 0,
          is_error: true,
          num_turns: 0,
          stop_reason: null,
          session_id: deps.getSessionId(),
          total_cost_usd: 0,
          usage: EMPTY_USAGE,
          modelUsage: {},
          permission_denials: [],
          uuid: randomUUID(),
          errors: [
            `Background task result was never delivered to the model: ${expired.join(', ')}`,
          ],
        })
        undeliveredTaskIds.length = 0
        return { type: 'failed_closed', undeliveredTaskIds: expired }
      } else if (heldBackResult) {
        deps.emit(heldBackResult)
        heldBackResult = null
        deps.onHeldResultFlushed()
      }
      return { type: 'idle' }
    },

    _forTest: {
      trackedIds: () => pendingTaskNotifications._forTest.trackedIds(),
    },
  }
}
