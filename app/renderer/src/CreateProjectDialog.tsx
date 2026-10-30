import { useEffect, useId, useRef, useState } from 'react'
import type { CreateProjectInput, CreateProjectResult, DesktopProject, ProjectFolderResult, ProjectFolder } from '../../shared/projects.js'
import { useModalFocus } from './overlayFocus.js'
import { ActionCloseIcon } from './SessionActionIcons.js'
import cat from './assets/generated-welcome-cats/hiding-in-a-box-tail-gives-it-away.png'
import './CreateProjectDialog.css'

export interface CreateProjectDialogBridge {
  beginProjectDraft(): Promise<string>
  pickProjectFolder(draftId: string): Promise<ProjectFolderResult>
  createProject(input: CreateProjectInput): Promise<CreateProjectResult>
  cancelProjectDraft(draftId: string): Promise<void>
}

export interface CreateProjectDialogProps {
  bridge: CreateProjectDialogBridge
  onClose(): void
  onCreated(project: DesktopProject): void
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

export function CreateProjectDialog({ bridge, onClose, onCreated }: CreateProjectDialogProps) {
  const [name, setName] = useState('')
  const [folder, setFolder] = useState<ProjectFolder | null>(null)
  const [draftId, setDraftId] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLFormElement>(null)
  const lifecycle = useRef<{ active: boolean; busy: boolean; creating: boolean; draftId: string | null } | null>(null)
  // The adapter belongs to this draft, even if the parent re-renders with a new wrapper.
  const draftBridge = useRef(bridge).current
  const nameId = useId()
  const folderId = useId()

  useEffect(() => {
    const life = { active: true, busy: false, creating: false, draftId: null as string | null }
    lifecycle.current = life
    const cancel = (id: string) => {
      void draftBridge.cancelProjectDraft(id).catch(reason => {
        console.warn('Could not cancel the closed project draft', reason)
      })
    }
    void draftBridge.beginProjectDraft().then(id => {
      life.draftId = id
      if (!life.active) { cancel(id); return }
      setDraftId(id)
    }).catch(reason => { if (life.active) setError(errorText(reason)) })
    return () => {
      life.active = false
      if (life.draftId) cancel(life.draftId)
    }
  }, [draftBridge])

  const close = () => {
    if (!lifecycle.current?.active || lifecycle.current.creating) return
    lifecycle.current.active = false
    onClose()
  }
  useModalFocus({ open: true, containerRef: dialogRef, onEscape: close })

  const pick = async () => {
    const life = lifecycle.current
    if (!life?.active || life.busy || !life.draftId) return
    life.busy = true
    setPending(true)
    setError(null)
    try {
      const result = await draftBridge.pickProjectFolder(life.draftId)
      if (!life.active) return
      if (result.kind === 'selected') {
        setFolder(result.folder)
        setName(current => current.trim() ? current : result.folder.name.slice(0, 160))
      } else if (result.kind === 'error') setError(result.error)
    } catch (reason) {
      if (life.active) setError(errorText(reason))
    } finally {
      life.busy = false
      if (life.active) setPending(false)
    }
  }
  const valid = !!draftId && !!folder && name.trim().length > 0 && name.trim().length <= 160
  const create = async () => {
    const life = lifecycle.current
    if (!valid || !life?.active || life.busy || !life.draftId) return
    life.busy = true
    life.creating = true
    setCreating(true)
    setPending(true)
    setError(null)
    try {
      const result = await draftBridge.createProject({ draftId: life.draftId, name: name.trim() })
      if (!life.active) return
      if (result.ok) { life.active = false; onCreated(result.project) }
      else setError(result.error)
    } catch (reason) {
      if (life.active) setError(errorText(reason))
    } finally {
      life.busy = false
      life.creating = false
      if (life.active) setCreating(false)
      if (life.active) setPending(false)
    }
  }

  return <div className="create-project-scrim" role="presentation" onMouseDown={close}>
    <form className="create-project-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-label="Create project" tabIndex={-1}
      onMouseDown={event => event.stopPropagation()} onSubmit={event => { event.preventDefault(); void create() }}>
      <div className="create-project-main">
        <img className="create-project-cat" src={cat} alt="" />
        <div className="create-project-fields">
          <h2 className="create-project-wordmark">new <span>project</span></h2>
          <div className="create-project-field"><label htmlFor={nameId}>Name</label>
            <input id={nameId} value={name} maxLength={160} required autoComplete="off" disabled={pending} onChange={event => setName(event.target.value)} />
          </div>
          <div className="create-project-field"><span id={folderId} className="create-project-label">Folder</span>
            {folder ? <div className="create-project-folder" role="group" aria-labelledby={folderId}>
              <FolderIcon /><span className="create-project-path" title={folder.cwd}>{folder.cwd}</span>
              <button className="create-project-change" type="button" disabled={pending} onClick={() => void pick()}>Change</button>
            </div> : <button className="create-project-folder create-project-choose" type="button" disabled={!draftId || pending} onClick={() => void pick()}><FolderIcon />Choose folder…</button>}
          </div>
          {error && <div className="create-project-error" role="alert">{error}</div>}
        </div>
      </div>
      <button className="create-project-close" type="button" aria-label="Close dialog" disabled={creating} onClick={close}><ActionCloseIcon /></button>
      <div className="create-project-footer">
        <button className="create-project-button" type="button" disabled={creating} onClick={close}>Cancel</button>
        <button className="create-project-button create-project-primary" type="submit" disabled={!valid || pending}>Create project</button>
      </div>
    </form>
  </div>
}

function FolderIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 19V6a2 2 0 0 1 2-2h3.6l2 2.5H19a2 2 0 0 1 2 2V19a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /></svg>
}
