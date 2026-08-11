/**
 * Task-control write-seam (P4-8b) — the deferred orchestrator worker Stop/kill
 * action, wired to the engine's OWN task-abort machinery. P4-8's roster/detail/
 * focus surfaces shipped read-only because "Stop/kill a worker needs an inbound
 * write verb" (`decisions/AGENT-CHROME.md` §2, PARITY-LEDGER §20 "WorkerDetail
 * Stop button" + §21 TasksPage "K → stop"); this domain is that verb's engine side.
 *
 * The real abort call is `stopTask` (`src/tasks/stopTask.ts:58`) — the SAME
 * function `TaskStopTool` and the SDK `stop_task` control use. It looks the task up
 * by id in THIS session's `AppState.tasks` (the SAME store the tasks/agent-mode
 * read-seams read), validates it is running, and dispatches the per-type
 * `Task.kill`: a `local_agent` worker → `killAsyncAgent` (`LocalAgentTask.tsx:368`
 * — aborts the worker's `AbortController` + releases its Codex lease). The store
 * mutation drives the existing `tasks.snapshot` / `agent-mode.snapshot`
 * re-broadcasts (no synthetic frame — the live path any engine-side kill takes).
 *
 * Fail-closed: the renderer names a `taskId` only; `stopTask` re-resolves it
 * against the live store and throws `StopTaskError` for an unknown / already-
 * terminal / unsupported target, which becomes an `ok:false` result with NO side
 * effect. secretGuard-clean by construction — the result carries a redacted human
 * string, never a token. A test injects a fake executor so the SERVER boundary is
 * exercised without the engine round-trip (the accountsDomain / agentModeDomain
 * executor-seam idiom).
 *
 * DISMISS (2026-08-09, the CC-32 follow-up) is the terminal counterpart, and it
 * has no `stopTask`-shaped engine entry point of its own — the terminal REPL's
 * `x` key composes two engine calls, so this does the same two:
 * `stopOrDismissAgent` (`src/state/teammateViewHelpers.ts:116`) to set
 * `evictAfter: 0` and drop `retain`, then `evictTerminalTask`
 * (`src/utils/task/framework.ts:120`) to retire the row. Both are the engine's
 * own; nothing here deletes from the store. `evictTerminalTask` keeps its own
 * guards, so a worker whose completion notification is still queued is MARKED
 * here and retired by the panel reaper on its next beat (`panelTaskReaper.ts`) —
 * the mark is what makes that eventual sweep succeed, since a blocked handoff
 * never had a deadline to sweep on.
 */
import { StopTaskError, stopTask } from '../../src/tasks/stopTask.js'
import { isPanelAgentTask } from '../../src/tasks/LocalAgentTask/LocalAgentTask.js'
import { isTerminalTaskStatus } from '../../src/Task.js'
import { stopOrDismissAgent } from '../../src/state/teammateViewHelpers.js'
import { evictTerminalTask } from '../../src/utils/task/framework.js'
import type { AppStateStore } from '../../src/state/AppStateStore.js'

/** The redacted outcome of a stop write (no transport, no secret). */
export type TaskStopResult = {
  ok: boolean
  message: string
}

/**
 * The engine stop op, behind a seam. The real implementation
 * (`createRealTaskControlExecutor`) wires the engine's OWN `stopTask` against this
 * session's app-state store; boundary tests inject a fake so a headless round-trip
 * proves the SERVER wiring without mutating a real task graph.
 */
export type TaskControlExecutor = {
  /**
   * Stop the task by id via the engine's own `stopTask`. Resolves to the stopped
   * task's type + display on success; throws `StopTaskError` (not_found /
   * not_running / unsupported_type) when the live store refuses the target.
   */
  stop(taskId: string): Promise<{ taskType: string; display: string | undefined }>
  /**
   * Retire a FINISHED panel worker via the engine's own dismiss composition. The
   * refusal codes mirror `StopTaskError`'s vocabulary, but they are decided here
   * rather than thrown by the engine: `evictTerminalTask` is silent about why it
   * declined, so the target is checked against the live store BEFORE the write.
   * A result union rather than an exception, because nothing engine-side throws.
   */
  dismiss(
    taskId: string,
  ): Promise<
    | { ok: true; display: string | undefined }
    | { ok: false; code: TaskDismissRefusal }
  >
}

/** Why a dismiss was refused at the live store (fail-closed, no side effect). */
export type TaskDismissRefusal = 'not_found' | 'still_running' | 'unsupported_type'

