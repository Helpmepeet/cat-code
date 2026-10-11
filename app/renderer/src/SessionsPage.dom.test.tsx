import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { SessionsPage } from './SessionsPage.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import type { MergedSessionRow } from './sessionsCatalogState.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })

function row(sessionId: string, overrides: Partial<MergedSessionRow> = {}): MergedSessionRow {
  return {
    sessionId,
    appSessionId: `app-${sessionId}`,
    cwd: '/work/project',
    cwdExists: true,
    title: sessionId,
    displayLabel: sessionId,
    name: null,
    live: true,
    restorable: false,
    parked: false,
    status: 'ready',
    inRegistry: true,
    modifiedAtMs: 1000,
    createdAtMs: 1000,
    lastMessageSentAt: null,
    transcriptActivityAtMs: 1000,
    gitBranch: null,
    tag: null,
    mode: null,
    agentSetting: null,
    prNumber: null,
    prRepository: null,
    ...overrides,
  }
}

function page(rows: MergedSessionRow[], extra: Partial<Parameters<typeof SessionsPage>[0]> = {}) {
  return <SessionsPage rows={rows} activeCwd={null} catalogLoaded truncated={false}
    onOpenRow={() => {}} onNewSession={() => {}} {...extra} />
}

function openButton(container: HTMLElement, label: string): HTMLButtonElement | null {
  return container.querySelector(`[aria-label="Open session ${label}"]`)
}

function tagFilter(container: HTMLElement, tag: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.textContent?.trim() === `#${tag}` && button.title !== 'Edit tag')
}

test('missing project rows cannot open, while live sessions and managed recovery remain reachable', async () => {
  const opened: string[] = []
  const rows = [
    row('Gone history', { appSessionId: null, inRegistry: false, live: false, status: 'history', cwdExists: false }),
    row('Gone desktop', { live: false, restorable: true, status: 'exited', cwdExists: false }),
    row('Live desktop', { cwdExists: false }),
    row('Managed recovery', {
      live: false, restorable: true, status: 'exited', cwdExists: false,
      binding: { kind: 'managed', storageRootId: '00000000-0000-4000-8000-000000000001', storageId: '00000000-0000-4000-8000-000000000002' },
    }),
  ]
  const tree = await harness.mount(page(rows, { onOpenRow: target => { opened.push(target.sessionId) } }))

  expect(openButton(tree.container, 'Gone history') === null).toBe(true)
  expect(openButton(tree.container, 'Gone desktop') === null).toBe(true)
  expect(tree.container.textContent).toContain('Gone history')
  expect(tree.container.textContent).toContain('Gone desktop')
  await act(async () => {
    openButton(tree.container, 'Live desktop')!.click()
    openButton(tree.container, 'Managed recovery')!.click()
  })
  expect(opened).toEqual(['Live desktop', 'Managed recovery'])
})

test('confirmed tag changes immediately update tag filters and search before the catalog refresh', async () => {
  const rows = [row('Changed session', { tag: 'old' }), row('Existing session', { tag: 'new' })]
  const tree = await harness.mount(page(rows))
  await tree.render(page(rows, { tagEcho: { entries: [{ sessionIds: ['Changed session'], tag: 'new' }] } }))

  await act(async () => tagFilter(tree.container, 'new')!.click())
  expect(openButton(tree.container, 'Changed session')).not.toBeNull()
  expect(openButton(tree.container, 'Existing session')).not.toBeNull()
  expect(tagFilter(tree.container, 'old')).toBeUndefined()

  await act(async () => {
    [...tree.container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === 'All')!.click()
  })
  const search = tree.container.querySelector<HTMLInputElement>('input[placeholder="Search sessions…"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'new')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(openButton(tree.container, 'Changed session')).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'old')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(openButton(tree.container, 'Changed session')).toBeNull()
})

test('a newly confirmed tag becomes a filter and clearing it removes that filter', async () => {
  const rows = [row('Changed session')]
  const tree = await harness.mount(page(rows))
  await tree.render(page(rows, { tagEcho: { entries: [{ sessionIds: ['Changed session'], tag: 'novel' }] } }))
  expect(tagFilter(tree.container, 'novel')).toBeDefined()
  await act(async () => tagFilter(tree.container, 'novel')!.click())
  expect(openButton(tree.container, 'Changed session')).not.toBeNull()

  await tree.render(page(rows, { tagEcho: { entries: [{ sessionIds: ['Changed session'], tag: null }] } }))
  expect(tagFilter(tree.container, 'novel')).toBeUndefined()
  expect(openButton(tree.container, 'Changed session')).not.toBeNull()
})
