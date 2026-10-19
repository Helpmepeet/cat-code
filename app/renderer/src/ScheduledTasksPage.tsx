import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { type ScheduledRun, type ScheduledTask, type ScheduledTaskCommand, type ScheduledTaskOptions, type ScheduledTasksSnapshot } from '../../shared/scheduledTasks.js'
import { getBridge } from './bridge.js'
import { ComposerPopoverPanel } from './ComposerPopoverPanel.js'
import { usePopover } from './composerPopover.js'
import { handleMenuRovingKeyDown, usePopoverFocus } from './overlayFocus.js'
import { basename } from './pathUtils.js'
import { ProviderLogo } from './ProviderLogo.js'
import { SAButton, SAModal } from './SAModal.js'
import {
  EFFORT_LABELS,
  MAX_PROMPT_BYTES,
  WEEKDAY_NAMES,
  activeRunFor,
  availableTimeZones,
  displayPath,
  effortChoicesFor,
  createResponseOrder,
  draftAfterRefusedSave,
  draftProblems,
  draftToInput,
  editTaskDraft,
  formatDuration,
  formatRunTime,
  isWorkspaceMapTask,
  localTimeZone,
  newTaskDraft,
  nextRunText,
  orderTasks,
  partitionRuns,
  previewNextRun,
  promptBytes,
  providerLabel,
  readStoredScheduledSelection,
  readStoredScheduledTaskDraft,
  runStatusPresentation,
  scheduleLabel,
  storeScheduledSelection,
  storeScheduledTaskDraft,
  type ProjectChoice,
  type ScheduledEffort,
  type ScheduledModelOption,
  type ScheduledSelection,
  type ScheduledTaskDraft,
} from './scheduledTasksModel.js'

const POLL_MS = 5_000
const RUN_PAGE = 20

const FOCUS = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
const BTN = `inline-flex h-[30px] shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-shell-seam px-3 text-[12.5px] font-medium text-text-primary transition-colors hover:bg-shell-hover disabled:cursor-default disabled:text-text-ghost disabled:hover:bg-transparent ${FOCUS}`
const GHOST = `inline-flex h-[30px] shrink-0 items-center rounded-lg px-2.5 text-[12.5px] font-medium text-text-muted transition-colors hover:bg-shell-hover hover:text-text-primary disabled:cursor-default disabled:opacity-45 ${FOCUS}`
const TINTED = `inline-flex h-[30px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-accent/30 bg-accent/[0.08] px-3.5 text-[13px] font-medium text-accent transition-colors hover:bg-accent/15 disabled:cursor-default disabled:opacity-45 ${FOCUS}`
const FIELD = 'h-[33px] w-full min-w-0 rounded-[5px] border bg-surface-raised px-2.5 text-[12.5px] text-text-primary outline-none transition-colors focus:border-accent/50 disabled:opacity-50'
const LABEL = 'mb-[5px] block text-[12px] font-medium text-text-muted'
const H3 = 'mb-1.5 text-[13px] font-semibold text-text-primary'

const DOT = {
  neutral: 'shadow-[inset_0_0_0_1.5px_var(--color-text-faint)]',
  info: 'bg-tone-info',
  warn: 'bg-tone-warn',
  good: 'bg-tone-good',
  danger: 'bg-tone-danger',
  accent: 'bg-accent',
  default: 'bg-text-faint',
} as const
const STATUS_TEXT = {
  neutral: 'text-text-subtle',
  info: 'text-tone-info',
  warn: 'text-tone-warn',
  good: 'text-tone-good',
  danger: 'text-tone-danger',
  accent: 'text-accent',
  default: 'text-text-subtle',
} as const

type Confirm = { kind: 'delete' | 'resume-preset'; task: ScheduledTask }

/** Scopes for pending state and refusals: a task id, or one of these. */
const EDITOR = 'editor'
const PRESET = 'preset'

