import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { createElement, type ComponentProps } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { Sidebar } from './Sidebar.js'
import { TabBar, type TabModel } from './TabBar.js'
import { sessionDescriptor } from './sessionDescriptorFixture.js'
import type { MergedSessionRow } from './sessionsCatalogState.js'

let harness: DomTestHarness
const noop = () => {}
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })

// Observe work inside the real components, not wrapper renders or DOM mutations.
// A memo bailout must not even read the roster during an unrelated parent update.
function observedArray<T>(values: T[]) {
  let reads = 0
  const array = new Proxy(values, {
    get(target, key, receiver) {
      reads += 1
      return Reflect.get(target, key, receiver)
    },
  })
  return { array, reads: () => reads }
}

test('TabBar skips unchanged shell inputs and installs changed action closures', async () => {
  const roster = observedArray<TabModel>([{
    descriptor: sessionDescriptor('one'),
    visual: { label: 'ready', tone: 'live', restartable: false, needsAttention: false },
  }])
  let selected = ''
  const props: ComponentProps<typeof TabBar> = {
    tabs: roster.array, activeSessionId: 'one', onSelect: noop,
    onClose: noop, onRestart: noop, onNewTab: noop,
  }
  const tree = await harness.mount(createElement(TabBar, props))
  const reads = roster.reads()
  for (let token = 0; token < 10; token++) {
    await tree.render(createElement(TabBar, { ...props }))
  }
  expect(roster.reads()).toBe(reads)
  await tree.render(createElement(TabBar, {
    ...props, onSelect: id => { selected = `new:${id}` },
  }))
  expect(roster.reads()).toBeGreaterThan(reads)
  tree.container.querySelector<HTMLElement>('[role="tab"]')!.click()
  expect(selected).toBe('new:one')
})

test('Sidebar skips unchanged shell inputs but renders roster changes', async () => {
  const roster = observedArray<MergedSessionRow>([])
  const props: ComponentProps<typeof Sidebar> = {
    rows: roster.array, activeSessionId: null, activeView: 'chat',
    onSelectView: noop, onSelectLive: noop, onRestore: noop,
    onOpenHistory: noop, storage: null,
  }
  const tree = await harness.mount(createElement(Sidebar, props))
  const reads = roster.reads()
  for (let token = 0; token < 10; token++) {
    await tree.render(createElement(Sidebar, { ...props }))
  }
  expect(roster.reads()).toBe(reads)
  const replacement = observedArray<MergedSessionRow>([])
  await tree.render(createElement(Sidebar, { ...props, rows: replacement.array }))
  expect(replacement.reads()).toBeGreaterThan(0)
})
