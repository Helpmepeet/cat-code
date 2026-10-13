import type { SessionDescriptor } from '../../shared/hostApi.js'
import type { RunControlProvider, RunControlsSnapshot } from '../../shared/protocol.js'
import {
  isActiveScheduledRun,
  nextTaskOccurrence,
  validTaskSchedule,
  type ScheduledRun,
  type ScheduledTask,
  type ScheduledTaskInput,
  type TaskSchedule,
} from '../../shared/scheduledTasks.js'
import { basename } from './pathUtils.js'
import type { Tone } from './tone.js'

export type ScheduledEffort = ScheduledTaskInput['effort']
export type ScheduledPermissionMode = ScheduledTaskInput['permissionMode']

/**
 * Where a draft's project comes from. The renderer never holds a path it could
 * submit: a new task names a host-owned project session or a single-use picker
 * token, and an edit may keep the saved project (HC1, `parseScheduledTaskCommand`).
 */
export type DraftProject =
  | { kind: 'none'; reason?: 'token-spent' }
  | { kind: 'saved' }
  | { kind: 'session'; appSessionId: string }
  | { kind: 'folder'; cwdToken: string }

export type ScheduledTaskDraft = {
  /** null creates a task; otherwise the edited task's id. */
  taskId: string | null
  name: string
  prompt: string
  project: DraftProject
  scheduleKind: TaskSchedule['kind']
  time: string
  timeZone: string
  day: number
  /** Text so a partly typed number survives until it is valid. */
  minutes: string
  model: string
  effort: ScheduledEffort
  permissionMode: ScheduledPermissionMode
  /** New tasks only; an edit keeps the task's current enabled state. */
  startPaused: boolean
}

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const
export const EFFORT_LABELS: Record<ScheduledEffort, string> = {
  default: 'Default',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}
const MAX_NAME_CHARS = 120
export const MAX_PROMPT_BYTES = 64 * 1024
const MODEL_PATTERN = /^[a-zA-Z0-9._:/-]+$/

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

export function availableTimeZones(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] }
  try { return intl.supportedValuesOf?.('timeZone') ?? [] } catch { return [] }
}

export function newTaskDraft(timeZone = localTimeZone()): ScheduledTaskDraft {
  return {
    taskId: null, name: '', prompt: '', project: { kind: 'none' },
    scheduleKind: 'daily', time: '09:00', timeZone, day: 1, minutes: '60',
    model: '', effort: 'default', permissionMode: 'default', startPaused: false,
  }
}

export function editTaskDraft(task: ScheduledTask, timeZone = localTimeZone()): ScheduledTaskDraft {
  const wallClock = task.schedule.kind === 'interval' ? null : task.schedule
  return {
    taskId: task.id, name: task.name, prompt: task.prompt, project: { kind: 'saved' },
    scheduleKind: task.schedule.kind,
    time: wallClock?.time ?? '09:00',
    timeZone: wallClock?.timeZone ?? timeZone,
    day: wallClock?.day ?? 1,
    minutes: task.schedule.kind === 'interval' ? String(task.schedule.minutes) : '60',
    model: task.model, effort: task.effort, permissionMode: task.permissionMode, startPaused: !task.enabled,
  }
}

export function draftSchedule(draft: ScheduledTaskDraft): TaskSchedule {
  return draft.scheduleKind === 'interval'
    ? { kind: 'interval', minutes: Number(draft.minutes) }
    : { kind: draft.scheduleKind, time: draft.time, timeZone: draft.timeZone.trim(), day: draft.day }
}

export type DraftProblems = Partial<Record<'name' | 'prompt' | 'project' | 'schedule' | 'timeZone' | 'model', string>>

/** Mirrors the receiving parser so a refusal is explained before submission. */
export function draftProblems(draft: ScheduledTaskDraft): DraftProblems {
  const problems: DraftProblems = {}
  if (!draft.name.trim()) problems.name = 'Enter a name.'
  else if (draft.name.length > MAX_NAME_CHARS) problems.name = `Use ${MAX_NAME_CHARS} characters or fewer.`
  if (!draft.prompt.trim()) problems.prompt = 'Enter instructions.'
  else if (promptBytes(draft.prompt) > MAX_PROMPT_BYTES) problems.prompt = 'Shorten the instructions to 64 KB or less.'
  if (draft.project.kind === 'none') problems.project = draft.project.reason === 'token-spent' ? 'Choose the folder again.' : 'Choose a project.'
  if (draft.scheduleKind === 'interval') {
    const minutes = Number(draft.minutes)
    if (!/^\d+$/.test(draft.minutes.trim()) || minutes < 1 || minutes > 10080) problems.schedule = 'Enter 1 to 10080 minutes.'
  } else {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time)) problems.schedule = 'Enter a time.'
    if (!validTimeZone(draft.timeZone.trim())) problems.timeZone = 'Enter a time zone such as Asia/Bangkok.'
  }
  const model = draft.model.trim()
  if (model.length > 100 || (model !== '' && !MODEL_PATTERN.test(model))) problems.model = 'Use a model name without spaces.'
  return problems
}

