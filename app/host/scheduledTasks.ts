import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { isActiveScheduledRun, parseScheduledTaskCommand, type ScheduledTask, type ScheduledTaskInput, type ScheduledRun, type ScheduledTasksSnapshot, type TaskSchedule } from '../shared/scheduledTasks.js'
import type { ServerFrame } from '../shared/protocol.js'

const MAX_RUNS = 200
type Document = ScheduledTasksSnapshot & { version: 1 }
export type ScheduledTasksPorts = {
  launch(task: ScheduledTask, appSessionId: string): Promise<void>
  submit(appSessionId: string, prompt: string, submitId: string): boolean
}

/** Uses the saved zone rather than the machine's current zone. Repeated DST minutes fire once; missing minutes are skipped. */
export function nextTaskOccurrence(schedule: TaskSchedule, after: number): number {
  if (schedule.kind === 'interval') return after + schedule.minutes * 60_000
  const format = new Intl.DateTimeFormat('en-GB', { timeZone: schedule.timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' })
  const afterParts = format.formatToParts(after)
  const localDate = (parts: Intl.DateTimeFormatPart[]) => ['year', 'month', 'day'].map(type => parts.find(entry => entry.type === type)?.value).join('-')
  const lastMinute = ['hour', 'minute'].map(type => afterParts.find(entry => entry.type === type)?.value).join(':')
  const skipDate = lastMinute >= schedule.time ? localDate(afterParts) : null
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  // Two weeks covers a weekly occurrence skipped by a daylight-saving transition.
  for (let time = Math.floor(after / 60_000) * 60_000 + 60_000; time <= after + 15 * 86400_000; time += 60_000) {
    const parts = format.formatToParts(time)
    const part = (type: string) => parts.find(entry => entry.type === type)?.value
    if (`${part('hour')}:${part('minute')}` !== schedule.time || localDate(parts) === skipDate) continue
    const day = days.indexOf(part('weekday') ?? '')
    if (schedule.kind === 'daily' || (schedule.kind === 'weekdays' && day >= 1 && day <= 5) || (schedule.kind === 'weekly' && day === schedule.day)) return time
  }
  throw new Error('The next scheduled time could not be calculated')
}

function load(file: string): Document {
  if (!existsSync(file)) return { version: 1, tasks: [], runs: [] }
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!value || typeof value !== 'object') throw new Error('Saved scheduled tasks could not be read')
  const doc = value as Document
  if (doc.version !== 1 || !Array.isArray(doc.tasks) || doc.tasks.length > 50 || !Array.isArray(doc.runs) || doc.runs.length > MAX_RUNS) throw new Error('Saved scheduled tasks could not be read')
  const ids = new Set<string>()
  for (const task of doc.tasks) {
    if (!task || typeof task.cwd !== 'string' || !isAbsolute(task.cwd) || !Number.isFinite(task.createdAt) || !Number.isFinite(task.nextRunAt) || ids.has(task.id) ||
        !parseScheduledTaskCommand({ type: 'save', task: { id: task.id, name: task.name, prompt: task.prompt, schedule: task.schedule, enabled: task.enabled, model: task.model, effort: task.effort, permissionMode: task.permissionMode } })) throw new Error('Saved scheduled tasks could not be read')
    ids.add(task.id)
  }
  for (const run of doc.runs) {
    if (!run || typeof run.id !== 'string' || typeof run.taskId !== 'string' || typeof run.appSessionId !== 'string' || typeof run.taskName !== 'string' ||
        !Number.isFinite(run.scheduledAt) || !Number.isFinite(run.startedAt) || (run.endedAt !== null && !Number.isFinite(run.endedAt)) ||
        !['starting', 'submitted', 'running', 'waiting', 'completed', 'failed', 'interrupted'].includes(run.status) || typeof run.summary !== 'string') throw new Error('Saved scheduled runs could not be read')
  }
  return doc
}

/** One owner in Electron's single-instance host. Persist the run claim before any engine side effect. */
export class ScheduledTasks {
  private doc: Document
  private timer: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private error: string | undefined
  private awaitingLaunch = new Set<string>()
  private results = new Map<string, { status: 'completed' | 'failed'; summary: string }>()
  constructor(private readonly file: string, private readonly ports: ScheduledTasksPorts) {
    this.doc = load(file)
    let recovered = false
    for (const run of this.doc.runs) if (isActiveScheduledRun(run)) {
      run.status = 'interrupted'; run.endedAt = Date.now(); run.summary = 'Cat Code closed before this run finished. Open its chat to review or continue.'; recovered = true
    }
    if (recovered) this.commit(this.doc)
  }
  snapshot(): ScheduledTasksSnapshot {
    return structuredClone({ tasks: this.doc.tasks, runs: this.doc.runs, ...(this.error ? { error: this.error } : {}) })
  }
  private commit(next: Document): void {
    if (this.error) throw new Error(this.error)
    const temp = `${this.file}.${randomUUID()}.tmp`
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const fd = openSync(temp, 'wx', 0o600)
      try { writeFileSync(fd, JSON.stringify(next, null, 2) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(temp, this.file)
      const dir = openSync(dirname(this.file), 'r')
      try { fsyncSync(dir) } finally { closeSync(dir) }
      this.doc = structuredClone(next)
    } catch {
      this.error = 'Scheduled tasks could not be saved. Scheduling has stopped; restart Cat Code after fixing storage.'
      throw new Error(this.error)
    } finally { try { unlinkSync(temp) } catch { /* Already published or never created. */ } }
  }
  save(input: ScheduledTaskInput, cwd: string, now = Date.now()): ScheduledTask {
    const next = structuredClone(this.doc)
    const previous = input.id ? next.tasks.find(task => task.id === input.id) : undefined
    if (input.id && !previous) throw new Error('This scheduled task no longer exists')
    if (!previous && next.tasks.length >= 50) throw new Error('Delete a scheduled task before adding another')
    const task: ScheduledTask = { id: previous?.id ?? randomUUID(), name: input.name.trim(), prompt: input.prompt.trim(), enabled: input.enabled,
      schedule: input.schedule, cwd, model: input.model, effort: input.effort, permissionMode: input.permissionMode, createdAt: previous?.createdAt ?? now,
      nextRunAt: previous && JSON.stringify(previous.schedule) === JSON.stringify(input.schedule) && previous.enabled === input.enabled ? previous.nextRunAt : nextTaskOccurrence(input.schedule, now) }
    next.tasks = [...next.tasks.filter(entry => entry.id !== task.id), task]
    this.commit(next)
    return task
  }
  change(type: 'pause' | 'resume' | 'delete', id: string, now = Date.now()): void {
    const next = structuredClone(this.doc)
    const task = next.tasks.find(entry => entry.id === id)
    if (!task) throw new Error('This scheduled task no longer exists')
    if (type === 'delete') next.tasks = next.tasks.filter(entry => entry.id !== id)
    else { task.enabled = type === 'resume'; if (task.enabled) task.nextRunAt = nextTaskOccurrence(task.schedule, now) }
    this.commit(next)
  }
  start(): void {
    this.stopped = false
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), 15_000)
    this.timer.unref?.()
    this.tick()
  }
  stop(): void { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = null }
  tick(now = Date.now()): void {
    if (this.stopped || this.error) return
    for (const task of [...this.doc.tasks]) {
      if (!task.enabled || task.nextRunAt > now || this.doc.runs.some(run => run.taskId === task.id && isActiveScheduledRun(run))) continue
      try { this.run(task.id, false, now) } catch { /* Storage failure freezes subsequent dispatches. */ }
    }
  }
  run(id: string, manual = true, now = Date.now()): void {
    if (this.stopped) throw new Error('Scheduled tasks are not running')
    const task = this.doc.tasks.find(entry => entry.id === id)
    if (!task) throw new Error('This scheduled task no longer exists')
    if (this.doc.runs.some(run => run.taskId === id && isActiveScheduledRun(run))) throw new Error('This task already has an unfinished run')
    const next = structuredClone(this.doc)
    const run: ScheduledRun = { id: randomUUID(), taskId: id, taskName: task.name, appSessionId: randomUUID(), scheduledAt: manual ? now : task.nextRunAt, startedAt: now, endedAt: null, status: 'starting', summary: '' }
    // A missed recurring occurrence is dispatched once, then moved forward.
    if (!manual) next.tasks.find(entry => entry.id === id)!.nextRunAt = nextTaskOccurrence(task.schedule, now)
    const allRuns = [run, ...next.runs]
    let remaining = MAX_RUNS - allRuns.filter(isActiveScheduledRun).length
    next.runs = allRuns.filter(entry => isActiveScheduledRun(entry) || remaining-- > 0)
    this.commit(next)
    this.awaitingLaunch.add(run.appSessionId)
    void this.ports.launch(task, run.appSessionId).then(() => {
      this.awaitingLaunch.delete(run.appSessionId)
      if (this.stopped) return
      this.ready(run.appSessionId, task.prompt)
    }).catch(error => {
      this.awaitingLaunch.delete(run.appSessionId)
      this.update(run.appSessionId, entry => { entry.status = 'failed'; entry.endedAt = Date.now(); entry.summary = error instanceof Error ? error.message.slice(0, 1200) : 'The scheduled chat could not start' })
    })
  }
  private update(sessionId: string, apply: (run: ScheduledRun) => void): void {
    if (this.error || this.stopped) return
    const next = structuredClone(this.doc)
    const run = next.runs.find(entry => entry.appSessionId === sessionId && isActiveScheduledRun(entry))
    if (!run) return
    apply(run)
    try { this.commit(next) } catch { /* Freeze without repeating uncertain work. */ }
  }
  private ready(sessionId: string, prompt: string): void {
    const run = this.doc.runs.find(entry => entry.appSessionId === sessionId && entry.status === 'starting')
    if (!run || this.stopped || this.error) return
    this.update(sessionId, entry => { entry.status = 'submitted' })
    if (this.error) return
    if (!this.ports.submit(sessionId, prompt, run.id)) this.update(sessionId, entry => { entry.status = 'failed'; entry.endedAt = Date.now(); entry.summary = 'The scheduled prompt could not be delivered. Open the chat to retry.' })
  }
  receive(sessionId: string, frame: ServerFrame): void {
    if (frame.kind === 'ready' && !this.awaitingLaunch.has(sessionId)) {
      const run = this.doc.runs.find(entry => entry.appSessionId === sessionId)
      const task = this.doc.tasks.find(entry => entry.id === run?.taskId)
      if (task) this.ready(sessionId, task.prompt)
    }
    if (frame.kind === 'submit.result' && !frame.accepted) this.update(sessionId, run => {
      if (run.id !== frame.submitId) return
      run.status = 'failed'; run.endedAt = Date.now(); run.summary = 'The scheduled prompt was refused. Open the chat to check workspace trust or permissions.'
    })
    if (frame.kind === 'lifecycle' || frame.kind === 'error' && frame.code === 'session_disconnected') {
      this.results.delete(sessionId)
      this.update(sessionId, run => { run.status = 'interrupted'; run.endedAt = Date.now(); run.summary = 'The scheduled chat disconnected before completion.' })
    }
    if (frame.kind !== 'event' || frame.replay) return
    const event = frame.event
    if (event.type === 'permission.requested') this.update(sessionId, run => { run.status = 'waiting'; run.summary = 'Open this chat to answer the pending request.' })
    if (event.type === 'permission.resolved' || event.type === 'turn.status' && event.activeTurn) this.update(sessionId, run => { run.status = 'running'; run.summary = '' })
    if (event.type === 'turn.status' && !event.activeTurn) {
      const result = this.results.get(sessionId)
      this.results.delete(sessionId)
      this.update(sessionId, run => {
        run.status = result?.status ?? 'failed'; run.summary = result?.summary ?? 'The turn ended without a result. Open its chat to review.'; run.endedAt = Date.now()
      })
    }
    if (event.type === 'message' && event.message.type === 'result') {
      const message = event.message
      if (this.doc.runs.some(run => run.appSessionId === sessionId && isActiveScheduledRun(run))) this.results.set(sessionId, {
        status: message.subtype === 'success' && !message.is_error ? 'completed' : 'failed',
        summary: message.subtype === 'success' ? (typeof message.result === 'string' ? message.result : 'The agent turn finished. Open its chat to review the result.').slice(0, 1200) : 'The run did not complete successfully. Open its chat for details.',
      })
    }
  }
}
