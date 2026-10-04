import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, createElement } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { sessionDescriptor } from './sessionDescriptorFixture.js'
import { TabBar, type TabBarEntry, type TabModel } from './TabBar.js'
import type { NavigationTarget } from './pageTabNavigation.js'

let harness: DomTestHarness
const noop = () => {}

function tab(id: string): TabModel {
  return {
    descriptor: sessionDescriptor(id),
    visual: { label: 'ready', tone: 'live', restartable: false, needsAttention: false },
  }
}

function bar(tabs: TabModel[], activeSessionId: string | null, rosterReady = true) {
  return createElement(TabBar, {
    tabs, activeSessionId, onSelect: noop, onClose: noop,
    onRestart: noop, onNewTab: noop, rosterReady,
  })
}

beforeAll(async () => {
  harness = await createDomTestHarness()
})

afterEach(async () => {
  await harness.unmountAll()
})

afterAll(async () => {
  await harness.teardown()
})

test('roster hydration stays still; a later new tab keeps its entrance through rerenders', async () => {
  const first = tab('first')
  const second = tab('second')
  const later = tab('later')
  const tree = await harness.mount(bar([], null, false))
  await tree.render(bar([first, second], 'first', true))
  expect(tree.container.querySelectorAll('.animate-tab-in')).toHaveLength(0)

  await tree.render(bar([first, second, later], 'later'))
  const entering = tree.container.querySelectorAll<HTMLElement>('[role="tab"].animate-tab-in')
  expect(entering).toHaveLength(1)
  expect(entering[0]?.getAttribute('aria-label')).toContain('later')

  await tree.render(bar([first, second, later], 'later'))
  expect(tree.container.querySelectorAll('.animate-tab-in')).toHaveLength(1)
  await act(async () => {
    tree.container.querySelector('[role="tab"].animate-tab-in')?.dispatchEvent(
      new Event('animationend', { bubbles: true }),
    )
  })
  expect(tree.container.querySelectorAll('.animate-tab-in')).toHaveLength(0)
  await tree.unmount()

  const remounted = await harness.mount(bar([first, second, later], 'later'))
  expect(remounted.container.querySelectorAll('.animate-tab-in')).toHaveLength(0)
})

test('a first tab added after an empty roster has hydrated enters once', async () => {
  const first = tab('first')
  const tree = await harness.mount(bar([], null, false))
  await tree.render(bar([], null, true))
  expect(tree.container.querySelector('.animate-tab-in')).toBeNull()
  await tree.render(bar([first], 'first', true))
  expect(tree.container.querySelectorAll('.animate-tab-in')).toHaveLength(1)
  await tree.unmount()
  const remounted = await harness.mount(bar([first], 'first', true))
  expect(remounted.container.querySelector('.animate-tab-in')).toBeNull()
})

test('the selected tab scrolls into view with reduced-motion-aware behavior', async () => {
  const calls: Array<{ label: string | null; options: ScrollIntoViewOptions }> = []
  const originalScroll = HTMLElement.prototype.scrollIntoView
  const originalMatchMedia = window.matchMedia
  HTMLElement.prototype.scrollIntoView = function (options?: boolean | ScrollIntoViewOptions) {
    calls.push({ label: this.getAttribute('aria-label'), options: options as ScrollIntoViewOptions })
  }
  window.matchMedia = (() => ({
    matches: false, addEventListener: noop, removeEventListener: noop,
  })) as unknown as typeof window.matchMedia
  try {
    const first = tab('first')
    const second = tab('second')
    const tree = await harness.mount(bar([first, second], 'first'))
    calls.length = 0
    await tree.render(bar([first, second], 'second'))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.label).toContain('second')
    expect(calls[0]?.options).toMatchObject({ inline: 'nearest', behavior: 'smooth' })

    window.matchMedia = (() => ({
      matches: true, addEventListener: noop, removeEventListener: noop,
    })) as unknown as typeof window.matchMedia
    await tree.render(bar([first, second], 'first'))
    expect(calls.at(-1)?.options).toMatchObject({ inline: 'nearest', behavior: 'instant' })
  } finally {
    HTMLElement.prototype.scrollIntoView = originalScroll
    window.matchMedia = originalMatchMedia
  }
})

