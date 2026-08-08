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
 *
 * P4-32b adds the prototype's `TasksPanel` tab structure
 * (`OrchestratorMode.jsx:713`) as ruled on 2026-07-30
 * (`decisions/ORCHESTRATOR-IN-SESSION.md` §10): inspection **D1** puts a READ-ONLY
 * worker drilldown here and nowhere else, and lease option **L1** adds the
 * session-scoped Codex lease roster. Consequences that shape this file:
 *
 *  - **D1 waives `WorkerFocusView` entirely.** There is no main-column focus swap,
 *    no "Open thread" control and no worker composer: the user talks only to the
 *    orchestrator (`OrchestratorMode.jsx:1-15`). The waiver is recorded in
 *    `PARITY-LEDGER.md` §20 rather than left as a silent omission.
 *  - **Result policy Q2** puts a worker's real conclusion HERE and never in the
 *    transcript or a focus column (`selectWorkerResult`, `workerInspection.ts`).
 *  - The tab row is three items, not the prototype's two (🔁 adapted): this dialog
 *    is the real `/tasks` manager, whose list is a SUPERSET of orchestrator workers
 *    (background bash, dreams, monitors, remote agents). Folding workers into that
 *    list would either hide those tasks or drop the prototype's role grouping, so
 *    Tasks keeps the built list and Workers is the role-grouped worker view.
 *
 * The three panel components are exported because this package's renderer suite is
 * SSR-only (no DOM harness — see `AccountsPage.test.tsx`'s header), so a tab click
 * cannot be simulated; rendering a panel directly is how its real fields are
 * asserted. They are React components, so the Fast Refresh boundary still holds.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentModeSnapshot,
  AgentModeWorkerItem,
  LeaseOwnerRow,
  LeaseSnapshot,
  TaskSnapshotItem,
  TasksSnapshot,
} from '../../shared/protocol.js'
import { agentStateMeta } from './agentIdentity.js'
import { useModalFocus } from './overlayFocus.js'
import {
  AgentActionButton,
  AgentHandle,
  AgentPip,
  AgentSectionLabel,
  AgentStateLabel,
  AgentTypeLabel,
  Baton,
} from './AgentChrome.js'
import {
  deriveWorkerOwner,
  orchestratorWorkerState,
  selectWorkerById,
  selectWorkerDisplayName,
  summarizeOrchestratorWorkers,
  workerAccessibleLabel,
} from './orchestratorState.js'
import type { LeaseAccountGroup, LeaseAgentRow } from './leaseState.js'
import {
  leaseAccountLabel,
  leaseHeldLabel,
  selectLeaseAgentCount,
  selectLeaseConcentrationNote,
  selectLeaseForOwner,
  selectLeaseGroups,
} from './leaseState.js'
import {
  groupWorkersByRole,
  selectWorkerResult,
  selectWorkerStopTargetId,
} from './workerInspection.js'
import {
  groupTaskItems,
  isTerminalTaskStatus,
  stoppableTaskIdAt,
  taskColorClass,
  taskDisplayState,
  taskKindMeta,
  tasksDialogKeyAction,
} from './tasksState.js'

type DialogTab = 'tasks' | 'workers' | 'leases'

