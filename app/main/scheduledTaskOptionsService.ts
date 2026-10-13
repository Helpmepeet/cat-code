import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { ScheduledTaskOptions } from '../shared/scheduledTasks.js'
import type { ScheduledTaskOptionsResult } from '../shared/scheduledTaskOptions.js'

export class ScheduledTaskOptionsService {
  private readonly handles = new Map<string, string>()
  private readonly paths = new Map<string, string>()
  private pending: Promise<ScheduledTaskOptions> | null = null
  constructor(private readonly readCatalog: () => Promise<ScheduledTaskOptionsResult>,
    private readonly validate: (path: string) => { ok: true; realpath: string } | { ok: false }) {}

  read(): Promise<ScheduledTaskOptions> {
    if (this.pending) return this.pending
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

  private async load(): Promise<ScheduledTaskOptions> {
    try {
      const catalog = await this.readCatalog()
      const projects: ScheduledTaskOptions['projects'] = []
      const seen = new Set<string>()
      for (const path of catalog.projectPaths) {
        const checked = this.validate(path)
        if (!checked.ok || seen.has(checked.realpath)) continue
        seen.add(checked.realpath)
        let workspaceId = this.paths.get(checked.realpath)
        if (!workspaceId) {
          if (this.paths.size >= 4096) throw new Error('Project handle limit reached')
          workspaceId = randomUUID()
          this.paths.set(checked.realpath, workspaceId)
          this.handles.set(workspaceId, checked.realpath)
        }
        projects.push({ workspaceId, cwd: checked.realpath, label: basename(checked.realpath) || checked.realpath })
      }
      return { models: catalog.models, defaultEffortOptions: catalog.defaultEffortOptions, projects }
    } catch {
      return { models: [], defaultEffortOptions: [], projects: [], error: 'Scheduled task options could not be read. Try again.' }
    }
  }
}