export function ScheduledTasksPage({
  onOpenChat,
}: {
  onOpenChat: (appSessionId: string) => void
}) {
  const [snapshot, setSnapshot] = useState<ScheduledTasksSnapshot | null>(null)
  const [options, setOptions] = useState<ScheduledTaskOptions | null>(null)
  const [optionsError, setOptionsError] = useState(false)
  const [optionsRefreshing, setOptionsRefreshing] = useState(false)
  const [readError, setReadError] = useState<string | null>(null)
  const [draft, setDraftState] = useState<ScheduledTaskDraft | null>(readStoredScheduledTaskDraft)
  const [selection, setSelectionState] = useState<ScheduledSelection>(readStoredScheduledSelection)
  const [editing, setEditing] = useState(() => readStoredScheduledTaskDraft() !== null)
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [announcement, setAnnouncement] = useState('')
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const order = useRef(createResponseOrder())
  const optionsInFlight = useRef(false)

  const setDraft = useCallback((next: ScheduledTaskDraft | null) => {
    storeScheduledTaskDraft(next)
    setDraftState(next)
  }, [])
  const select = useCallback((next: ScheduledSelection) => {
    storeScheduledSelection(next)
    setSelectionState(next)
    setEditing(false)
  }, [])
  const clearError = (scope: string) => setErrors(current => { const { [scope]: _, ...rest } = current; return rest })

  const refresh = useCallback(async () => {
    const id = order.current.issue()
    try {
      const next = await getBridge().readScheduledTasks()
      if (order.current.accept(id)) { setSnapshot(next); setReadError(null) }
    } catch {
      if (order.current.accept(id)) setReadError('Scheduled tasks could not be loaded. Cat Code will keep trying.')
    } finally {
      setNow(Date.now())
    }
  }, [])

  const refreshOptions = useCallback(async (force = false) => {
    if (optionsInFlight.current) return
    optionsInFlight.current = true
    setOptionsRefreshing(true)
    try {
      const next = await getBridge().readScheduledTaskOptions(force ? { refresh: true } : undefined)
      if (!next.error || next.updatedAt !== undefined) setOptions(next)
      setOptionsError(!!next.error)
    } catch {
      setOptionsError(true)
    } finally {
      optionsInFlight.current = false
      setOptionsRefreshing(false)
    }
  }, [])

  // A pull API: poll while visible and re-read when the window returns.
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { if (!document.hidden) void refresh() }, POLL_MS)
    const onVisible = () => { if (!document.hidden) void refresh() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [refresh])

  const choicesVisible = (editing && draft !== null) || selection?.kind === 'preset'
  useEffect(() => {
    if (!choicesVisible) return
    void refreshOptions()
    const onVisible = () => { if (!document.hidden) void refreshOptions() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [choicesVisible, refreshOptions])

  const command = useCallback(async (scope: string, value: ScheduledTaskCommand, success: string): Promise<ScheduledTasksSnapshot | null> => {
    setPending(current => ({ ...current, [scope]: true }))
    clearError(scope)
    const id = order.current.issue()
    try {
      const result = await getBridge().scheduledTask(value)
      if (!result.ok) {
        setErrors(current => ({ ...current, [scope]: result.error }))
        return null
      }
      if (order.current.accept(id)) setSnapshot(result.snapshot)
      setAnnouncement(success)
      return result.snapshot
    } catch {
      setErrors(current => ({ ...current, [scope]: 'Cat Code could not reach scheduled tasks. Try again.' }))
      return null
    } finally {
      setPending(current => { const { [scope]: _, ...rest } = current; return rest })
      setNow(Date.now())
    }
  }, [])

  const tasks = useMemo(() => orderTasks(snapshot?.tasks ?? []), [snapshot])
  const runs = snapshot?.runs ?? []
  const taskById = useMemo(() => new Map((snapshot?.tasks ?? []).map(task => [task.id, task])), [snapshot])
  const projects = options?.projects ?? []
  const modelOptions = options?.models ?? []
  const unavailable = snapshot?.error ?? null
  const loaded = snapshot !== null
  const editingTask = draft?.taskId ? taskById.get(draft.taskId) ?? null : null
  const hasPreset = tasks.some(isWorkspaceMapTask)
  const selectedTask = selection?.kind === 'task' ? taskById.get(selection.id) ?? null : null

  // One draft at a time: New task and Edit return to an open draft rather than replacing it.
  const openEditor = (next: () => ScheduledTaskDraft) => {
    if (!draft) setDraft(next())
    clearError(EDITOR)
    setEditing(true)
  }
  const closeEditor = (after: ScheduledSelection) => {
    setDraft(null)
    clearError(EDITOR)
    select(after)
  }
  const save = async () => {
    if (!draft) return
    const input = draftToInput(draft, editingTask)
    const saved = await command(EDITOR, { type: 'save', task: input }, draft.taskId ? 'Task saved' : 'Task created')
    if (saved) {
      const id = draft.taskId ?? saved.tasks.find(task => !taskById.has(task.id))?.id
      closeEditor(id ? { kind: 'task', id } : null)
    } else {
      const latest = readStoredScheduledTaskDraft()
      if (latest) setDraft(draftAfterRefusedSave(latest, input.cwdToken))
    }
  }
  const pickFolder = async () => {
    try {
      const token = await getBridge().pickScheduledTaskDirectory()
      const latest = readStoredScheduledTaskDraft()
      if (token && latest) setDraft({ ...latest, project: { kind: 'folder', cwdToken: token } })
    } catch {
      setErrors(current => ({ ...current, [EDITOR]: 'The folder picker could not open. Try again.' }))
    }
  }
  const toggle = (task: ScheduledTask) => {
    if (task.enabled) void command(task.id, { type: 'pause', id: task.id }, `${task.name} paused`)
    else if (isWorkspaceMapTask(task)) setConfirm({ kind: 'resume-preset', task })
    else void command(task.id, { type: 'resume', id: task.id }, `${task.name} active`)
  }
  const createPreset = async (project: Extract<ScheduledTaskCommand, { type: 'workspace-maps' }>): Promise<boolean> => {
    const before = new Set(taskById.keys())
    const created = await command(PRESET, project, 'Workspace-map task created, paused')
    const id = created?.tasks.find(task => !before.has(task.id))?.id
    if (id) select({ kind: 'task', id })
    return created !== null
  }

  let pane: ReactNode
  if (!loaded) pane = readError ? null : <p className="py-10 text-center text-[13px] text-text-subtle">Loading scheduled tasks…</p>
  else if (editing && draft) {
    pane = (
      <EditorPane
        draft={draft}
        task={editingTask}
        missing={draft.taskId !== null && editingTask === null}
        projects={projects}
        modelOptions={modelOptions}
        defaultEffortOptions={options?.defaultEffortOptions ?? []}
        optionsReady={options !== null}
        now={now}
        busy={!!pending[EDITOR]}
        error={errors[EDITOR] ?? null}
        disabled={!!unavailable}
        onChange={setDraft}
        onPickFolder={() => void pickFolder()}
        onSave={() => void save()}
        onCancel={() => closeEditor(draft.taskId ? { kind: 'task', id: draft.taskId } : null)}
      />
    )
  } else if (selectedTask) {
    pane = (
      <TaskPane
        key={selectedTask.id}
        task={selectedTask}
        runs={runs}
        now={now}
        busy={!!pending[selectedTask.id]}
        error={errors[selectedTask.id] ?? null}
        disabled={!!unavailable}
        onBack={() => select(null)}
        onToggle={() => toggle(selectedTask)}
        onRun={() => void command(selectedTask.id, { type: 'run', id: selectedTask.id }, `${selectedTask.name} started`)}
        onEdit={() => openEditor(() => editTaskDraft(selectedTask))}
        onDelete={() => setConfirm({ kind: 'delete', task: selectedTask })}
        onOpenChat={onOpenChat}
      />
    )
  } else if (selection?.kind === 'history') {
    pane = <HistoryPane runs={runs} taskById={taskById} now={now} onBack={() => select(null)} onOpenChat={onOpenChat} />
  } else if (selection?.kind === 'preset') {
    pane = (
      <PresetPane
        projects={projects}
        tasks={tasks}
        busy={!!pending[PRESET]}
        error={errors[PRESET] ?? null}
        disabled={!!unavailable}
        onBack={() => select(null)}
        onCreate={createPreset}
      />
    )
  } else if (tasks.length === 0) {
    pane = <PromptPane disabled={!!unavailable} offerPreset={!hasPreset} onNew={() => openEditor(() => newTaskDraft())} onPreset={() => select({ kind: 'preset' })} />
  } else {
    pane = <ActivityPane runs={runs} taskById={taskById} now={now} onOpenChat={onOpenChat} onSelectTask={id => select({ kind: 'task', id })} onHistory={() => select({ kind: 'history' })} />
  }
  const detailOpen = (editing && draft !== null) || selection !== null

  return (
    <main className="flex min-h-0 min-w-0 flex-1">
      <nav
        aria-label="Scheduled tasks"
        data-window-chrome
        className={`${detailOpen ? 'hidden md:block' : 'block'} w-full shrink-0 overflow-y-auto border-r border-shell-seam bg-shell-chrome px-2.5 pb-6 pt-[18px] md:w-[272px]`}
      >
        <h1 className="mb-2.5 px-2.5 text-[15px] font-semibold tracking-[-0.01em] text-text-primary">Scheduled</h1>
        <ListRow
          selected={editing && draft !== null && draft.taskId === null}
          disabled={!loaded || !!unavailable}
          onClick={() => openEditor(() => newTaskDraft())}
        >
          <span className="flex items-center gap-2.5 text-[13px] text-text-muted">
            <PlusIcon />
            New task
            {draft && draft.taskId === null ? <span className="rounded border border-shell-seam px-1.5 py-px text-[9.5px] font-bold uppercase tracking-wide text-text-subtle">Draft</span> : null}
          </span>
        </ListRow>
        <TaskGroup label="Upcoming" tasks={tasks.filter(task => task.enabled)} runs={runs} now={now} draftTaskId={draft?.taskId ?? null} selection={editing ? null : selection} onSelect={id => select({ kind: 'task', id })} />
        <TaskGroup label="Paused" tasks={tasks.filter(task => !task.enabled)} runs={runs} now={now} draftTaskId={draft?.taskId ?? null} selection={editing ? null : selection} onSelect={id => select({ kind: 'task', id })} />
        {!hasPreset && loaded && !unavailable ? (
          <>
            <div className="mx-2.5 mb-1 mt-[18px] text-[11.5px] font-medium text-text-subtle">Suggested</div>
            <ListRow selected={!editing && selection?.kind === 'preset'} onClick={() => select({ kind: 'preset' })}>
              <RowText title="Workspace-map refresh" subtitle="Daily at 03:00 · starts paused" />
            </ListRow>
          </>
        ) : null}
        {runs.length > 0 ? (
          <>
            <div className="mx-2.5 my-3.5 h-px bg-shell-seam" />
            <ListRow selected={!editing && selection?.kind === 'history'} onClick={() => select({ kind: 'history' })}>
              <span className="flex w-full items-center justify-between gap-2">
                <span className="text-[13px] font-medium text-text-primary">Run history</span>
                <span className="font-mono text-[11px] text-text-subtle">{partitionRuns(runs).finished.length}</span>
              </span>
            </ListRow>
          </>
        ) : null}
      </nav>

      <section className={`${detailOpen ? 'block' : 'hidden md:block'} min-w-0 flex-1 overflow-y-auto px-4 pb-16 pt-5 md:px-10 md:pt-[30px]`}>
        <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
        {unavailable || readError ? (
          <div role="alert" className="mb-5 max-w-[680px] rounded-[10px] border border-tone-danger/30 bg-tone-danger/[0.06] px-3.5 py-2.5 text-[12.5px] text-tone-danger">
            {unavailable ?? readError}
          </div>
        ) : null}
        {optionsError && choicesVisible ? (
          <div role="alert" className={`mb-5 flex max-w-[680px] items-center gap-3 text-[12.5px] ${options ? 'text-tone-warn' : 'text-tone-danger'}`}>
            <span>{options ? 'Models and projects may be out of date.' : 'Models and projects could not be loaded.'}</span>
            <button type="button" className={BTN} disabled={optionsRefreshing} onClick={() => void refreshOptions(true)}>Refresh choices</button>
          </div>
        ) : null}
        {pane}
      </section>

      {confirm ? (
        <ConfirmDialog
          confirm={confirm}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const { kind, task } = confirm
            setConfirm(null)
            if (kind === 'delete') {
              void command(task.id, { type: 'delete', id: task.id }, `${task.name} deleted`).then(deleted => {
                if (!deleted) return
                if (draft?.taskId === task.id) setDraft(null)
                select(null)
              })
            } else void command(task.id, { type: 'resume', id: task.id }, `${task.name} active`)
          }}
        />
      ) : null}
    </main>
  )
}

