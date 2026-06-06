import type { AppStateStore } from '../state/AppStateStore.js'
import { getCwd } from '../utils/cwd.js'
import { getCommandQueueLength } from '../utils/messageQueueManager.js'
import {
  truncateBridgeText,
  type PtcloveOutbound,
  type PtcloveStatus,
} from './ptcloveBridgeProtocol.js'

type Send = (payload: PtcloveOutbound) => void

type Options = {
  sessionId: string
  store: AppStateStore
  send: Send
  getIsLoading: () => boolean
  getTurnStartedAt: () => number | null
}

export type PtcloveBridgeBroadcasterHandle = {
  schedule: () => void
  resync: () => void
  markAbortRequested: () => void
  dispose: () => void
}

export function createPtcloveBridgeBroadcaster(
  options: Options,
): PtcloveBridgeBroadcasterHandle {
  let lastSentAt = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastActivitySummary: string | null = null
  let wasLoading = options.getIsLoading()
  let turnStartMs: number | null = wasLoading
    ? options.getTurnStartedAt() ?? Date.now()
    : null
  let busySince: string | undefined = turnStartMs
    ? new Date(turnStartMs).toISOString()
    : undefined
  let abortRequested = false
  let filesTouched = new Set<string>()
  let lastTodosJson = ''
  let lastGoal: string | null | undefined = undefined

  function sendSnapshot(force = false): void {
    timer = null
    lastSentAt = Date.now()
    const state = options.store.getState()
    const isLoading = options.getIsLoading()
    const previousLoading = wasLoading
    if (isLoading && !wasLoading) {
      turnStartMs = options.getTurnStartedAt() ?? Date.now()
      busySince = new Date(turnStartMs).toISOString()
      abortRequested = false
      filesTouched = new Set()
    } else if (!isLoading) {
      busySince = undefined
    }

    const status: PtcloveStatus = isLoading ? 'running' : 'idle'
    const activeTool = isLoading ? state.ptcloveCurrentTool : null
    const summary = truncateBridgeText(
      activeTool?.summary ??
        state.statusLineText ??
        state.spinnerTip ??
        (isLoading ? 'Working' : 'Idle'),
    )
    options.send({
      type: 'session_state',
      session_id: options.sessionId,
      status,
      status_text: summary,
      busy_since: busySince,
      cwd: getCwd(),
      current_tool: isLoading
        ? activeTool
          ? {
              name: truncateBridgeText(activeTool.name, 36),
              summary,
              target_path: activeTool.targetPath,
            }
          : {
              name: conciseToolName(summary),
              summary,
            }
        : null,
      spinner_tip: state.spinnerTip
        ? truncateBridgeText(state.spinnerTip)
        : undefined,
      model: state.mainLoopModelForSession ?? state.mainLoopModel,
      queue_depth: getCommandQueueLength(),
    })

    if (isLoading && summary && summary !== lastActivitySummary) {
      lastActivitySummary = summary
      const targetPath = targetPathFromSummary(summary)
      if (targetPath) filesTouched.add(targetPath)
      options.send({
        type: 'session_activity',
        session_id: options.sessionId,
        kind: targetPath ? 'file_edit' : 'status',
        summary,
        target_path: targetPath,
        at: new Date().toISOString(),
      })
    }

    if (!isLoading && previousLoading && turnStartMs !== null) {
      const durationMs = Date.now() - turnStartMs
      if (durationMs > 20_000 || abortRequested) {
        const resultSummary = truncateBridgeText(
          state.statusLineText ?? lastActivitySummary ?? 'Turn finished',
        )
        options.send({
          type: 'session_result',
          session_id: options.sessionId,
          kind: abortRequested
            ? 'cancelled'
            : /fail|failed|error/i.test(resultSummary)
              ? 'failed'
              : 'completed',
          summary: resultSummary,
          duration_ms: durationMs,
          files_touched: Array.from(filesTouched),
        })
      }
      turnStartMs = null
      abortRequested = false
    }
    wasLoading = isLoading

    const todos = Object.entries(state.todos).flatMap(([agentId, list]) =>
      list.map((todo, index) => ({
        id: `${agentId}:${index}`,
        text: truncateBridgeText(todo.content),
        status: todo.status,
      })),
    )
    const todosJson = JSON.stringify(todos)
    if (force || todosJson !== lastTodosJson) {
      lastTodosJson = todosJson
      options.send({
        type: 'session_todos',
        session_id: options.sessionId,
        todos,
      })
    }

    const goal = state.threadGoal?.objective ?? null
    if (force || goal !== lastGoal) {
      lastGoal = goal
      options.send({
        type: 'session_thread_goal',
        session_id: options.sessionId,
        goal: goal ? truncateBridgeText(goal) : null,
      })
    }
  }

  function schedule(): void {
    const elapsed = Date.now() - lastSentAt
    if (elapsed >= 333) {
      sendSnapshot()
      return
    }
    if (timer) return
    timer = setTimeout(sendSnapshot, 333 - elapsed)
  }

  const unsubscribe = options.store.subscribe(schedule)
  sendSnapshot()

  return {
    schedule,
    resync: () => sendSnapshot(true),
    markAbortRequested: () => {
      abortRequested = true
    },
    dispose: () => {
      unsubscribe()
      if (timer) clearTimeout(timer)
    },
  }
}

function targetPathFromSummary(summary: string): string | undefined {
  const match = summary.match(/(?:Editing|Writing|Updated)\s+([^\s]+)\b/)
  return match?.[1]
}

function conciseToolName(summary: string): string {
  return truncateBridgeText(summary.replace(/\s+[+-]\d+.*$/, ''), 36)
}
