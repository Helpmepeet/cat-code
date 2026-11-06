import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, createElement } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { Sidebar } from './Sidebar.js'
import { TabBar, type TabModel } from './TabBar.js'
import { sessionDescriptor } from './sessionDescriptorFixture.js'

let harness: DomTestHarness
const noop = () => {}
const tip = () => document.body.querySelector<HTMLElement>('[role="tooltip"]')
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })

test('rail labels show account sign-in details, hide on leave, and follow focus', async () => {
  const tree = await harness.mount(createElement(Sidebar, {
    rows: [], activeSessionId: null, activeView: 'chat', accountsNeedingSignIn: 2,
    onSelectView: noop, onSelectLive: noop, onRestore: noop, onOpenHistory: noop, storage: null,
  }))
  const accounts = tree.container.querySelector<HTMLButtonElement>('[data-sidebar-nav-id="accounts"]')!
  expect(accounts.title).toBe('')
  await act(async () => {
    accounts.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    await wait(120)
  })
  expect(tip()?.textContent).toBe('Accounts, 2 Codex accounts need sign-in')
  expect(tip()?.parentElement).toBe(document.body)
  await act(async () => { accounts.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
  expect(tip()).toBeNull()
  const goals = tree.container.querySelector<HTMLButtonElement>('[data-sidebar-nav-id="goals"]')!
  await act(async () => { goals.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
  expect(tip()?.textContent).toBe('Goals')
  await act(async () => { goals.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
  // Focus is handed from the collapsed rail to the corresponding expanded item.
  await act(async () => { accounts.focus() })
  expect(tip()?.textContent).toBe('Accounts, 2 Codex accounts need sign-in')
  await act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  expect(tip()).toBeNull()
})

test('tab tooltips show full title, session name, folder, shortcut and fork state; managed chats omit folder', async () => {
  const normal: TabModel = {
    descriptor: sessionDescriptor('normal', { title: 'A long full session title', cwd: '/work/project-name', forked: true, name: 'Bear' }),
    visual: { label: 'ready', tone: 'live', restartable: false, needsAttention: false },
  }
  const managed: TabModel = {
    ...normal,
    descriptor: sessionDescriptor('managed', { title: 'Managed chat', cwd: '/secret/storage-name', name: 'Otter', binding: { kind: 'managed', storageRootId: 'root', storageId: 'id' } }),
  }
  const tree = await harness.mount(createElement(TabBar, {
    tabs: [normal, managed], activeSessionId: 'normal', onSelect: noop, onClose: noop, onRestart: noop, onNewTab: noop,
  }))
  const tabs = tree.container.querySelectorAll<HTMLElement>('[role="tab"]')
  expect(tabs[0]!.getAttribute('title')).toBeNull()
  await act(async () => { tabs[0]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
  expect(tip()).toBeNull()
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  await act(async () => { await wait(370) })
  expect(tip()).toBeNull()
  await act(async () => {
    tabs[0]!.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
    tabs[0]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  })
  await act(async () => { await wait(370) })
  expect(tip()?.textContent).toBe('A long full session titleBearproject-nameForked session⌘1')
  expect(tip()?.parentElement).toBe(document.body)
  await act(async () => {
    tabs[0]!.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
    tabs[1]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  })
  expect(tip()?.textContent).toBe('Managed chatOtter⌘2')
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  expect(tip()).toBeNull()
  await act(async () => { tabs[0]!.focus() })
  expect(tip()?.textContent).toContain('A long full session title')
  await act(async () => { tabs[0]!.click() })
  expect(tip()).toBeNull()
})

test('tabs after the ninth omit shortcuts and managed chats omit empty metadata', async () => {
  const tabs: TabModel[] = Array.from({ length: 10 }, (_, index) => ({
    descriptor: sessionDescriptor(`chat-${index}`, index === 9
      ? { title: 'Tenth chat', cwd: '/managed/path', binding: { kind: 'managed', storageRootId: 'root', storageId: 'id' } }
      : {}),
    visual: { label: 'ready', tone: 'live', restartable: false, needsAttention: false },
  }))
  const tree = await harness.mount(createElement(TabBar, {
    tabs, activeSessionId: 'chat-9', onSelect: noop, onClose: noop, onRestart: noop, onNewTab: noop,
  }))
  await act(async () => { tree.container.querySelectorAll<HTMLElement>('[role="tab"]')[9]!.focus() })
  expect(tip()?.textContent).toBe('Tenth chat')
  expect(tip()?.children).toHaveLength(1)
})
