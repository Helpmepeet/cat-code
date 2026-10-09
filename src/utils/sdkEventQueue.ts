import type { UUID } from 'crypto'
import { randomUUID } from 'crypto'
import { getIsNonInteractiveSession, getSessionId } from '../bootstrap/state.js'
import type { SdkWorkflowProgress } from '../types/tools.js'

type TaskStartedEvent = {
  type: 'system'
  subtype: 'task_started'
  task_id: string
  tool_use_id?: string
  description: string
  task_type?: string
  workflow_name?: string
  prompt?: string
}

type TaskProgressEvent = {
  type: 'system'
  subtype: 'task_progress'
  task_id: string
  tool_use_id?: string
  description: string
  usage: {
    total_tokens: number
    tool_uses: number
    duration_ms: number
  }
  last_tool_name?: string
  summary?: string
  // Delta batch of workflow state changes. Clients upsert by
  // `${type}:${index}` then group by phaseIndex to rebuild the phase tree,
  // same fold as collectFromEvents + groupByPhase in PhaseProgress.tsx.
  workflow_progress?: SdkWorkflowProgress[]
}

// Emitted when a foreground agent completes without being backgrounded.
// Drained by drainSdkEvents() directly into the output stream — does NOT
// go through the print.ts XML task_notification parser and does NOT trigger
// the LLM loop. Consumers (e.g. VS Code session.ts) use this to remove the
// task from the subagent panel.
type TaskNotificationSdkEvent = {
  type: 'system'
  subtype: 'task_notification'
  task_id: string
  tool_use_id?: string
  status: 'completed' | 'failed' | 'stopped'
  output_file: string
  summary: string
  usage?: {
    total_tokens: number
    tool_uses: number
    duration_ms: number
  }
}

// Mirrors notifySessionStateChanged. The CCR bridge already receives this
// via its own listener; SDK consumers (scmuxd, VS Code) need the same signal
// to know when the main turn's generator is idle vs actively producing.
// The 'idle' transition fires AFTER heldBackResult flushes and the bg-agent
// do-while loop exits — so SDK consumers can trust it as the authoritative
// "turn is over" signal even when result was withheld for background agents.
type SessionStateChangedEvent = {
  type: 'system'
  subtype: 'session_state_changed'
  state: 'idle' | 'running' | 'requires_action'
}

export type SdkEvent =
  | TaskStartedEvent
  | TaskProgressEvent
  | TaskNotificationSdkEvent
  | SessionStateChangedEvent

const MAX_QUEUE_SIZE = 1000
const queue: { event: SdkEvent; terminalKey?: string }[] = []
const recentTerminalTaskRuns = new Set<string>()
let capacityError: Error | undefined

export function enqueueSdkEvent(event: SdkEvent, taskRunId?: string): boolean {
  // SDK events are only consumed (drained) in headless/streaming mode.
  // In TUI mode they would accumulate up to the cap and never be read.
  if (!getIsNonInteractiveSession()) {
    return false
  }
  const terminalKey =
    event.subtype === 'task_notification' && event.task_id
      ? `${JSON.stringify(event.task_id)}:${JSON.stringify(taskRunId ?? null)}`
      : undefined
  if (
    terminalKey &&
    (recentTerminalTaskRuns.has(terminalKey) ||
      queue.some(entry => entry.terminalKey === terminalKey))
  ) {
    return false
  }
  if (queue.length >= MAX_QUEUE_SIZE) {
    // Progress is expendable; accepted lifecycle bookends are not. In the
    // lifecycle-only case report backpressure at the consumer boundary, after
    // draining retained rows. Throwing here could interrupt task kill/finally
    // cleanup, and claiming the rejected terminal would prevent its retry.
    const progressIndex = queue.findIndex(
      entry => entry.event.subtype === 'task_progress',
    )
    if (progressIndex >= 0) {
      queue.splice(progressIndex, 1)
    } else if (event.subtype === 'task_progress') {
      return false
    } else {
      capacityError ??= new Error('SDK lifecycle event queue capacity exceeded')
      return false
    }
  }
  if (event.subtype === 'task_started') {
    const taskKeyPrefix = `${JSON.stringify(event.task_id)}:`
    for (const key of recentTerminalTaskRuns) {
      if (key.startsWith(taskKeyPrefix)) recentTerminalTaskRuns.delete(key)
    }
    // Keep the earlier terminal row in order, but do not let its identity
    // suppress the closing bookend of a newly accepted start with the same ID.
    for (const entry of queue) {
      if (entry.terminalKey?.startsWith(taskKeyPrefix)) {
        entry.terminalKey = undefined
      }
    }
  }
  queue.push({ event, terminalKey })
  return true
}

function rememberDeliveredTerminal(key: string): void {
  recentTerminalTaskRuns.add(key)
  if (recentTerminalTaskRuns.size > MAX_QUEUE_SIZE) {
    const oldest = recentTerminalTaskRuns.values().next()
    if (!oldest.done) recentTerminalTaskRuns.delete(oldest.value)
  }
}

export function drainSdkEvents(): Array<
  SdkEvent & { uuid: UUID; session_id: string }
> {
  if (queue.length === 0) {
    return []
  }
  const events = queue.splice(0)
  return events.map(({ event, terminalKey }) => {
    if (terminalKey) rememberDeliveredTerminal(terminalKey)
    return {
      ...event,
      uuid: randomUUID(),
      session_id: getSessionId(),
    }
  })
}

/** Transfer accepted lifecycle rows before reporting rejected SDK output. */
export function flushSdkEvents(output: {
  enqueue(event: SdkEvent & { uuid: UUID; session_id: string }): void
}): void {
  for (const event of drainSdkEvents()) {
    output.enqueue(event)
  }
  const error = capacityError
  capacityError = undefined
  if (error) throw error
}

/**
 * Emit a task_notification SDK event for a task reaching a terminal state.
 *
 * registerTask() always emits task_started; this is the closing bookend.
 * Call this from any exit path that sets a task terminal WITHOUT going
 * through enqueuePendingNotification-with-<task-id> (print.ts parses that
 * XML into the same SDK event, so paths that do both would double-emit).
 * Paths that suppress the XML notification (notified:true pre-set, kill
 * paths, abort branches) must call this directly so SDK consumers
 * (Scuttle's bg-task dot, VS Code subagent panel) see the task close.
 */
export function emitTaskTerminatedSdk(
  taskId: string,
  status: 'completed' | 'failed' | 'stopped',
  opts?: {
    toolUseId?: string
    runId?: string
    summary?: string
    outputFile?: string
    usage?: { total_tokens: number; tool_uses: number; duration_ms: number }
  },
): void {
  enqueueSdkEvent({
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    tool_use_id: opts?.toolUseId,
    status,
    output_file: opts?.outputFile ?? '',
    summary: opts?.summary ?? '',
    usage: opts?.usage,
  }, opts?.runId)
}
