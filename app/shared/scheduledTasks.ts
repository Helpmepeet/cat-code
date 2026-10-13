export type TaskSchedule =
  | { kind: 'daily' | 'weekdays' | 'weekly'; time: string; timeZone: string; day: number }
  | { kind: 'interval'; minutes: number }

export type ScheduledTaskInput = {
  id?: string
  name: string
  prompt: string
  schedule: TaskSchedule
  enabled: boolean
  workspaceSessionId?: string
  cwdToken?: string
  model: string
  permissionMode: 'default' | 'auto'
  effort: 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

export type ScheduledTask = Omit<ScheduledTaskInput, 'id' | 'workspaceSessionId' | 'cwdToken'> & {
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
  | { type: 'workspace-maps'; workspaceSessionId: string }

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'] as const
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}
export function validTaskSchedule(value: unknown): value is TaskSchedule {
  if (!object(value)) return false
  if (value.kind === 'interval') return keys(value, ['kind', 'minutes']) && typeof value.minutes === 'number' && Number.isInteger(value.minutes) && value.minutes >= 1 && value.minutes <= 10080
  if (!keys(value, ['kind', 'time', 'timeZone', 'day']) || !['daily', 'weekdays', 'weekly'].includes(String(value.kind)) ||
      typeof value.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time) ||
      typeof value.day !== 'number' || !Number.isInteger(value.day) || value.day < 0 || value.day > 6 ||
      typeof value.timeZone !== 'string' || value.timeZone.length > 80) return false
  try { new Intl.DateTimeFormat('en', { timeZone: value.timeZone }).format(); return true } catch { return false }
}
export function parseScheduledTaskCommand(value: unknown): ScheduledTaskCommand | null {
  if (!object(value)) return null
  if (value.type === 'workspace-maps') return keys(value, ['type', 'workspaceSessionId']) && typeof value.workspaceSessionId === 'string' && UUID.test(value.workspaceSessionId) ? value as ScheduledTaskCommand : null
  if (['pause', 'resume', 'delete', 'run'].includes(String(value.type))) return keys(value, ['type', 'id']) && typeof value.id === 'string' && UUID.test(value.id) ? value as ScheduledTaskCommand : null
  if (value.type !== 'save' || !keys(value, ['type', 'task']) || !object(value.task)) return null
  const task = value.task
  if (!keys(task, ['id', 'name', 'prompt', 'schedule', 'enabled', 'workspaceSessionId', 'cwdToken', 'model', 'effort', 'permissionMode']) ||
      typeof task.name !== 'string' || !task.name.trim() || task.name.length > 120 ||
      typeof task.prompt !== 'string' || !task.prompt.trim() || new TextEncoder().encode(task.prompt).length > 64 * 1024 ||
      typeof task.enabled !== 'boolean' || !validTaskSchedule(task.schedule) ||
      typeof task.model !== 'string' || task.model.length > 100 || (task.model !== '' && !/^[a-zA-Z0-9._:/-]+$/.test(task.model)) ||
      !['default', 'auto'].includes(String(task.permissionMode)) ||
      !EFFORTS.includes(task.effort as typeof EFFORTS[number]) ||
      (task.id !== undefined && (typeof task.id !== 'string' || !UUID.test(task.id))) ||
      (task.workspaceSessionId !== undefined && (typeof task.workspaceSessionId !== 'string' || !UUID.test(task.workspaceSessionId))) ||
      (task.cwdToken !== undefined && (typeof task.cwdToken !== 'string' || task.cwdToken.length > 200)) ||
      (task.workspaceSessionId !== undefined && task.cwdToken !== undefined)) return null
  return value as ScheduledTaskCommand
}

export function isActiveScheduledRun(run: ScheduledRun): boolean {
  return ['starting', 'submitted', 'running', 'waiting'].includes(run.status)
}
