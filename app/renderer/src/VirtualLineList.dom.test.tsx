import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { VirtualLineList } from './VirtualLineList.js'
import { SourceTextView } from './SourceTextView.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'

let harness: DomTestHarness
let width = 600
let height = 100
let firstRowHeight = 60
let renders = 0
const frames = new Map<number, FrameRequestCallback>()
let nextFrame = 0
const observers = new Set<ControlledResizeObserver>()
class ControlledResizeObserver {
  nodes = new Set<Element>()
  constructor(readonly callback: ResizeObserverCallback) { observers.add(this) }
  observe(node: Element) { this.nodes.add(node) }
  unobserve(node: Element) { this.nodes.delete(node) }
  disconnect() { this.nodes.clear(); observers.delete(this) }
}
const saved: Array<() => void> = []
function replace(object: object, key: string, descriptor: PropertyDescriptor) {
  const previous = Object.getOwnPropertyDescriptor(object, key)
  Object.defineProperty(object, key, { configurable: true, ...descriptor })
  saved.push(() => { if (previous) Object.defineProperty(object, key, previous); else Reflect.deleteProperty(object, key) })
}
beforeAll(async () => {
  harness = await createDomTestHarness()
  replace(globalThis, 'ResizeObserver', { value: ControlledResizeObserver })
  replace(globalThis, 'requestAnimationFrame', { value: (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame } })
  replace(globalThis, 'cancelAnimationFrame', { value: (id: number) => frames.delete(id) })
  replace(HTMLElement.prototype, 'clientWidth', { get: () => width })
  replace(HTMLElement.prototype, 'clientHeight', { get: () => height })
  replace(HTMLElement.prototype, 'scrollHeight', { get(this: HTMLElement) {
    if (!width || !height) return 0
    return this.querySelector('[data-index="0"]') ? firstRowHeight : 20
  } })
})
afterEach(async () => {
  await harness.unmountAll()
  frames.clear()
  width = 600; height = 100; firstRowHeight = 60; renders = 0
})
afterAll(async () => { for (const restore of saved.reverse()) restore(); await harness.teardown() })
async function flushFrames() {
  await act(async () => {
    const pending = [...frames.values()]
    frames.clear()
    for (const callback of pending) callback(0)
  })
}
async function resize(root: Element, rows = false) {
  await act(async () => {
    for (const observer of observers) {
      if (rows || observer.nodes.has(root)) observer.callback([], observer as unknown as ResizeObserver)
    }
  })
}
const lines = Array.from({ length: 500 }, (_, index) => `line ${index}`)
function list(widthAffectsRowHeight?: boolean, className = 'source') {
  return <VirtualLineList lines={lines} activeIndex={null} className={className}
    widthAffectsRowHeight={widthAffectsRowHeight}
    renderLine={(_line, index) => { renders++; return <span data-index={index}>{index}</span> }} />
}
async function scroll(root: HTMLElement, top: number) {
  await act(async () => { root.scrollTop = top; root.dispatchEvent(new Event('scroll')) })
}
function topSpacer(root: HTMLElement) { return (root.firstElementChild as HTMLElement).style.height }
function firstIndex(root: HTMLElement) { return root.querySelector('[data-index]')!.getAttribute('data-index') }

test('width-independent rows retain offscreen geometry and do not render during width-only resizing or hide/reveal', async () => {
  const tree = await harness.mount(list(false))
  const root = tree.container.firstElementChild as HTMLElement
  await flushFrames()
  await scroll(root, 3000)
  await flushFrames()
  const spacer = topSpacer(root)
  const index = firstIndex(root)
  const count = renders
  for (const next of [550, 450, 300]) { width = next; await resize(root, true); await flushFrames() }
  expect(renders).toBe(count)
  expect(topSpacer(root)).toBe(spacer)
  expect(firstIndex(root)).toBe(index)
  width = 0; height = 0
  await resize(root, true); await flushFrames()
  expect(renders).toBe(count)
  expect(topSpacer(root)).toBe(spacer)
  width = 300; height = 100
  await resize(root, true); await flushFrames()
  expect(renders).toBe(count)
  expect(topSpacer(root)).toBe(spacer)
  expect(firstIndex(root)).toBe(index)
  const mounted = root.querySelectorAll('[data-index]').length
  height = 800
  await resize(root); await flushFrames()
  expect(root.querySelectorAll('[data-index]').length).toBeGreaterThan(mounted)
  expect(root.scrollTop).toBe(3000)
})

test('conservative default retains hidden measurements but invalidates offscreen wrapped geometry on actual width changes', async () => {
  const tree = await harness.mount(list())
  const root = tree.container.firstElementChild as HTMLElement
  await flushFrames()
  await scroll(root, 3000); await flushFrames()
  const spacer = topSpacer(root)
  const index = firstIndex(root)
  const count = renders
  width = 0; height = 0
  await resize(root, true); await flushFrames()
  width = 600; height = 100
  await resize(root, true); await flushFrames()
  expect(topSpacer(root)).toBe(spacer)
  expect(renders).toBe(count)
  width = 400
  await resize(root); await flushFrames()
  expect(firstIndex(root)).not.toBe(index)
  expect(renders).toBeGreaterThan(count)
})

test('wrap toggles invalidate geometry and remeasure mounted rows even without a row resize notification', async () => {
  const tree = await harness.mount(list(false))
  const root = tree.container.firstElementChild as HTMLElement
  await flushFrames()
  expect(root.firstElementChild!.className).toBe('')
  firstRowHeight = 100
  await tree.render(list(true, 'source wrapped'))
  expect(root.firstElementChild!.className).toContain('min-h')
  await flushFrames()
  expect(root.firstElementChild!.className).toBe('')
  await scroll(root, 3000); await flushFrames()
  const wrappedIndex = firstIndex(root)
  firstRowHeight = 20
  await tree.render(list(false))
  await flushFrames()
  expect(firstIndex(root)).not.toBe(wrappedIndex)
  const count = renders
  width = 350
  await resize(root); await flushFrames()
  expect(renders).toBe(count)
})

test('SourceTextView opts out only while unwrapped and preserves the search input across resizing', async () => {
  const view = (wrap: boolean) => <SourceTextView lines={lines} body={lines.join('\n')} copy=""
    gutter={index => { renders++; return index + 1 }} language={null} diffRows={null}
    wrap={wrap} onWrap={() => {}} subject="file" />
  const tree = await harness.mount(view(false))
  const root = tree.container.querySelector<HTMLElement>('[role="region"]')!
  await flushFrames()
  const input = tree.container.querySelector('[aria-label="Search file"]')
  const count = renders
  width = 400
  await resize(root); await flushFrames()
  expect(renders).toBe(count)
  expect(tree.container.querySelector('[aria-label="Search file"]')).toBe(input)
  await tree.render(view(true)); await flushFrames()
  const wrappedCount = renders
  width = 300
  await resize(root); await flushFrames()
  expect(renders).toBeGreaterThan(wrappedCount)
})
