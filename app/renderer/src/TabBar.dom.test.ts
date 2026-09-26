import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { createElement } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { sessionDescriptor } from './sessionDescriptorFixture.js'
import { TabBar, type TabModel } from './TabBar.js'

let harness: DomTestHarness
const noop = () => {}

function tab(id: string): TabModel {
  return {
    descriptor: sessionDescriptor(id),
    visual: { label: 'ready', tone: 'live', restartable: false, needsAttention: false },
  }
}

function bar(tabs: TabModel[], activeSessionId: string | null) {
  return createElement(TabBar, {
    tabs, activeSessionId, onSelect: noop, onClose: noop,
    onRestart: noop, onNewTab: noop,
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

test('roster hydration stays still; a later new tab enters for one render', async () => {
  const first = tab('first')
  const second = tab('second')
  const later = tab('later')
  const tree = await harness.mount(bar([], null))
  await tree.render(bar([first, second], 'first'))
  expect(tree.container.querySelectorAll('.animate-tab-in')).toHaveLength(0)

  await tree.render(bar([first, second, later], 'later'))
  const entering = tree.container.querySelectorAll<HTMLElement>('[role="tab"].animate-tab-in')
  expect(entering).toHaveLength(1)
  expect(entering[0]?.getAttribute('aria-label')).toContain('later')

  await tree.render(bar([first, second, later], 'later'))
  expect(tree.container.querySelectorAll('.animate-tab-in')).toHaveLength(0)
  await tree.unmount()

  const remounted = await harness.mount(bar([first, second, later], 'later'))
  expect(remounted.container.querySelectorAll('.animate-tab-in')).toHaveLength(0)
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
