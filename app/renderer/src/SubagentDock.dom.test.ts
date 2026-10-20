/** DOM owns the keyboard/disclosure and pane measurement risks; selector tests own lifecycle joins. */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act, createElement, useState } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { placeSubagentTooltip } from './subagentDockLayout.js'
import { SubagentDock } from './SubagentDock.js'
import { animateDockMorph, dockMorphStart } from './subagentDockMotion.js'
import { isSubagentDockTerminal, type DerivedSubagentDock, type SubagentDockRow } from './subagentDockState.js'

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
    stateWord: '', account: null, rowModel: null, stripLines: ['GPT-6.1 Sol', 'Reading the parser'], chipLines: ['GPT-6.1 Sol', 'Reading the parser'], settling: false, runToolUseIds: [], ...overrides,
  }
}
function state(active: SubagentDockRow[], finished: SubagentDockRow[] = []): DerivedSubagentDock {
  const chipFaces = active.some(row => !isSubagentDockTerminal(row.state))
    ? active : [...active, ...finished].filter(row => row.state === 'failed')
  return { active, finished, chipFaces, nextUpdateAt: null }
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

for (const mode of ['attached', 'popover', 'chip'] as const) {
  test(`${mode} details keep their size across live updates and scrolling, and recover after pane clamping`, async () => {
    width = mode === 'attached' ? 1600 : mode === 'popover' ? 400 : 800
    const initialWidth = width
    const tree = await mount(fixture(state([row()]), mode === 'chip'))
    if (mode === 'popover') {
      await act(async () => button(tree.container, 'Subagents: Ada, running').click())
    }
    const anchor = button(tree.container, mode === 'chip' ? 'Subagents: Ada, running' : 'Ada, running')
    anchor.getBoundingClientRect = () => new DOMRect(width - (mode === 'chip' ? 40 : 300), 30, mode === 'chip' ? 16 : 280, 50)
    await act(async () => anchor.focus())
    const tip = tree.container.querySelector<HTMLElement>('[role="tooltip"]')!
    const naturalWidth = mode === 'chip' ? 214 : 242
    const naturalHeight = mode === 'chip' ? 69 : 50
    const borderWidth = () => tip.classList.contains('subagent-dock-tip-attached') ? 1 : 2
    // Model border-box layout: scroll dimensions exclude borders and reflect
    // the last assigned size. happy-dom itself does not calculate these.
    Object.defineProperties(tip, {
      offsetWidth: { get: () => Number.parseFloat(tip.style.width) || naturalWidth },
      offsetHeight: { get: () => Number.parseFloat(tip.style.height) || naturalHeight },
      scrollWidth: { get: () => (Number.parseFloat(tip.style.width) || naturalWidth) - borderWidth() },
      scrollHeight: { get: () => (Number.parseFloat(tip.style.height) || naturalHeight) - 2 },
    })
    const panel = tree.container.querySelector('.subagent-dock-panel')!
    for (let update = 0; update < 24; update++) {
      await tree.render(fixture(state([row({ stripLines: ['GPT-6.1 Sol', `Reading file ${update}`] })]), mode === 'chip'))
      expect(Number.parseFloat(tip.style.width)).toBe(naturalWidth)
      expect(tip.classList.contains('subagent-dock-tip-attached')).toBe(mode === 'attached')
      if (mode === 'attached') expect(Number.parseFloat(tip.style.height)).toBe(50)
      await act(async () => panel.dispatchEvent(new Event('scroll')))
      expect(Number.parseFloat(tip.style.width)).toBe(naturalWidth)
    }
    await resize(mode === 'attached' ? 1560 : mode === 'chip' ? 160 : 340)
    height = 60
    await resize(width)
    expect(Number.parseFloat(tip.style.width)).toBeLessThanOrEqual(width - 16)
    expect(Number.parseFloat(tip.style.maxHeight)).toBe(44)
    height = 600
    await resize(initialWidth)
    expect(Number.parseFloat(tip.style.width)).toBe(naturalWidth)
    expect(Number.parseFloat(tip.style.maxHeight)).toBe(584)
  })
}

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

for (const finishBeforeUpdate of [false, true]) {
  test(`row movement does not replay on live updates ${finishBeforeUpdate ? 'after' : 'during'} a reorder animation`, async () => {
    const originalRect = HTMLElement.prototype.getBoundingClientRect
    const originalAnimate = HTMLElement.prototype.animate
    const offsets = new Map<HTMLElement, number>()
    let animations = 0
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (!this.hasAttribute('data-dock-row')) return originalRect.call(this)
      const rows = [...this.closest('.subagent-dock-list')!.querySelectorAll('[data-dock-row]')]
      return new DOMRect(1300, rows.indexOf(this) * 50 + (offsets.get(this) ?? 0), 280, 50)
    }
    HTMLElement.prototype.animate = function (frames) {
      const transform = (frames as Keyframe[])[0]?.transform
      const offset = typeof transform === 'string' ? /^translateY\(([-\d.]+)px\)$/.exec(transform) : null
      if (this.hasAttribute('data-dock-row') && offset) {
        animations++
        offsets.set(this, Number(offset[1]))
      }
      return { cancel: () => { offsets.delete(this) } } as Animation
    }
    try {
      const ada = row()
      const grace = row({ agentId: 'worker-b', name: 'Grace', launchOrder: 1 })
      const tree = await mount(fixture(state([ada, grace])))
      expect(animations).toBe(0)
      await tree.render(fixture(state([grace, ada])))
      expect(animations).toBe(2)
      expect([...offsets.values()]).toEqual([50, -50])
      if (finishBeforeUpdate) offsets.clear()
      for (let update = 0; update < 4; update++) {
        await tree.render(fixture(state([
          { ...grace, stripLines: ['GPT-6.1 Sol', `Reading file ${update}`] },
          ada,
        ])))
        expect(animations).toBe(2)
        expect([...offsets.values()]).toEqual(finishBeforeUpdate ? [] : [50, -50])
      }
      expect([...tree.container.querySelectorAll('[data-dock-row]')].map(element => element.getAttribute('data-dock-row'))).toEqual(['worker-b', 'worker-a'])
    } finally {
      await harness.unmountAll()
      HTMLElement.prototype.getBoundingClientRect = originalRect
      HTMLElement.prototype.animate = originalAnimate
    }
  })
}