export function createRealTaskControlExecutor(
  appStateStore: AppStateStore,
): TaskControlExecutor {
  return {
    async stop(taskId) {
      const result = await stopTask(taskId, {
        getAppState: appStateStore.getState,
        setAppState: appStateStore.setState,
      })
      return { taskType: result.taskType, display: result.command }
    },
    async dismiss(taskId) {
      // Re-resolve against the LIVE store — the renderer's id is a claim, not a
      // handle (T6-analog). `isPanelAgentTask` is the same predicate the panel
      // reaper uses, so the two agree on what a dismissible row even is.
      const task = appStateStore.getState().tasks?.[taskId]
      if (!task) return { ok: false, code: 'not_found' }
      if (!isPanelAgentTask(task)) return { ok: false, code: 'unsupported_type' }
      if (!isTerminalTaskStatus(task.status)) {
        return { ok: false, code: 'still_running' }
      }
      const display = task.description
      stopOrDismissAgent(taskId, appStateStore.setState)
      // Best-effort now, guaranteed later: this succeeds outright once the
      // completion notification has been consumed, and otherwise the `evictAfter:
      // 0` just written is what lets the reaper's next sweep finish the job.
      evictTerminalTask(taskId, appStateStore.setState)
      return { ok: true, display }
    },
  }
}

export type SidecarTaskControlDomain = {
  /**
   * Stop/kill the task with `taskId` in this session's store. Throw-free: an
   * unknown / already-terminal / unsupported target degrades to `ok:false` with no
   * side effect (fail-closed), never an exception.
   */
  stop(taskId: string): Promise<TaskStopResult>
  /**
   * Retire the finished worker with `taskId` from this session's store. Throw-free
   * and fail-closed the same way `stop` is: an unknown / still-running / non-worker
   * target degrades to `ok:false` with no side effect.
   */
  dismiss(taskId: string): Promise<TaskDismissResult>
}

/**
 * A dismiss outcome, carrying WHY it was refused. The code survives the domain
 * boundary because the live store is not the only plane a worker's row can come
 * from: a `not_found` means nothing LIVE holds this row, which is a different
 * situation from `still_running`, and only the server can see the other plane.
 * Flattening both into prose here would force the server to match on strings.
 */
export type TaskDismissResult = TaskStopResult & {
  refusal?: TaskDismissRefusal
}

export function createSidecarTaskControlDomain(
  appStateStore: AppStateStore,
  options: { executor?: TaskControlExecutor } = {},
): SidecarTaskControlDomain {
  const executor = options.executor ?? createRealTaskControlExecutor(appStateStore)
  return {
    async stop(taskId) {
      try {
        const { taskType, display } = await executor.stop(taskId)
        const label = display ? ` ${display}` : ''
        return {
          ok: true,
          message:
            taskType === 'local_agent'
              ? `Stopped worker${label}.`
              : `Stopped task${label}.`,
        }
      } catch (error) {
        if (error instanceof StopTaskError) {
          // Fail closed — the live store refused the renderer-named target. Map the
          // engine code to a redacted message (never echo the raw error, which
          // repeats the id); no store mutation happened, so no snapshot fires.
          return { ok: false, message: stopTaskErrorMessage(error) }
        }
        return {
          ok: false,
          message: `Could not stop the task: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }
      }
    },
    async dismiss(taskId) {
      try {
        const outcome = await executor.dismiss(taskId)
        if (!outcome.ok) {
          return {
            ok: false,
            refusal: outcome.code,
            message: dismissRefusalMessage(outcome.code),
          }
        }
        const label = outcome.display ? ` ${outcome.display}` : ''
        return { ok: true, message: `Dismissed worker${label}.` }
      } catch (error) {
        return {
          ok: false,
          message: `Could not dismiss the worker: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }
      }
    },
  }
}

function dismissRefusalMessage(refusal: TaskDismissRefusal): string {
  switch (refusal) {
    case 'not_found':
      return 'That worker is already gone.'
    case 'still_running':
      return 'That worker is still running. Stop it first.'
    case 'unsupported_type':
      return "That task type can't be dismissed."
    default: {
      // Closed union tripwire — a new refusal code must get its own message.
      const exhaustive: never = refusal
      return exhaustive
    }
  }
}

function stopTaskErrorMessage(error: StopTaskError): string {
  switch (error.code) {
    case 'not_found':
      return 'That task is no longer running.'
    case 'not_running':
      return 'That task has already finished.'
    case 'unsupported_type':
      return "That task type can't be stopped."
    default:
      return 'Could not stop the task.'
  }
}
