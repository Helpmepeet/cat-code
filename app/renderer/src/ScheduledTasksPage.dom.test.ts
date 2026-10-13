import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, createElement } from 'react'
import type { ScheduledRun, ScheduledTask, ScheduledTaskCommand, ScheduledTasksResult, ScheduledTasksSnapshot } from '../../shared/scheduledTasks.js'
import { createDomTestHarness, type DomTestHarness, type MountedTree } from './domTestHarness.js'
import { ScheduledTasksPage } from './ScheduledTasksPage.js'
import { storeScheduledSelection, storeScheduledTaskDraft } from './scheduledTasksModel.js'
import { sessionDescriptor } from './sessionDescriptorFixture.js'

let harness: DomTestHarness
let previousBridge: typeof window.catcode | undefined
beforeAll(async () => { harness = await createDomTestHarness(); previousBridge = window.catcode })
afterEach(async () => { await harness.unmountAll(); storeScheduledTaskDraft(null); storeScheduledSelection(null) })
afterAll(async () => {
  if (previousBridge) window.catcode = previousBridge
  else delete (window as unknown as Record<string, unknown>).catcode
  await harness.teardown()
})

const TASK_ID = '11111111-1111-4111-8111-111111111111'
const PRESET_ID = '44444444-4444-4444-8444-444444444444'
const PROJECT = sessionDescriptor('33333333-3333-4333-8333-333333333333', { cwd: '/repo/cat-code', binding: { kind: 'project' } })

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: TASK_ID, name: 'Nightly review', prompt: 'Review the diff', enabled: true, cwd: '/repo/cat-code',
    schedule: { kind: 'daily', time: '03:00', timeZone: 'Asia/Bangkok', day: 0 },
    model: '', effort: 'default', permissionMode: 'default', createdAt: 1, nextRunAt: Date.now() + 3600_000, ...overrides,
  }
}
const preset = (overrides: Partial<ScheduledTask> = {}) => task({ id: PRESET_ID, name: 'Refresh workspace maps', prompt: 'bun run scripts/workspaceMapRefreshState.ts help', enabled: false, ...overrides })

function run(overrides: Partial<ScheduledRun> = {}): ScheduledRun {
  const now = Date.now()
  return {
    id: crypto.randomUUID(), taskId: TASK_ID, taskName: 'Nightly review', appSessionId: crypto.randomUUID(),
    scheduledAt: now, startedAt: now, endedAt: null, status: 'running', summary: '', ...overrides,
  }
}

type Bridge = {
  snapshot: ScheduledTasksSnapshot
  commands: ScheduledTaskCommand[]
  respond: (command: ScheduledTaskCommand) => ScheduledTasksResult | Promise<ScheduledTasksResult>
  read?: () => Promise<ScheduledTasksSnapshot>
  pickToken?: string | null
}

function installBridge(state: Bridge): void {
  window.catcode = {
    readScheduledTasks: () => state.read ? state.read() : Promise.resolve(structuredClone(state.snapshot)),
    scheduledTask: async (command: ScheduledTaskCommand) => { state.commands.push(command); return state.respond(command) },
    pickDirectory: async () => state.pickToken ?? null,
  } as unknown as typeof window.catcode
}

async function mount(opened: string[] = []): Promise<MountedTree> {
  const tree = await harness.mount(createElement(ScheduledTasksPage, { sessions: [PROJECT], modelSuggestions: [], onOpenChat: (id: string) => { opened.push(id) } }))
  await flush()
  return tree
}
async function flush(): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
function buttons(tree: MountedTree, name: string): HTMLButtonElement[] {
  return [...tree.container.ownerDocument.querySelectorAll<HTMLButtonElement>('button')]
    .filter(entry => entry.getAttribute('aria-label') === name || entry.textContent?.trim() === name)
}
function button(tree: MountedTree, name: string): HTMLButtonElement {
  const found = buttons(tree, name)[0]
  if (!found) throw new Error(`No button ${name}`)
  return found
}
/** A list row's accessible text starts with the task name. */
function listRow(tree: MountedTree, name: string): HTMLButtonElement {
  const nav = tree.container.querySelector('nav')!
  const found = [...nav.querySelectorAll<HTMLButtonElement>('button')].find(entry => entry.textContent?.startsWith(name))
  if (!found) throw new Error(`No list row ${name}`)
  return found
}
async function click(element: HTMLElement): Promise<void> {
  await act(async () => { element.click() })
  await flush()
}
function field<T extends HTMLElement>(tree: MountedTree, label: string): T {
  const labelElement = [...tree.container.querySelectorAll('label')].find(entry => entry.textContent === label)
  const control = labelElement ? tree.container.ownerDocument.getElementById(labelElement.htmlFor) : null
  if (!control) throw new Error(`No field ${label}`)
  return control as T
}
async function type(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): Promise<void> {
  const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : control instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(control, value)
    control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}
