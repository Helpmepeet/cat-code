import type { RunControlProvider } from './protocol.js'

export type ScheduledModelOption = { value: string; label: string; provider: RunControlProvider; effortOptions: readonly string[] }
export type ScheduledProjectOption = { workspaceId: string; cwd: string; label: string; supportsWorkspaceMaps?: boolean }
export type ScheduledTaskOptions = { models: ScheduledModelOption[]; defaultEffortOptions: string[]; projects: ScheduledProjectOption[]; updatedAt?: number; error?: string }

export type TaskSchedule =
  | { kind: 'daily' | 'weekdays' | 'weekly'; time: string; timeZone: string; day: number }
  | { kind: 'interval'; minutes: number }

export type ScheduledTaskInput = {
  id?: string
  name: string
  prompt: string
  schedule: TaskSchedule
  enabled: boolean
  workspaceId?: string
  cwdToken?: string
  model: string
  permissionMode: 'default' | 'auto'
  effort: 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
}

export type ScheduledTask = Omit<ScheduledTaskInput, 'id' | 'workspaceId' | 'cwdToken'> & {
  id: string
  cwd: string
  createdAt: number
  nextRunAt: number
}

export type ScheduledRunStatus = 'starting' | 'submitted' | 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted'
export type ScheduledRun = {
  id: string
  taskId: string
  taskName: string
  appSessionId: string
  scheduledAt: number
  startedAt: number
  endedAt: number | null
  status: ScheduledRunStatus
  summary: string
}
export type ScheduledTasksSnapshot = { tasks: ScheduledTask[]; runs: ScheduledRun[]; error?: string }
export type ScheduledTasksResult = { ok: true; snapshot: ScheduledTasksSnapshot } | { ok: false; error: string }
export type ScheduledTaskCommand =
  | { type: 'save'; task: ScheduledTaskInput }
  | { type: 'pause' | 'resume' | 'delete' | 'run'; id: string }
  | { type: 'workspace-maps'; workspaceId: string; cwdToken?: never }
  | { type: 'workspace-maps'; cwdToken: string; workspaceId?: never }

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}
export function validTaskSchedule(value: unknown): value is TaskSchedule {
  if (!object(value)) return false
  if (value.kind === 'interval') return keys(value, ['kind', 'minutes']) && typeof value.minutes === 'number' && Number.isInteger(value.minutes) && value.minutes >= 1 && value.minutes <= 10080
  if (!keys(value, ['kind', 'time', 'timeZone', 'day']) || typeof value.kind !== 'string' || !['daily', 'weekdays', 'weekly'].includes(value.kind) ||
      typeof value.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time) ||
      typeof value.day !== 'number' || !Number.isInteger(value.day) || value.day < 0 || value.day > 6 ||
      typeof value.timeZone !== 'string' || value.timeZone.length > 80) return false
  try { new Intl.DateTimeFormat('en', { timeZone: value.timeZone }).format(); return true } catch { return false }
}
export function parseScheduledTaskCommand(value: unknown): ScheduledTaskCommand | null {
  if (!object(value)) return null
  if (value.type === 'workspace-maps') return keys(value, ['type', 'workspaceId', 'cwdToken']) && validProjectSource(value, true) ? value as ScheduledTaskCommand : null
  if (typeof value.type === 'string' && ['pause', 'resume', 'delete', 'run'].includes(value.type)) return keys(value, ['type', 'id']) && typeof value.id === 'string' && UUID.test(value.id) ? value as ScheduledTaskCommand : null
  if (value.type !== 'save' || !keys(value, ['type', 'task']) || !object(value.task)) return null
  const task = value.task
  if (!keys(task, ['id', 'name', 'prompt', 'schedule', 'enabled', 'workspaceId', 'cwdToken', 'model', 'effort', 'permissionMode']) ||
      typeof task.name !== 'string' || !task.name.trim() || task.name.length > 120 ||
      typeof task.prompt !== 'string' || !task.prompt.trim() || new TextEncoder().encode(task.prompt).length > 64 * 1024 ||
      typeof task.enabled !== 'boolean' || !validTaskSchedule(task.schedule) ||
      typeof task.model !== 'string' || task.model.length > 100 || (task.model !== '' && !/^[a-zA-Z0-9._:/[\]-]+$/.test(task.model)) ||
      typeof task.permissionMode !== 'string' || !['default', 'auto'].includes(task.permissionMode) ||
      !EFFORTS.includes(task.effort as typeof EFFORTS[number]) ||
      (task.id !== undefined && (typeof task.id !== 'string' || !UUID.test(task.id))) ||
      !validProjectSource(task, task.id === undefined)) return null
  return value as ScheduledTaskCommand
}

function validProjectSource(value: Record<string, unknown>, required: boolean): boolean {
  const hasWorkspace = Object.hasOwn(value, 'workspaceId')
  const hasToken = Object.hasOwn(value, 'cwdToken')
  if (hasWorkspace && hasToken || required && !hasWorkspace && !hasToken) return false
  return (!hasWorkspace || typeof value.workspaceId === 'string' && UUID.test(value.workspaceId)) &&
    (!hasToken || typeof value.cwdToken === 'string' && value.cwdToken.trim().length > 0 && value.cwdToken.length <= 200)
}

export function isActiveScheduledRun(run: ScheduledRun): boolean {
  return ['starting', 'submitted', 'running', 'waiting'].includes(run.status)
}

/** Uses the saved zone rather than the machine's current zone. Repeated DST minutes fire once; missing minutes are skipped. */
export function nextTaskOccurrence(schedule: TaskSchedule, after: number, claimedAt?: number): number {
  if (schedule.kind === 'interval') return after + schedule.minutes * 60_000
  const format = new Intl.DateTimeFormat('en-GB', { timeZone: schedule.timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' })
  const afterParts = format.formatToParts(after)
  const localDate = (parts: Intl.DateTimeFormatPart[]) => ['year', 'month', 'day'].map(type => parts.find(entry => entry.type === type)?.value).join('-')
  const lastMinute = ['hour', 'minute'].map(type => afterParts.find(entry => entry.type === type)?.value).join(':')
  const skipDate = lastMinute >= schedule.time ? localDate(afterParts) : null
  const claimedDate = claimedAt === undefined ? null : localDate(format.formatToParts(claimedAt))
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  // Two weeks covers a weekly occurrence skipped by a daylight-saving transition.
  for (let time = Math.floor(after / 60_000) * 60_000 + 60_000; time <= after + 15 * 86400_000; time += 60_000) {
    const parts = format.formatToParts(time)
    const part = (type: string) => parts.find(entry => entry.type === type)?.value
    if (`${part('hour')}:${part('minute')}` !== schedule.time || localDate(parts) === skipDate || localDate(parts) === claimedDate) continue
    const day = days.indexOf(part('weekday') ?? '')
    if (schedule.kind === 'daily' || (schedule.kind === 'weekdays' && day >= 1 && day <= 5) || (schedule.kind === 'weekly' && day === schedule.day)) return time
  }
  throw new Error('The next scheduled time could not be calculated')
}
