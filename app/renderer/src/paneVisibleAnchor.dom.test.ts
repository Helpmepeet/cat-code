import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import {
  observePaneBottomLock, observePaneScroll,
  compensatePanePrefix,
  reportPaneHeightCorrection as reportLivePaneHeightCorrection, type PaneHeightCorrection,
} from './markdownScrollCoordinator.js'
import { capturePaneVisibleAnchor, readPaneVisibleAnchorAdjustment } from './paneVisibleAnchor.js'

function reportPaneHeightCorrection(scroller: HTMLElement,
  correction: PaneHeightCorrection & { readOffset?: () => number | null }): void {
  reportLivePaneHeightCorrection(scroller, {
    delta: correction.delta, readOffset: correction.readOffset ?? (() => correction.offset),
  })
}

let harness: DomTestHarness
let frames: FrameRequestCallback[] = []
let restore: () => void
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(() => { restore?.(); harness.document.body.replaceChildren() })
afterAll(async () => { await harness.teardown() })

// Inject line boxes, not just a message's bounding box. These tests exercise the
// production coordinator, but are NOT evidence of native layout/RO timing.
function fixture(roundScroll = false) {
  const pane = document.createElement('div')
  const row = document.createElement('div')
  row.setAttribute('data-transcript-entry', 'reading')
  const paragraph = document.createElement('p')
  paragraph.textContent = Array.from({ length: 100 }, (_, i) => `${i.toString().padStart(3, '0')} reading content. `).join('')
  row.append(paragraph)
  pane.append(row)
  document.body.append(pane)
  let scrollTop = 110
  let prefix = 0
  let contentHeight = 3_000
  const writes: number[] = []
  Object.defineProperties(pane, {
    scrollTop: { configurable: true, get: () => scrollTop, set: (value: number) => {
      scrollTop = roundScroll ? Math.round(value) : value
      writes.push(scrollTop)
    } },
    clientHeight: { configurable: true, get: () => 80 },
    scrollHeight: { configurable: true, get: () => contentHeight },
    getBoundingClientRect: { value: () => ({ top: 0, bottom: 80, left: 0, right: 500, width: 500, height: 80 }) },
  })
  const rect = (offset: number, height = 20) => ({ top: prefix + Math.floor(offset / 20) * 20 - scrollTop, bottom: prefix + Math.floor(offset / 20) * 20 - scrollTop + height, height, left: 0, right: 500, width: 500 })
  const originalRange = document.createRange.bind(document)
  document.createRange = () => {
    const range = originalRange()
    range.getBoundingClientRect = () => {
      const box = rect(range.startOffset, range.endOffset - range.startOffset > 1 ? 2_500 : 20)
      const extra = Number(range.startContainer.parentElement?.getAttribute('data-prefix') ?? 0)
      return { ...box, top: box.top + extra, bottom: box.bottom + extra } as DOMRect
    }
    range.getClientRects = () => [range.getBoundingClientRect()] as unknown as DOMRectList
    return range
  }
  const raf = globalThis.requestAnimationFrame
  const cancel = globalThis.cancelAnimationFrame
  globalThis.requestAnimationFrame = cb => { frames.push(cb); return frames.length }
  globalThis.cancelAnimationFrame = () => {}
  frames = []
  const release = observePaneScroll(pane, () => {})
  const flush = () => { const pending = frames; frames = []; for (const cb of pending) cb(0) }
  pane.dispatchEvent(new Event('scroll'))
  flush()
  restore = () => { release(); document.createRange = originalRange; globalThis.requestAnimationFrame = raf; globalThis.cancelAnimationFrame = cancel }
  return { pane, row, paragraph, writes, flush, grow: (above: number, below: number) => { prefix += above; contentHeight += above + below } }
}

for (const delta of [-0.75, 0.75]) {
  for (const roundScroll of [false, true]) {
    test(`fractional movement stays bounded across frames: ${delta}px, rounded scroll ${roundScroll}`, () => {
      const f = fixture(roundScroll)
      const intended = capturePaneVisibleAnchor(f.pane)!
      for (let step = 0; step < 20; step++) {
        f.grow(delta, 0)
        reportPaneHeightCorrection(f.pane, { offset: 0, delta })
        f.flush()
        expect(Math.abs(readPaneVisibleAnchorAdjustment(f.pane, intended)!)).toBeLessThan(1)
      }
      expect(f.pane.scrollTop).toBe(110 + delta * 20)
    })
  }
}

