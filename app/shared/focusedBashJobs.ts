/** Additive tasks.snapshot metadata. See decisions/FOCUSED-LIVE-ACTIVITY.md. */
export type FocusedBashJob = {
  id: string
  toolUseId?: string
  label: string
  status: 'running' | 'completed' | 'failed' | 'killed'
  startTime: number
  endTime?: number
}

export const MAX_FOCUSED_BASH_JOBS = 64
export const MAX_FOCUSED_BASH_LABEL_CHARS = 500

export function isFocusedBashJobs(value: unknown): value is FocusedBashJob[] {
  if (!Array.isArray(value) || value.length > MAX_FOCUSED_BASH_JOBS) return false
  const time = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
  return value.every(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    const job = item as Record<string, unknown>
    return Object.keys(job).every(key => ['id', 'toolUseId', 'label', 'status', 'startTime', 'endTime'].includes(key)) &&
      typeof job.id === 'string' && job.id.length > 0 && job.id.length <= 200 &&
      (job.toolUseId === undefined || (typeof job.toolUseId === 'string' && job.toolUseId.length > 0 && job.toolUseId.length <= 200)) &&
      typeof job.label === 'string' && job.label.length <= MAX_FOCUSED_BASH_LABEL_CHARS &&
      ['running', 'completed', 'failed', 'killed'].includes(job.status as string) && time(job.startTime) &&
      (job.status === 'running' ? job.endTime === undefined : time(job.endTime) && (job.endTime as number) >= (job.startTime as number))
  })
}
