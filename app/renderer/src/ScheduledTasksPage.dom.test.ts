import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, createElement } from 'react'
import { ScheduledTasksPage } from './ScheduledTasksPage.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { sessionDescriptor } from './sessionDescriptorFixture.js'
import type { ScheduledTaskCommand } from '../../shared/scheduledTasks.js'

let harness: DomTestHarness
let previousBridge: typeof window.catcode | undefined
beforeAll(async () => { harness = await createDomTestHarness(); previousBridge = window.catcode })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { if (previousBridge) window.catcode = previousBridge; else delete (window as unknown as Record<string, unknown>).catcode; await harness.teardown() })

test('saving a task carries selected project identity, and a refused save keeps the user draft for retry', async () => {
  const commands: ScheduledTaskCommand[] = []
  window.catcode = { readScheduledTasks: async () => ({ tasks: [], runs: [] }), scheduledTask: async (command: ScheduledTaskCommand) => { commands.push(command); return { ok: false, error: 'Choose the folder again' } } } as unknown as typeof window.catcode
  const row = { ...sessionDescriptor(crypto.randomUUID()), cwd: '/project', binding: { kind: 'project' as const } }
  const tree = await harness.mount(createElement(ScheduledTasksPage, { sessions: [row], onOpenSession: () => {} }))
  const button = (label: string) => [...tree.container.querySelectorAll<HTMLButtonElement>('button')].find(entry => entry.textContent === label)!
  await act(async () => button('New task').click())
  const form = tree.container.querySelector('form')!
  const fields = form.querySelectorAll<HTMLInputElement>('input')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(fields[0], 'Maintain maps')
    fields[0]!.dispatchEvent(new Event('input', { bubbles: true }))
    const prompt = form.querySelector('textarea')!
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(prompt, 'Read source and refresh maps')
    prompt.dispatchEvent(new Event('input', { bubbles: true }))
    const project = form.querySelector('select')!
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(project, row.appSessionId)
    project.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(commands).toHaveLength(1)
  const saved = commands[0]!
  expect(saved.type).toBe('save')
  if (saved.type === 'save') { expect(saved.task.workspaceSessionId).toBe(row.appSessionId); expect(saved.task.prompt).toBe('Read source and refresh maps'); expect(saved.task).not.toHaveProperty('cwd') }
  expect(tree.container.querySelector('[role="alert"]')?.textContent).toBe('Choose the folder again')
  expect(form.querySelector('textarea')?.value).toBe('Read source and refresh maps')
  expect(button('Save task').disabled).toBe(false)
})
