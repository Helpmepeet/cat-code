import type { AppState } from '../../state/AppState.js'
import { isTerminalTaskStatus } from '../../Task.js'
import type { TaskState } from '../../tasks/types.js'
import { randomUUID } from 'crypto'
import { hasPendingTaskNotification } from '../messageQueueManager.js'
import { enqueueSdkEvent } from '../sdkEventQueue.js'

// Duration to display killed tasks before eviction
export const STOPPED_DISPLAY_MS = 3_000

// Grace period for terminal local_agent tasks in the coordinator panel
export const PANEL_GRACE_MS = 30_000

type SetAppState = (updater: (prev: AppState) => AppState) => void

/**
 * Update a task's state in AppState.
 * Helper function for task implementations.
 * Generic to allow type-safe updates for specific task types.
 */
export function updateTaskState<T extends TaskState>(
  taskId: string,
  setAppState: SetAppState,
  updater: (task: T) => T,
): void {
  setAppState(prev => {
    const task = prev.tasks?.[taskId] as T | undefined
    if (!task) {
      return prev
    }
    const updated = updater(task)
    if (updated === task) {
      // Updater returned the same reference (early-return no-op). Skip the
      // spread so s.tasks subscribers don't re-render on unchanged state.
      return prev
    }
    return {
      ...prev,
      tasks: {
        ...prev.tasks,
        [taskId]: updated,
      },
    }
  })
}

/**
 * Register a new task in AppState.
 */
export function registerTask(task: TaskState, setAppState: SetAppState): void {
  let isReplacement = false
  setAppState(prev => {
    const existing = prev.tasks[task.id]
    isReplacement = existing !== undefined
    // Carry forward UI-held state on re-register (resumeAgentBackground
    // replaces the task; user's retain shouldn't reset). startTime keeps
    // the panel sort stable; messages + diskLoaded preserve the viewed
    // transcript across the replace (the user's just-appended prompt lives
    // in messages and isn't on disk yet).
    const merged =
      existing && 'retain' in existing
        ? {
            ...task,
            retain: existing.retain,
            startTime: existing.startTime,
            messages: existing.messages,
            diskLoaded: existing.diskLoaded,
            pendingMessages: carryPendingMessagesAcrossRun(
              existing.pendingMessages,
            ),
          }
        : task
    return { ...prev, tasks: { ...prev.tasks, [task.id]: merged } }
  })

  // Replacement (resume) — not a new start. Skip to avoid double-emit.
  if (isReplacement) return

  enqueueSdkEvent({
    type: 'system',
    subtype: 'task_started',
    task_id: task.id,
    tool_use_id: task.toolUseId,
    description: task.description,
    task_type: task.type,
    workflow_name:
      'workflowName' in task
        ? (task.workflowName as string | undefined)
        : undefined,
    prompt: 'prompt' in task ? (task.prompt as string) : undefined,
  })
}

function carryPendingMessagesAcrossRun(
  messages: unknown,
): Array<Record<string, unknown>> {
  if (!Array.isArray(messages)) return []
  return messages.flatMap(message => {
    if (typeof message === 'string') {
      return [
        {
          id: randomUUID(),
          message,
          status: 'pending',
          acceptedAt: Date.now(),
        },
      ]
    }
    if (
      typeof message !== 'object' ||
      message === null ||
      typeof (message as { id?: unknown }).id !== 'string' ||
      typeof (message as { message?: unknown }).message !== 'string'
    ) {
      return []
    }
    const record = message as Record<string, unknown>
    if (record.status === 'prepared' || record.status === 'submitted') {
      return [
        {
          ...record,
          status: 'uncertain',
          outcome: 'The previous worker run ended before delivery was confirmed.',
          reported: false,
        },
      ]
    }
    return [record]
  })
}

