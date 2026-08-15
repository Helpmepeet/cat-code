/**
 * DOM proof for the invariants a `renderToStaticMarkup` suite cannot reach:
 * effects run, cleanups run, and the shared pane scroller is real.
 *
 * What this pins (CC-59 / `db83036a`): a Markdown body registers with the pane
 * coordinator ONCE for its lifetime. Streamed source updates rebuild the plan
 * and the mounted window, and they must not detach and re-attach the shared
 * scroller listener, because a transcript holds one body per message and the
 * pane-level attachment count has to stay flat as history grows.
 *
 * No JSX here on purpose: keeping the file `.ts` keeps it outside the
 * `lint:fast-refresh` component-boundary rule that governs `renderer/src/**.tsx`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createElement, useState } from 'react'
import type { ReactNode } from 'react'
import { createDomTestHarness } from './domTestHarness.js'
import type { DomTestHarness } from './domTestHarness.js'
import { BoundedMarkdown } from './BoundedMarkdown.js'
import { _forTest as coordinator } from './markdownScrollCoordinator.js'
import { renderMarkdownTree, type MountedMarkdownLeaf } from './markdownRenderPlan.js'

let harness: DomTestHarness

beforeAll(async () => {
  harness = await createDomTestHarness()
})

afterEach(async () => {
  await harness.unmountAll()
})

afterAll(async () => {
  await harness.teardown()
})

/** A scroll parent `findScrollParent` will accept, holding one Markdown body. */
function Pane({ source }: { source: string }): ReactNode {
  const [scroller, setScroller] = useState<HTMLElement | null>(null)
  const attach = (element: HTMLElement | null): void => {
    if (element !== null) element.style.overflowY = 'auto'
    setScroller(element)
  }
  return createElement(
    'div',
    { ref: attach, 'data-testid': 'pane' },
    scroller === null
      ? null
      : createElement(BoundedMarkdown, {
          sourceId: 'row-1',
          source,
          renderLeaf: (leaf: MountedMarkdownLeaf) => renderMarkdownTree(leaf.tree),
        }),
  )
}

/**
 * Counts real `scroll` registrations on one element by shadowing its own.
 * Cumulative, not balanced: a detach followed by a re-attach in the same commit
 * leaves the balance at 1 and is exactly the churn this file exists to catch.
 */
function countScrollListeners(element: HTMLElement): () => { added: number; removed: number } {
  let added = 0
  let removed = 0
  const add = element.addEventListener.bind(element)
  const remove = element.removeEventListener.bind(element)
  Object.defineProperties(element, {
    addEventListener: {
      configurable: true,
      value: (type: string, ...rest: unknown[]) => {
        if (type === 'scroll') added += 1
        return (add as (...args: unknown[]) => unknown)(type, ...rest)
      },
    },
    removeEventListener: {
      configurable: true,
      value: (type: string, ...rest: unknown[]) => {
        if (type === 'scroll') removed += 1
        return (remove as (...args: unknown[]) => unknown)(type, ...rest)
      },
    },
  })
  return () => ({ added, removed })
}

function paragraphs(count: number): string {
  return Array.from({ length: count }, (_unused, index) => `Paragraph ${index}.`).join('\n\n')
}

/**
 * happy-dom reports 0 for every box, so both halves of a height correction are
 * injected: the scroller's own geometry, and the body root's rectangle. The
 * `box` object stays mutable, which is how a later commit can render a taller
 * body than the one before it.
 */
function injectRect(element: HTMLElement, box: { top: number; height: number }): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      top: box.top,
      bottom: box.top + box.height,
      left: 0,
      right: 0,
      width: 0,
      height: box.height,
    }),
  })
}

function injectScrollGeometry(
  element: HTMLElement,
  geometry: { scrollTop: number; clientHeight: number; scrollHeight: number },
): void {
  let scrollTop = geometry.scrollTop
  Object.defineProperties(element, {
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (next: number) => {
        scrollTop = next
      },
    },
    clientHeight: { configurable: true, get: () => geometry.clientHeight },
    scrollHeight: { configurable: true, get: () => geometry.scrollHeight },
  })
}