test('mixed tabs expose one selection and page close intent without session controls', async () => {
  const first = tab('first')
  const entries: TabBarEntry[] = [
    { kind: 'session', model: first },
    { kind: 'page', page: 'accounts' },
  ]
  const selected: NavigationTarget[] = []
  const closed: NavigationTarget[] = []
  const tree = await harness.mount(createElement(TabBar, {
    tabs: [first],
    navigationTabs: entries,
    selectedTarget: { kind: 'page', page: 'accounts' },
    onSelect: noop,
    onClose: noop,
    onSelectTarget: target => selected.push(target),
    onCloseTarget: target => closed.push(target),
    onOpenActions: noop,
    onAddPanel: noop,
    panelCount: 2,
    canAddPanel: true,
    onRestart: noop,
    onNewTab: noop,
  }))

  const tabs = [...tree.container.querySelectorAll<HTMLElement>('[role="tab"]')]
  expect(tabs.map(element => element.getAttribute('aria-selected'))).toEqual(['false', 'true'])
  expect(tabs.map(element => element.tabIndex)).toEqual([-1, 0])
  expect(tabs[1]?.getAttribute('aria-label')).toBe('Accounts page')
  expect(tabs[1]?.getAttribute('draggable')).toBeNull()
  expect(tabs[1]?.getAttribute('title')).toContain('⌘2')
  expect(tabs[1]?.querySelector('[title="Restart this session"]')).toBeNull()
  expect(tabs[1]?.querySelector('[title="Session actions"]')).toBeNull()
  expect(tree.container.querySelector('[aria-label="Split view"]')).toBeNull()

  await act(async () => {
    tabs[1]?.querySelector<HTMLButtonElement>('[aria-label="Close Accounts page"]')?.click()
  })
  expect(closed).toEqual([{ kind: 'page', page: 'accounts' }])

  await act(async () => {
    tabs[1]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
  })
  expect(selected).toEqual([{ kind: 'session', sessionId: 'first' }])
  await act(async () => { tabs[0]?.click() })
  expect(selected).toEqual([
    { kind: 'session', sessionId: 'first' },
    { kind: 'session', sessionId: 'first' },
  ])
  await act(async () => { tabs[0]?.querySelector<HTMLButtonElement>('[aria-label="Close session first"]')?.click() })
  expect(closed.at(-1)).toEqual({ kind: 'session', sessionId: 'first' })
})

test('mixed navigation does not mark retained session context selected when selection is empty', async () => {
  const retainedContext = tab('retained-context')
  const tree = await harness.mount(createElement(TabBar, {
    tabs: [retainedContext],
    navigationTabs: [{ kind: 'session', model: retainedContext }],
    selectedTarget: null,
    activeSessionId: 'retained-context',
    onSelect: noop,
    onClose: noop,
    onRestart: noop,
    onNewTab: noop,
  }))

  expect(tree.container.querySelector('[role="tab"]')?.getAttribute('aria-selected')).toBe('false')
})


test('a newly opened page enters once and retains its mixed keyboard slot', async () => {
  const first = tab('first')
  const props = { tabs: [first], onSelect: noop, onClose: noop, onRestart: noop, onNewTab: noop }
  const tree = await harness.mount(createElement(TabBar, { ...props,
    navigationTabs: [{ kind: 'session', model: first }], selectedTarget: { kind: 'session', sessionId: 'first' },
  }))
  const withPage = () => createElement(TabBar, { ...props,
    navigationTabs: [{ kind: 'session', model: first }, { kind: 'page', page: 'goals' }], selectedTarget: { kind: 'page', page: 'goals' },
  })
  await tree.render(withPage())
  await tree.render(withPage())
  const entering = tree.container.querySelectorAll('[role="tab"].animate-tab-in')
  expect(entering).toHaveLength(1)
  expect(entering[0]?.getAttribute('aria-label')).toBe('Goals page')
  await act(async () => { entering[0]?.dispatchEvent(new Event('animationend', { bubbles: true })) })
  await tree.render(withPage())
  expect(tree.container.querySelector('.animate-tab-in')).toBeNull()
})
