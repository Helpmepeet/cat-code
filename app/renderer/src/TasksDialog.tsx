/**
 * TasksDialog (P4-9 + P4-8b) — the desktop port of `BackgroundTasksDialog`
 * (`src/components/tasks/BackgroundTasksDialog.tsx`, opened by the real `/tasks`
 * command, `src/commands/tasks/tasks.tsx`).
 *
 * P4-8b adds the `K → stop` worker-control action the prototype's BgTasksDialog
 * has (`TasksPage.jsx:109` keyboard `K`/`k` on a non-terminal row; footer hint
 * `:227`) — deferred in P4-9's read-only v1 for lack of an inbound write verb
 * (PARITY-LEDGER §21 rows "Keyboard: K → stop" / footer-hint strip). It rides the
 * new `task.stop` verb (`decisions/AGENT-CHROME.md` §2 WorkerDetail Stop); the
 * renderer only NAMES the target `taskId`, the sidecar re-resolves it against the
 * live store and runs the engine's own `stopTask`. The per-type detail dialogs
 * (`ShellDetailDialog` + 4 siblings) stay deferred — no fake toasts.
 *
 * Visual grammar adapted from `~/catcode_prototype/cat-app/TasksPage.jsx`
 * (`BgTasksDialog`), rebuilt on the P0-2 tokens, zero ported code.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { TaskSnapshotItem, TasksSnapshot } from '../../shared/protocol.js'
import { agentStateMeta } from './agentIdentity.js'
import { useModalFocus } from './overlayFocus.js'
import {
  groupTaskItems,
  isTerminalTaskStatus,
  stoppableTaskIdAt,
  taskColorClass,
  taskDisplayState,
  taskKindMeta,
  tasksDialogKeyAction,
} from './tasksState.js'

export function TasksDialog({
  open,
  onClose,
  snapshot,
  hasActiveSession,
  onStopTask,
}: {
  open: boolean
  onClose: () => void
  /** The active session's task snapshot; null when there is no active session or none has arrived yet. */
  snapshot: TasksSnapshot | null
  /** Whether an active session exists — gates the "This session" scope option. */
  hasActiveSession: boolean
  /**
   * P4-8b — stop/kill the task with this id (the `task.stop` verb). Undefined when
   * there is no active session, in which case the `K → stop` control is inert and
   * its footer hint is hidden (no dead affordance). The prototype's BgTasksDialog
   * gates `K` on a non-terminal row (`TasksPage.jsx:109`); we match that.
   */
  onStopTask?: (taskId: string) => void
}) {
  const [selected, setSelected] = useState(0)
  const dialogRef = useRef<HTMLDivElement>(null)

  const { active, completed } = useMemo(
    () => groupTaskItems(snapshot),
    [snapshot],
  )
  const flat = useMemo(() => [...active, ...completed], [active, completed])

  useEffect(() => {
    if (!open) return
    setSelected(0)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      // A modifier chord belongs to the app, not to this dialog — `tasksDialogKeyAction`
      // owns that bail so ⌘K can reach the command palette without stopping a task.
      const action = tasksDialogKeyAction(event)
      if (action === 'close') {
        event.preventDefault()
        onClose()
        return
      }
      if (action === 'next') {
        event.preventDefault()
        setSelected(index => Math.min(flat.length - 1, index + 1))
        return
      }
      if (action === 'previous') {
        event.preventDefault()
        setSelected(index => Math.max(0, index - 1))
        return
      }
      // P4-8b — `K`/`k` stops the selected task, but ONLY a non-terminal one
      // (`TasksPage.jsx:109` gates on `!isTerminal(t)`); a terminal row / absent
      // handler is a no-op, never a dead action. The gate is the pure
      // `stoppableTaskIdAt` selector (unit-tested — the SSR harness can't press K).
      if (action === 'stop') {
        const targetId = onStopTask ? stoppableTaskIdAt(flat, selected) : null
        if (onStopTask && targetId) {
          event.preventDefault()
          onStopTask(targetId)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, flat, selected, onClose, onStopTask])

  useModalFocus({
    open,
    containerRef: dialogRef,
    onEscape: onClose,
  })

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/55 backdrop-blur-sm"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        className="animate-toast-in flex max-h-[74vh] w-[640px] max-w-[calc(100%-48px)] flex-col overflow-hidden rounded-[14px] border border-shell-seam bg-surface-panel shadow-[0_30px_80px_rgba(0,0,0,0.6)]"
        role="dialog"
        aria-modal="true"
        aria-label="Background tasks"
        tabIndex={-1}
        onMouseDown={event => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-shell-seam px-[18px] py-3.5">
          <div>
            <div className="text-sm font-semibold text-text-primary">Tasks</div>
            <div className="mt-0.5 text-xs text-text-subtle">
              {active.length} active · {completed.length} completed
              {!hasActiveSession ? ' · no active session' : ''}
            </div>
          </div>
          <button
            aria-label="Close (Esc)"
            className="flex h-7 w-7 items-center justify-center rounded-md text-lg text-text-subtle hover:bg-shell-hover hover:text-text-muted"
            onClick={onClose}
            title="Close (Esc)"
            type="button"
          >
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {flat.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <div className="mb-1 text-[13px] font-medium text-text-subtle">
                {hasActiveSession ? 'No tasks in this session' : 'No background tasks'}
              </div>
              <div className="text-[11.5px] text-text-subtle/70">
                Run a background bash, agent, or dream to see it here
              </div>
            </div>
          ) : (
            <>
              <TaskGroup label="Active" items={active} offset={0} selected={selected} />
              <TaskGroup
                label="Completed"
                items={completed}
                offset={active.length}
                selected={selected}
              />
            </>
          )}
        </div>

        <div className="flex gap-3.5 border-t border-shell-seam px-4 py-2 font-mono text-[10.5px] text-text-subtle">
          <span>
            <span className="text-text-muted">↑↓</span> select
          </span>
          {onStopTask ? (
            <span>
              <span className="text-text-muted">K</span> stop
            </span>
          ) : null}
          <span>
            <span className="text-text-muted">esc</span> close
          </span>
        </div>
      </div>
    </div>
  )
}

function TaskGroup({
  label,
  items,
  offset,
  selected,
}: {
  label: string
  items: TaskSnapshotItem[]
  offset: number
  selected: number
}) {
  if (items.length === 0) return null
  return (
    <div className="mb-1.5">
      <div className="flex items-center gap-2 px-2.5 pb-1.5 pt-2.5">
        <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-text-subtle">
          {label}
        </span>
        <div className="h-px flex-1 bg-shell-seam" />
        <span className="text-[10.5px] text-text-subtle/60">{items.length}</span>
      </div>
      {items.map((item, index) => (
        <TaskRow key={item.id} item={item} isSelected={offset + index === selected} />
      ))}
    </div>
  )
}

function TaskRow({ item, isSelected }: { item: TaskSnapshotItem; isSelected: boolean }) {
  const kind = taskKindMeta(item.type)
  const kindColor = taskColorClass(kind.color)
  const state = agentStateMeta(taskDisplayState(item))
  const terminal = isTerminalTaskStatus(item.status)
  const isMonoLabel = item.type === 'local_bash' || item.type === 'local_workflow' || item.type === 'monitor_mcp'
  // Status label color: attention → the state's own tone; a failed terminal
  // task → soft red; otherwise the muted subtle tone. All resolve to STATIC
  // Tailwind classes (never an interpolated arbitrary value).
  const statusTextClass = state.attention
    ? taskColorClass(state.color).text
    : terminal && item.status === 'failed'
      ? 'text-red-300'
      : 'text-text-subtle'

  return (
    <div
      className={
        'flex items-center gap-2.5 rounded-lg px-2.5 py-2 ' +
        (isSelected ? 'bg-shell-active' : '') +
        (terminal ? ' opacity-70' : '')
      }
    >
      <span className="flex w-3.5 shrink-0 justify-center">
        <StatusMarker terminal={terminal} attention={state.attention} color={state.color} />
      </span>
      <span
        className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.04em] ${kindColor.text} ${kindColor.border}`}
      >
        {kind.label}
      </span>
      <span
        className={
          'min-w-0 flex-1 truncate text-[12.5px] text-text-primary ' +
          (isMonoLabel ? 'font-mono text-[#c4c4c8]' : '')
        }
      >
        {item.label}
      </span>
      <span
        className={`shrink-0 max-w-[220px] truncate font-mono text-[11px] ${statusTextClass}`}
      >
        {state.label}
      </span>
    </div>
  )
}

function StatusMarker({
  terminal,
  attention,
  color,
}: {
  terminal: boolean
  attention: boolean
  color: string
}) {
  if (terminal || attention) {
    return (
      <span
        className={`inline-block h-2 w-2 shrink-0 rounded-full ${taskColorClass(color).dot}`}
        aria-hidden="true"
      />
    )
  }
  return (
    <span
      className="inline-block h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-shell-seam border-t-text-muted"
      aria-hidden="true"
    />
  )
}
