import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SessionDescriptor } from '../../shared/hostApi.js'
import type { DesktopProject } from '../../shared/projects.js'
import { groupByWorkspace, selectMergedSessionRows } from './sessionsCatalogState.js'
import { selectSettingsProjectBinding } from './settingsProjectBinding.js'
import { selectVisibleWorkspaceGroups, reduceWorkspaceHidden } from './sidebarHiddenWorkspaces.js'
import { SessionGroup } from './Sidebar.js'
import { createProjectsState, reduceProjectsState } from './projectsState.js'

const project: DesktopProject = { id: 'f5d9108d-d77e-4c9b-a9e7-43a913b700a5', name: 'Chosen name', cwd: '/stored', createdAt: 100 }

test('a delayed baseline cannot erase a live project or successful create', () => {
  const empty = createProjectsState()
  const live = reduceProjectsState(empty, { type: 'snapshot', projects: [project] })
  expect(reduceProjectsState(live, { type: 'baseline', projects: [] })).toBe(live)
  const created = reduceProjectsState(empty, { type: 'created', project })
  expect(reduceProjectsState(created, { type: 'baseline', projects: [] })).toBe(created)
  expect(reduceProjectsState(created, { type: 'created', project }).projects).toEqual([project])
})
function row(cwd: string, managed = false): SessionDescriptor {
  return { appSessionId: cwd, engineSessionId: null, cwd, title: 'Existing session', forked: false, titleUpdatedAt: null,
    status: 'ready', restorable: false, parked: false, createdAt: 1, lastAttachedAt: 1, lastMessageSentAt: null,
    ...(managed ? { binding: { kind: 'managed' as const, storageId: 'chat', storageRootId: 'root' } } : {}) }
}

test('stored empty groups coexist with unchanged legacy rows and do not absorb managed chats', () => {
  const rows = selectMergedSessionRows([row('/legacy'), row('/managed', true)], null)
  const original = groupByWorkspace(rows, null)
  const groups = groupByWorkspace(rows, null, [project])
  expect(groups.find(group => group.cwd === '/legacy')).toEqual(original[0])
  expect(groups.find(group => group.cwd === '/managed')).toBeUndefined()
  expect(groups.find(group => group.cwd === '/stored')).toEqual({ projectId: project.id, cwd: '/stored', name: 'Chosen name', current: false, rows: [] })
  expect(rows).toHaveLength(2)
})

test('records and sessions with the same cwd are one named group without rewriting rows', () => {
  const rows = selectMergedSessionRows([row('/stored')], null)
  const groups = groupByWorkspace(rows, '/stored', [project])
  expect(groups).toHaveLength(1)
  expect(groups[0]).toMatchObject({ projectId: project.id, name: 'Chosen name', current: true })
  expect(groups[0]!.rows[0]).toBe(rows[0]!)
  expect(selectSettingsProjectBinding(rows, '/stored', [project])).toMatchObject({ bound: true, cwd: '/stored', name: 'Chosen name' })
})

test('an empty project can be hidden and restored without deleting its record or generating activity', () => {
  const groups = groupByWorkspace([], null, [project])
  const hidden = reduceWorkspaceHidden([], project.cwd, 200)
  const selected = selectVisibleWorkspaceGroups(groups, hidden, group => group.rows.reduce((last, row) => Math.max(last, row.lastMessageSentAt ?? 0), 0))
  expect(selected.visible).toEqual([])
  expect(selected.hidden).toEqual(groups)
  expect(groupByWorkspace([], null, [project])).toEqual(groups)
  expect(selectVisibleWorkspaceGroups(groups, [], () => 0).visible).toEqual(groups)
})

test('an empty stored project renders a zero count and its own session action', () => {
  const group = groupByWorkspace([], null, [project])[0]!
  const html = renderToStaticMarkup(<SessionGroup group={group} activeSessionId={null} collapsed={false} onToggle={() => {}}
    onSelectLive={() => {}} onRestore={() => {}} onOpenHistory={() => {}} onNewProjectSession={() => {}} />)
  expect(html).toContain('Chosen name')
  expect(html).toContain('New session in this workspace')
  expect(html).toMatch(/>0<\/span>/)
  expect(html).not.toContain('Existing session')
})