for (const movement of ['scroll', 'pane move'] as const) {
  test(`${movement} does not animate unchanged rows or distort a later reorder`, async () => {
    const originalRect = HTMLElement.prototype.getBoundingClientRect
    const originalAnimate = HTMLElement.prototype.animate
    let listTop = 100
    const moves: [string, number][] = []
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.classList.contains('subagent-dock-list')) return new DOMRect(1300, listTop, 280, 100)
      if (!this.hasAttribute('data-dock-row')) return originalRect.call(this)
      const list = this.closest<HTMLElement>('.subagent-dock-list')!
      const rows = [...list.querySelectorAll('[data-dock-row]')]
      return new DOMRect(1300, listTop + rows.indexOf(this) * 50 - list.scrollTop, 280, 50)
    }
    HTMLElement.prototype.animate = function (frames) {
      const transform = (frames as Keyframe[])[0]?.transform
      const offset = typeof transform === 'string' ? /^translateY\(([-\d.]+)px\)$/.exec(transform) : null
      if (this.dataset.dockRow && offset) moves.push([this.dataset.dockRow, Number(offset[1])])
      return { cancel() {} } as Animation
    }
    try {
      const ada = row()
      const grace = row({ agentId: 'worker-b', name: 'Grace', launchOrder: 1 })
      const linus = row({ agentId: 'worker-c', name: 'Linus', launchOrder: 2 })
      const tree = await mount(fixture(state([ada, grace, linus])))
      expect(moves).toEqual([])
      if (movement === 'scroll') tree.container.querySelector('.subagent-dock-list')!.scrollTop = 35
      else listTop += 80
      await tree.render(fixture(state([{ ...ada, task: 'Still reading' }, grace, linus])))
      expect(moves).toEqual([])
      await tree.render(fixture(state([grace, ada, linus])))
      expect(moves).toEqual([['worker-b', 50], ['worker-a', -50]])
    } finally {
      await harness.unmountAll()
      HTMLElement.prototype.getBoundingClientRect = originalRect
      HTMLElement.prototype.animate = originalAnimate
    }
  })
}

test('reduced motion resumes instantly and an empty dock leaves no controls', async () => {
  reduced = true
  const tree = await mount(fixture(state([], [row({ state: 'completed' })])))
  await tree.render(fixture(state([row({ state: 'resumed', stateWord: 'resumed', runKey: 'run-b', resumedAt: 30 })])))
  expect(button(tree.container, 'Ada, resumed').classList.contains('subagent-dock-arrival')).toBe(false)
  await tree.render(fixture(state([])))
  expect(tree.container.querySelector('.subagent-dock')).toBeNull()
})

for (const reduceMotion of [false, true]) {
  for (const terminal of ['completed', 'stopped'] as const) {
    test(`last ${terminal} face disappears without losing announcements or Finished history (reduced motion ${reduceMotion})`, async () => {
      reduced = reduceMotion
      const tree = await mount(fixture(state([row()]), true))
      await act(async () => button(tree.container, 'Subagents: Ada, running').focus())
      expect(tree.container.querySelector('[role="tooltip"]')).not.toBeNull()
      const done = row({ state: terminal, stateWord: terminal === 'completed' ? 'done' : 'stopped', settling: !reduced, terminalAt: 20 })
      await tree.render(fixture(reduced ? state([], [done]) : state([done]), true))
      expect(tree.container.querySelector('.subagent-dock-chip')).toBeNull()
      expect(tree.container.querySelector('[role="tooltip"]')).toBeNull()
      expect(tree.container.querySelector('[role="status"]')?.textContent).toBe('Ada finished.')
      await tree.render(fixture(state([], [{ ...done, settling: false }]), true))
      expect(tree.container.querySelector('[data-finished-toggle]')?.textContent).toContain('Finished 1')
      expect(tree.container.querySelector('.subagent-dock-chip')).toBeNull()
      await resize(800)
      await tree.render(fixture(state([row({ state: 'resumed', stateWord: 'resumed', runKey: 'run-b', resumedAt: 30 })]), true))
      const chip = button(tree.container, 'Subagents: Ada, resumed')
      await act(async () => chip.click())
      expect(tree.container.querySelector('.subagent-dock')?.getAttribute('data-layout')).toBe('floating')
    })
  }
}