function ListRow({ selected, disabled, onClick, children }: { selected: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-current={selected ? 'page' : undefined}
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left transition-colors disabled:cursor-default disabled:opacity-45 ${selected ? 'bg-shell-active' : 'hover:bg-shell-hover'} ${FOCUS}`}
    >
      {children}
    </button>
  )
}

function RowText({ title, subtitle, tone, muted, chevron, draft }: { title: string; subtitle: string; tone?: 'warn'; muted?: boolean; chevron?: boolean; draft?: boolean }) {
  return (
    <span className="min-w-0 flex-1">
      <span className={`flex items-center gap-1 text-[13px] font-medium ${muted ? 'text-text-muted' : 'text-text-primary'}`}>
        <span className="truncate">{title}</span>
        {chevron ? <ChevronRight className="shrink-0 text-text-subtle" /> : null}
        {draft ? <span className="ml-1 shrink-0 rounded border border-shell-seam px-1.5 py-px text-[9.5px] font-bold uppercase tracking-wide text-text-subtle">Draft</span> : null}
      </span>
      <span className={`mt-px block truncate text-[11.5px] ${tone === 'warn' ? 'text-tone-warn' : 'text-text-subtle'}`}>{subtitle}</span>
    </span>
  )
}

function TaskGroup({ label, tasks, runs, now, draftTaskId, selection, onSelect }: {
  label: string
  draftTaskId: string | null
  tasks: readonly ScheduledTask[]
  runs: readonly ScheduledRun[]
  now: number
  selection: ScheduledSelection
  onSelect: (id: string) => void
}) {
  if (tasks.length === 0) return null
  return (
    <>
      <div className="mx-2.5 mb-1 mt-[18px] text-[11.5px] font-medium text-text-subtle">{label}</div>
      {tasks.map(task => {
        const active = activeRunFor(task.id, runs)
        const selected = selection?.kind === 'task' && selection.id === task.id
        const rec = scheduleLabel(task.schedule)
        const subtitle = active?.status === 'waiting' ? `Needs answer · ${rec}` : task.enabled ? `${nextRunText(task, runs, now)} · ${rec}` : rec
        const status = active ? runStatusPresentation(active) : null
        return (
          <ListRow key={task.id} selected={selected} onClick={() => onSelect(task.id)}>
            <RowText title={task.name} subtitle={subtitle} tone={active?.status === 'waiting' ? 'warn' : undefined} muted={!task.enabled} chevron={selected} draft={draftTaskId === task.id} />
            <span aria-hidden="true" className={`h-[7px] w-[7px] shrink-0 rounded-full ${status ? DOT[status.tone] : ''}`} />
            {status ? <span className="sr-only">{status.label}</span> : null}
          </ListRow>
        )
      })}
    </>
  )
}

function PaneHeader({ title, meta, onBack, actions }: { title: string; meta?: ReactNode; onBack?: () => void; actions?: ReactNode }) {
  return (
    <>
      {onBack ? (
        <button type="button" onClick={onBack} className={`mb-3.5 inline-flex items-center gap-1 rounded text-[12.5px] text-text-subtle hover:text-text-primary md:hidden ${FOCUS}`}>
          <ChevronLeft /> Scheduled
        </button>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 md:flex-nowrap">
        <div className="min-w-0 flex-[1_1_240px]">
          <h2 className="break-words text-[20px] font-semibold tracking-[-0.02em] text-text-primary">{title}</h2>
          {meta ? <div className="mt-1 text-[13px] text-text-subtle">{meta}</div> : null}
        </div>
        {actions}
      </div>
    </>
  )
}

function RunLine({ run, now, task, showTask, onOpenChat }: { run: ScheduledRun; now: number; task?: ScheduledTask | null; showTask?: boolean; onOpenChat: (id: string) => void }) {
  const { label, tone } = runStatusPresentation(run)
  const when = formatRunTime(run.startedAt, now)
  const detail = [showTask ? when : '', run.endedAt !== null ? formatDuration(run.endedAt - run.startedAt) : ''].filter(Boolean).join(' · ')
  return (
    <li className="border-b border-shell-seam last:border-b-0">
      <button
        type="button"
        onClick={() => onOpenChat(run.appSessionId)}
        aria-label={`Open chat for ${run.taskName}, ${when}, ${label}`}
        className={`grid w-full grid-cols-[7px_minmax(0,1fr)_auto_14px] items-center gap-x-3 rounded-md py-2.5 text-left transition-colors hover:bg-shell-hover/60 ${FOCUS}`}
      >
        <span className={`h-[7px] w-[7px] rounded-full ${DOT[tone]}`} />
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className={`text-[13px] font-medium tabular-nums ${showTask && !task ? 'text-text-muted' : 'text-text-primary'}`}>{showTask ? run.taskName : when}</span>
          {showTask && !task ? <span className="rounded border border-shell-seam px-1.5 text-[9.5px] font-bold uppercase tracking-wide text-text-subtle">Deleted</span> : null}
          <span className={`text-[12.5px] ${STATUS_TEXT[tone]}`}>{label}</span>
        </span>
        <span className="whitespace-nowrap text-[12px] tabular-nums text-text-subtle">{detail}</span>
        <ChevronRight className="text-text-faint" />
        {run.summary ? <span className="col-start-2 col-end-4 mt-[3px] line-clamp-2 text-[12.5px] leading-normal text-text-muted">{run.summary}</span> : null}
      </button>
    </li>
  )
}

/** The current run, with the one action it needs. */
function LiveRun({ run, now, showTask, onOpenChat }: { run: ScheduledRun; now: number; showTask?: boolean; onOpenChat: (id: string) => void }) {
  const waiting = run.status === 'waiting'
  const { label, tone } = runStatusPresentation(run)
  const headline = waiting ? 'Waiting for your answer' : label
  const detail = run.summary && !waiting ? run.summary : `since ${formatRunTime(run.startedAt, now).replace(/^Today /, '')}`
  return (
    <div className={`my-1 flex items-center gap-3 rounded-[10px] border py-[9px] pl-3 pr-[9px] ${waiting ? 'border-tone-warn/25 bg-tone-warn/[0.06]' : 'border-shell-seam bg-shell-hover/40'}`}>
      <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${DOT[tone]}`} />
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 text-[13px]">
        <span className="font-medium text-text-primary">{showTask ? run.taskName : headline}</span>
        <span className="text-[12.5px] text-text-subtle">{showTask ? `${waiting ? 'is waiting for your answer' : label.toLowerCase()} · ${detail}` : detail}</span>
      </span>
      <button type="button" className={BTN} onClick={() => onOpenChat(run.appSessionId)} aria-label={`${waiting ? 'Answer in chat' : 'Open chat'} for ${run.taskName}`}>
        {waiting ? 'Answer in chat' : 'Open chat'}
      </button>
    </div>
  )
}

