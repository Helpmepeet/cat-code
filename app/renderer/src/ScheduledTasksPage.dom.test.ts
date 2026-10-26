import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, createElement } from 'react'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runScheduledTaskOptionsWorker } from '../../main/scheduledTaskOptionsRunner.js'
import { ScheduledTaskOptionsService } from '../../main/scheduledTaskOptionsService.js'
import type { ScheduledRun, ScheduledTask, ScheduledTaskCommand, ScheduledTaskOptions, ScheduledTasksResult, ScheduledTasksSnapshot } from '../../shared/scheduledTasks.js'
import { SCHEDULED_OPTIONS_CACHE_MS } from '../../shared/scheduledTaskOptions.js'
import { createDomTestHarness, type DomTestHarness, type MountedTree } from './domTestHarness.js'
import { ScheduledTasksPage } from './ScheduledTasksPage.js'
import { storeScheduledSelection, storeScheduledTaskDraft } from './scheduledTasksModel.js'

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
const MODELS = [
  { value: 'gpt-6-sol', label: 'GPT-6 Sol', provider: 'openai' as const, effortOptions: ['low', 'medium', 'high', 'ultra'] },
  { value: 'haiku', label: 'Haiku', provider: 'anthropic' as const, effortOptions: [] },
]
const PROJECT = { workspaceId: '33333333-3333-4333-8333-333333333333', cwd: '/repo/cat-code', label: 'cat-code', supportsWorkspaceMaps: true }

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
  options?: ScheduledTaskOptions
  readOptions?: (request?: { refresh: true }) => Promise<ScheduledTaskOptions>
}

function installBridge(state: Bridge): void {
  window.catcode = {
    readScheduledTasks: () => state.read ? state.read() : Promise.resolve(structuredClone(state.snapshot)),
    readScheduledTaskOptions: (request?: { refresh: true }) => state.readOptions ? state.readOptions(request) : Promise.resolve(state.options ?? { models: MODELS, defaultEffortOptions: ['medium', 'high'], projects: [PROJECT] }),
    scheduledTask: async (command: ScheduledTaskCommand) => { state.commands.push(command); return state.respond(command) },
    pickDirectory: async () => { throw new Error('Scheduled must not use the chat picker') },
    pickScheduledTaskDirectory: async () => state.pickToken ?? null,
  } as unknown as typeof window.catcode
}