test('finished-only expanded panel retains disclosure and Clear, but collapsing leaves no chip', async () => {
  const done = row({ state: 'completed', stateWord: 'done', terminalAt: 20 })
  const tree = await mount(fixture(state([], [done])))
  expect(tree.container.querySelector('.subagent-dock')?.getAttribute('data-layout')).toBe('panel')
  expect(tree.container.querySelector('.subagent-dock-chip')).toBeNull()
  const toggle = tree.container.querySelector<HTMLButtonElement>('[data-finished-toggle]')!
  await act(async () => toggle.click())
  expect(button(tree.container, 'Ada, completed').parentElement?.hasAttribute('inert')).toBe(false)
  expect([...tree.container.querySelectorAll('button')].some(button => button.textContent === 'Clear')).toBe(true)
  await act(async () => button(tree.container, 'Collapse subagents').click())
  expect(tree.container.querySelector('.subagent-dock-chip')).toBeNull()
  expect(tree.container.querySelector('.subagent-dock-panel')?.hasAttribute('inert')).toBe(true)
})

test('a failed-only chip keeps its red badge and tooltip, then disappears when the failure is cleared', async () => {
  const done = row({ state: 'completed', terminalAt: 20 })
  const failed = row({ agentId: 'worker-b', name: 'Grace', state: 'failed', terminalAt: 30 })
  const tree = await mount(fixture(state([], [failed, done]), true))
  const chip = button(tree.container, 'Subagents: Grace, failed')
  expect(chip.querySelectorAll('[data-dock-face]')).toHaveLength(1)
  expect(chip.querySelector('.subagent-dock-badge-failed')).not.toBeNull()
  expect(chip.classList.contains('subagent-dock-all-finished')).toBe(false)
  await act(async () => chip.focus())
  expect(tree.container.querySelector('[role="tooltip"]')?.textContent).toContain('Gracefailed')
  await tree.render(fixture(state([], [done]), true))
  expect(tree.container.querySelector('.subagent-dock-chip')).toBeNull()
  expect(tree.container.querySelector('[role="tooltip"]')).toBeNull()
})

test('a focused live chip does not keep completed details when only a failed face remains', async () => {
  const failed = row({ agentId: 'worker-b', name: 'Grace', state: 'failed', terminalAt: 20 })
  const tree = await mount(fixture(state([row()], [failed]), true))
  await act(async () => button(tree.container, 'Subagents: Ada, running').focus())
  expect(tree.container.querySelector('[role="tooltip"]')?.textContent).toContain('Adarunning')
  await tree.render(fixture(state([], [row({ state: 'completed', terminalAt: 30 }), failed]), true))
  expect(button(tree.container, 'Subagents: Grace, failed').querySelectorAll('[data-dock-face]')).toHaveLength(1)
  expect(tree.container.querySelector('[role="tooltip"]')).toBeNull()
  expect(tree.container.querySelector('[role="status"]')?.textContent).toBe('Ada finished.')
})

for (const opening of [true, false]) {
  test(`losing the last chip face cancels ${opening ? 'opening' : 'closing'} motion and allows a later chip to morph again`, async () => {
    const originalAnimate = HTMLElement.prototype.animate
    let cancelled = 0
    HTMLElement.prototype.animate = function () { return { cancel() { cancelled++ } } as Animation }
    try {
      const tree = await mount(fixture(state([row()]), opening))
      await act(async () => button(tree.container, opening ? 'Subagents: Ada, running' : 'Collapse subagents').click())
      expect(tree.container.querySelector('.subagent-dock-frame')).not.toBeNull()
      await tree.render(fixture(state([], [row({ state: 'completed', terminalAt: 20 })]), opening))
      expect(tree.container.querySelector('.subagent-dock-frame')).toBeNull()
      expect(tree.container.querySelector('.subagent-dock-flyer')).toBeNull()
      expect(tree.container.querySelector('.subagent-dock-morphing')).toBeNull()
      expect(cancelled).toBeGreaterThan(0)
      await tree.render(fixture(state([row({ state: 'resumed', stateWord: 'resumed', runKey: 'run-b', resumedAt: 30 })]), opening))
      await act(async () => button(tree.container, opening ? 'Collapse subagents' : 'Subagents: Ada, resumed').click())
      expect(tree.container.querySelector('.subagent-dock-frame')).not.toBeNull()
    } finally {
      await harness.unmountAll()
      HTMLElement.prototype.animate = originalAnimate
    }
  })
}

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
