import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, createElement } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { TranscriptRowsView } from './TranscriptView.js'
import { BoundedMarkdown } from './BoundedMarkdown.js'
import { renderMarkdownTree } from './markdownRenderPlan.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'

let harness: DomTestHarness
let restore: () => void
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll(); restore?.() })
afterAll(async () => { await harness.teardown() })

function geometry(row125Height = 82) {
  const raf = globalThis.requestAnimationFrame
  const windowRaf = window.requestAnimationFrame
  const cancel = globalThis.cancelAnimationFrame
  const windowCancel = window.cancelAnimationFrame
  const observer = globalThis.ResizeObserver
  const elementRect = HTMLElement.prototype.getBoundingClientRect
  const createRange = document.createRange.bind(document)
  let frames = new Map<number, FrameRequestCallback>()
  let sequence = 0
  const observers = new Map<ResizeObserver, { callback: ResizeObserverCallback; targets: Set<Element> }>()
  class ControlledObserver {
    constructor(callback: ResizeObserverCallback) { observers.set(this as unknown as ResizeObserver, { callback, targets: new Set() }) }
    observe(target: Element) { observers.get(this as unknown as ResizeObserver)!.targets.add(target) }
    unobserve(target: Element) { observers.get(this as unknown as ResizeObserver)!.targets.delete(target) }
    disconnect() { observers.delete(this as unknown as ResizeObserver) }
  }
  globalThis.ResizeObserver = ControlledObserver as unknown as typeof ResizeObserver
  globalThis.requestAnimationFrame = window.requestAnimationFrame = callback => { frames.set(++sequence, callback); return sequence }
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame = id => { frames.delete(id) }
  let pane: HTMLElement
  let scrollTop = 9_050
  let markdownHeight = 2_400
  const writes: number[] = []
  const height = (element: Element): number => {
    const key = element.getAttribute('data-transcript-entry')
    if (key) return key === 'history:125' ? row125Height : 82
    if (element.hasAttribute('aria-hidden')) return Number.parseFloat((element as HTMLElement).style.height) || 0
    if (element.classList.contains('transcript-virtual-column')) return Array.from(element.children).reduce((sum, child) => sum + height(child), 0)
    const row = element.closest('[data-transcript-entry]')
    if (row) return height(row)
    if (element.hasAttribute('data-markdown-leaf')) return element.querySelectorAll('p').length * 24 || 24
    return markdownHeight
  }
  const top = (element: Element): number => {
    const row = element.closest('[data-transcript-entry]')
    if (row) {
      let offset = 0
      for (const sibling of row.parentElement!.children) { if (sibling === row) break; offset += height(sibling) }
      return offset - scrollTop
    }
    return -scrollTop
  }
  const rect = (y: number, h: number) => ({ top: y, bottom: y + h, height: h, left: 0, right: 600, width: 600 }) as DOMRect
  HTMLElement.prototype.getBoundingClientRect = function () { return this === pane ? rect(0, 800) : rect(top(this), height(this)) }
  document.createRange = () => {
    const range = createRange()
    range.getBoundingClientRect = () => {
      const parent = range.startContainer.parentElement!
      const row = parent.closest('[data-transcript-entry]')
      const index = Number(parent.textContent?.match(/Paragraph (\d+)/)?.[1] ?? 0)
      return rect(row ? top(row) : index * 24 - scrollTop, 20)
    }
    range.getClientRects = () => [range.getBoundingClientRect()] as unknown as DOMRectList
    return range
  }
  restore = () => {
    globalThis.requestAnimationFrame = raf; window.requestAnimationFrame = windowRaf
    globalThis.cancelAnimationFrame = cancel; window.cancelAnimationFrame = windowCancel
    globalThis.ResizeObserver = observer; HTMLElement.prototype.getBoundingClientRect = elementRect
    document.createRange = createRange
  }
  return {
    attach: (element: HTMLElement | null) => {
      if (!element) return
      pane = element
      element.style.overflowY = 'auto'
      Object.defineProperties(element, {
        scrollTop: { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; writes.push(value) } },
        clientHeight: { configurable: true, get: () => 800 },
        scrollHeight: { configurable: true, get: () => 40_000 },
      })
    },
    setScroll: (value: number) => { scrollTop = value; pane.dispatchEvent(new Event('scroll')) },
    growMarkdown: () => { markdownHeight += 24 },
    writes,
    flush: async () => {
      for (let turn = 0; turn < 10; turn++) {
        await act(async () => {
          for (const [instance, record] of observers) {
            const entries = [...record.targets].map(target => ({
              target, borderBoxSize: [{ blockSize: height(target), inlineSize: 600 }],
              contentBoxSize: [{ blockSize: height(target), inlineSize: 600 }],
              devicePixelContentBoxSize: [{ blockSize: height(target), inlineSize: 600 }],
              contentRect: rect(top(target), height(target)),
            }) as ResizeObserverEntry)
            record.callback(entries, instance)
          }
          const pending = frames; frames = new Map()
          for (const callback of pending.values()) callback(0)
        })
      }
    },
  }
}

for (const measured of [58, 82, 106]) {
  test(`actual transcript lower-edge mount measures ${measured}px without moving the reader`, async () => {
    const g = geometry(measured)
    const rows = Array.from({ length: 240 }, (_, index) => ({
      id: `history:${index}`, sessionId: 'synthetic', messageId: `m:${index}`, frameId: `f:${index}`,
      blockIndex: 0, parentToolUseId: null, children: [], kind: 'user-text', content: `Synthetic message ${index}`,
      role: 'user', isReplay: false,
    }) as NestedTranscriptRow)
    const tree = await harness.mount(createElement('div', { ref: g.attach }, createElement(TranscriptRowsView, { rows, initialScrollRowKey: 'history:110' })))
    await g.flush()
    const pane = tree.container.firstElementChild as HTMLElement
    const visible = pane.querySelector('[data-transcript-entry="history:111"]')!
    expect(visible).not.toBeNull()
    const before = visible.getBoundingClientRect().top
    g.writes.length = 0
    g.setScroll(9_052)
    await g.flush()
    expect(pane.scrollTop).toBe(9_052)
    expect(visible.getBoundingClientRect().top).toBe(before - 2)
    expect(g.writes).toEqual([])
    expect(pane.querySelectorAll('[data-transcript-entry]').length).toBeLessThanOrEqual(80)
  })
}

test('actual partially visible Markdown appends below the reader without a correction', async () => {
  const g = geometry()
  const source = (count: number) => Array.from({ length: count }, (_, index) => `Paragraph ${index}.`).join('\n\n')
  const view = (count: number) => createElement('div', { ref: g.attach }, createElement(BoundedMarkdown, {
    sourceId: 'synthetic-markdown', source: source(count), renderLeaf: leaf => renderMarkdownTree(leaf.tree),
  }))
  const tree = await harness.mount(view(100))
  g.setScroll(1_000)
  await g.flush()
  g.writes.length = 0
  g.growMarkdown()
  await tree.render(view(101))
  await g.flush()
  expect((tree.container.firstElementChild as HTMLElement).scrollTop).toBe(1_000)
  expect(g.writes).toEqual([])
})