function TaskPane({
  task, runs, now, busy, error, disabled, onBack, onToggle, onRun, onEdit, onDelete, onOpenChat,
}: {
  task: ScheduledTask
  runs: readonly ScheduledRun[]
  now: number
  busy: boolean
  error: string | null
  disabled: boolean
  onBack: () => void
  onToggle: () => void
  onRun: () => void
  onEdit: () => void
  onDelete: () => void
  onOpenChat: (id: string) => void
}) {
  const [limit, setLimit] = useState(RUN_PAGE)
  const own = partitionRuns(runs.filter(run => run.taskId === task.id))
  const current = own.active[0]
  const preset = isWorkspaceMapTask(task)
  const meta = [
    scheduleLabel(task.schedule),
    basename(task.cwd) || task.cwd,
    task.permissionMode === 'auto' ? 'Auto permissions' : 'Asks for permission',
    ...(task.model || task.effort !== 'default' ? [[task.model || 'Default model', task.effort !== 'default' ? `${EFFORT_LABELS[task.effort].toLowerCase()} effort` : ''].filter(Boolean).join(', ')] : []),
  ].join(' · ')
  const actions = (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
      <label className="mr-1 inline-flex cursor-pointer items-center gap-2 text-[12.5px] text-text-muted">
        {task.enabled ? 'Active' : 'Paused'}
        <button
          type="button"
          role="switch"
          aria-checked={task.enabled}
          aria-label={`Run ${task.name} on schedule`}
          disabled={busy || disabled}
          onClick={onToggle}
          className={`relative inline-flex h-[18px] w-[31px] shrink-0 items-center rounded-full border transition-colors disabled:cursor-default disabled:opacity-50 ${task.enabled ? 'border-accent bg-accent' : 'border-shell-seam bg-shell-hover'} ${FOCUS}`}
        >
          <span className={`inline-block h-3 w-3 rounded-full transition-transform ${task.enabled ? 'translate-x-4 bg-on-fill' : 'translate-x-0.5 bg-text-subtle'}`} />
        </button>
      </label>
      <span aria-hidden="true" className="mx-1 h-[18px] w-px bg-shell-seam" />
      <button
        type="button"
        className={BTN}
        disabled={busy || disabled || !!current}
        aria-label={current ? `Run ${task.name} now, unavailable until the current run finishes` : `Run ${task.name} now`}
        onClick={onRun}
      >
        Run now
      </button>
      <button type="button" className={GHOST} disabled={busy || disabled} onClick={onEdit}>Edit</button>
      <TaskMenu task={task} lastChat={(current ?? own.finished[0])?.appSessionId ?? null} disabled={busy || disabled} onOpenChat={onOpenChat} onDelete={onDelete} />
    </div>
  )
  const nextLabel = !task.enabled ? null : current && task.nextRunAt <= now ? 'Next run' : nextRunText(task, runs, now)
  const finished = own.finished.slice(0, limit)

  return (
    <div className="max-w-[680px]">
      <PaneHeader title={task.name} meta={meta} onBack={onBack} actions={actions} />
      {preset && !task.enabled ? <p className="mt-2.5 text-[12.5px] text-tone-warn">Pause the previous map-refresh schedule outside Cat Code before turning this on.</p> : null}
      {error ? <p role="alert" className="mt-2.5 text-[12.5px] text-tone-danger">{error}</p> : null}

      <section className="mt-[30px]" aria-label="Runs">
        <h3 className={H3}>Runs</h3>
        {nextLabel ? (
          <div className="grid grid-cols-[7px_minmax(0,1fr)] items-center gap-x-3 border-b border-shell-seam py-2.5 last:border-b-0">
            <span className="h-[7px] w-[7px] rounded-full shadow-[inset_0_0_0_1.5px_var(--color-text-ghost)]" />
            <span className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-[13px] tabular-nums text-text-muted">{nextLabel}</span>
              <span className="text-[12.5px] text-text-subtle">{current && task.nextRunAt <= now ? 'after this one finishes' : 'Scheduled'}</span>
            </span>
          </div>
        ) : null}
        {current ? <LiveRun run={current} now={now} onOpenChat={onOpenChat} /> : null}
        {finished.length > 0 ? (
          <ul>{finished.map(run => <RunLine key={run.id} run={run} now={now} onOpenChat={onOpenChat} />)}</ul>
        ) : !current ? <p className="py-2.5 text-[12.5px] text-text-subtle">No runs yet</p> : null}
        {own.finished.length > finished.length ? (
          <button type="button" className={`${GHOST} mt-1 -ml-2.5`} onClick={() => setLimit(value => value + RUN_PAGE)}>Show older runs</button>
        ) : null}
      </section>

      <section className="mt-[30px]" aria-label="Instructions">
        <h3 className={H3}>Instructions</h3>
        <p className="whitespace-pre-wrap break-words border-l-2 border-shell-seam py-0.5 pl-3 text-[13px] leading-relaxed text-text-muted">{task.prompt}</p>
      </section>
    </div>
  )
}