test('intentional scrolling supersedes an uncorrected fractional reading goal', () => {
  const f = fixture()
  f.grow(0.75, 0)
  reportPaneHeightCorrection(f.pane, { offset: 0, delta: 0.75 })
  f.flush()
  f.pane.scrollTop = 600
  f.pane.dispatchEvent(new Event('scroll'))
  f.grow(0, 24)
  reportPaneHeightCorrection(f.pane, { offset: 0, delta: 24 })
  f.flush()
  expect(f.pane.scrollTop).toBe(600)
})

for (const delta of [-24, 0, 24]) {
  test(`a lower-edge replacement of ${delta}px does not move visible text`, () => {
    const f = fixture()
    f.grow(0, delta)
    reportPaneHeightCorrection(f.pane, { offset: 0, delta })
    f.flush()
    expect(f.pane.scrollTop).toBe(110)
    expect(f.writes).toEqual([])
  })
}

for (const order of ['lower-first', 'upper-first', 'separate-frames'] as const) {
  test(`visible content survives multiple commits: ${order}`, () => {
    const f = fixture()
    let lowerOffset = 120
    if (order === 'upper-first') {
      f.grow(30, 0)
      lowerOffset += 30
      reportPaneHeightCorrection(f.pane, { offset: 0, delta: 30 })
      f.grow(0, 20)
      reportPaneHeightCorrection(f.pane, { offset: lowerOffset, delta: 20, readOffset: () => lowerOffset })
    } else {
      f.grow(0, 20)
      reportPaneHeightCorrection(f.pane, { offset: lowerOffset, delta: 20, readOffset: () => lowerOffset })
      if (order === 'separate-frames') f.flush()
      f.grow(30, 0)
      lowerOffset += 30
      reportPaneHeightCorrection(f.pane, { offset: 0, delta: 30 })
    }
    f.flush()
    expect(f.pane.scrollTop).toBe(140)
  })
}

test('equal-and-opposite changes preserve an interior line despite unchanged total height', () => {
  const f = fixture()
  f.grow(24, -24)
  // A commit invalidates geometry even when its aggregate delta is zero.
  reportPaneHeightCorrection(f.pane, { offset: 0, delta: 0 })
  f.flush()
  expect(f.pane.scrollTop).toBe(134)
})

test('a remounted text node is resolved by content within its stable row', () => {
  const f = fixture()
  f.paragraph.replaceWith(f.paragraph.cloneNode(true))
  f.grow(30, 0)
  reportPaneHeightCorrection(f.pane, { offset: 0, delta: 30 })
  f.flush()
  expect(f.pane.scrollTop).toBe(140)
})

test('text inserted before the visible character resolves its context instead of reusing its old offset', () => {
  const f = fixture()
  f.paragraph.firstChild!.textContent = 'New prefix content. ' + f.paragraph.textContent
  reportPaneHeightCorrection(f.pane, { offset: 0, delta: 20 })
  f.flush()
  expect(f.pane.scrollTop).toBe(130)
})

test('reused paragraph nodes with identical interior lines do not substitute for the tracked content', () => {
  const f = fixture()
  const original = 'Paragraph alpha. ' + 'Repeated interior reading context. '.repeat(40)
  f.paragraph.textContent = original
  f.pane.dispatchEvent(new Event('scroll'))
  f.flush()
  const retained = f.paragraph.cloneNode(true) as HTMLElement
  retained.setAttribute('data-prefix', '24')
  f.paragraph.textContent = original.replace('alpha', 'bravo')
  f.row.append(retained)
  reportPaneHeightCorrection(f.pane, { offset: 0, delta: 0 })
  f.flush()
  expect(f.pane.scrollTop).toBe(134)
})

test('a window can discard a paragraph prefix while retaining its visible character', () => {
  const f = fixture()
  f.paragraph.textContent = f.paragraph.textContent!.slice(80)
  f.paragraph.setAttribute('data-prefix', '80')
  reportPaneHeightCorrection(f.pane, { offset: 0, delta: 24 })
  f.flush()
  expect(f.pane.scrollTop).toBe(110)
})

function repeatedParagraphs() {
  const f = fixture()
  const first = document.createElement('p')
  first.textContent = 'Repeated reading content.'
  first.setAttribute('data-top', '-60')
  const second = first.cloneNode(true) as HTMLElement
  second.setAttribute('data-top', '0')
  f.row.setAttribute('data-transcript-entry', 'one-message')
  f.row.replaceChildren(first, second)
  f.pane.scrollTop = 100
  const makeRange = document.createRange.bind(document)
  document.createRange = () => {
    const range = makeRange()
    range.getBoundingClientRect = () => {
      const top = Number(range.startContainer.parentElement!.getAttribute('data-top'))
      return { top, bottom: top + 20, height: 20, left: 0, right: 500, width: 500 } as DOMRect
    }
    return range
  }
  const anchor = capturePaneVisibleAnchor(f.pane)!
  expect(anchor).not.toBeNull()
  return { ...f, first, second, anchor }
}