const text = (tree: MountedTree) => tree.container.textContent ?? ''
const heading = (tree: MountedTree) => tree.container.querySelector('h2')?.textContent
const alerts = (tree: MountedTree) => [...tree.container.querySelectorAll('[role="alert"]')].map(entry => entry.textContent)
const toggleSwitch = (tree: MountedTree) => tree.container.querySelector<HTMLButtonElement>('[role="switch"]')!

test('creating a task sends the project session, not a path, and opens the new task', async () => {
  const state: Bridge = {
    snapshot: { tasks: [], runs: [] },
    commands: [],
    respond: command => command.type === 'save' ? { ok: true, snapshot: { tasks: [task({ name: command.task.name })], runs: [] } } : { ok: false, error: 'unexpected' },
  }
  installBridge(state)
  const tree = await mount()
  expect(heading(tree)).toBe('Schedule a task')
  await click(listRow(tree, 'New task'))
  expect(button(tree, 'Create task').disabled).toBe(true)
  await type(field(tree, 'Name'), 'Nightly review')
  await type(field(tree, 'Instructions'), 'Review the diff')
  await type(field(tree, 'Project'), PROJECT.appSessionId)
  await click(button(tree, 'Auto'))
  expect(text(tree)).toContain('Next run')
  await click(button(tree, 'Create task'))

  expect(state.commands).toHaveLength(1)
  const saved = state.commands[0]!
  if (saved.type !== 'save') throw new Error('expected save')
  expect(saved.task).toMatchObject({ name: 'Nightly review', prompt: 'Review the diff', workspaceSessionId: PROJECT.appSessionId, enabled: true, permissionMode: 'auto' })
  expect(saved.task).not.toHaveProperty('cwd')
  expect(saved.task).not.toHaveProperty('cwdToken')
  expect(tree.container.querySelector('form')).toBeNull()
  expect(heading(tree)).toBe('Nightly review')
  expect(listRow(tree, 'Nightly review').getAttribute('aria-current')).toBe('page')
})

test('a refused save keeps the draft, explains the refusal, and asks for a spent folder again', async () => {
  const state: Bridge = { snapshot: { tasks: [], runs: [] }, commands: [], pickToken: 'token-1', respond: () => ({ ok: false, error: 'Choose a project folder for this task' }) }
  installBridge(state)
  const tree = await mount()
  await click(listRow(tree, 'New task'))
  await type(field(tree, 'Name'), 'Weekly')
  await type(field(tree, 'Instructions'), 'Summarize the week')
  await click(button(tree, 'Choose folder…'))
  await click(button(tree, 'Create task'))

  const saved = state.commands[0]!
  expect(saved.type === 'save' && saved.task.cwdToken).toBe('token-1')
  expect(alerts(tree)).toContain('Choose a project folder for this task')
  expect(field<HTMLTextAreaElement>(tree, 'Instructions').value).toBe('Summarize the week')
  expect(text(tree)).toContain('Choose the folder again.')
  expect(button(tree, 'Create task').disabled).toBe(true)

  state.pickToken = 'token-2'
  state.respond = () => ({ ok: true, snapshot: { tasks: [task({ name: 'Weekly' })], runs: [] } })
  await click(button(tree, 'Choose folder…'))
  await click(button(tree, 'Create task'))
  const retried = state.commands[1]!
  expect(retried.type === 'save' && retried.task.cwdToken).toBe('token-2')
  expect(tree.container.querySelector('form')).toBeNull()
})