function TaskMenu({ task, lastChat, disabled, onOpenChat, onDelete }: { task: ScheduledTask; lastChat: string | null; disabled: boolean; onOpenChat: (id: string) => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  const { restoreTriggerFocus } = usePopoverFocus({ open, containerRef: menuRef, onEscape: close })
  const choose = (action: () => void) => { setOpen(false); restoreTriggerFocus(); action() }
  const item = `block w-full rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors hover:bg-shell-hover focus-visible:bg-shell-hover focus-visible:outline-none disabled:cursor-default disabled:opacity-45`
  return (
    <span className="relative">
      <button
        type="button"
        aria-label={`More actions for ${task.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(value => !value)}
        className={`flex h-[30px] w-[30px] items-center justify-center rounded-lg transition-colors disabled:opacity-45 ${open ? 'bg-accent/15 text-accent' : 'text-text-subtle hover:bg-shell-hover hover:text-text-primary'} ${FOCUS}`}
      >
        <MoreIcon />
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-[70]" onMouseDown={close} />
          <div
            ref={menuRef}
            role="menu"
            aria-label={`Actions for ${task.name}`}
            onKeyDown={handleMenuRovingKeyDown}
            className="absolute right-0 top-[calc(100%+4px)] z-[71] w-[232px] rounded-[11px] border border-shell-seam bg-shell-chrome p-1.5 shadow-[var(--elev-menu)]"
          >
            <button type="button" role="menuitem" disabled={!lastChat} className={`${item} text-text-muted hover:text-text-primary`} onClick={() => lastChat && choose(() => onOpenChat(lastChat))}>Open last chat</button>
            <div className="my-1 h-px bg-shell-seam" />
            <button type="button" role="menuitem" className={`${item} text-tone-danger`} onClick={() => choose(onDelete)}>Delete</button>
          </div>
        </>
      ) : null}
    </span>
  )
}

function ActivityPane({ runs, taskById, now, onOpenChat, onSelectTask, onHistory }: {
  runs: readonly ScheduledRun[]
  taskById: ReadonlyMap<string, ScheduledTask>
  now: number
  onOpenChat: (id: string) => void
  onSelectTask: (id: string) => void
  onHistory: () => void
}) {
  const { active, finished } = partitionRuns(runs)
  const upcoming = orderTasks([...taskById.values()]).find(task => task.enabled && !activeRunFor(task.id, runs))
  return (
    <div className="max-w-[680px]">
      <PaneHeader title="Activity" meta="Runs while Cat Code is open" />
      {active.length > 0 ? (
        <section className="mt-[22px]" aria-label="Current runs">{active.map(run => <LiveRun key={run.id} run={run} now={now} showTask onOpenChat={onOpenChat} />)}</section>
      ) : upcoming ? (
        <button type="button" onClick={() => onSelectTask(upcoming.id)} className={`mt-[22px] flex w-full items-center gap-3 rounded-[10px] border border-shell-seam py-2.5 pl-3 pr-3 text-left transition-colors hover:bg-shell-hover ${FOCUS}`}>
          <span className="h-[7px] w-[7px] shrink-0 rounded-full shadow-[inset_0_0_0_1.5px_var(--color-text-ghost)]" />
          <span className="min-w-0 flex-1 text-[13px]"><span className="font-medium text-text-primary">{upcoming.name}</span> <span className="text-text-subtle">runs next · {formatRunTime(upcoming.nextRunAt, now)}</span></span>
          <ChevronRight className="text-text-faint" />
        </button>
      ) : null}
      {finished.length > 0 ? (
        <section className="mt-[30px]" aria-label="Recent runs">
          <div className="flex items-center justify-between">
            <h3 className={H3}>Recent runs</h3>
            {finished.length > 5 ? <button type="button" className={`${GHOST} -mr-2.5 h-6`} onClick={onHistory}>All runs</button> : null}
          </div>
          <ul>{finished.slice(0, 5).map(run => <RunLine key={run.id} run={run} now={now} task={taskById.get(run.taskId) ?? null} showTask onOpenChat={onOpenChat} />)}</ul>
        </section>
      ) : null}
    </div>
  )
}

function HistoryPane({ runs, taskById, now, onBack, onOpenChat }: {
  runs: readonly ScheduledRun[]
  taskById: ReadonlyMap<string, ScheduledTask>
  now: number
  onBack: () => void
  onOpenChat: (id: string) => void
}) {
  const [filter, setFilter] = useState('')
  const [limit, setLimit] = useState(RUN_PAGE)
  const finished = partitionRuns(runs).finished
  const sources = useMemo(() => {
    const names = new Map<string, string>()
    for (const run of finished) if (!names.has(run.taskId)) names.set(run.taskId, taskById.get(run.taskId)?.name ?? run.taskName)
    return [...names].sort((a, b) => a[1].localeCompare(b[1]))
  }, [finished, taskById])
  const visible = filter ? finished.filter(run => run.taskId === filter) : finished
  const shown = visible.slice(0, limit)
  const filterControl = sources.length > 1 ? (
    <span className="w-[200px] shrink-0">
      <Picker
        label="Show runs for"
        compact
        value={filter}
        options={[{ value: '', label: 'All tasks' }, ...sources.map(([id, name]) => ({ value: id, label: name, ...(taskById.has(id) ? {} : { detail: 'Deleted' }) }))]}
        onChange={value => { setFilter(value); setLimit(RUN_PAGE) }}
      />
    </span>
  ) : null
  return (
    <div className="max-w-[680px]">
      <PaneHeader title="Run history" meta={`${visible.length} ${visible.length === 1 ? 'run' : 'runs'}`} onBack={onBack} actions={filterControl} />
      {shown.length > 0 ? (
        <ul className="mt-5">{shown.map(run => <RunLine key={run.id} run={run} now={now} task={taskById.get(run.taskId) ?? null} showTask onOpenChat={onOpenChat} />)}</ul>
      ) : <p className="mt-5 text-[12.5px] text-text-subtle">No finished runs</p>}
      {visible.length > shown.length ? <button type="button" className={`${GHOST} mt-1 -ml-2.5`} onClick={() => setLimit(value => value + RUN_PAGE)}>Show older runs</button> : null}
    </div>
  )
}

function PromptPane({ disabled, offerPreset, onNew, onPreset }: { disabled: boolean; offerPreset: boolean; onNew: () => void; onPreset: () => void }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center pb-10 text-center">
      <ClockIcon className="mb-3.5 text-text-subtle" />
      <h2 className="text-[15px] font-semibold text-text-primary">Schedule a task</h2>
      <p className="mt-1 max-w-[340px] text-[13px] text-text-subtle">Each run starts a new chat at the time you set, while Cat Code is open.</p>
      <div className="mt-[18px] flex flex-wrap justify-center gap-1.5">
        <button type="button" className={TINTED} disabled={disabled} onClick={onNew}><PlusIcon size={11} /> New task</button>
        {offerPreset ? <button type="button" className={BTN} disabled={disabled} onClick={onPreset}>Add workspace-map refresh</button> : null}
      </div>
    </div>
  )
}

function PresetPane({ projects, tasks, busy, error, disabled, onBack, onCreate }: {
  projects: readonly ProjectChoice[]
  tasks: readonly ScheduledTask[]
  busy: boolean
  error: string | null
  disabled: boolean
  onBack: () => void
  onCreate: (command: Extract<ScheduledTaskCommand, { type: 'workspace-maps' }>) => Promise<boolean>
}) {
  const [selected, setSelected] = useState('')
  const [cwdToken, setCwdToken] = useState<string | null>(null)
  const [pickerError, setPickerError] = useState<string | null>(null)
  const selectId = useId()
  const choice = projects.find(project => project.workspaceId === selected) ?? null
  const exists = choice !== null && tasks.some(task => task.cwd === choice.cwd && isWorkspaceMapTask(task))
  const pickFolder = async () => {
    setPickerError(null)
    try {
      const token = await getBridge().pickScheduledTaskDirectory()
      if (token) { setCwdToken(token); setSelected('folder') }
    } catch { setPickerError('The folder picker could not open. Try again.') }
  }
  const create = async () => {
    const token = selected === 'folder' ? cwdToken : null
    const created = await onCreate(token ? { type: 'workspace-maps', cwdToken: token } : { type: 'workspace-maps', workspaceId: selected })
    if (!created && token) {
      setCwdToken(current => current === token ? null : current)
      setSelected(current => current === 'folder' ? '' : current)
      setPickerError('Choose the folder again.')
    }
  }
  return (
    <div className="max-w-[680px]">
      <PaneHeader title="Workspace-map refresh" meta={`Daily at 03:00 Asia/Bangkok · Auto permissions`} onBack={onBack} />
      <div className="mt-[22px] space-y-2 text-[13px] leading-relaxed text-text-muted">
        <p>Starts paused. Pause the previous map-refresh schedule outside Cat Code before turning this on; creating the task does not change that schedule.</p>
        <p>The project needs its workspace-map refresh helper. Cat Code keeps its own refresh state and imports a matching earlier cursor once.</p>
      </div>
      <section className="mt-[30px]" aria-label="Project">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 basis-[240px]">
            <label htmlFor={selectId} className={LABEL}>Project</label>
            <Picker
              id={selectId}
              label="Project"
              value={selected}
              placeholder="Choose a project"
              disabled={busy || disabled}
              panelWidth="w-[min(440px,calc(100vw-16px))]"
              options={[
                ...(cwdToken ? [{ value: 'folder', label: 'Chosen folder' }] : []),
                ...projects.map(project => ({ value: project.workspaceId, label: project.label, detail: displayPath(project.cwd) })),
              ]}
              footer={{ label: 'Choose another folder…', onSelect: () => void pickFolder() }}
              onChange={setSelected}
            />
          </div>
          <button type="button" className={`${TINTED} h-[33px]`} disabled={busy || disabled || (!choice && !(selected === 'folder' && cwdToken)) || exists} onClick={() => void create()}>
            {busy ? 'Creating…' : 'Create paused task'}
          </button>
        </div>
        {exists ? <p className="mt-2 text-[12px] text-text-subtle">This project already has a workspace-map task.</p> : null}
        {pickerError ? <p role="alert" className="mt-2 text-[12.5px] text-tone-danger">{pickerError}</p> : null}
        {error ? <p role="alert" className="mt-2 text-[12.5px] text-tone-danger">{error}</p> : null}
      </section>
    </div>
  )
}

function EditorPane({
  draft, task, missing, projects, modelOptions, defaultEffortOptions, optionsReady, now, busy, error, disabled, onChange, onPickFolder, onSave, onCancel,
}: {
  draft: ScheduledTaskDraft
  task: ScheduledTask | null
  missing: boolean
  projects: readonly ProjectChoice[]
  modelOptions: readonly ScheduledModelOption[]
  defaultEffortOptions: readonly string[]
  optionsReady: boolean
  now: number
  busy: boolean
  error: string | null
  disabled: boolean
  onChange: (draft: ScheduledTaskDraft) => void
  onPickFolder: () => void
  onSave: () => void
  onCancel: () => void
}) {
  const ids = { name: useId(), prompt: useId(), project: useId(), day: useId(), time: useId(), zone: useId(), minutes: useId(), model: useId(), effort: useId() }
  const nameRef = useRef<HTMLInputElement>(null)
  const zones = useMemo(() => {
    const local = localTimeZone()
    return [local, ...availableTimeZones().filter(zone => zone !== local)]
  }, [])
  const supportedEfforts = effortChoicesFor(draft.model, modelOptions, defaultEffortOptions)
  // Keep a saved effort visible until the operator chooses a different model.
  const efforts = supportedEfforts.includes(draft.effort) ? supportedEfforts : [...supportedEfforts, draft.effort]
  const models: PickerOption[] = [
    { value: '', label: 'Default' },
    ...modelOptions.map(option => ({ value: option.value, label: option.label, group: providerLabel(option.provider), provider: option.provider })),
    ...(draft.model && !modelOptions.some(option => option.value === draft.model) ? [{ value: draft.model, label: draft.model, group: 'Saved' }] : []),
  ]
  const projectOptions: PickerOption[] = [
    ...(draft.taskId && task ? [{ value: 'saved', label: basename(task.cwd) || task.cwd, detail: displayPath(task.cwd), marker: 'Current' }] : []),
    ...(draft.project.kind === 'folder' ? [{ value: 'folder', label: 'Chosen folder' }] : []),
    ...projects.filter(project => project.cwd !== task?.cwd).map(project => ({ value: project.workspaceId, label: project.label, detail: displayPath(project.cwd) })),
  ]
  const problems = draftProblems(draft)
  const blocked = Object.keys(problems).length > 0
  const set = <K extends keyof ScheduledTaskDraft>(key: K, value: ScheduledTaskDraft[K]) => onChange({ ...draft, [key]: value })
  useEffect(() => { nameRef.current?.focus() }, [draft.taskId])
  const bytes = promptBytes(draft.prompt)
  const projectValue = draft.project.kind === 'workspace' ? draft.project.workspaceId : draft.project.kind === 'saved' ? 'saved' : draft.project.kind === 'folder' ? 'folder' : ''
  const next = previewNextRun(draft, now)
  const heading = draft.taskId ? `Edit ${task?.name ?? 'task'}` : 'New task'
  const border = (problem?: string) => (problem ? 'border-tone-danger/60' : 'border-shell-seam')

  return (
    <form
      aria-label={heading}
      className="max-w-[680px]"
      onSubmit={event => { event.preventDefault(); if (!blocked && !busy && !missing && !disabled && optionsReady) onSave() }}
    >
      <PaneHeader title={heading} onBack={onCancel} />
      {missing ? <p role="alert" className="mt-2.5 text-[12.5px] text-tone-danger">This task was deleted. Cancel to discard the draft.</p> : null}

      <div className="mt-[22px]">
        <Field id={ids.name} label="Name" problem={draft.name ? problems.name : undefined}>
          <input ref={nameRef} id={ids.name} className={`${FIELD} ${border(draft.name ? problems.name : undefined)}`} value={draft.name} maxLength={160} onChange={event => set('name', event.target.value)} />
        </Field>
        <Field id={ids.prompt} label="Instructions" problem={draft.prompt ? problems.prompt : undefined} hint={bytes > MAX_PROMPT_BYTES * 0.8 ? `${Math.ceil(bytes / 1024)} of 64 KB` : undefined}>
          <textarea
            id={ids.prompt}
            rows={6}
            className={`${FIELD} h-auto min-h-[128px] resize-y py-2 text-[13px] leading-relaxed ${border(draft.prompt ? problems.prompt : undefined)}`}
            value={draft.prompt}
            onChange={event => set('prompt', event.target.value)}
          />
        </Field>
      </div>

      <FormSection title="Where">
        <Field id={ids.project} label="Project" hiddenLabel problem={draft.project.kind === 'none' && draft.project.reason ? problems.project : undefined}>
          <Picker
            id={ids.project}
            label="Project"
            value={projectValue}
            placeholder="Choose a project"
            invalid={draft.project.kind === 'none' && !!draft.project.reason}
            panelWidth="w-[min(440px,calc(100vw-16px))]"
            options={projectOptions}
            footer={{ label: 'Choose another folder…', onSelect: onPickFolder }}
            onChange={value => onChange({ ...draft, project: value === 'saved' ? { kind: 'saved' } : value === 'folder' ? draft.project : { kind: 'workspace', workspaceId: value } })}
          />
        </Field>
      </FormSection>

      <FormSection title="When">
        <Segmented
          label="Repeat"
          value={draft.scheduleKind}
          options={[['daily', 'Every day'], ['weekdays', 'Weekdays'], ['weekly', 'Weekly'], ['interval', 'Interval']]}
          onChange={value => set('scheduleKind', value)}
        />
        <div className="mt-2.5 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-x-3">
          {draft.scheduleKind === 'interval' ? (
            <Field id={ids.minutes} label="Minutes between runs" problem={problems.schedule}>
              <input id={ids.minutes} inputMode="numeric" className={`${FIELD} ${border(problems.schedule)}`} value={draft.minutes} onChange={event => set('minutes', event.target.value)} />
            </Field>
          ) : (
            <>
              {draft.scheduleKind === 'weekly' ? (
                <Field id={ids.day} label="Day">
                  <Picker id={ids.day} label="Day" value={String(draft.day)} options={WEEKDAY_NAMES.map((day, index) => ({ value: String(index), label: day }))} onChange={value => set('day', Number(value))} />
                </Field>
              ) : null}
              <Field id={ids.time} label="Time" problem={problems.schedule}>
                <input id={ids.time} type="time" className={`${FIELD} ${border(problems.schedule)}`} value={draft.time} onChange={event => set('time', event.target.value)} />
              </Field>
              <Field id={ids.zone} label="Time zone" problem={problems.timeZone}>
                <Picker
                  id={ids.zone}
                  label="Time zone"
                  value={draft.timeZone}
                  invalid={!!problems.timeZone}
                  searchable
                  panelWidth="w-72"
                  options={(zones.includes(draft.timeZone) ? zones : [draft.timeZone, ...zones]).map(zone => ({ value: zone, label: zone, ...(zone === zones[0] ? { marker: 'This computer' } : {}) }))}
                  onChange={value => set('timeZone', value)}
                />
              </Field>
            </>
          )}
        </div>
        {next !== null ? (
          <p className="text-[12.5px] text-text-subtle">
            Next run <span className="tabular-nums text-text-primary">{formatRunTime(next, now)}</span>
            {draft.scheduleKind !== 'interval' && draft.timeZone.trim() !== localTimeZone() ? ' on this computer' : ''}
          </p>
        ) : null}
      </FormSection>

      <FormSection title="Runs with">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-x-3">
          <Field id={ids.model} label="Model" problem={problems.model}>
            <Picker
              id={ids.model}
              label="Model"
              value={draft.model}
              invalid={!!problems.model}
              options={models}
              disabled={!optionsReady}
              onChange={value => {
                const allowed = effortChoicesFor(value, modelOptions, defaultEffortOptions)
                onChange({ ...draft, model: value, effort: allowed.includes(draft.effort) ? draft.effort : 'default' })
              }}
            />
          </Field>
          <Field id={ids.effort} label="Effort">
            <Picker
              id={ids.effort}
              label="Effort"
              value={draft.effort}
              disabled={!optionsReady}
              options={efforts.map(effort => ({ value: effort, label: EFFORT_LABELS[effort] }))}
              onChange={value => set('effort', value as ScheduledEffort)}
            />
          </Field>
        </div>
        <span className={LABEL}>Permissions</span>
        <Segmented label="Permissions" value={draft.permissionMode} options={[['default', 'Ask'], ['auto', 'Auto']]} onChange={value => set('permissionMode', value)} />
        <p className="mt-[5px] text-[11.5px] text-text-subtle">
          {draft.permissionMode === 'default' ? "Requests wait in the run's chat until you answer." : 'The safety classifier reviews actions that are not already approved.'}
        </p>
        {draft.taskId === null ? (
          <label className="mt-4 flex w-fit items-center gap-2 text-[12.5px] text-text-muted">
            <input type="checkbox" className={`accent-[var(--color-accent)] ${FOCUS}`} checked={draft.startPaused} onChange={event => set('startPaused', event.target.checked)} />
            Start paused
          </label>
        ) : null}
      </FormSection>

      {error ? <p role="alert" className="mt-4 text-[12.5px] text-tone-danger">{error}</p> : null}
      <div className="mt-6 flex justify-end gap-2.5 border-t border-shell-seam pt-4">
        <SAButton label="Cancel" onClick={onCancel} />
        <button type="submit" disabled={busy || disabled || blocked || missing || !optionsReady} className={`flex shrink-0 items-center rounded-lg bg-accent px-[15px] py-2 text-[12.5px] font-semibold text-on-fill transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-45 ${FOCUS}`}>
          {busy ? 'Saving…' : draft.taskId ? 'Save changes' : 'Create task'}
        </button>
      </div>
    </form>
  )
}

type PickerOption = { value: string; label: string; detail?: string; group?: string; marker?: string; provider?: string }

const MAX_SEARCH_RESULTS = 80

/** A designed select: the composer's popover, menu roving, and focus lifecycle. */
function Picker({
  id, label, value, options, onChange, placeholder, invalid, disabled, compact, searchable, panelWidth = 'w-64', footer,
}: {
  id?: string
  label: string
  value: string
  options: readonly PickerOption[]
  onChange: (value: string) => void
  placeholder?: string
  invalid?: boolean
  disabled?: boolean
  compact?: boolean
  searchable?: boolean
  panelWidth?: string
  footer?: { label: string; onSelect: () => void }
}) {
  const { open, setOpen, close, ref, triggerRef, panelRef } = usePopover()
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const selected = options.find(option => option.value === value)
  const needle = query.trim().toLowerCase()
  const matches = needle ? options.filter(option => option.label.toLowerCase().includes(needle)).slice(0, MAX_SEARCH_RESULTS) : options.slice(0, searchable ? MAX_SEARCH_RESULTS : undefined)
  const groups: { name: string | undefined; options: PickerOption[] }[] = []
  for (const option of matches) {
    const group = groups.find(entry => entry.name === option.group)
    if (group) group.options.push(option)
    else groups.push({ name: option.group, options: [option] })
  }
  useEffect(() => {
    if (!open || !searchable) return
    setQuery('')
    // After the popover's own first-item focus, so typing lands in the search field.
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => searchRef.current?.focus()))
    return () => cancelAnimationFrame(frame)
  }, [open, searchable])
  const choose = (next: string) => { close(); onChange(next) }
  const items = (
    <div ref={listRef} role="menu" aria-label={label} onKeyDown={handleMenuRovingKeyDown} className="flex flex-col">
      {groups.map(group => (
        <div key={group.name ?? ''}>
          {group.name ? <div className="flex items-center gap-1.5 px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-subtle"><ProviderLogo provider={group.options[0]?.provider ?? ''} size={11} />{group.name}</div> : null}
          {group.options.map(option => {
            const active = option.value === value
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => choose(option.value)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-shell-hover focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${active ? 'bg-shell-active' : ''}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] text-text-primary">{option.label}</span>
                  {option.detail ? <span className="block truncate font-mono text-[11px] text-text-subtle">{option.detail}</span> : null}
                </span>
                {option.marker ? <span className="shrink-0 text-[11px] text-text-subtle">{option.marker}</span> : null}
                <CheckIcon className={`shrink-0 text-accent ${active ? '' : 'invisible'}`} />
              </button>
            )
          })}
        </div>
      ))}
      {matches.length === 0 ? <p className="px-2 py-1.5 text-[12px] text-text-subtle">No matches</p> : null}
      {footer ? (
        <>
          <div className="my-1 h-px bg-shell-seam" />
          <button type="button" role="menuitem" onClick={() => { close(); footer.onSelect() }} className="w-full rounded-md px-2 py-1.5 text-left text-[12.5px] text-text-muted transition-colors hover:bg-shell-hover hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent">
            {footer.label}
          </button>
        </>
      ) : null}
    </div>
  )
  return (
    <div ref={ref} className="relative min-w-0">
      <button
        ref={triggerRef}
        id={id}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={id ? undefined : label}
        disabled={disabled}
        onClick={() => setOpen(current => !current)}
        className={`flex w-full min-w-0 items-center gap-2 rounded-[5px] border bg-surface-raised px-2.5 text-left transition-colors hover:border-text-ghost/40 disabled:cursor-default disabled:opacity-50 ${compact ? 'h-[30px]' : 'h-[33px]'} ${invalid ? 'border-tone-danger/60' : open ? 'border-accent/50' : 'border-shell-seam'} ${FOCUS}`}
      >
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          {selected?.provider ? <ProviderLogo provider={selected.provider} size={12} className="self-center text-text-subtle" /> : null}
          <span className={`truncate text-[12.5px] ${selected ? 'text-text-primary' : 'text-text-ghost'}`}>{selected?.label ?? placeholder ?? value}</span>
          {selected?.detail ? <span className="min-w-0 truncate font-mono text-[11px] text-text-subtle">{selected.detail}</span> : null}
        </span>
        <ChevronDown />
      </button>
      {open ? (
        <ComposerPopoverPanel panelRef={panelRef} triggerRef={triggerRef} gap={4} side="below">
          <div className={`animate-pop-up max-h-[320px] overflow-auto rounded-lg border border-shell-seam bg-surface-raised p-1.5 shadow-[var(--elev-popover)] ${panelWidth}`} {...(searchable ? { role: 'dialog', 'aria-label': label } : {})}>
            {searchable ? (
              <div className="sticky -top-1.5 z-10 -mx-1.5 -mt-1.5 mb-1 bg-surface-raised p-1.5">
              <input
                ref={searchRef}
                value={query}
                aria-label={`Search ${label.toLowerCase()}`}
                placeholder="Search"
                spellCheck={false}
                onChange={event => setQuery(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'ArrowDown') { event.preventDefault(); listRef.current?.querySelector<HTMLElement>('[role="menuitemradio"]')?.focus() }
                  if (event.key === 'Enter') { event.preventDefault(); if (matches[0]) choose(matches[0].value) }
                }}
                className="h-[30px] w-full rounded-md border border-shell-seam bg-app-bg px-2 text-[12.5px] text-text-primary outline-none placeholder:text-text-ghost focus:border-accent/50"
              />
              </div>
            ) : null}
            {items}
          </div>
        </ComposerPopoverPanel>
      ) : null}
    </div>
  )
}

function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="mt-[22px] min-w-0 border-0 p-0">
      <legend className="mb-2.5 p-0 text-[13px] font-semibold text-text-primary">{title}</legend>
      {children}
    </fieldset>
  )
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: ReadonlyArray<readonly [T, string]>; onChange: (value: T) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1">
      {options.map(([option, text]) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          onClick={() => onChange(option)}
          className={`rounded-full px-3 py-1.5 text-[12px] transition-colors ${value === option ? 'bg-accent/[0.12] text-accent' : 'text-text-subtle hover:bg-shell-hover hover:text-text-primary'} ${FOCUS}`}
        >
          {text}
        </button>
      ))}
    </div>
  )
}

function Field({ id, label, problem, hint, hiddenLabel, children }: { id: string; label: string; problem?: string; hint?: string; hiddenLabel?: boolean; children: ReactNode }) {
  return (
    <div className="mb-3 min-w-0">
      <label htmlFor={id} className={hiddenLabel ? 'sr-only' : LABEL}>{label}</label>
      {children}
      {problem ? <p className="mt-[5px] text-[11.5px] text-tone-danger">{problem}</p> : hint ? <p className="mt-[5px] text-[11.5px] text-text-subtle">{hint}</p> : null}
    </div>
  )
}

function ConfirmDialog({ confirm, onCancel, onConfirm }: { confirm: Confirm; onCancel: () => void; onConfirm: () => void }) {
  const deleting = confirm.kind === 'delete'
  return (
    <SAModal
      icon={<ClockIcon size={16} />}
      tint="warn"
      title={deleting ? `Delete ${confirm.task.name}?` : `Turn on ${confirm.task.name}?`}
      onClose={onCancel}
      footer={
        <>
          <SAButton label="Cancel" onClick={onCancel} />
          <SAButton label={deleting ? 'Delete task' : 'Turn on'} variant={deleting ? 'danger-primary' : 'primary'} onClick={onConfirm} />
        </>
      }
    >
      <p className="text-[13px] leading-relaxed text-text-muted">
        {deleting
          ? 'Future runs stop. A run that already started continues, and past run chats stay available.'
          : 'Confirm that the previous map-refresh schedule outside Cat Code is paused. Two schedules would refresh the same maps.'}
      </p>
    </SAModal>
  )
}

function ClockIcon({ size = 30, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={size > 20 ? 1.4 : 1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  )
}

function PlusIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0 text-text-subtle">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function MoreIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="5" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="12" cy="19" r="1.7" />
    </svg>
  )
}

function ChevronRight({ className }: { className?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path d="m9 6 6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ChevronLeft() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m15 6-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ChevronDown() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0 text-text-subtle">
      <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path d="m5 12.5 4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