export function validTimeZone(timeZone: string): boolean {
  if (!timeZone || timeZone.length > 80) return false
  try { new Intl.DateTimeFormat('en', { timeZone }).format(); return true } catch { return false }
}

export function promptBytes(prompt: string): number {
  return new TextEncoder().encode(prompt).length
}

/**
 * The closed save input. An edit takes `enabled` from the latest snapshot so a
 * pause or resume made while the draft was open is not reverted by saving.
 */
export function draftToInput(draft: ScheduledTaskDraft, current: ScheduledTask | null): ScheduledTaskInput {
  const schedule = draftSchedule(draft)
  if (!validTaskSchedule(schedule)) throw new Error('The schedule is incomplete')
  return {
    ...(draft.taskId ? { id: draft.taskId } : {}),
    name: draft.name.trim(),
    prompt: draft.prompt,
    schedule,
    enabled: current ? current.enabled : !draft.startPaused,
    model: draft.model.trim(),
    effort: draft.effort,
    permissionMode: draft.permissionMode,
    ...(draft.project.kind === 'session' ? { workspaceSessionId: draft.project.appSessionId } : {}),
    ...(draft.project.kind === 'folder' ? { cwdToken: draft.project.cwdToken } : {}),
  }
}

/**
 * Main consumes a picker token on any save attempt, so a refused save spends
 * it. A folder chosen again while the save was pending is a different token.
 */
export function draftAfterRefusedSave(draft: ScheduledTaskDraft, spentToken: string | undefined): ScheduledTaskDraft {
  return draft.project.kind === 'folder' && draft.project.cwdToken === spentToken
    ? { ...draft, project: { kind: 'none', reason: 'token-spent' } }
    : draft
}

export type ProjectChoice = { appSessionId: string; cwd: string; label: string }

/** One host-owned project session per folder; main accepts any of them. */
export function projectChoices(sessions: readonly SessionDescriptor[]): ProjectChoice[] {
  const byCwd = new Map<string, SessionDescriptor>()
  for (const session of sessions) {
    if (session.binding?.kind !== 'project') continue
    const previous = byCwd.get(session.cwd)
    if (!previous || session.lastAttachedAt > previous.lastAttachedAt) byCwd.set(session.cwd, session)
  }
  return [...byCwd.values()]
    .map(session => ({ appSessionId: session.appSessionId, cwd: session.cwd, label: basename(session.cwd) || session.cwd }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.cwd.localeCompare(b.cwd))
}

export type ScheduledModelOption = { value: string; label: string; provider: RunControlProvider; effortOptions: readonly string[] }

/** Models the engine offered in open sessions, without the provider-local Default row. */
export function modelChoices(snapshots: Iterable<RunControlsSnapshot>): ScheduledModelOption[] {
  const byValue = new Map<string, ScheduledModelOption>()
  for (const snapshot of snapshots) {
    for (const option of snapshot.model.options) {
      if (option.value !== null && !byValue.has(option.value)) {
        byValue.set(option.value, { value: option.value, label: option.label, provider: option.provider, effortOptions: option.effortOptions })
      }
    }
  }
  return [...byValue.values()]
}

const SCHEDULED_EFFORTS = Object.keys(EFFORT_LABELS) as ScheduledEffort[]

/**
 * Effort levels the chosen model accepts, always including Default. The default
 * model's own levels are unknown here, so it offers every level the parser accepts.
 */
export function effortChoicesFor(model: string, options: readonly ScheduledModelOption[]): ScheduledEffort[] {
  const option = model ? options.find(entry => entry.value === model) : undefined
  if (!option) return SCHEDULED_EFFORTS
  return SCHEDULED_EFFORTS.filter(effort => effort === 'default' || option.effortOptions.includes(effort))
}

export function providerLabel(provider: RunControlProvider): string {
  switch (provider) {
    case 'anthropic': return 'Anthropic'
    case 'openai': return 'OpenAI'
    case 'bedrock': return 'AWS'
    case 'vertex': return 'Vertex'
    case 'foundry': return 'Foundry'
  }
}

/** A display-only path with the home folder shortened. */
export function displayPath(path: string): string {
  return path.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, '~')
}

/** Matches main's duplicate check plus the preset's helper contract. */
export function isWorkspaceMapTask(task: ScheduledTask): boolean {
  return task.name === 'Refresh workspace maps' && task.prompt.includes('workspaceMapRefreshState.ts')
}

/** The saved zone is named only when it differs from this computer's. */
export function scheduleLabel(schedule: TaskSchedule, viewerZone = localTimeZone()): string {
  if (schedule.kind === 'interval') {
    const { minutes } = schedule
    if (minutes % 1440 === 0) return minutes === 1440 ? 'Every day' : `Every ${minutes / 1440} days`
    if (minutes % 60 === 0) return minutes === 60 ? 'Every hour' : `Every ${minutes / 60} hours`
    return minutes === 1 ? 'Every minute' : `Every ${minutes} min`
  }
  const when = schedule.kind === 'daily' ? 'Daily' : schedule.kind === 'weekdays' ? 'Weekdays' : `${WEEKDAY_NAMES[schedule.day]}s`
  return `${when} at ${schedule.time}${schedule.timeZone === viewerZone ? '' : ` ${schedule.timeZone}`}`
}

