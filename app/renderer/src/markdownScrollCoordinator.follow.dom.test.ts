import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import {
  observePaneScroll, observePaneBottomLock, reportPaneLayoutChange,
  reportPaneHeightCorrection, flushPaneScrollCorrections, compensatePanePrefix,
} from './markdownScrollCoordinator.js'

let harness: DomTestHarness
let cleanup: (() => void) | undefined
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(() => { cleanup?.(); cleanup = undefined; document.body.replaceChildren() })
afterAll(async () => { await harness.teardown() })

// Real DOM traversal with injected line boxes, not a native-layout benchmark.
function fixture(ownerFirst = false) {
  const pane = document.createElement('div')
  for (let i = 0; i < 1_200; i++) {
    const p = document.createElement('p')
    p.dataset.line = String(i)
    p.textContent = `Reading paragraph ${i}`
    pane.append(p)
  }
  document.body.append(pane)
  let height = 24_000
  let prefix = 0
  let following = true
  let reads = 0
  let frames: FrameRequestCallback[] = []
  const callbacks: number[] = []
  Object.defineProperties(pane, {
    clientHeight: { get: () => 80 },
    scrollHeight: { get: () => height },
    getBoundingClientRect: { value: () => ({ top: 0, bottom: 80, height: 80 }) },
  })
  pane.scrollTop = height - 80
  const originalRange = document.createRange.bind(document)
  const raf = globalThis.requestAnimationFrame
  const cancel = globalThis.cancelAnimationFrame
  document.createRange = () => {
    const range = originalRange()
    range.getBoundingClientRect = () => {
      reads++
      const top = Number(range.startContainer.parentElement?.getAttribute('data-line')) * 20 + prefix - pane.scrollTop
      return { top, bottom: top + 20, height: 20 } as DOMRect
    }
    return range
  }
  globalThis.requestAnimationFrame = cb => { frames.push(cb); return frames.length }
  globalThis.cancelAnimationFrame = () => {}
  const ownerScroll = () => { following = false }
  if (ownerFirst) pane.addEventListener('scroll', ownerScroll)
  const releaseScroll = observePaneScroll(pane, () => {})
  const releaseBottom = observePaneBottomLock(pane, () => following, top => callbacks.push(top))
  if (!ownerFirst) pane.addEventListener('scroll', ownerScroll)
  const flush = () => { const pending = frames; frames = []; for (const cb of pending) cb(0) }
  cleanup = () => {
    releaseScroll(); releaseBottom()
    pane.removeEventListener('scroll', ownerScroll)
    document.createRange = originalRange
    globalThis.requestAnimationFrame = raf
    globalThis.cancelAnimationFrame = cancel
  }
  return {
    pane, callbacks, flush, releaseBottom,
    resetReads: () => { reads = 0 }, reads: () => reads,
    grow: (above: number, below = 0) => { prefix += above; height += above + below },
    setFollowing: (value: boolean) => { following = value },
  }
}

test('bottom-follow streaming and early flushes do no character geometry work', () => {
  const f = fixture()
  expect(f.reads()).toBeGreaterThan(1_190)
  f.resetReads()
  for (let i = 0; i < 20; i++) {
    f.grow(0, 20)
    reportPaneHeightCorrection(f.pane, { delta: 20, readOffset: () => 24_000 })
    flushPaneScrollCorrections(f.pane)
    f.flush()
  }
  expect(f.pane.scrollTop).toBe(24_320)
  expect(f.callbacks).toHaveLength(20)
  expect(f.reads()).toBe(0)
  // Net-zero invalidation must not become a new request to pin the pane.
  f.pane.scrollTop -= 10
  reportPaneLayoutChange(f.pane)
  f.flush()
  expect(f.pane.scrollTop).toBe(24_310)
  expect(f.reads()).toBe(0)
})

for (const ownerFirst of [false, true]) {
  test(`scroll away captures the reading goal before reflow, owner first ${ownerFirst}`, () => {
    const f = fixture(ownerFirst)
    f.resetReads()
    f.pane.scrollTop = 23_810
    f.pane.dispatchEvent(new Event('scroll'))
    expect(f.reads()).toBeGreaterThan(1_190)
    // Reflow precedes the scroll's scheduled frame, so frame-only sampling
    // would miss this net-zero movement entirely.
    f.grow(24, -24)
    reportPaneLayoutChange(f.pane)
    flushPaneScrollCorrections(f.pane)
    expect(f.pane.scrollTop).toBe(23_834)
    f.flush()
    expect(f.pane.scrollTop).toBe(23_834)
  })
}

test('an unresolved reading row cannot block a later bottom-follow early flush', () => {
  const f = fixture()
  f.pane.scrollTop = 23_810
  f.pane.dispatchEvent(new Event('scroll'))
  f.pane.replaceChildren()
  f.grow(0, 40)
  // The pending report retains an unresolved reading goal. Follow can be
  // reacquired after the report, before the window selector's early flush.
  reportPaneHeightCorrection(f.pane, { delta: 40, readOffset: () => 24_000 })
  f.setFollowing(true)
  f.resetReads()
  flushPaneScrollCorrections(f.pane)
  expect(f.pane.scrollTop).toBe(23_960)
  expect(f.reads()).toBe(0)
})

test('releasing the bottom owner establishes a reading goal for remaining subscribers', () => {
  const f = fixture()
  f.pane.scrollTop = 23_810
  f.releaseBottom()
  f.grow(24, -24)
  reportPaneLayoutChange(f.pane)
  f.flush()
  expect(f.pane.scrollTop).toBe(23_834)
  const releaseRebound = observePaneBottomLock(f.pane, () => true)
  f.resetReads()
  f.grow(0, 20)
  reportPaneLayoutChange(f.pane)
  f.flush()
  expect(f.pane.scrollTop).toBe(23_940)
  expect(f.reads()).toBe(0)
  releaseRebound()
})

test('prefix compensation while following keeps callbacks without character reads', () => {
  const f = fixture()
  f.resetReads()
  f.grow(30)
  compensatePanePrefix(f.pane, 30)
  f.flush()
  expect(f.pane.scrollTop).toBe(23_950)
  expect(f.callbacks).toEqual([23_950])
  expect(f.reads()).toBe(0)
})
