import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { ScheduledTaskOptions } from '../shared/scheduledTasks.js'
import { SCHEDULED_OPTIONS_CACHE_MS, type ScheduledTaskOptionsResult } from '../shared/scheduledTaskOptions.js'
import { supportsWorkspaceMapSchedule } from './workspaceMapSchedule.js'
import type { DesktopProject } from '../shared/projects.js'

export class ScheduledTaskOptionsService {
  private readonly handles = new Map<string, string>()
  private readonly paths = new Map<string, string>()
  private pending: Promise<ScheduledTaskOptions> | null = null
  private cached: ScheduledTaskOptions | null = null
  private lastResult: ScheduledTaskOptions | null = null
  private retryAt = 0
  private expiresAt = 0
  private generation = 0
  constructor(private readonly readCatalog: () => Promise<ScheduledTaskOptionsResult>,
    private readonly validate: (path: string) => { ok: true; realpath: string } | { ok: false },
    private readonly now: () => number = Date.now,
    private readonly storedProjects: () => readonly DesktopProject[] = () => []) {}

  read(request?: { refresh: true }): Promise<ScheduledTaskOptions> {
    if (this.pending) return this.pending
    const now = this.now()
    if (!request?.refresh && now < this.retryAt && this.lastResult) return Promise.resolve(this.lastResult)
    if (!request?.refresh && !this.lastResult?.error && this.cached && now < this.expiresAt) return Promise.resolve(this.cached)
    const pending = this.load().finally(() => { if (this.pending === pending) this.pending = null })
    this.pending = pending
    return pending
  }

  resolve(workspaceId: string): string | undefined {
    const path = this.handles.get(workspaceId)
    if (!path) return undefined
    const checked = this.validate(path)
    // Refuse a replaced directory/symlink that would redirect an existing handle.
    return checked.ok && checked.realpath === path ? checked.realpath : undefined
  }

  invalidate(): void {
    this.generation++
    this.expiresAt = 0
    this.retryAt = 0
  }

  private async load(): Promise<ScheduledTaskOptions> {
    const generation = this.generation
    try {
      const catalog = await this.readCatalog()
      if (generation !== this.generation) throw new Error('Scheduled task choices changed during the read')
      const projects: ScheduledTaskOptions['projects'] = []
      const seen = new Set<string>()
      const stored = new Map(this.storedProjects().map(project => [project.cwd, project]))
      for (const path of [...stored.keys(), ...catalog.projectPaths]) {
        const checked = this.validate(path)
        if (!checked.ok || (stored.has(path) && checked.realpath !== path) || seen.has(checked.realpath)) continue
        seen.add(checked.realpath)
        let workspaceId = this.paths.get(checked.realpath)
        if (!workspaceId) {
          if (this.paths.size >= 4096) throw new Error('Project handle limit reached')
          workspaceId = randomUUID()
          this.paths.set(checked.realpath, workspaceId)
          this.handles.set(workspaceId, checked.realpath)
        }
        projects.push({
          workspaceId,
          cwd: checked.realpath,
          label: stored.get(checked.realpath)?.name ?? (basename(checked.realpath) || checked.realpath),
          supportsWorkspaceMaps: supportsWorkspaceMapSchedule(checked.realpath),
        })
      }
      this.cached = { models: catalog.models, defaultEffortOptions: catalog.defaultEffortOptions, projects, updatedAt: this.now() }
      this.expiresAt = this.now() + SCHEDULED_OPTIONS_CACHE_MS
      this.retryAt = 0
      this.lastResult = this.cached
      return this.cached
    } catch {
      this.retryAt = generation === this.generation ? this.now() + 30_000 : 0
      this.lastResult = { ...(this.cached ?? { models: [], defaultEffortOptions: [], projects: [] }), error: 'Scheduled task options could not be read. Try again.' }
      return this.lastResult
    }
  }
}