/** Calendar-relative wall time in the viewer's zone (or `timeZone` for tests). */
export function formatRunTime(at: number, now: number, timeZone?: string): string {
  const zone = timeZone ? { timeZone } : {}
  const day = new Intl.DateTimeFormat('en-CA', { ...zone, year: 'numeric', month: '2-digit', day: '2-digit' })
  const time = new Intl.DateTimeFormat('en-GB', { ...zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)
  const target = day.format(at)
  const offsets: Array<[number, string]> = [[0, 'Today'], [86400_000, 'Tomorrow'], [-86400_000, 'Yesterday']]
  for (const [offset, label] of offsets) if (day.format(now + offset) === target) return `${label} ${time}`
  if (Math.abs(at - now) < 6 * 86400_000) return `${new Intl.DateTimeFormat('en-US', { ...zone, weekday: 'short' }).format(at)} ${time}`
  const date = new Intl.DateTimeFormat('en-US', { ...zone, month: 'short', day: 'numeric', ...(Math.abs(at - now) > 300 * 86400_000 ? { year: 'numeric' as const } : {}) }).format(at)
  return `${date} ${time}`
}

/** The draft's first dispatch, by the scheduler's own rule; null while incomplete. */
export function previewNextRun(draft: ScheduledTaskDraft, now: number): number | null {
  const schedule = draftSchedule(draft)
  if (!validTaskSchedule(schedule)) return null
  try { return nextTaskOccurrence(schedule, now) } catch { return null }
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`
}

export function activeRunFor(taskId: string, runs: readonly ScheduledRun[]): ScheduledRun | undefined {
  return runs.find(run => run.taskId === taskId && isActiveScheduledRun(run))
}

/** What the task's next dispatch will be, given the one-unfinished-run rule. */
export function nextRunText(task: ScheduledTask, runs: readonly ScheduledRun[], now: number, timeZone?: string): string {
  if (!task.enabled) return 'Paused'
  if (task.nextRunAt <= now) return activeRunFor(task.id, runs) ? 'After this run' : 'Due now'
  return formatRunTime(task.nextRunAt, now, timeZone)
}

/** Enabled tasks in dispatch order, then paused tasks by name. */
export function orderTasks(tasks: readonly ScheduledTask[]): ScheduledTask[] {
  return [...tasks].sort((a, b) =>
    a.enabled !== b.enabled ? (a.enabled ? -1 : 1)
      : a.enabled ? a.nextRunAt - b.nextRunAt || a.name.localeCompare(b.name)
        : a.name.localeCompare(b.name))
}

/** Unfinished runs (answers needed first) and retained finished runs, newest first. */
export function partitionRuns(runs: readonly ScheduledRun[]): { active: ScheduledRun[]; finished: ScheduledRun[] } {
  const newest = [...runs].sort((a, b) => b.startedAt - a.startedAt)
  const active = newest.filter(isActiveScheduledRun)
  return {
    active: [...active.filter(run => run.status === 'waiting'), ...active.filter(run => run.status !== 'waiting')],
    finished: newest.filter(run => !isActiveScheduledRun(run)),
  }
}

export function runStatusPresentation(run: ScheduledRun): { label: string; tone: Tone | 'neutral' } {
  switch (run.status) {
    case 'starting':
    case 'submitted': return { label: 'Starting', tone: 'neutral' }
    case 'running': return { label: 'Running', tone: 'info' }
    case 'waiting': return { label: 'Needs answer', tone: 'warn' }
    // A finished turn, not proof the requested work succeeded.
    case 'completed': return { label: 'Turn completed', tone: 'good' }
    case 'failed': return { label: 'Failed', tone: 'danger' }
    // Closed before finishing; reviewing the chat is optional, so no alarm tone.
    case 'interrupted': return { label: 'Interrupted', tone: 'neutral' }
  }
}

/**
 * Orders responses from the pull API. A poll issued before a command can
 * resolve after it; only a response issued later than the last applied one
 * may replace the snapshot.
 */
export function createResponseOrder(): { issue(): number; accept(id: number): boolean } {
  let issued = 0
  let applied = 0
  return {
    issue: () => ++issued,
    accept: id => {
      if (id <= applied) return false
      applied = id
      return true
    },
  }
}

/** What the main pane shows; a draft takes precedence over this. */
export type ScheduledSelection = { kind: 'task'; id: string } | { kind: 'history' } | { kind: 'preset' } | null

let storedDraft: ScheduledTaskDraft | null = null
let storedSelection: ScheduledSelection = null

/** Pages unmount when another tab is selected; an open draft survives that, not reload. */
export function readStoredScheduledTaskDraft(): ScheduledTaskDraft | null {
  return storedDraft
}

export function storeScheduledTaskDraft(draft: ScheduledTaskDraft | null): void {
  storedDraft = draft
}

export function readStoredScheduledSelection(): ScheduledSelection {
  return storedSelection
}

export function storeScheduledSelection(selection: ScheduledSelection): void {
  storedSelection = selection
}
