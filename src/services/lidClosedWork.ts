import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { TaskState } from '../tasks/types.js'
import { setPreventSleepSuppressed } from './preventSleep.js'
import type { LidWorkRun, LidWorkWindow } from '../../app/shared/lidClosed.js'
type Root = { startedAt: number; active: boolean; providers: Set<string>; approvals: Map<string, string> }
type TaskOrigin = { root: string; execution: string; finite: boolean }
const execution = new AsyncLocalStorage<string>()
let owner: LidWorkRuntime | undefined

// This state is process-local. Transcripts and restored task rows cannot enroll
// work or preserve an availability instruction after an engine restart.
export class LidWorkRuntime {
  private roots = new Map<string, Root>()
  private tasks = new Map<string, TaskOrigin>()
  private shellTools = new Map<string, { root: string; finite: boolean }>()
  private permissionRoots = new Map<string, string>()
  private enrolled = new Set<string>()
  private blocked = new Set<string>()
  private window: LidWorkWindow | undefined
  private freshUntil = 0
  private expiredIdentity: string | undefined
  private timer: ReturnType<typeof setInterval>
  private overflow = false

  constructor(private readonly readTasks: () => Record<string, TaskState>) {
    this.timer = setInterval(() => this.expire(), 250)
    this.timer.unref()
  }
  async run<T>(action: () => Promise<T>): Promise<T> {
    // A fresh user turn after the window ends restores ordinary idle policy.
    // It does not unblock or re-enroll any earlier protected run.
    this.expire()
    if (!this.window?.active) setPreventSleepSuppressed(false)
    const id = randomUUID()
    this.prune()
    if (this.roots.size >= 256) { this.overflow = true; return execution.run(id, action) }
    this.roots.set(id, { startedAt: Date.now(), active: true, providers: new Set(), approvals: new Map() })
    try { return await execution.run(id, action) }
    finally { const root = this.roots.get(id); if (root) root.active = false }
  }
  shell(toolId: string | undefined, finite: boolean): void {
    const root = execution.getStore()
    if (this.shellTools.size >= 4096) { this.overflow = true; return }
    if (toolId && root && this.roots.has(root)) this.shellTools.set(toolId, { root, finite })
  }
  task(task: TaskState): void {
    const shell = task.toolUseId ? this.shellTools.get(task.toolUseId) : undefined
    const root = shell?.root ?? execution.getStore()
    if (!root || !this.roots.has(root)) return
    const token = 'runId' in task ? String(task.runId ?? task.startTime) : String(task.startTime)
    const previous = this.tasks.get(task.id)
    if (previous?.execution === token) return
    if (this.tasks.size >= 4096) { this.overflow = true; return }
    const finite = task.type === 'local_agent' && !!task.toolUseId || task.type === 'remote_agent' ||
      task.type === 'local_bash' && task.kind !== 'monitor' && shell?.finite === true
    this.tasks.set(task.id, { root, execution: token, finite })
  }
  approval(id: string, pending: boolean, actor = 'main'): void {
    const rootId = pending ? execution.getStore() : this.permissionRoots.get(id)
    const root = this.roots.get(rootId ?? '')
    if (!root) return
    if (pending) { root.approvals.set(id, actor); this.permissionRoots.set(id, rootId!) }
    else { root.approvals.delete(id); this.permissionRoots.delete(id) }
  }
  progress(providerBlocked: boolean, parentToolUseId?: string | null): void {
    const root = this.roots.get(execution.getStore() ?? '')
    if (!root) return
    const task = Object.values(this.readTasks()).find(task => parentToolUseId && task.toolUseId === parentToolUseId)
    const actor = task && 'agentId' in task ? String(task.agentId) : 'main'
    if (providerBlocked) root.providers.add(actor)
    else root.providers.delete(actor)
  }
  snapshot(): { available: boolean; runs: LidWorkRun[] } {
    this.expire()
    const tasks = this.readTasks()
    return { available: !this.overflow, runs: [...this.roots].map(([id, root]) => {
      const children = [...this.tasks].flatMap(([taskId, origin]) => {
        const task = tasks[taskId]
        if (origin.root !== id || !origin.finite || !task) return []
        return [{ id: taskId, label: task.description.slice(0, 160), status: task.status }]
      })
      const active = children.filter(task => task.status === 'running' || task.status === 'pending')
      const foregroundChild = active.some(child => {
        const task = tasks[child.id]
        return task?.type === 'local_agent' && !task.isBackgrounded
      })
      const actors = active.map(child => {
        const task = tasks[child.id]
        return task && 'agentId' in task && task.type !== 'local_bash' ? String(task.agentId) : `shell:${child.id}`
      })
      if (root.active && !foregroundChild) actors.push('main')
      const waiting = new Set(root.approvals.values())
      const status = actors.length === 0 ? 'completed' : actors.every(actor => waiting.has(actor)) ? 'approval' :
        actors.every(actor => waiting.has(actor) || root.providers.has(actor)) ? 'provider' : 'running'
      return { id, startedAt: root.startedAt, activeTurn: root.active, status, children }
    }) }
  }
  update(window: LidWorkWindow): void {
    if (window.active && window.identity === this.expiredIdentity) throw new Error('Work supervision expired')
    const freshActivation = window.active && window.identity !== this.window?.identity
    this.window = window
    this.freshUntil = performance.now() + 2500
    for (const id of window.roots) {
      if (window.active) this.enrolled.add(id)
      if (freshActivation) this.blocked.delete(id)
      if (window.block) this.blocked.add(id)
    }
    setPreventSleepSuppressed(window.suppressIdleSleep)
  }
  context(): string | undefined {
    this.expire()
    const id = execution.getStore()
    if (!id || !this.enrolled.has(id)) return undefined
    if (!this.window?.active || Date.now() >= this.window.deadline || !this.window.roots.includes(id)) {
      return 'The temporary work window has ended. Its availability instruction no longer applies. Follow the current user instructions and existing permissions.'
    }
    return 'The user may be unavailable during this work window. Continue within the existing instructions and permissions. Leave optional questions for the final summary. If required information or approval is missing, preserve progress and report the blocker.'
  }
  assertAdmission(): void {
    this.expire()
    if (this.blocked.has(execution.getStore() ?? '')) throw new Error('Lid-closed work ended. Resume with a new user action.')
  }
  dispose(): void {
    clearInterval(this.timer)
    if (owner === this) owner = undefined
  }
  private expire(): void {
    if (!this.window?.active || performance.now() < this.freshUntil && Date.now() < this.window.deadline) return
    this.expiredIdentity = this.window.identity
    // Once supervision is stale, the last lid reading may predate closure.
    // Fail closed for enrolled admissions until an explicit fresh activation.
    for (const id of this.window.roots) this.blocked.add(id)
    this.window = { ...this.window, active: false }
    setPreventSleepSuppressed(true)
  }
  private prune(): void {
    const liveTasks = this.readTasks()
    for (const [id, task] of this.tasks) if (!liveTasks[id] || !['running', 'pending'].includes(liveTasks[id]!.status)) this.tasks.delete(id)
    if (this.roots.size < 128) return
    for (const [id, root] of this.roots) {
      if (root.active || [...this.tasks.values()].some(task => task.root === id)) continue
      this.roots.delete(id); this.enrolled.delete(id); this.blocked.delete(id)
      for (const [toolId, tool] of this.shellTools) if (tool.root === id) this.shellTools.delete(toolId)
    }
  }
}

export function installLidWorkRuntime(readTasks: () => Record<string, TaskState>): LidWorkRuntime {
  if (owner) throw new Error('Lid work owner already installed')
  owner = new LidWorkRuntime(readTasks)
  return owner
}
export function withLidWorkRun<T>(action: () => Promise<T>): Promise<T> { return owner ? owner.run(action) : action() }
export function registerLidWorkTask(task: TaskState): void { owner?.task(task) }
export function registerLidShellTool(toolId: string | undefined, finite: boolean): void { owner?.shell(toolId, finite) }
export function noteLidWorkApproval(id: string, pending: boolean, actor?: string): void { owner?.approval(id, pending, actor) }
export function noteLidWorkProgress(providerBlocked: boolean, parentToolUseId?: string | null): void { owner?.progress(providerBlocked, parentToolUseId) }
export function lidWorkContext(): string | undefined { return owner?.context() }
export function assertLidWorkAdmission(): void { owner?.assertAdmission() }
