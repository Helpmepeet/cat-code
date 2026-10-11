/** DOM owns the keyboard/disclosure and pane measurement risks; selector tests own lifecycle joins. */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act, createElement, useState } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { placeSubagentTooltip } from './subagentDockLayout.js'
import { SubagentDock } from './SubagentDock.js'
import { animateDockMorph, dockMorphStart } from './subagentDockMotion.js'
import type { DerivedSubagentDock, SubagentDockRow } from './subagentDockState.js'

let harness: DomTestHarness
let width = 1600
let height = 600
let reduced = false
let dialogs = 0
const observers = new Set<() => void>()
let oldObserver: typeof ResizeObserver
let oldMatchMedia: typeof window.matchMedia

beforeAll(async () => {
  harness = await createDomTestHarness()
  oldObserver = globalThis.ResizeObserver
  oldMatchMedia = window.matchMedia
  globalThis.ResizeObserver = class {
    callback: () => void
    constructor(callback: () => void) { this.callback = callback }
    observe() { observers.add(this.callback) }
    unobserve() {}
    disconnect() { observers.delete(this.callback) }
  } as unknown as typeof ResizeObserver
  window.matchMedia = (() => ({ matches: reduced, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
})
beforeEach(() => { width = 1600; height = 600; reduced = false; dialogs = 0 })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { globalThis.ResizeObserver = oldObserver; window.matchMedia = oldMatchMedia; await harness.teardown() })

function row(overrides: Partial<SubagentDockRow> = {}): SubagentDockRow {
  return {
    agentId: 'worker-a', runKey: 'run-a', toolUseId: 'tool-a', name: 'Ada', task: 'Inspect the parser', type: 'Explore', state: 'running', model: 'GPT-6.1 Sol', recordedAccount: null, usageLabel: null, verdict: null, resultSummary: null, blockReason: null, launchOrder: 0, terminalAt: null, resumedAt: null, lastSeenAt: 10, missingSince: null, settleUntil: null,
    stateWord: '', account: null, rowModel: null, stripLines: ['GPT-6.1 Sol', 'Reading the parser'], chipLines: ['GPT-6.1 Sol', 'Reading the parser'], settling: false, ...overrides,
  }
}
function state(active: SubagentDockRow[], finished: SubagentDockRow[] = []): DerivedSubagentDock {
  return { active, finished, chipFaces: active.length ? active : finished, nextUpdateAt: null }
}
function Fixture({ value, initialCollapsed = false }: { value: DerivedSubagentDock; initialCollapsed?: boolean }) {
  const [collapsed, setCollapsed] = useState(initialCollapsed)
  return createElement('section', {
    ref: (element: HTMLElement | null) => {
      if (element) element.getBoundingClientRect = () => new DOMRect(0, 0, width, height)
    },
  }, createElement(SubagentDock, { state: value, collapsed, onCollapsedChange: setCollapsed, onClearFinished() {}, onOpenWorker() {}, onOpenWorkers() { dialogs++ } }))
}
async function mount(node: ReturnType<typeof fixture>) {
  const tree = await harness.mount(node)
  await resize(width)
  return tree
}
function fixture(value: DerivedSubagentDock, initialCollapsed = false) { return createElement(Fixture, { value, initialCollapsed }) }
function button(container: HTMLElement, label: string): HTMLButtonElement {
  const element = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (!element) throw new Error(`Missing button ${label}`)
  return element
}
async function resize(nextWidth: number) {
  await act(async () => { width = nextWidth; for (const callback of observers) callback() })
}

test('pane resize selects flat panel, floating panel, and Workers fallback without using window width', async () => {
  const tree = await mount(fixture(state([row()])))
  const dock = () => tree.container.querySelector<HTMLElement>('.subagent-dock')!
  expect(dock().dataset.layout).toBe('panel')
  await resize(800)
  expect(dock().dataset.layout).toBe('chip')
  await act(async () => button(tree.container, 'Subagents: Ada, running').click())
  expect(dock().dataset.layout).toBe('floating')
  expect(document.activeElement?.getAttribute('data-dock-row')).toBe('worker-a')
  await resize(160)
  expect(dock().dataset.layout).toBe('chip')
  await act(async () => button(tree.container, 'Subagents: Ada, running').click())
  expect(dialogs).toBe(1)
  expect(dock().dataset.layout).toBe('chip')
})

test('Finished stays inert until disclosed and collapse/expand returns keyboard focus', async () => {
  const done = row({ agentId: 'worker-b', name: 'Grace', state: 'completed', stateWord: 'done', terminalAt: 20 })
  const tree = await mount(fixture(state([row()], [done])))
  const toggle = tree.container.querySelector<HTMLButtonElement>('[data-finished-toggle]')!
  const finished = button(tree.container, 'Grace, completed')
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(finished.parentElement?.hasAttribute('inert')).toBe(true)
  await act(async () => toggle.click())
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(finished.parentElement?.hasAttribute('inert')).toBe(false)
  await act(async () => button(tree.container, 'Collapse subagents').click())
  const chip = button(tree.container, 'Subagents: Ada, running')
  expect(document.activeElement === chip).toBe(true)
  await act(async () => chip.click())
  expect(document.activeElement === button(tree.container, 'Ada, running')).toBe(true)
})

test('chip remains one button and names each face, and focus links row details until Escape', async () => {
  const tree = await mount(fixture(state([row(), row({ agentId: 'worker-b', name: null, task: 'Check release', state: 'background' })]), true))
  const chip = button(tree.container, 'Subagents: Ada, running; Check release, background')
  expect(chip.querySelectorAll('button')).toHaveLength(0)
  await act(async () => chip.click())
  const active = button(tree.container, 'Ada, running')
  await act(async () => active.focus())
  const describedBy = active.getAttribute('aria-describedby')
  expect(describedBy).toBeTruthy()
  expect(document.getElementById(describedBy!)?.textContent).toBe('GPT-6.1 SolReading the parser')
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(active.hasAttribute('aria-describedby')).toBe(false)
  expect(tree.container.querySelector('[role="tooltip"]')).toBeNull()
})

test('resume from Finished preserves the row and its full arrival across unrelated rerenders', async () => {
  const completed = row({ state: 'completed', stateWord: 'done', terminalAt: 20 })
  const tree = await mount(fixture(state([], [completed])))
  const before = button(tree.container, 'Ada, completed')
  const resumed = row({ state: 'resumed', stateWord: 'resumed', runKey: 'run-b', resumedAt: 30 })
  await tree.render(fixture(state([resumed])))
  const after = button(tree.container, 'Ada, resumed')
  expect(after === before).toBe(true)
  expect(after.classList.contains('subagent-dock-arrival')).toBe(true)
  await tree.render(fixture(state([{ ...resumed, task: 'Continue the parser' }])))
  expect(after.classList.contains('subagent-dock-arrival')).toBe(true)
  expect(tree.container.querySelector('[role="status"]')?.textContent).toBe('Ada resumed.')
  await tree.render(fixture(state([])))
  await tree.render(fixture(state([{ ...resumed, runKey: 'run-c', resumedAt: 40 }])))
  expect(button(tree.container, 'Ada, resumed').classList.contains('subagent-dock-arrival')).toBe(true)
})

test('reduced motion resumes instantly and an empty dock leaves no controls', async () => {
  reduced = true
  const tree = await mount(fixture(state([], [row({ state: 'completed' })])))
  await tree.render(fixture(state([row({ state: 'resumed', stateWord: 'resumed', runKey: 'run-b', resumedAt: 30 })])))
  expect(button(tree.container, 'Ada, resumed').classList.contains('subagent-dock-arrival')).toBe(false)
  await tree.render(fixture(state([])))
  expect(tree.container.querySelector('.subagent-dock')).toBeNull()
})

// Synthetic rectangles exercise clamping; happy-dom does not calculate screen geometry.
test('row details attach on the left when possible and stay within narrow or short panes', () => {
  const roomy = placeSubagentTooltip(new DOMRect(0, 0, 1600, 600), new DOMRect(1300, 20, 280, 50), 300, 70, true)
  expect(roomy.attached).toBe(true)
  expect(roomy.left).toBe(1001)
  expect(roomy.top).toBe(20)
  expect(roomy.height).toBe(50)
  const narrow = placeSubagentTooltip(new DOMRect(0, 0, 340, 300), new DOMRect(40, 240, 280, 50), 300, 70, true)
  expect(narrow.attached).toBe(false)
  expect(narrow.left).toBe(20)
  expect(narrow.top + narrow.height).toBe(292)
  const short = placeSubagentTooltip(new DOMRect(0, 0, 160, 60), new DOMRect(24, 20, 100, 27), 260, 70, false)
  expect(short.width).toBe(144)
  expect(short.left).toBe(8)
  expect(short.height).toBe(44)
  expect(short.top).toBe(8)
})


test('closing an inert panel keeps live faces and names travelling and excludes undisclosed Finished rows', () => {
  const originalAnimate = HTMLElement.prototype.animate
  HTMLElement.prototype.animate = function () { return { cancel() {} } as Animation }
  const root = document.createElement('div')
  document.body.append(root)
  root.innerHTML = '<button class="chip"><span data-dock-face="a">a</span></button><div class="panel" inert><div><button data-dock-row="a"><span data-dock-face="a">a</span><span class="subagent-dock-name">Ada</span></button></div><div inert><button data-dock-row="b"><span data-dock-face="b">b</span><span class="subagent-dock-name">Grace</span></button></div></div>'
  let cancel: (() => void) | undefined
  try {
    const panel = root.querySelector<HTMLElement>('.panel')!
    const start = dockMorphStart(root.querySelector<HTMLElement>('.chip')!)
    cancel = animateDockMorph(root, panel, start, false, () => {})
    expect([...root.querySelectorAll('.subagent-dock-flyer')].map(element => element.textContent)).toEqual(['a', 'Ada'])
    cancel()
    panel.removeAttribute('inert')
    cancel = animateDockMorph(root, panel, start, true, () => {})
    expect([...root.querySelectorAll('.subagent-dock-flyer')].map(element => element.textContent)).toEqual(['a', 'Ada'])
  } finally {
    cancel?.()
    root.remove()
    HTMLElement.prototype.animate = originalAnimate
  }
})
