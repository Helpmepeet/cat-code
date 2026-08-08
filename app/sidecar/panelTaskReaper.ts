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
 * The other evictor — `getUnifiedTaskAttachments` (`src/utils/attachments.ts:3456`)
 * — runs at turn start, which is exactly the wrong moment: the 30s grace has by
 * construction not elapsed on the completion-notification turn that follows a
 * worker finishing, and an idle session starts no further turn.
 *
 * So this is the sidecar's equivalent of the between-turn drain the server
 * already owns for queued prompts (`sidecarServer.ts:470`): same reason, same
 * shape. It reuses the engine's OWN eviction entry point rather than deleting
 * from the store itself, so the `retain` / not-yet-notified / pending-
 * notification guards stay the engine's (`src/utils/task/framework.ts:120-140`).
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
      let stopped = false

      const panelTasks = () =>
        Object.values(appStateStore.getState().tasks).filter(isPanelAgentTask)

      const sweep = () => {
        timer = null
        if (stopped) return
        const now = Date.now()
        for (const task of panelTasks()) {
          if ((task.evictAfter ?? Infinity) <= now) {
            evictTerminalTask(task.id, appStateStore.setState)
          }
        }
        schedule()
      }

      // Deadline-driven, not a standing poll: a session with no terminal worker
      // pending eviction holds no timer at all. Re-armed from the store
      // subscription, so a worker that finishes mid-idle still gets its deadline.
      const schedule = () => {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        if (stopped) return
        let earliest: number | null = null
        for (const task of panelTasks()) {
          const deadline = task.evictAfter
          if (deadline === undefined) continue
          if (earliest === null || deadline < earliest) earliest = deadline
        }
        if (earliest === null) return
        const remaining = earliest - Date.now()
        timer = setTimeout(sweep, remaining > 0 ? remaining : RETRY_INTERVAL_MS)
      }

      const unsubscribe = appStateStore.subscribe(schedule)
      schedule()

      return () => {
        stopped = true
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        unsubscribe()
      }
    },
  }
}