test('refreshed state does not overwrite an open draft, and the draft survives leaving the page', async () => {
  const state: Bridge = { snapshot: { tasks: [task()], runs: [] }, commands: [], respond: () => ({ ok: false, error: 'unused' }) }
  installBridge(state)
  const tree = await mount()
  await click(listRow(tree, 'Nightly review'))
  await click(button(tree, 'Edit'))
  await type(field(tree, 'Instructions'), 'Edited instructions')

  state.snapshot = { tasks: [task({ prompt: 'Changed elsewhere', enabled: false })], runs: [run({ status: 'waiting' })] }
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  await flush()
  expect(field<HTMLTextAreaElement>(tree, 'Instructions').value).toBe('Edited instructions')
  expect(listRow(tree, 'Nightly review').textContent).toContain('Needs answer')

  // Leaving the editor keeps the draft on its own row; New task returns to it rather than replacing it.
  await click(listRow(tree, 'Nightly review'))
  expect(tree.container.querySelector('form')).toBeNull()
  expect(listRow(tree, 'Nightly review').textContent).toContain('Draft')
  expect(listRow(tree, 'New task').textContent).not.toContain('Draft')
  await tree.unmount()
  const again = await mount()
  await click(listRow(again, 'New task'))
  expect(again.container.querySelector('h2')?.textContent).toBe('Edit Nightly review')
  expect(field<HTMLTextAreaElement>(again, 'Instructions').value).toBe('Edited instructions')
  state.respond = () => ({ ok: true, snapshot: { tasks: [task()], runs: [] } })
  await click(button(again, 'Save changes'))
  const saved = state.commands[0]!
  // Paused while the draft was open: saving keeps the latest enabled state.
  expect(saved.type === 'save' && saved.task.enabled).toBe(false)
  expect(saved.type === 'save' && saved.task).not.toHaveProperty('workspaceSessionId')
})

test('a stale poll that resolves after a command cannot replace the command snapshot', async () => {
  let resolveRead: (value: ScheduledTasksSnapshot) => void = () => {}
  const state: Bridge = { snapshot: { tasks: [task()], runs: [] }, commands: [], respond: () => ({ ok: true, snapshot: { tasks: [task({ enabled: false })], runs: [] } }) }
  installBridge(state)
  const tree = await mount()
  await click(listRow(tree, 'Nightly review'))
  state.read = () => new Promise(resolve => { resolveRead = resolve })
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  await click(toggleSwitch(tree))
  expect(state.commands).toEqual([{ type: 'pause', id: TASK_ID }])
  expect(toggleSwitch(tree).getAttribute('aria-checked')).toBe('false')
  await act(async () => { resolveRead({ tasks: [task({ enabled: true })], runs: [] }) })
  await flush()
  expect(toggleSwitch(tree).getAttribute('aria-checked')).toBe('false')
})