for (const movement of [0, 24]) {
  test(`remount tracks the second identical paragraph occurrence, movement ${movement}px`, () => {
    const f = repeatedParagraphs()
    const intended = f.second.cloneNode(true) as HTMLElement
    intended.setAttribute('data-top', String(movement))
    f.second.replaceWith(intended)
    // The oracle names the intended occurrence, not the first equal string.
    expect(f.row.lastChild).toBe(intended)
    expect(readPaneVisibleAnchorAdjustment(f.pane, f.anchor)).toBe(
      Number(intended.getAttribute('data-top')),
    )
  })
}

test('remount of all identical occurrences is unresolved without retained occurrence identity', () => {
  const f = repeatedParagraphs()
  f.row.replaceChildren(f.first.cloneNode(true), f.second.cloneNode(true))
  expect(readPaneVisibleAnchorAdjustment(f.pane, f.anchor)).toBeNull()
})

test('explicit navigation starts a new anchor instead of undoing the jump', () => {
  const f = fixture()
  f.pane.scrollTop = 600
  f.pane.dispatchEvent(new Event('scroll'))
  f.grow(0, 24)
  reportPaneHeightCorrection(f.pane, { offset: 0, delta: 24 })
  f.flush()
  expect(f.pane.scrollTop).toBe(600)
})

test('a prepend already compensated by its owner is not compensated twice', () => {
  const f = fixture()
  f.grow(30, 0)
  compensatePanePrefix(f.pane, 30)
  reportPaneHeightCorrection(f.pane, { offset: 0, delta: 30 })
  f.flush()
  expect(f.pane.scrollTop).toBe(140)
})

test('partial prepend compensation does not discard simultaneous interior reflow', () => {
  const f = fixture()
  const intended = capturePaneVisibleAnchor(f.pane)!
  f.grow(54, 0)
  compensatePanePrefix(f.pane, 30)
  f.pane.dispatchEvent(new Event('scroll'))
  reportPaneHeightCorrection(f.pane, { offset: 0, delta: 24 })
  f.flush()
  expect(f.pane.scrollTop).toBe(164)
  expect(readPaneVisibleAnchorAdjustment(f.pane, intended)).toBe(0)
})

test('overestimated prefix compensation corrects only the remainder and notifies the follow owner', () => {
  const f = fixture()
  const intended = capturePaneVisibleAnchor(f.pane)!
  const seen: number[] = []
  const release = observePaneBottomLock(f.pane, () => false, top => seen.push(top))
  f.grow(20, 0)
  compensatePanePrefix(f.pane, 30)
  f.pane.dispatchEvent(new Event('scroll'))
  reportPaneHeightCorrection(f.pane, { offset: 0, delta: -10 })
  f.flush()
  expect(f.pane.scrollTop).toBe(130)
  expect(readPaneVisibleAnchorAdjustment(f.pane, intended)).toBe(0)
  expect(seen).toEqual([140, 130])
  release()
})

test('explicit navigation supersedes a pending owned prefix correction', () => {
  const f = fixture()
  f.grow(54, 0)
  compensatePanePrefix(f.pane, 30)
  f.pane.scrollTop = 600
  f.pane.dispatchEvent(new Event('scroll'))
  reportPaneHeightCorrection(f.pane, { offset: 0, delta: 24 })
  f.flush()
  expect(f.pane.scrollTop).toBe(600)
})

test('bottom following wins over the visible anchor, then reader movement releases it', () => {
  const f = fixture()
  let following = true
  const release = observePaneBottomLock(f.pane, () => following)
  f.grow(0, 24)
  reportPaneHeightCorrection(f.pane, { offset: 0, delta: 24 })
  f.flush()
  expect(f.pane.scrollTop).toBe(2_944)
  following = false
  f.pane.scrollTop = 110
  f.pane.dispatchEvent(new Event('scroll'))
  f.grow(0, 24)
  reportPaneHeightCorrection(f.pane, { offset: 0, delta: 24 })
  f.flush()
  expect(f.pane.scrollTop).toBe(110)
  release()
})
