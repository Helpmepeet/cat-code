/**
 * Tracks background tasks that have reached a terminal state but whose
 * model-facing notification has not been enqueued yet.
 *
 * Why this exists: a background agent's status flips to terminal well before
 * its notification is queued. `completeAsyncAgent` runs at
 * `src/tools/AgentTool/AgentTool.tsx:1714`, then a full `classifyHandoffIfNeeded`
 * API call, worktree cleanup, and a transcript write, and only then
 * `enqueueAgentNotification` at `:1756`. Throughout that window
 * `isBackgroundTask()` already returns false (`src/tasks/types.ts:38`) and the
 * command queue is still empty, so the headless wait loop reads it as idle,
 * exits, and flushes the pre-wait `heldBackResult` as the run's final answer.
 *
 * Only ids this run actually observed as background work are tracked. A global
 * scan of `state.tasks` cannot be used: terminal tasks with `notified: false`
 * are deliberately never evicted (`src/utils/task/framework.ts:129` and `:168`),
 * so one such task would keep a global predicate true for the life of the
 * process. `TaskState` also widens to `any` (`src/tasks/types.ts` imports two
 * modules that are not on disk, see `src/tasks/attention.ts:11`), so a broad
 * structural predicate would look type-checked without being so. Callers pass
 * narrow facts instead.
 *
 * Deadlines fail closed. Waiting forever would hang headless runs; resuming the
 * normal exit path on expiry would flush the stale held result and exit 0, which
 * is exactly the defect this module exists to prevent. Expiry is reported to the
 * caller so it can fail the run.
 */

/** Narrow, caller-derived facts about one task. Deliberately not `TaskState`. */
export type ObservedTask = {
  id: string
  /** `isBackgroundTask(t) && t.type !== 'in_process_teammate'` at observe time. */
  isBackgroundWork: boolean
  /** completed | failed | killed */
  isTerminal: boolean
  notified: boolean
}

export type NotificationSweep = {
  /** Tracked ids still awaiting their notification, within deadline. */
  pending: string[]
  /** Tracked ids whose deadline passed. Untracked afterwards; fail the run. */
  expired: string[]
}

export type PendingTaskNotifications = {
  update(tasks: readonly ObservedTask[], nowMs: number): NotificationSweep
  /** @internal test seam */
  _trackedIdsForTest(): string[]
}

export function createPendingTaskNotifications(
  deadlineMs: number,
): PendingTaskNotifications {
  // id -> deadline timestamp, or null while the task is still running.
  const tracked = new Map<string, { deadlineAt: number | null }>()

  return {
    update(tasks, nowMs) {
      const byId = new Map<string, ObservedTask>()
      for (const task of tasks) {
        byId.set(task.id, task)
        if (task.isBackgroundWork && !tracked.has(task.id)) {
          tracked.set(task.id, { deadlineAt: null })
        }
      }

      const pending: string[] = []
      const expired: string[] = []

      for (const [id, entry] of tracked) {
        const task = byId.get(id)
        // Gone from AppState, or delivered. Either way we are done with it.
        if (!task || task.notified) {
          tracked.delete(id)
          continue
        }
        if (!task.isTerminal) {
          // Still working. `hasRunningBg` covers this case, and a task that
          // resumes must not carry a deadline set by an earlier terminal blip.
          entry.deadlineAt = null
          continue
        }
        if (entry.deadlineAt === null) {
          entry.deadlineAt = nowMs + deadlineMs
        }
        if (nowMs >= entry.deadlineAt) {
          tracked.delete(id)
          expired.push(id)
          continue
        }
        pending.push(id)
      }

      return { pending, expired }
    },

    _trackedIdsForTest() {
      return [...tracked.keys()]
    },
  }
}
