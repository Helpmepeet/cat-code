import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, createElement } from 'react'
import { BoundedMarkdown } from './BoundedMarkdown.js'
import { renderMarkdownTree } from './markdownRenderPlan.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'

let harness: DomTestHarness
let restore: () => void
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll(); restore?.() })
afterAll(async () => { await harness.teardown() })

// The native-layout gate is separate. Zero Range boxes deliberately force the
// production components through their documented height-correction fallback.
for (const order of ['lower-first', 'upper-first'] as const) {
  for (const commits of ['same-layout', 'separate-layouts', 'separate-frames'] as const) {
    test(`actual Markdown fallback uses final offsets: ${order}, ${commits}`, async () => {
      const raf = globalThis.requestAnimationFrame
      const windowRaf = window.requestAnimationFrame
      const cancel = globalThis.cancelAnimationFrame
      const windowCancel = window.cancelAnimationFrame
      let frames = new Map<number, FrameRequestCallback>()
      let sequence = 0
      globalThis.requestAnimationFrame = window.requestAnimationFrame = callback => {
        frames.set(++sequence, callback)
        return sequence
      }
      globalThis.cancelAnimationFrame = window.cancelAnimationFrame = id => { frames.delete(id) }
      restore = () => {
        globalThis.requestAnimationFrame = raf; window.requestAnimationFrame = windowRaf
        globalThis.cancelAnimationFrame = cancel; window.cancelAnimationFrame = windowCancel
      }
      const source = (revision: number) => Array.from({ length: revision }, (_, index) => `Paragraph ${index}.`).join('\n\n')
      const view = (lower: number, upper: number) => createElement('div', {
        ref: (pane: HTMLElement | null) => { if (pane) pane.style.overflowY = 'auto' },
      }, (order === 'lower-first' ? ['lower', 'upper'] : ['upper', 'lower']).map(id => createElement('div', {
        key: id, 'data-body': id,
      }, createElement(BoundedMarkdown, {
        sourceId: id, source: source(id === 'lower' ? lower : upper),
        renderLeaf: leaf => renderMarkdownTree(leaf.tree),
      }))))
      const tree = await harness.mount(view(1, 1))
      const pane = tree.container.firstElementChild as HTMLElement
      let scrollTop = 110
      Object.defineProperties(pane, {
        scrollTop: { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value } },
        clientHeight: { configurable: true, get: () => 80 },
        scrollHeight: { configurable: true, get: () => 1_000 },
        getBoundingClientRect: { value: () => ({ top: 0, bottom: 80, height: 80 }) },
      })
      const boxes = {
        lower: { offset: commits === 'same-layout' ? 100 : 120, height: 200 },
        upper: { offset: 0, height: 100 },
      }
      for (const id of ['lower', 'upper'] as const) {
        const body = pane.querySelector(`[data-body="${id}"]`)!.firstElementChild!
        Object.defineProperty(body, 'getBoundingClientRect', { value: () => ({
          top: boxes[id].offset - scrollTop, bottom: boxes[id].offset - scrollTop + boxes[id].height,
          height: boxes[id].height,
        }) })
      }
      const flush = async () => {
        for (let turn = 0; turn < 6; turn++) {
          await act(async () => {
            const pending = frames; frames = new Map()
            for (const callback of pending.values()) callback(0)
          })
        }
      }
      await tree.render(view(2, 2))
      await flush()
      pane.scrollTop = 110
      pane.dispatchEvent(new Event('scroll'))
      await flush()
      if (commits === 'same-layout') {
        // Both effects already see the upper growth. The lower change was above
        // the old anchor (100), but its final document boundary is now 130.
        boxes.lower.offset = 130
        boxes.lower.height += 20
        boxes.upper.height += 30
        await tree.render(view(3, 3))
      } else if (order === 'lower-first') {
        // The lower boundary starts below the anchor. A later, separate upper
        // commit moves that same boundary to 150 before the shared frame runs.
        boxes.lower.height += 20
        await tree.render(view(3, 2))
        if (commits === 'separate-frames') await flush()
        boxes.upper.height += 30
        boxes.lower.offset += 30
        await tree.render(view(3, 3))
      } else {
        boxes.upper.height += 30
        boxes.lower.offset += 30
        await tree.render(view(2, 3))
        if (commits === 'separate-frames') await flush()
        boxes.lower.height += 20
        await tree.render(view(3, 3))
      }
      await flush()
      expect(pane.scrollTop).toBe(commits === 'same-layout' ? 160 : 140)
    })
  }
}
