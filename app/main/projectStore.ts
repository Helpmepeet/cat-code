import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { isProjectDraftId, isProjectName, type DesktopProject } from '../shared/projects.js'

export type ProjectStoreDeps = {
  acquireLock?: (path: string) => Promise<() => Promise<void>>
  now?: () => number
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
  async create(input: { cwd: string; name: string }, legacyKnown: () => readonly { cwd: string; name: string }[] = () => [], isActive: () => boolean = () => true): Promise<DesktopProject> {
    if (!isProjectName(input.name) || !isAbsolute(input.cwd) || realpathSync(input.cwd).normalize('NFC') !== input.cwd) throw new Error('Invalid project folder or name')
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const release = await (this.deps.acquireLock ?? acquireLock)(this.path)
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
      const project: DesktopProject = { id: randomUUID(), name: input.name.trim(), cwd: input.cwd, createdAt: (this.deps.now ?? Date.now)() }
      const temporary = `${this.path}.${randomUUID()}.tmp`
      try {
        const fd = openSync(temporary, 'wx', 0o600)
        try { writeFileSync(fd, JSON.stringify({ version: 1, projects: [...projects, project] }) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
        renameSync(temporary, this.path)
        // Windows does not support opening directory handles this way. The
        // file is already flushed; POSIX also makes the rename durable here.
        if (process.platform !== 'win32') {
          const directoryFd = openSync(this.directory, 'r')
          try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
        }
      } finally {
        try { unlinkSync(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
      return project
    } finally { await release() }
  }
}
async function acquireLock(path: string): Promise<() => Promise<void>> {
  const lockfile = require('proper-lockfile') as { lock: (path: string, options: unknown) => Promise<() => Promise<void>> }
  return lockfile.lock(path, { realpath: false, stale: 20_000, retries: { retries: 10, factor: 1.5, minTimeout: 50, maxTimeout: 500, randomize: true } })
}
