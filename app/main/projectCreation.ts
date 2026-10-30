import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { basename } from 'node:path'
import { isCreateProjectInput, isProjectDraftId, type CreateProjectResult, type PickProjectResult, type ProjectFolder } from '../shared/projects.js'
import { DuplicateProjectError, type ProjectStore } from './projectStore.js'

export type ProjectCreationDeps = {
  store: Pick<ProjectStore, 'create'>
  pick: () => Promise<string | null>
  validateCwd: (cwd: string) => { ok: true; realpath: string } | { ok: false }
  legacyKnown: () => readonly { cwd: string; name: string }[]
  log?: (message: string, error: unknown) => void
}
export class ProjectCreationController {
  private draft: { id: string; folder?: ProjectFolder; identity?: string; picking?: boolean; creating?: boolean } | undefined
  constructor(private readonly deps: ProjectCreationDeps) {}
  /** A new renderer document cannot retain the previous dialog's authority. */
  reset(): void { this.draft = undefined }
  begin(): string {
    const id = randomUUID()
    this.draft = { id }
    return id
  }
  cancel(id: unknown): void {
    if (isProjectDraftId(id) && this.draft?.id === id) this.draft = undefined
  }
  async pick(id: unknown): Promise<PickProjectResult> {
    const draft = this.draft
    if (!isProjectDraftId(id) || !draft || draft.id !== id) return { kind: 'error', error: 'This project dialog is no longer open.' }
    if (draft.picking || draft.creating) return { kind: 'error', error: 'A project operation is already in progress.' }
    draft.picking = true
    try {
      const path = await this.deps.pick()
      if (this.draft !== draft || path === null) return { kind: 'cancelled' }
      const checked = this.deps.validateCwd(path)
      if (!checked.ok) return { kind: 'error', error: 'That folder is unavailable. Choose an existing folder you can access.' }
      const folder = { cwd: checked.realpath, name: basename(checked.realpath) || checked.realpath }
      draft.identity = folderIdentity(folder.cwd)
      draft.folder = folder
      return { kind: 'selected', folder: { ...folder } }
    } catch (error) {
      this.deps.log?.('Project folder selection failed', error)
      return this.draft !== draft ? { kind: 'cancelled' } : { kind: 'error', error: 'Could not open that folder. Choose another folder or try again.' }
    } finally { draft.picking = false }
  }
  async create(input: unknown): Promise<CreateProjectResult> {
    if (!isCreateProjectInput(input)) return { ok: false, error: 'Enter a project name of 1 to 160 characters.' }
    const draft = this.draft
    if (!draft || draft.id !== input.draftId) return { ok: false, error: 'This project dialog is no longer open.' }
    if (draft.picking || !draft.folder) return { ok: false, error: 'Choose a folder first.' }
    if (draft.creating) return { ok: false, error: 'The project is already being saved.' }
    draft.creating = true
    try {
      const checked = this.deps.validateCwd(draft.folder.cwd)
      if (!checked.ok || checked.realpath !== draft.folder.cwd || folderIdentity(checked.realpath) !== draft.identity) return { ok: false, error: 'The selected folder has changed or is unavailable. Choose it again.' }
      const project = await this.deps.store.create({ cwd: draft.folder.cwd, name: input.name.trim() }, this.deps.legacyKnown, () => this.draft === draft && folderIdentity(draft.folder!.cwd) === draft.identity)
      if (this.draft === draft) this.draft = undefined
      return { ok: true, project }
    } catch (error) {
      this.deps.log?.(`Project creation failed for ${draft.folder.cwd}`, error)
      return { ok: false, error: error instanceof DuplicateProjectError ? error.message : 'Could not save the project. Check folder access and try again.' }
    } finally { draft.creating = false }
  }
}
function folderIdentity(cwd: string): string {
  const stat = statSync(cwd)
  if (!stat.isDirectory()) throw new Error('Selected project folder is not a directory')
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`
}
