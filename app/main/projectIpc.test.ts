import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { registerProjectIpc } from './projectIpc.js'
import type { DesktopProject } from '../shared/projects.js'
import type { SessionDescriptor } from '../shared/hostApi.js'
import {
  CH_PROJECTS_LIST, CH_PROJECT_DRAFT_BEGIN, CH_PROJECT_FOLDER_PICK,
  CH_PROJECT_CREATE, CH_PROJECT_DRAFT_CANCEL, CH_PROJECT_SESSION_CREATE,
} from '../shared/ipcChannels.js'

function harness() {
  const handlers = new Map<string, (event: boolean, ...args: unknown[]) => unknown>()
  const projects: DesktopProject[] = [{ id: randomUUID(), name: 'Named project', cwd: '/project', createdAt: 1 }]
  const calls: string[] = []
  let canonical = '/project'
  registerProjectIpc<boolean>({
    handle: (channel, listener) => { handlers.set(channel, listener) }, isAuthorized: event => event,
    list: () => projects, begin: () => { calls.push('begin'); return 'draft' },
    pick: async () => { calls.push('pick'); return { kind: 'cancelled' } },
    cancel: () => { calls.push('cancel') },
    create: async () => { calls.push('create'); return { ok: true, project: projects[0]! } },
    validate: () => ({ ok: true, realpath: canonical }),
    createSession: async cwd => { calls.push(`session:${cwd}`); return { ok: true, value: {} as SessionDescriptor } },
    onCreated: () => { calls.push('published') },
  })
  return { projects, calls, invoke: (channel: string, event = true, ...args: unknown[]) => handlers.get(channel)!(event, ...args), redirect: () => { canonical = '/replacement' } }
}

test('creating a project publishes records without starting a session; its ID starts the first session', async () => {
  const h = harness()
  expect(h.invoke(CH_PROJECTS_LIST)).toEqual(h.projects)
  h.invoke(CH_PROJECT_DRAFT_BEGIN)
  await h.invoke(CH_PROJECT_FOLDER_PICK, true, 'draft')
  await h.invoke(CH_PROJECT_CREATE, true, { draftId: 'draft', name: 'Named project' })
  expect(h.calls).toEqual(['begin', 'pick', 'create', 'published'])
  expect(await h.invoke(CH_PROJECT_SESSION_CREATE, true, h.projects[0]!.id)).toMatchObject({ ok: true })
  expect(h.calls.at(-1)).toBe('session:/project')
})

test('unauthorized senders and extra arguments cannot read, pick, create, cancel or launch', async () => {
  const h = harness()
  for (const channel of [CH_PROJECTS_LIST, CH_PROJECT_DRAFT_BEGIN]) expect(() => h.invoke(channel, false)).toThrow()
  for (const channel of [CH_PROJECT_FOLDER_PICK, CH_PROJECT_CREATE, CH_PROJECT_DRAFT_CANCEL, CH_PROJECT_SESSION_CREATE]) await h.invoke(channel, false, h.projects[0]!.id)
  expect(h.calls).toEqual([])
  expect(() => h.invoke(CH_PROJECTS_LIST, true, '/authored')).toThrow()
  for (const channel of [CH_PROJECT_FOLDER_PICK, CH_PROJECT_CREATE, CH_PROJECT_DRAFT_CANCEL, CH_PROJECT_SESSION_CREATE]) await h.invoke(channel, true, h.projects[0]!.id, '/authored')
  expect(h.calls).toEqual([])
})

test('unknown IDs, authored paths, and canonical redirects never launch', async () => {
  const h = harness()
  for (const value of [randomUUID(), '/project', { id: h.projects[0]!.id, cwd: '/authored' }]) {
    expect(await h.invoke(CH_PROJECT_SESSION_CREATE, true, value)).toMatchObject({ ok: false })
  }
  h.redirect()
  expect(await h.invoke(CH_PROJECT_SESSION_CREATE, true, h.projects[0]!.id)).toMatchObject({ ok: false })
  expect(h.calls).toEqual([])
})