function hasUnresolvedLocalAgentMessages(task: TaskState): boolean {
  if (task.type !== 'local_agent') return false
  const messages = (task as { pendingMessages?: unknown }).pendingMessages
  if (!Array.isArray(messages)) return false
  return messages.some(message => {
    if (typeof message === 'string') return true
    if (typeof message !== 'object' || message === null) return false
    const status = (message as { status?: unknown }).status
    const reported = (message as { reported?: unknown }).reported
    return (
      status === 'pending' ||
      status === 'prepared' ||
      status === 'submitted' ||
      ((status === 'undelivered' || status === 'uncertain') &&
        reported !== true)
    )
  })
}

/**
 * Eagerly evict a terminal task from AppState.
 * The task must be in a terminal state (completed/failed/killed) with notified=true.
 * Unresolved local-worker delivery records keep it addressable until their
 * terminal report is queued.
 * This allows memory to be freed without waiting for the next query loop iteration.
 * The lazy GC in generateTaskAttachments() remains as a safety net.
 */
export function evictTerminalTask(
  taskId: string,
  setAppState: SetAppState,
): void {
  setAppState(prev => {
    const task = prev.tasks?.[taskId]
    if (!task) return prev
    if (!isTerminalTaskStatus(task.status)) return prev
    if (!task.notified) return prev
    if (hasUnresolvedLocalAgentMessages(task)) return prev
    if (hasPendingTaskNotification(taskId)) return prev
    // Panel grace period — blocks eviction until deadline passes.
    // 'retain' in task narrows to LocalAgentTaskState (the only type with
    // that field); evictAfter is optional so 'evictAfter' in task would
    // miss tasks that haven't had it set yet.
    if ('retain' in task && (task.evictAfter ?? Infinity) > Date.now()) {
      return prev
    }
    const { [taskId]: _, ...remainingTasks } = prev.tasks
    return { ...prev, tasks: remainingTasks }
  })
}

/**
 * Get all running tasks.
 */
export function getRunningTasks(state: AppState): TaskState[] {
  const tasks = state.tasks ?? {}
  return (Object.values(tasks) as TaskState[]).filter(
    task => task.status === 'running',
  )
}

/**
 * Collect terminal tasks that have been consumed and can be GC'd.
 *
 * Deliberately generates no attachments: each task type delivers its own
 * completion notification via enqueuePendingNotification(), so emitting one
 * here would race those per-type callbacks into dual delivery (one inline
 * attachment plus one separate API turn).
 */
export function generateTaskAttachments(state: AppState): {
  evictedTaskIds: string[]
} {
  const evictedTaskIds: string[] = []
  const tasks = state.tasks ?? {}

  for (const taskState of Object.values(tasks) as TaskState[]) {
    // Not yet notified, or still pending/running — the parent still needs it.
    if (!taskState.notified) continue
    if (!isTerminalTaskStatus(taskState.status)) continue
    if (hasUnresolvedLocalAgentMessages(taskState)) continue
    if (!hasPendingTaskNotification(taskState.id)) {
      evictedTaskIds.push(taskState.id)
    }
  }

  return { evictedTaskIds }
}

/**
 * Apply the evictions collected by generateTaskAttachments.
 * Re-checks each id against FRESH prev.tasks rather than the caller's earlier
 * snapshot, so a status transition queued in between isn't clobbered.
 */
export function applyTaskEvictions(
  setAppState: SetAppState,
  evictedTaskIds: string[],
): void {
  if (evictedTaskIds.length === 0) {
    return
  }
  setAppState(prev => {
    let changed = false
    const newTasks = { ...prev.tasks } as Record<string, TaskState>
    for (const id of evictedTaskIds) {
      const fresh = newTasks[id]
      // Re-check terminal+notified on fresh state (TOCTOU: resume may have
      // replaced the task since it was collected)
      if (!fresh || !isTerminalTaskStatus(fresh.status) || !fresh.notified) {
        continue
      }
      if (hasUnresolvedLocalAgentMessages(fresh)) continue
      if (hasPendingTaskNotification(id)) continue
      if ('retain' in fresh && (fresh.evictAfter ?? Infinity) > Date.now()) {
        continue
      }
      delete newTasks[id]
      changed = true
    }
    return changed ? { ...prev, tasks: newTasks } : prev
  })
}