export function TasksDialog({
  open,
  onClose,
  snapshot,
  hasActiveSession,
  onStopTask,
  agentMode = null,
  leases = null,
  now,
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
  /** P4-32b — the active session's orchestrator roster, source of the Workers tab. */
  agentMode?: AgentModeSnapshot | null
  /** P4-32b — the active session's Codex lease snapshot, source of the Leases tab. */
  leases?: LeaseSnapshot | null
  /** Injected clock for held-duration display; defaults to now at render time. */
  now?: number
}) {
  const [selected, setSelected] = useState(0)
  const dialogRef = useRef<HTMLDivElement>(null)
  const [tab, setTab] = useState<DialogTab>('tasks')
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null)

  const { active, completed } = useMemo(
    () => groupTaskItems(snapshot),
    [snapshot],
  )
  const flat = useMemo(() => [...active, ...completed], [active, completed])
  const workers = agentMode?.workers ?? []
  // A focused worker that vanished from the snapshot degrades back to the list
  // rather than rendering a stale row (`selectWorkerById`'s contract).
  const selectedWorker = selectWorkerById(agentMode, selectedWorkerId)

  useEffect(() => {
    if (!open) return
    setSelected(0)
    setTab('tasks')
    setSelectedWorkerId(null)
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
      // Selection and stop address the TASK list, so they are inert on the
      // Workers/Leases tabs: there is no selected task to move or kill there, and
      // a worker is stopped from its own detail button (P4-32b).
      if (tab !== 'tasks') return
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
  }, [open, tab, flat, selected, onClose, onStopTask])

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

        {/* Workers | Leases tabs (prototype `TasksPanel`, `OrchestratorMode.jsx:744`).
            Hidden inside the worker drilldown, as the prototype hides them there. */}
        {selectedWorker ? null : (
          <div className="flex shrink-0 gap-1 border-b border-shell-seam px-3.5 pt-2">
            <DialogTabButton
              active={tab === 'tasks'}
              count={flat.length}
              label="Tasks"
              onSelect={() => setTab('tasks')}
              tone="neutral"
            />
            <DialogTabButton
              active={tab === 'workers'}
              count={workers.length}
              label="Workers"
              onSelect={() => setTab('workers')}
              tone="worker"
            />
            <DialogTabButton
              active={tab === 'leases'}
              count={selectLeaseAgentCount(leases)}
              label="Accounts"
              onSelect={() => setTab('leases')}
              tone="lease"
            />
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {selectedWorker ? (
            <WorkerDetailPanel
              lease={selectLeaseForOwner(leases, selectedWorker.agentId)}
              nowMs={now}
              onBack={() => setSelectedWorkerId(null)}
              orchestratorActive={agentMode?.active ?? false}
              {...(onStopTask ? { onStopTask } : {})}
              worker={selectedWorker}
            />
          ) : tab === 'leases' ? (
            <LeaseRosterPanel nowMs={now} snapshot={leases} workers={workers} />
          ) : tab === 'workers' ? (
            <WorkerRosterPanel
              onSelect={setSelectedWorkerId}
              orchestratorActive={agentMode?.active ?? false}
              workers={workers}
            />
          ) : flat.length === 0 ? (
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

        {/* Footer hint, contextual per panel (prototype `OrchestratorMode.jsx:810`).
            The task-list chords are only advertised where they do something. */}
        <div className="flex gap-3.5 border-t border-shell-seam px-4 py-2 font-mono text-[10.5px] text-text-subtle">
          {selectedWorker ? (
            <span>read only, the orchestrator relays this worker&apos;s outcome</span>
          ) : tab === 'leases' ? null : tab === 'workers' ? (
            <span>click a worker to inspect it</span>
          ) : (
            <>
              <span>
                <span className="text-text-muted">↑↓</span> select
              </span>
              {onStopTask ? (
                <span>
                  <span className="text-text-muted">K</span> stop
                </span>
              ) : null}
            </>
          )}
          <span className="ml-auto">
            <span className="text-text-muted">esc</span> close
          </span>
        </div>
      </div>
    </div>
  )
}

const TAB_TONE_CLASS: Record<
  'neutral' | 'worker' | 'lease',
  { border: string; count: string }
> = {
  neutral: { border: 'border-text-muted', count: 'text-text-muted' },
  worker: { border: 'border-purple-400', count: 'text-purple-400' },
  lease: { border: 'border-teal-300', count: 'text-teal-300' },
}

function DialogTabButton({
  label,
  count,
  active,
  tone,
  onSelect,
}: {
  label: string
  count: number
  active: boolean
  tone: 'neutral' | 'worker' | 'lease'
  onSelect: () => void
}) {
  const toneClass = TAB_TONE_CLASS[tone]
  return (
    <button
      aria-pressed={active}
      className={
        'inline-flex items-center gap-1.5 border-b-[1.5px] px-2.5 py-1.5 text-xs ' +
        (active
          ? `${toneClass.border} font-semibold text-text-primary`
          : 'border-transparent font-medium text-text-subtle hover:text-text-muted')
      }
      onClick={onSelect}
      type="button"
    >
      {label}
      {count > 0 ? (
        <span
          className={`font-mono text-[10px] ${active ? toneClass.count : 'text-text-subtle/70'}`}
        >
          {count}
        </span>
      ) : null}
    </button>
  )
}

/**
 * Workers tab — the role-grouped roster (prototype `OrchestratorMode.jsx:786-800`)
 * over the REAL `agent-mode.snapshot` workers. The counts strip above it uses the
 * two-axis summary (`summarizeOrchestratorWorkers`), so a worker blocked under an
 * active orchestrator counts as orchestrator-owned and never alarms the user.
 */
export function WorkerRosterPanel({
  workers,
  orchestratorActive,
  onSelect,
}: {
  workers: readonly AgentModeWorkerItem[]
  orchestratorActive: boolean
  onSelect: (agentId: string) => void
}) {
  const summary = summarizeOrchestratorWorkers(workers, orchestratorActive)
  const groups = groupWorkersByRole(workers)

  if (workers.length === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <div className="mb-1 text-[13px] font-medium text-text-subtle">
          No workers yet
        </div>
        <div className="text-[11.5px] text-text-subtle/70">
          They appear as the assistant delegates
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="flex flex-wrap gap-3 px-2.5 pb-2 pt-2.5 text-[11px] text-text-muted">
        {summary.working > 0 ? (
          <span className="inline-flex items-center gap-1.5">
            <AgentPip size="xs" state="running" />
            {summary.working} working
          </span>
        ) : null}
        {summary.background > 0 ? (
          <span className="inline-flex items-center gap-1.5">
            <AgentPip size="xs" state="background" />
            {summary.background} in background
          </span>
        ) : null}
        {summary.orchestrator > 0 ? (
          <span className="inline-flex items-center gap-1.5 text-purple-400">
            <AgentPip size="xs" state="waiting" />
            {summary.orchestrator} on the assistant
          </span>
        ) : null}
        {summary.user > 0 ? (
          <span className="inline-flex items-center gap-1.5 text-tone-warn">
            <AgentPip size="xs" state="needs-you" />
            {summary.user} needs you
          </span>
        ) : null}
        {summary.done > 0 ? (
          <span className="inline-flex items-center gap-1.5">
            <AgentPip size="xs" state="completed" />
            {summary.done} done
          </span>
        ) : null}
      </div>
      {groups.map(group => (
        <div className="mb-1.5" key={group.role}>
          <div className="px-2.5 pb-1 pt-2">
            <AgentSectionLabel>
              {group.label} · {group.workers.length}
            </AgentSectionLabel>
          </div>
          {group.workers.map(worker => (
            <WorkerRow
              key={worker.agentId}
              onSelect={() => onSelect(worker.agentId)}
              orchestratorActive={orchestratorActive}
              worker={worker}
            />
          ))}
        </div>
      ))}
    </>
  )
}

/** One worker row: lifecycle pip, genuine name when available, task text, type. */
function WorkerRow({
  worker,
  orchestratorActive,
  onSelect,
}: {
  worker: AgentModeWorkerItem
  orchestratorActive: boolean
  onSelect: () => void
}) {
  const state = orchestratorWorkerState(worker, orchestratorActive)
  const name = selectWorkerDisplayName(worker)
  return (
    <button
      aria-label={workerAccessibleLabel(worker, orchestratorActive)}
      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-shell-hover"
      onClick={onSelect}
      type="button"
    >
      <AgentPip size="sm" state={state} />
      {name ? <AgentHandle name={name} /> : null}
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-text-subtle">
        {worker.description ?? ''}
      </span>
      <AgentTypeLabel role={worker.role} />
    </button>
  )
}

/**
 * Read-only worker detail (inspection ruling **D1**). Every field traces to a real
 * engine seam; the fields the prototype's `WMeta` fabricated (model, elapsed, tool
 * count, traffic, cost) are WAIVED rather than mocked (§9 waiver 7, approved), and
 * the account/failover half of that line renders here from the real lease.
 *
 * The only control is Stop, which rides the existing `task.stop` verb.
 */
export function WorkerDetailPanel({
  worker,
  orchestratorActive,
  lease,
  onBack,
  onStopTask,
  nowMs,
}: {
  worker: AgentModeWorkerItem
  orchestratorActive: boolean
  lease: LeaseOwnerRow | null
  onBack: () => void
  onStopTask?: (taskId: string) => void
  nowMs?: number
}) {
  const state = orchestratorWorkerState(worker, orchestratorActive)
  const name = selectWorkerDisplayName(worker)
  const result = selectWorkerResult(worker)
  const stopTargetId = selectWorkerStopTargetId(worker)

  return (
    <div className="px-2 pb-3 pt-1">
      <button
        className="mb-2.5 inline-flex items-center gap-1.5 px-0.5 text-[11.5px] text-text-muted hover:text-text-primary"
        onClick={onBack}
        type="button"
      >
        <span aria-hidden="true">‹</span>All workers
      </button>
      <div className="flex flex-wrap items-center gap-2 border-b border-shell-seam pb-3">
        {name ? <AgentHandle name={name} /> : null}
        <AgentTypeLabel role={worker.role} />
        <AgentStateLabel state={state} />
        <Baton owner={deriveWorkerOwner(worker, orchestratorActive)} />
      </div>

      <div className="flex flex-col gap-3.5 px-0.5 pt-3.5">
        <WorkerMetaLine lease={lease} nowMs={nowMs} worker={worker} />

        {worker.description ? (
          <div>
            <AgentSectionLabel>Prompt</AgentSectionLabel>
            <div className="mt-1 text-[12.5px] leading-relaxed text-text-muted">
              {worker.description}
            </div>
          </div>
        ) : null}

        {/* The real handoff gate: `handoffStatus: 'blocked'` + its `blockReason`
            (`LocalAgentTask.tsx:184`). Neutral-purple, because an active
            orchestrator owns this handoff and the user has nothing to do (D2 C2). */}
        {worker.handoffStatus === 'blocked' && worker.blockReason ? (
          <div className="rounded-lg border border-purple-400/30 bg-purple-400/[0.08] px-3 py-2.5">
            <AgentSectionLabel tone="accent">
              {orchestratorActive ? 'Waiting on the assistant' : 'Waiting on you'}
            </AgentSectionLabel>
            <div className="mt-1.5 text-[12.5px] leading-relaxed text-purple-200">
              {worker.blockReason}
            </div>
            {orchestratorActive ? (
              <div className="mt-1.5 text-[10.5px] text-text-subtle">
                The assistant resolves this or relays it to you in its own turn.
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Result policy Q2: a worker's own conclusion appears HERE only. */}
        {result ? (
          <div>
            <AgentSectionLabel>{result.label}</AgentSectionLabel>
            <div className="mt-1 rounded-md border border-shell-seam bg-white/[0.02] px-3 py-2.5 text-[12.5px] leading-relaxed text-text-muted">
              {result.text}
            </div>
          </div>
        ) : null}

        {onStopTask && stopTargetId ? (
          <div className="flex flex-wrap items-center gap-2.5 pt-0.5">
            <AgentActionButton
              label="Stop"
              onClick={() => onStopTask(stopTargetId)}
              tone="danger"
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}

/**
 * The surviving half of the prototype's `WMeta` line (`OrchestratorMode.jsx:53`).
 * WAIVED, not mocked: model, elapsed, tool count, token traffic and cost have no
 * field on `AgentModeWorkerItem` and no engine seam behind them. What renders is
 * real: the lease's account, its failover count, and the worker's own origin /
 * background flags.
 */
function WorkerMetaLine({
  worker,
  lease,
  nowMs,
}: {
  worker: AgentModeWorkerItem
  lease: LeaseOwnerRow | null
  nowMs?: number
}) {
  const bits: string[] = []
  if (lease) bits.push(`acct ${leaseAccountLabel(lease)}`)
  if (lease && lease.state === 'active') {
    bits.push(`held ${leaseHeldLabel(lease.createdAt, nowMs ?? Date.now())}`)
  }
  if (worker.isBackgrounded) bits.push('backgrounded')
  if (worker.origin === 'prior') {
    bits.push(worker.resumable ? 'resumable' : 'from an earlier session')
  }
  const failover = lease && lease.failoverCount > 0 ? lease : null
  if (bits.length === 0 && !failover) return null

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10.5px] text-text-subtle">
      {bits.map((bit, index) => (
        <span className="whitespace-nowrap" key={bit}>
          {index > 0 ? <span className="pr-2 text-zinc-700">·</span> : null}
          {bit}
        </span>
      ))}
      {failover ? (
        <span
          className="whitespace-nowrap text-tone-warn"
          {...(failover.lastFailureReason ? { title: failover.lastFailureReason } : {})}
        >
          {bits.length > 0 ? <span className="pr-2 text-zinc-700">·</span> : null}
          failed over ×{failover.failoverCount}
        </span>
      ) : null}
    </div>
  )
}

/**
 * Accounts tab (lease option **L1**) — this session's Codex agents, grouped by the
 * account each one holds (prototype `LeaseRoster`, `OrchestratorMode.jsx:643`, over
 * the real `lease.snapshot`). The prototype's failover/rotation EVENT strip is CUT:
 * the engine exposes current lease state, not an event history (§10).
 *
 * Grouped by account rather than listed flat because the question the panel answers
 * is whether a `spread` session actually spread; the engine's own per-account
 * rollup is deliberately not the source (`selectLeaseGroups`). The word "lease" is
 * engine vocabulary and appears nowhere the user can read it.
 */
export function LeaseRosterPanel({
  snapshot,
  workers = [],
  nowMs,
}: {
  snapshot: LeaseSnapshot | null
  /** The orchestrator roster, joined on `ownerId === agentId` for real worker names. */
  workers?: readonly AgentModeWorkerItem[]
  nowMs?: number
}) {
  const groups = selectLeaseGroups(snapshot, workers, nowMs ?? Date.now())
  const note = selectLeaseConcentrationNote(snapshot?.strategy ?? null, groups)

  return (
    <div className="pb-2">
      <div className="flex items-baseline gap-2 border-b border-shell-seam px-3.5 py-2.5">
        <span className="text-[11.5px] text-text-subtle">Strategy</span>
        <span className="font-mono text-[11.5px] font-medium text-text-primary">
          {snapshot?.strategy ?? 'spread'}
        </span>
        {note ? <span className="ml-auto text-[11.5px] text-text-muted">{note}</span> : null}
      </div>

      {groups.length === 0 ? (
        <div className="px-3.5 py-3 text-[11.5px] italic text-text-subtle/70">
          No accounts in use. Agents take one when they run.
        </div>
      ) : (
        groups.map(group => <LeaseAccountBlock group={group} key={group.key} />)
      )}
    </div>
  )
}

/**
 * One account and its agents. The rail brackets the heading AND the rows so a lone
 * group still reads as a group: with the rail starting below the heading, a
 * single-account session (the common case) looked like a plain list under a section
 * label, and the panel's whole organising idea disappeared in exactly that state.
 */
function LeaseAccountBlock({ group }: { group: LeaseAccountGroup }) {
  return (
    <div className="px-3.5 pb-0.5 pt-3">
      <div className="border-l border-shell-seam pl-3">
        <div className="flex items-baseline gap-2 pb-1">
          {group.isStranded ? (
            <span
              aria-hidden="true"
              className="inline-block h-1.5 w-1.5 self-center shrink-0 rounded-full bg-tone-danger"
            />
          ) : null}
          <span
            className={
              'min-w-0 truncate font-mono text-[12.5px] ' +
              (group.isStranded
                ? 'text-text-muted'
                : 'font-semibold text-text-primary')
            }
          >
            {group.label}
          </span>
          <span className="shrink-0 text-[11px] text-text-subtle">
            {group.agents.length} {group.agents.length === 1 ? 'agent' : 'agents'}
          </span>
        </div>
        {group.agents.map(agent => (
          <LeaseAgentRowView agent={agent} key={agent.ownerId} />
        ))}
      </div>
    </div>
  )
}

/** One agent under its account. The note is INSIDE the row, not a sibling of it. */
function LeaseAgentRowView({ agent }: { agent: LeaseAgentRow }) {
  return (
    <div className="flex items-baseline gap-2.5 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          {agent.name ? (
            <span className="shrink-0 text-[12.5px] font-medium text-text-primary">
              {agent.name}
            </span>
          ) : null}
          {agent.task ? (
            <span className="min-w-0 truncate text-[11.5px] text-text-subtle">
              {agent.task}
            </span>
          ) : null}
        </div>
        {agent.note ? (
          <div
            className={
              'mt-0.5 flex items-center gap-1.5 text-[11px] ' +
              (agent.note.tone === 'stranded' ? 'text-tone-danger' : 'text-text-subtle')
            }
            title={agent.note.detail}
          >
            {agent.note.tone === 'moved' ? (
              <span
                aria-hidden="true"
                className="inline-block h-1 w-1 shrink-0 rounded-full bg-zinc-500"
              />
            ) : null}
            {agent.note.text}
          </div>
        ) : null}
      </div>
      {agent.held ? (
        <span className="shrink-0 font-mono text-[11px] text-text-subtle">
          {agent.held}
        </span>
      ) : null}
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
