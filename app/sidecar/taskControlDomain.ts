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
 */
import { StopTaskError, stopTask } from '../../src/tasks/stopTask.js'
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
}

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
  }
}

export type SidecarTaskControlDomain = {
  /**
   * Stop/kill the task with `taskId` in this session's store. Throw-free: an
   * unknown / already-terminal / unsupported target degrades to `ok:false` with no
   * side effect (fail-closed), never an exception.
   */
  stop(taskId: string): Promise<TaskStopResult>
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