test('task refusals show in place; delete and turning on the preset need confirmation', async () => {
  const state: Bridge = {
    snapshot: { tasks: [task(), preset()], runs: [] },
    commands: [],
    respond: command => command.type === 'run' ? { ok: false, error: 'This task already has an unfinished run' } : { ok: true, snapshot: { tasks: command.type === 'delete' ? [preset()] : [task(), preset({ enabled: command.type === 'resume' })], runs: [] } },
  }
  installBridge(state)
  const tree = await mount()
  await click(listRow(tree, 'Nightly review'))
  await click(button(tree, 'Run Nightly review now'))
  expect(alerts(tree)).toContain('This task already has an unfinished run')

  await click(listRow(tree, 'Refresh workspace maps'))
  expect(text(tree)).toContain('Pause the previous map-refresh schedule outside Cat Code before turning this on.')
  await click(toggleSwitch(tree))
  const dialog = () => tree.container.ownerDocument.querySelector('[role="dialog"]')
  expect(dialog()?.textContent).toContain('Two schedules would refresh the same maps.')
  expect(state.commands.map(command => command.type)).toEqual(['run'])
  await click(button(tree, 'Turn on'))
  expect(state.commands.at(-1)).toEqual({ type: 'resume', id: PRESET_ID })

  await click(listRow(tree, 'Nightly review'))
  await click(button(tree, 'More actions for Nightly review'))
  expect(tree.container.querySelector('[role="menu"]')).not.toBeNull()
  await click(button(tree, 'Delete'))
  expect(dialog()?.textContent).toContain('past run chats stay available')
  await act(async () => { dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  await flush()
  expect(dialog()).toBeNull()
  expect(state.commands.at(-1)?.type).toBe('resume')
  await click(button(tree, 'More actions for Nightly review'))
  await click(button(tree, 'Delete'))
  await click(button(tree, 'Delete task'))
  expect(state.commands.at(-1)).toEqual({ type: 'delete', id: TASK_ID })
  expect(heading(tree)).toBe('Activity')
})

test('activity leads with answers needed, history keeps deleted tasks, and runs open their chats', async () => {
  const other = '66666666-6666-4666-8666-666666666666'
  const waiting = run({ status: 'waiting', summary: 'Open this chat to answer the pending request.' })
  const starting = run({ taskId: other, taskName: 'Other', status: 'starting', summary: 'Waiting for Cat Code to have room for this chat.', startedAt: Date.now() + 1 })
  const orphan = run({ taskId: '55555555-5555-4555-8555-555555555555', taskName: 'Old task', status: 'completed', endedAt: Date.now(), startedAt: Date.now() - 120_000, summary: 'Done.' })
  const state: Bridge = { snapshot: { tasks: [task(), task({ id: other, name: 'Other' }), preset()], runs: [starting, waiting, orphan] }, commands: [], respond: () => ({ ok: false, error: 'unused' }) }
  installBridge(state)
  const opened: string[] = []
  const tree = await mount(opened)
  expect(heading(tree)).toBe('Activity')
  const current = tree.container.querySelector('section[aria-label="Current runs"]')!
  expect(current.textContent?.indexOf('Nightly review')).toBeLessThan(current.textContent!.indexOf('Other'))
  expect(current.textContent).toContain('Waiting for Cat Code to have room for this chat.')
  expect(current.textContent).not.toContain('Open this chat to answer')

  await click(button(tree, 'Answer in chat for Nightly review'))
  expect(opened).toEqual([waiting.appSessionId])

  await click(listRow(tree, 'Run history'))
  expect(heading(tree)).toBe('Run history')
  expect(text(tree)).toContain('Deleted')
  expect(text(tree)).toContain('Turn completed')
  await click(tree.container.querySelector<HTMLButtonElement>('button[aria-label^="Open chat for Old task"]')!)
  expect(opened).toEqual([waiting.appSessionId, orphan.appSessionId])

  await click(listRow(tree, 'Nightly review'))
  expect(button(tree, 'Run Nightly review now, unavailable until the current run finishes').disabled).toBe(true)
  expect(text(tree)).toContain('Waiting for your answer')
})

test('the workspace-map preset is created paused for a chosen project session and then opened', async () => {
  const state: Bridge = {
    snapshot: { tasks: [], runs: [] },
    commands: [],
    respond: () => ({ ok: true, snapshot: { tasks: [preset()], runs: [] } }),
  }
  installBridge(state)
  const tree = await mount()
  await click(listRow(tree, 'Workspace-map refresh'))
  expect(button(tree, 'Create paused task').disabled).toBe(true)
  await type(field(tree, 'Project'), PROJECT.appSessionId)
  await click(button(tree, 'Create paused task'))
  expect(state.commands).toEqual([{ type: 'workspace-maps', workspaceSessionId: PROJECT.appSessionId }])
  expect(heading(tree)).toBe('Refresh workspace maps')
  expect(toggleSwitch(tree).getAttribute('aria-checked')).toBe('false')
  expect(() => listRow(tree, 'Workspace-map refresh')).toThrow()
})

test('unavailable scheduling is explained and blocks changes', async () => {
  installBridge({ snapshot: { tasks: [task()], runs: [], error: 'Scheduled tasks are already running in another Cat Code app, or their storage is unavailable.' }, commands: [], respond: () => ({ ok: false, error: 'unused' }) })
  const tree = await mount()
  expect(alerts(tree)).toContain('Scheduled tasks are already running in another Cat Code app, or their storage is unavailable.')
  expect(listRow(tree, 'New task').disabled).toBe(true)
  await click(listRow(tree, 'Nightly review'))
  expect(toggleSwitch(tree).disabled).toBe(true)
  expect(button(tree, 'Run Nightly review now').disabled).toBe(true)
})
