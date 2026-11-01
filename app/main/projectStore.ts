import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { isProjectDraftId, isProjectName, type DesktopProject } from '../shared/projects.js'

export type ProjectStoreDeps = {
  acquireLock?: (path: string) => Promise<() => Promise<void>>
  now?: () => number
  fsync?: typeof fsyncSync
  rename?: typeof renameSync
  onWarning?: (project: DesktopProject, warning: string, cause: unknown) => void
  onCleanupError?: (error: unknown, primaryError: unknown) => void
}
export class ProjectCommitUncertainError extends Error {
  constructor(public readonly project: DesktopProject, cause: unknown) {
    super('Project saving could not be confirmed. Check the project list before trying again.', { cause })
  }
}
export class DuplicateProjectError extends Error {
  constructor(public readonly project: { cwd: string; name: string }) { super(`This folder already belongs to project "${project.name}".`) }
}

/** Every mutation reads the latest document under the same cross-process lock. */
export class ProjectStore {
  readonly path: string
  constructor(private readonly directory: string, private readonly deps: ProjectStoreDeps = {}) {
    this.path = join(directory, 'projects.json')
  }
  list(): DesktopProject[] {
    let text: string
    try { text = readFileSync(this.path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const doc = JSON.parse(text)
    if (!doc || doc.version !== 1 || Object.keys(doc).sort().join(',') !== 'projects,version' || !Array.isArray(doc.projects)) throw new Error('Unreadable projects file')
    const ids = new Set<string>(), paths = new Set<string>()
    for (const row of doc.projects) {
      if (!row || Object.keys(row).sort().join(',') !== 'createdAt,cwd,id,name' || !isProjectDraftId(row.id) || !isProjectName(row.name) || row.name !== row.name.trim() || typeof row.cwd !== 'string' || !isAbsolute(row.cwd) || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0 || ids.has(row.id) || paths.has(row.cwd)) throw new Error('Unreadable projects file')
      ids.add(row.id); paths.add(row.cwd)
    }
    return doc.projects
  }
  get(id: string): DesktopProject | undefined { return this.list().find(row => row.id === id) }
  async create(input: { cwd: string; name: string }, legacyKnown: () => readonly { cwd: string; name: string }[] = () => [], isActive: () => boolean = () => true, beforeSave?: () => Promise<void>): Promise<DesktopProject> {
    if (!isProjectName(input.name) || !isAbsolute(input.cwd) || realpathSync(input.cwd).normalize('NFC') !== input.cwd) throw new Error('Invalid project folder or name')
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const release = await (this.deps.acquireLock ?? acquireLock)(this.path)
    let committed: DesktopProject | undefined
    let primaryError: unknown
    let hasPrimaryError = false
    try {
      if (!isActive()) throw new Error('Project draft cancelled')
      if (realpathSync(input.cwd).normalize('NFC') !== input.cwd || !statSync(input.cwd).isDirectory()) throw new Error('Project folder changed')
      const projects = this.list()
      const duplicate = projects.find(row => row.cwd === input.cwd) ?? legacyKnown().find(row => {
        if (row.cwd === input.cwd) return true
        try { return realpathSync(row.cwd).normalize('NFC') === input.cwd } catch (error) {
          if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
          throw error
        }
      })
      if (duplicate) throw new DuplicateProjectError(duplicate)
      // Trust must succeed before the project becomes visible. Check duplicates
      // first so a rejected creation cannot grant trust as a side effect.
      if (beforeSave) {
        await beforeSave()
        if (!isActive() || realpathSync(input.cwd).normalize('NFC') !== input.cwd || !statSync(input.cwd).isDirectory()) throw new Error('Project folder changed or draft cancelled')
      }
      const project: DesktopProject = { id: randomUUID(), name: input.name.trim(), cwd: input.cwd, createdAt: (this.deps.now ?? Date.now)() }
      const temporary = `${this.path}.${randomUUID()}.tmp`
      try {
        const fd = openSync(temporary, 'wx', 0o600)
        try { writeFileSync(fd, JSON.stringify({ version: 1, projects: [...projects, project] }) + '\n'); (this.deps.fsync ?? fsyncSync)(fd) } finally { closeSync(fd) }
        ;(this.deps.rename ?? renameSync)(temporary, this.path)
        // Windows does not support opening directory handles this way. The
        // file is already flushed; POSIX also makes the rename durable here.
        if (process.platform !== 'win32') {
          const directoryFd = openSync(this.directory, 'r')
          try { (this.deps.fsync ?? fsyncSync)(directoryFd) } finally { closeSync(directoryFd) }
        }
        committed = project
      } catch (error) {
        // Reconcile the exact generated identity under the lock, including
        // rename implementations that performed the rename before throwing.
        let visible: DesktopProject | undefined
        try { visible = this.get(project.id) } catch { throw new ProjectCommitUncertainError(project, error) }
        if (!visible || JSON.stringify(visible) !== JSON.stringify(project)) throw error
        committed = project
        this.warn(project, 'The project was saved, but its durability could not be confirmed. Check the project list before making further changes.', error)
      } finally {
        try { unlinkSync(temporary) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.warn(project, 'The project save left a temporary file that could not be removed.', error)
        }
      }
      return project
    } catch (error) {
      primaryError = error
      hasPrimaryError = true
      throw error
    } finally {
      try { await release() } catch (error) {
        if (committed) this.warn(committed, 'The project was saved, but its save lock could not be released. Further changes may be temporarily unavailable.', error)
        else if (!hasPrimaryError) throw error
        else {
          // Retain the primary exception and the secondary cleanup evidence.
          if (primaryError instanceof Error && Object.isExtensible(primaryError)) {
            try { Object.defineProperty(primaryError, 'cleanupError', { value: error, configurable: true }) } catch { /* The original error can have a read-only cleanup property. */ }
          }
          try { this.deps.onCleanupError?.(error, primaryError) } catch { /* Preserve the primary failure. */ }
        }
      }
    }
  }
  private warnings = new Map<string, string>()
  takeWarning(id: string): string | undefined {
    const warning = this.warnings.get(id)
    this.warnings.delete(id)
    return warning
  }
  private warn(project: DesktopProject, warning: string, cause: unknown): void {
    this.warnings.set(project.id, [this.warnings.get(project.id), warning].filter(Boolean).join(' '))
    try { this.deps.onWarning?.(project, warning, cause) } catch { /* Diagnostics cannot replace the save outcome. */ }
  }
}
async function acquireLock(path: string): Promise<() => Promise<void>> {
  const lockfile = require('proper-lockfile') as { lock: (path: string, options: unknown) => Promise<() => Promise<void>> }
  return lockfile.lock(path, { realpath: false, stale: 20_000, retries: { retries: 10, factor: 1.5, minTimeout: 50, maxTimeout: 500, randomize: true } })
}