describe('BoundedMarkdown pane registration', () => {
  test('a streamed body registers once and never re-attaches the pane scroller', async () => {
    const tree = await harness.mount(createElement(Pane, { source: paragraphs(20) }))
    const pane = tree.container.querySelector<HTMLElement>('[data-testid="pane"]')
    expect(pane).not.toBeNull()
    const live = countScrollListeners(pane!)

    expect(coordinator.isPaneAttached(pane!)).toBe(true)
    expect(coordinator.paneSubscriberCount(pane!)).toBe(1)

    // Ten streamed updates, each a new plan and a new mounted window.
    for (let step = 1; step <= 10; step += 1) {
      await tree.render(createElement(Pane, { source: paragraphs(20 + step * 40) }))
      expect(coordinator.paneSubscriberCount(pane!)).toBe(1)
    }

    // Counting starts after the first mount, so these are the registrations
    // the ten streamed updates caused: none, in either direction.
    expect(live()).toEqual({ added: 0, removed: 0 })
    expect(coordinator.isPaneAttached(pane!)).toBe(true)
    expect(pane!.textContent).toContain('Paragraph 0.')

    // The one listener the mount installed is released exactly once.
    await tree.unmount()
    expect(live()).toEqual({ added: 0, removed: 1 })
    expect(coordinator.paneSubscriberCount(pane!)).toBe(0)
    expect(coordinator.isPaneAttached(pane!)).toBe(false)
  })

  test('the mounted window stays bounded while the source grows ten times', async () => {
    const tree = await harness.mount(createElement(Pane, { source: paragraphs(400) }))
    const pane = tree.container.querySelector<HTMLElement>('[data-testid="pane"]')
    const small = pane!.querySelectorAll('p').length

    await tree.render(createElement(Pane, { source: paragraphs(4_000) }))
    await harness.nextFrame()
    const large = pane!.querySelectorAll('p').length

    expect(small).toBeGreaterThan(0)
    expect(large).toBe(small)
    expect(large).toBeLessThan(400)
  })

  test('a body that grows above the anchor corrects the pane scroll by its own delta', async () => {
    const tree = await harness.mount(createElement(Pane, { source: paragraphs(20) }))
    const pane = tree.container.querySelector<HTMLElement>('[data-testid="pane"]')
    const root = pane!.firstElementChild as HTMLElement

    injectScrollGeometry(pane!, { scrollTop: 1_000, clientHeight: 800, scrollHeight: 40_000 })
    injectRect(pane!, { top: 0, height: 800 })
    // Placed far above the scroller's top edge: this body has been read past.
    const rootBox = { top: -5_000, height: 900 }
    injectRect(root, rootBox)

    // One settling commit, so the body's first real box is the baseline rather
    // than a correction. Only what happens after it is a replaced estimate.
    await tree.render(createElement(Pane, { source: paragraphs(21) }))
    await harness.nextFrame()
    pane!.scrollTop = 1_000

    rootBox.height = 950
    await tree.render(createElement(Pane, { source: paragraphs(22) }))
    await harness.nextFrame()

    expect(pane!.scrollTop).toBe(1_050)
    expect(coordinator.paneSubscriberCount(pane!)).toBe(1)
  })

  test('a body that grows below the anchor does not move the pane', async () => {
    const tree = await harness.mount(createElement(Pane, { source: paragraphs(20) }))
    const pane = tree.container.querySelector<HTMLElement>('[data-testid="pane"]')
    const root = pane!.firstElementChild as HTMLElement

    injectScrollGeometry(pane!, { scrollTop: 1_000, clientHeight: 800, scrollHeight: 40_000 })
    injectRect(pane!, { top: 0, height: 800 })
    // Below the scroller's top edge: this body has not been reached yet.
    const rootBox = { top: 400, height: 900 }
    injectRect(root, rootBox)

    await tree.render(createElement(Pane, { source: paragraphs(21) }))
    await harness.nextFrame()
    pane!.scrollTop = 1_000

    rootBox.height = 950
    await tree.render(createElement(Pane, { source: paragraphs(22) }))
    await harness.nextFrame()

    expect(pane!.scrollTop).toBe(1_000)
  })

  test('a long table keeps its header row in the mounted window', async () => {
    const rows = Array.from({ length: 500 }, (_unused, index) => `| a${index} | b${index} |`).join('\n')
    const tree = await harness.mount(
      createElement(Pane, { source: `| Alpha | Beta |\n| --- | --- |\n${rows}` }),
    )
    const pane = tree.container.querySelector<HTMLElement>('[data-testid="pane"]')

    expect(pane!.querySelectorAll('table')).toHaveLength(1)
    expect(pane!.querySelectorAll('thead th')).toHaveLength(2)
    expect(pane!.querySelector('thead th')?.textContent).toBe('Alpha')
    expect(pane!.querySelectorAll('tbody tr').length).toBeLessThan(500)
    expect(pane!.querySelectorAll('tbody tr').length).toBeGreaterThan(0)
  })
})
