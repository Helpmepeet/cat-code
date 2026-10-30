import type { DesktopProject, CreateProjectResult, ProjectFolderResult } from '../shared/projects.js'
import type { HostResult, SessionDescriptor } from '../shared/hostApi.js'
import {
  CH_PROJECTS_LIST, CH_PROJECT_DRAFT_BEGIN, CH_PROJECT_FOLDER_PICK,
  CH_PROJECT_CREATE, CH_PROJECT_DRAFT_CANCEL, CH_PROJECT_SESSION_CREATE,
} from '../shared/ipcChannels.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Main is the receiving boundary. Display paths never become launch authority. */
export function registerProjectIpc<Event>(dependencies: {
  handle: (channel: string, listener: (event: Event, ...args: unknown[]) => unknown) => void
  isAuthorized: (event: Event) => boolean
  list: () => DesktopProject[]
  begin: () => string
  pick: (draftId: unknown) => Promise<ProjectFolderResult>
  create: (input: unknown) => CreateProjectResult | Promise<CreateProjectResult>
  cancel: (draftId: unknown) => void
  validate: (cwd: string) => { ok: true; realpath: string } | { ok: false }
  createSession: (cwd: string) => Promise<HostResult<SessionDescriptor>>
  onCreated: (projects: DesktopProject[]) => void
}) {
  const allowed = (event: Event, args: unknown[], count: number) => dependencies.isAuthorized(event) && args.length === count
  dependencies.handle(CH_PROJECTS_LIST, (event, ...args) => {
    if (!allowed(event, args, 0)) throw new Error('Projects are unavailable')
    return dependencies.list()
  })
  dependencies.handle(CH_PROJECT_DRAFT_BEGIN, (event, ...args) => {
    if (!allowed(event, args, 0)) throw new Error('Projects are unavailable')
    return dependencies.begin()
  })
  dependencies.handle(CH_PROJECT_FOLDER_PICK, (event, ...args): Promise<ProjectFolderResult> => {
    if (!allowed(event, args, 1)) return Promise.resolve({ kind: 'error', error: 'The folder picker is unavailable. Try again.' })
    return dependencies.pick(args[0])
  })
  dependencies.handle(CH_PROJECT_CREATE, async (event, ...args): Promise<CreateProjectResult> => {
    if (!allowed(event, args, 1)) return { ok: false, error: 'The project could not be created. Try again.' }
    const result = await dependencies.create(args[0])
    if (result.ok) dependencies.onCreated(dependencies.list())
    return result
  })
  dependencies.handle(CH_PROJECT_DRAFT_CANCEL, (event, ...args) => {
    if (allowed(event, args, 1)) dependencies.cancel(args[0])
  })
  dependencies.handle(CH_PROJECT_SESSION_CREATE, async (event, ...args): Promise<HostResult<SessionDescriptor>> => {
    const unavailable = (): HostResult<SessionDescriptor> => ({ ok: false, error: { code: 'invalid_cwd', message: 'This project folder is unavailable.' } })
    if (!allowed(event, args, 1) || typeof args[0] !== 'string' || !UUID.test(args[0])) return unavailable()
    try {
      const project = dependencies.list().find(project => project.id === args[0])
      if (!project) return unavailable()
      const checked = dependencies.validate(project.cwd)
      if (!checked.ok || checked.realpath !== project.cwd) return unavailable()
      return await dependencies.createSession(checked.realpath)
    } catch (error) {
      return { ok: false, error: { code: 'spawn_failed', message: error instanceof Error ? error.message : 'The project session could not be started.' } }
    }
  })
}
