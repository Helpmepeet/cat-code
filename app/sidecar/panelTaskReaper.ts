/**
 * Panel-task reaper — the desktop's owner of the engine's terminal-worker
 * visibility deadline.
 *
 * A finished `local_agent` worker is NOT meant to stay in `AppState.tasks`. The
 * engine stamps `evictAfter = now + PANEL_GRACE_MS` at the terminal transition
 * (`src/tasks/LocalAgentTask/LocalAgentTask.tsx:381,548,573`) and documents it as
 * "hide + GC-eligible after this time" (`:178-181`). Something has to come back
 * at that deadline and call `evictTerminalTask`. In the terminal REPL that owner
 * is a UI component: `CoordinatorTaskPanel`'s 1s tick
 * (`src/components/CoordinatorAgentStatus.tsx:51-63`). The desktop has no Ink
 * tree, so nothing came back, and a backgrounded worker's row survived forever
 * above the composer.
 *
 * So this is the sidecar's equivalent of the between-turn drain the server
 * already owns for queued prompts (`sidecarServer.ts:470`): same reason, same
 * shape. It reuses the engine's OWN eviction entry point rather than deleting
 * from the store itself, so the `retain` / not-yet-notified / pending-
 * notification guards stay the engine's (`src/utils/task/framework.ts:120-140`).
 *
 * SCOPE, precisely — this closes the missing TRIGGER, not a missing guard. The
 * engine has a second evictor, `getUnifiedTaskAttachments`
 * (`src/utils/attachments.ts:3451`), and it IS reachable on the desktop:
 * QueryEngine (`src/QueryEngine.ts:462`) → `processUserInput`
 * (`processUserInput.ts:497`) → `getAttachments` (`attachments.ts:755`), where
 * the session sidecar sets neither `CLAUDE_CODE_SIMPLE` nor
 * `CLAUDE_CODE_DISABLE_ATTACHMENTS` and `isMainThread` is true. But it only runs
 * at a turn boundary, so a session that goes idle right after a worker finishes
 * never reaches it — that is the gap this owns, and it is the terminal panel
 * tick's whole reason for existing too.
 *
 * What this does NOT fix: both evictors share one guard set (terminal status,
 * `notified`, no pending notification, `evictAfter` passed), so a worker held by
 * a guard is held here as well. The 2026-08-08 report that prompted this module
 * had ~41 post-grace turns and the row still did not leave, which means a GUARD
 * refused rather than a trigger being missing. Do not read this file as having
 * closed that; `docs/migration/STATUS.md` CC-32 carries the open question.
 *
 * Evicting the task is what makes the row disappear: the store mutation drives
 * the existing `tasks.snapshot` / `agent-mode.snapshot` re-broadcasts, and the
 * roster renders nothing once its worker list empties.
 */
import { isPanelAgentTask } from '../../src/tasks/LocalAgentTask/LocalAgentTask.js'
import type { AppStateStore } from '../../src/state/AppStateStore.js'
import { evictTerminalTask } from '../../src/utils/task/framework.js'

/**
 * Re-check cadence for a task whose deadline has passed but whose eviction the
 * engine still refuses (not `notified` yet, or its completion notification is
 * still queued). The terminal panel's tick is the same 1s, so a worker held back
 * by those guards clears on the same beat here as there.
 */
const RETRY_INTERVAL_MS = 1_000

export type SidecarPanelTaskReaper = {
  /** Begin watching this session's tasks. Returns the disposer. */
  start(): () => void
}

export function createSidecarPanelTaskReaper(
  appStateStore: AppStateStore,
): SidecarPanelTaskReaper {
  return {
    start() {
      let timer: ReturnType<typeof setTimeout> | null = null
      /** Absolute time the pending timer fires at; null when none is armed. */
      let armedFor: number | null = null
      /**
       * Earliest time the next sweep may run. Raised only after a sweep leaves a
       * due task behind, which means the engine's own guards refused it. Without
       * this floor, re-arming on a store change would fire the refused sweep
       * again immediately and spin at store-write speed.
       */
      let retryNotBefore = 0
      let stopped = false

      const panelTasks = () =>
        Object.values(appStateStore.getState().tasks).filter(isPanelAgentTask)

      /** The soonest `evictAfter` still pending, or null when none is stamped. */
      const earliestDeadline = (): number | null => {
        let earliest: number | null = null
        for (const task of panelTasks()) {
          const deadline = task.evictAfter
          if (deadline === undefined) continue
          if (earliest === null || deadline < earliest) earliest = deadline
        }
        return earliest
      }

      /**
       * Arm for `target`, but NEVER postpone a sweep that is already due sooner.
       * `schedule` runs on every app-state change, so an unconditional re-arm let
       * sub-second store churn (a sibling worker's progress updates during a live
       * turn) push the sweep past its deadline forever, which reproduced the very
       * symptom this module exists to fix.
       */
      const armAt = (target: number) => {
        if (stopped) return
        if (timer !== null && armedFor !== null && armedFor <= target) return
        if (timer) clearTimeout(timer)
        armedFor = target
        timer = setTimeout(sweep, Math.max(target - Date.now(), 0))
      }

      const sweep = () => {
        timer = null
        armedFor = null
        if (stopped) return
        const now = Date.now()
        for (const task of panelTasks()) {
          if ((task.evictAfter ?? Infinity) <= now) {
            evictTerminalTask(task.id, appStateStore.setState)
          }
        }
        const earliest = earliestDeadline()
        if (earliest === null) return
        if (earliest > Date.now()) {
          armAt(earliest)
          return
        }
        // Still due after the sweep: the engine refused it (not `notified` yet,
        // or its completion notification is still queued). Retry on the terminal
        // panel tick's cadence rather than at zero.
        retryNotBefore = Date.now() + RETRY_INTERVAL_MS
        armAt(retryNotBefore)
      }

      // Deadline-driven, not a standing poll: a session with no terminal worker
      // pending eviction holds no timer at all. Re-armed from the store
      // subscription, so a worker that finishes mid-idle still gets its deadline.
      const schedule = () => {
        if (stopped) return
        const earliest = earliestDeadline()
        if (earliest === null) {
          if (timer) clearTimeout(timer)
          timer = null
          armedFor = null
          return
        }
        // A deadline already past fires immediately (target clamps to 0 in
        // `armAt`), so nothing waits out a retry interval it never earned.
        armAt(Math.max(earliest, retryNotBefore))
      }

      const unsubscribe = appStateStore.subscribe(schedule)
      schedule()

      return () => {
        stopped = true
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        armedFor = null
        unsubscribe()
      }
    },
  }
}