async function mount(opened: string[] = []): Promise<MountedTree> {
  const tree = await harness.mount(createElement(ScheduledTasksPage, { onOpenChat: (id: string) => { opened.push(id) } }))
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
/** Opens a picker by its label and chooses the option whose text starts with `option`. */
async function choose(tree: MountedTree, label: string, option: string): Promise<void> {
  await click(field<HTMLButtonElement>(tree, label))
  const item = [...tree.container.ownerDocument.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(entry => entry.textContent?.startsWith(option))
  if (!item) throw new Error(`No option ${option} in ${label}`)
  await click(item)
}
const menuOptions = (tree: MountedTree) => [...tree.container.ownerDocument.querySelectorAll('[role="menuitemradio"]')].map(entry => entry.textContent)
const text = (tree: MountedTree) => tree.container.textContent ?? ''
const heading = (tree: MountedTree) => tree.container.querySelector('h2')?.textContent
const alerts = (tree: MountedTree) => [...tree.container.querySelectorAll('[role="alert"]')].map(entry => entry.textContent)
const toggleSwitch = (tree: MountedTree) => tree.container.querySelector<HTMLButtonElement>('[role="switch"]')!

test('with no chats, creating a task offers catalog models/projects and sends a project handle, not a path', async () => {
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
  await choose(tree, 'Project', 'cat-code')
  expect(field(tree, 'Project').textContent).toContain('/repo/cat-code')
  await click(button(tree, 'Auto'))
  await choose(tree, 'Model', 'Haiku')
  // Haiku takes no effort setting, so only Default remains.
  await click(field(tree, 'Effort'))
  expect(menuOptions(tree)).toEqual(['Default'])
  await act(async () => { tree.container.ownerDocument.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  await flush()
  await choose(tree, 'Model', 'GPT-6 Sol')
  await click(field(tree, 'Effort'))
  expect(menuOptions(tree)).toEqual(['Default', 'Low', 'Medium', 'High', 'Ultra'])
  await click(button(tree, 'Ultra'))
  expect(field(tree, 'Effort').textContent).toBe('Ultra')
  await choose(tree, 'Effort', 'High')
  await click(field(tree, 'Time zone'))
  const search = tree.container.ownerDocument.querySelector<HTMLInputElement>('input[aria-label="Search time zone"]')!
  await type(search, 'tokyo')
  expect(menuOptions(tree)).toEqual(['Asia/Tokyo'])
  await act(async () => { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  await flush()
  expect(field(tree, 'Time zone').textContent).toContain('Asia/Tokyo')
  expect(text(tree)).toContain('Next run')
  await click(button(tree, 'Create task'))

  expect(state.commands).toHaveLength(1)
  const saved = state.commands[0]!
  if (saved.type !== 'save') throw new Error('expected save')
  expect(saved.task).toMatchObject({ name: 'Nightly review', prompt: 'Review the diff', workspaceId: PROJECT.workspaceId, enabled: true, permissionMode: 'auto', model: 'gpt-6-sol', effort: 'high' })
  expect(saved.task.schedule).toMatchObject({ kind: 'daily', timeZone: 'Asia/Tokyo' })
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
  await click(field(tree, 'Project'))
  await click(button(tree, 'Choose another folder…'))
  expect(field(tree, 'Project').textContent).toContain('Chosen folder')
  await click(button(tree, 'Create task'))

  const saved = state.commands[0]!
  expect(saved.type === 'save' && saved.task.cwdToken).toBe('token-1')
  expect(alerts(tree)).toContain('Choose a project folder for this task')
  expect(field<HTMLTextAreaElement>(tree, 'Instructions').value).toBe('Summarize the week')
  expect(text(tree)).toContain('Choose the folder again.')
  expect(button(tree, 'Create task').disabled).toBe(true)

  state.pickToken = 'token-2'
  state.respond = () => ({ ok: true, snapshot: { tasks: [task({ name: 'Weekly' })], runs: [] } })
  await click(field(tree, 'Project'))
  await click(button(tree, 'Choose another folder…'))
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
  expect(saved.type === 'save' && saved.task).not.toHaveProperty('workspaceId')
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

test('with no chats the workspace-map preset uses a catalog project and opens paused', async () => {
  const state: Bridge = {
    snapshot: { tasks: [], runs: [] },
    commands: [],
    respond: () => ({ ok: true, snapshot: { tasks: [preset()], runs: [] } }),
  }
  installBridge(state)
  const tree = await mount()
  await click(listRow(tree, 'Workspace-map refresh'))
  expect(button(tree, 'Create paused task').disabled).toBe(true)
  await choose(tree, 'Project', 'cat-code')
  await click(button(tree, 'Create paused task'))
  expect(state.commands).toEqual([{ type: 'workspace-maps', workspaceId: PROJECT.workspaceId }])
  expect(heading(tree)).toBe('Refresh workspace maps')
  expect(toggleSwitch(tree).getAttribute('aria-checked')).toBe('false')
  expect(() => listRow(tree, 'Workspace-map refresh')).toThrow()
})

test.each([false, undefined])('ordinary projects do not advertise the workspace-map preset (eligibility %s)', async eligibility => {
  installBridge({
    snapshot: { tasks: [], runs: [] }, commands: [],
    options: { models: MODELS, defaultEffortOptions: [], projects: [{ ...PROJECT, supportsWorkspaceMaps: eligibility }] },
    respond: () => ({ ok: false, error: 'unused' }),
  })
  const tree = await mount()
  expect(() => listRow(tree, 'Workspace-map refresh')).toThrow()
  expect(buttons(tree, 'Add workspace-map refresh')).toHaveLength(0)
  expect(buttons(tree, 'New task').length).toBeGreaterThan(0)
})

test('the preset offers only projects with a refresh helper while ordinary task projects remain available', async () => {
  const ordinary = { workspaceId: '55555555-5555-4555-8555-555555555555', cwd: '/repo/ordinary', label: 'ordinary', supportsWorkspaceMaps: false }
  installBridge({
    snapshot: { tasks: [], runs: [] }, commands: [],
    options: { models: MODELS, defaultEffortOptions: [], projects: [PROJECT, ordinary] },
    respond: () => ({ ok: false, error: 'unused' }),
  })
  const tree = await mount()
  await click(listRow(tree, 'Workspace-map refresh'))
  await click(field(tree, 'Project'))
  expect(menuOptions(tree).some(option => option?.startsWith('cat-code'))).toBe(true)
  expect(menuOptions(tree).some(option => option?.startsWith('ordinary'))).toBe(false)
  const supported = [...tree.container.ownerDocument.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
    .find(option => option.textContent?.startsWith('cat-code'))!
  await click(supported)
  await click(listRow(tree, 'New task'))
  await choose(tree, 'Project', 'ordinary')
  expect(field(tree, 'Project').textContent).toContain('/repo/ordinary')
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

test('default effort is engine-derived and model changes reconcile unsupported effort', async () => {
  installBridge({ snapshot: { tasks: [], runs: [] }, commands: [], respond: () => ({ ok: false, error: 'unused' }) })
  const tree = await mount()
  await click(listRow(tree, 'New task'))
  await click(field(tree, 'Effort'))
  expect(menuOptions(tree)).toEqual(['Default', 'Medium', 'High'])
  await click(button(tree, 'High'))
  await choose(tree, 'Model', 'Haiku')
  expect(field(tree, 'Effort').textContent).toBe('Default')
  expect(text(tree)).not.toContain('once a chat is open')
})

test('a retained preset selection accepts a native folder without known projects and retries spent tokens', async () => {
  const state: Bridge = {
    snapshot: { tasks: [], runs: [] }, commands: [], pickToken: 'preset-folder-1',
    options: { models: MODELS, defaultEffortOptions: [], projects: [] },
    respond: () => ({ ok: false, error: 'The project needs a refresh helper' }),
  }
  storeScheduledSelection({ kind: 'preset' })
  installBridge(state)
  const tree = await mount()
  expect(heading(tree)).toBe('Workspace-map refresh')
  expect(button(tree, 'Create paused task').disabled).toBe(true)
  expect(text(tree)).not.toContain('Open the project')
  await click(field(tree, 'Project'))
  await click(button(tree, 'Choose another folder…'))
  expect(field(tree, 'Project').textContent).toContain('Chosen folder')
  await click(button(tree, 'Create paused task'))
  expect(state.commands).toEqual([{ type: 'workspace-maps', cwdToken: 'preset-folder-1' }])
  expect(alerts(tree)).toContain('Choose the folder again.')
  expect(button(tree, 'Create paused task').disabled).toBe(true)
  state.pickToken = 'preset-folder-2'
  state.respond = () => ({ ok: true, snapshot: { tasks: [preset()], runs: [] } })
  await click(field(tree, 'Project'))
  await click(button(tree, 'Choose another folder…'))
  await click(button(tree, 'Create paused task'))
  expect(state.commands.at(-1)).toEqual({ type: 'workspace-maps', cwdToken: 'preset-folder-2' })
  expect(heading(tree)).toBe('Refresh workspace maps')
})

test('a catalog failure is explicit, can be retried, and never falls back to chat controls', async () => {
  const state: Bridge = {
    snapshot: { tasks: [], runs: [] }, commands: [],
    readOptions: async () => { throw new Error('worker failed') },
    respond: () => ({ ok: false, error: 'unused' }),
  }
  installBridge(state)
  const tree = await mount()
  await click(listRow(tree, 'New task'))
  expect(alerts(tree).join(' ')).toContain('Models and projects could not be loaded.')
  expect(field<HTMLButtonElement>(tree, 'Model').disabled).toBe(true)
  expect(button(tree, 'Create task').disabled).toBe(true)
  state.readOptions = async () => ({ models: MODELS, defaultEffortOptions: [], projects: [PROJECT] })
  await click(button(tree, 'Refresh choices'))
  expect(alerts(tree)).toEqual([])
  await click(field(tree, 'Model'))
  expect(menuOptions(tree)).toEqual(['Default', 'GPT-6 Sol', 'Haiku'])
})

test('App and the Scheduled page cannot feed choices from chat state', async () => {
  const app = await Bun.file(new URL('./App.tsx', import.meta.url)).text()
  const page = await Bun.file(new URL('./ScheduledTasksPage.tsx', import.meta.url)).text()
  const model = await Bun.file(new URL('./scheduledTasksModel.ts', import.meta.url)).text()
  const wiring = app.match(/<ScheduledTasksPage[\s\S]*?\/>/)?.[0]
  expect(wiring).toBeDefined()
  expect(wiring).not.toMatch(/sessions=|modelOptions=/)
  expect(app).not.toContain('scheduledModelOptions')
  expect(page).toContain('getBridge().readScheduledTaskOptions(')
  expect(page).not.toContain('.pickDirectory(')
  expect(page + model).not.toMatch(/SessionDescriptor|RunControlsSnapshot|workspaceSessionId|runControls\.last/)
})

test('real engine catalog reaches the designed pickers without creating any chat', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'scheduled-page-catalog-')))
  try {
    const config = join(dir, 'config')
    const project = join(dir, 'standalone-project')
    mkdirSync(config)
    mkdirSync(project)
    writeFileSync(join(config, '.config.json'), JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: true } } }))
    const catalog = await runScheduledTaskOptionsWorker({
      command: process.execPath,
      args: [fileURLToPath(new URL('../../sidecar/scheduledTaskOptionsWorker.ts', import.meta.url))],
      cwd: dir,
      env: { HOME: dir, NODE_ENV: 'production', CLAUDE_CONFIG_DIR: config, DISABLE_TELEMETRY: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' },
    })
    const options = await new ScheduledTaskOptionsService(async () => catalog,
      path => ({ ok: true, realpath: realpathSync(path) })).read()
    expect(options.error).toBeUndefined()
    expect(options.models.length).toBeGreaterThan(0)
    installBridge({ snapshot: { tasks: [], runs: [] }, commands: [], options, respond: () => ({ ok: false, error: 'unused' }) })
    const tree = await mount()
    await click(listRow(tree, 'New task'))
    await click(field(tree, 'Model'))
    expect(menuOptions(tree)).toEqual(['Default', ...options.models.map(model => model.label)])
    await click(button(tree, options.models[0]!.label))
    await click(field(tree, 'Effort'))
    expect(menuOptions(tree).length).toBe(options.models[0]!.effortOptions.length + 1)
    await click(button(tree, 'Default'))
    await choose(tree, 'Project', 'standalone-project')
    await type(field(tree, 'Name'), 'Independent')
    await type(field(tree, 'Instructions'), 'Inspect this project')
    expect(button(tree, 'Create task').disabled).toBe(false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 20_000)

test('a failed refresh keeps the last-good choices and leaves editing and saving available', async () => {
  const state: Bridge = {
    snapshot: { tasks: [], runs: [] }, commands: [],
    respond: () => ({ ok: true, snapshot: { tasks: [task()], runs: [] } }),
  }
  installBridge(state)
  const tree = await mount()
  await click(listRow(tree, 'New task'))
  await type(field(tree, 'Name'), 'Nightly review')
  await type(field(tree, 'Instructions'), 'Review the diff')
  await choose(tree, 'Project', 'cat-code')
  await choose(tree, 'Model', 'GPT-6 Sol')
  await choose(tree, 'Effort', 'High')
  state.readOptions = async () => ({ models: [], defaultEffortOptions: [], projects: [], error: 'Catalog read failed' })
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  await flush()
  expect(alerts(tree).join(' ')).toContain('Models and projects may be out of date.')
  expect(field<HTMLButtonElement>(tree, 'Model').disabled).toBe(false)
  expect(field<HTMLButtonElement>(tree, 'Effort').disabled).toBe(false)
  expect(field(tree, 'Model').textContent).toBe('GPT-6 Sol')
  expect(field(tree, 'Effort').textContent).toBe('High')
  expect(button(tree, 'Create task').disabled).toBe(false)
  await click(button(tree, 'Create task'))
  expect(state.commands[0]).toMatchObject({ type: 'save', task: { workspaceId: PROJECT.workspaceId, model: 'gpt-6-sol', effort: 'high' } })
})

test('a cached last-good catalog is usable on a new mount and explicit refresh bypasses the cache', async () => {
  const requests: Array<{ refresh: true } | undefined> = []
  const state: Bridge = {
    snapshot: { tasks: [], runs: [] }, commands: [],
    readOptions: async request => {
      requests.push(request)
      return {
        models: MODELS, defaultEffortOptions: ['high'], projects: [PROJECT], updatedAt: request ? Date.now() : Date.now() - 3600_000,
        ...(request ? {} : { error: 'Catalog read failed' }),
      }
    },
    respond: () => ({ ok: false, error: 'unused' }),
  }
  installBridge(state)
  const tree = await mount()
  await click(listRow(tree, 'New task'))
  expect(field<HTMLButtonElement>(tree, 'Model').disabled).toBe(false)
  expect(alerts(tree).join(' ')).toContain('Models and projects may be out of date.')
  await click(field(tree, 'Model'))
  expect(menuOptions(tree)).toEqual(['Default', 'GPT-6 Sol', 'Haiku'])
  await click(button(tree, 'Haiku'))
  await click(button(tree, 'Refresh choices'))
  expect(requests).toEqual([undefined, { refresh: true }])
  expect(alerts(tree)).toEqual([])
})

test('preset eligibility loads on page entry and overlapping editor/window signals share one read', async () => {
  let reads = 0
  let release!: (options: ScheduledTaskOptions) => void
  const state: Bridge = {
    snapshot: { tasks: [task()], runs: [] }, commands: [],
    readOptions: () => { reads++; return new Promise(resolve => { release = resolve }) },
    respond: () => ({ ok: false, error: 'unused' }),
  }
  installBridge(state)
  const tree = await mount()
  await click(listRow(tree, 'Nightly review'))
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  await flush()
  expect(reads).toBe(1)
  await click(button(tree, 'Edit'))
  expect(reads).toBe(1)
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
    release({ models: MODELS, defaultEffortOptions: [], projects: [PROJECT] })
  })
  await flush()
  expect(reads).toBe(1)
})

test('an aged catalog that loaded successfully raises no alert and adds no header control', async () => {
  installBridge({
    snapshot: { tasks: [], runs: [] }, commands: [],
    options: { models: MODELS, defaultEffortOptions: [], projects: [PROJECT], updatedAt: Date.now() - SCHEDULED_OPTIONS_CACHE_MS - 1 },
    respond: () => ({ ok: false, error: 'unused' }),
  })
  const tree = await mount()
  await click(listRow(tree, 'New task'))
  expect(alerts(tree)).toEqual([])
  expect(field<HTMLButtonElement>(tree, 'Model').disabled).toBe(false)
  expect(buttons(tree, 'Refresh choices')).toHaveLength(0)
})
