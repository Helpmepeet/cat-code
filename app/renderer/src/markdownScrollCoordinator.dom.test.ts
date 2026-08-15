/**
 * DOM proof for the pane scroll coordinator: real elements, a real React tree,
 * real effect cleanups, and a real dispatched `scroll` event.
 *
 * The sibling `markdownScrollCoordinator.test.ts` asserts the same pooling
 * against a hand-rolled fake scroller and a fake `requestAnimationFrame`. It
 * cannot show that the pooling survives a React mount/unmount cycle, because
 * `renderToStaticMarkup` never runs effects or their cleanups. This file does,
 * and is the first suite in `app/` to opt into a DOM (see `domTestHarness.ts`
 * for why the opt-in is per file).
 *
 * No JSX here on purpose: keeping the file `.ts` keeps it outside the
 * `lint:fast-refresh` component-boundary rule that governs `renderer/src/**.tsx`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createElement, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { _forTest as domHarness, createDomTestHarness } from './domTestHarness.js'
import type { DomTestHarness } from './domTestHarness.js'
import {
  _forTest as coordinator,
  observePaneBottomLock,
  observePaneScroll,
  reportPaneHeightCorrection,
} from './markdownScrollCoordinator.js'

const SCROLLER_TEST_ID = 'pane-scroller'

type PaneProps = {
  bodyCount: number
  onFrame: (bodyIndex: number) => void
}

/**
 * A pane scroller whose bodies subscribe through the coordinator, mirroring how
 * Markdown bodies register against the transcript scroller. The scroller is
 * handed down through a callback ref, so the bodies only mount once a real
 * element exists.
 */
function Pane({ bodyCount, onFrame }: PaneProps): ReactNode {
  const [scroller, setScroller] = useState<HTMLElement | null>(null)
  const bodies = scroller
    ? Array.from({ length: bodyCount }, (_unused, index) =>
        createElement(Body, { key: index, index, scroller, onFrame }),
      )
    : null
  return createElement('div', { ref: setScroller, 'data-testid': SCROLLER_TEST_ID }, bodies)
}

function Body({
  index,
  scroller,
  onFrame,
}: {
  index: number
  scroller: HTMLElement
  onFrame: (bodyIndex: number) => void
}): ReactNode {
  useEffect(() => observePaneScroll(scroller, () => onFrame(index)), [index, scroller, onFrame])
  return createElement('div', { 'data-body': index })
}

/**
 * Counts real `scroll` registrations on one element by shadowing its inherited
 * listener methods with own properties that delegate to the prototype. The
 * listeners are genuinely installed, so `dispatchEvent` still reaches them.
 */
function watchScrollListeners(element: HTMLElement): {
  counts: { added: number; removed: number }
  restore: () => void
} {
  const counts = { added: 0, removed: 0 }

  const addEventListener = (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void => {
    if (type === 'scroll') counts.added += 1
    EventTarget.prototype.addEventListener.call(element, type, listener, options)
  }
  const removeEventListener = (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void => {
    if (type === 'scroll') counts.removed += 1
    EventTarget.prototype.removeEventListener.call(element, type, listener, options)
  }
  Object.assign(element, { addEventListener, removeEventListener })

  return {
    counts,
    restore: () => {
      Reflect.deleteProperty(element, 'addEventListener')
      Reflect.deleteProperty(element, 'removeEventListener')
    },
  }
}

/**
 * happy-dom ships a `ResizeObserver` whose `observe` is an empty stub, so this
 * records construction and observation only. Layout-driven callbacks are not
 * something this environment can produce.
 */
function watchResizeObservers(): { targets: EventTarget[]; restore: () => void } {
  const targets: EventTarget[] = []
  const original = globalThis.ResizeObserver
  class RecordingResizeObserver extends original {
    override observe(observed: Element, options?: ResizeObserverOptions): void {
      targets.push(observed)
      super.observe(observed, options)
    }
  }
  globalThis.ResizeObserver = RecordingResizeObserver
  return {
    targets,
    restore: () => {
      globalThis.ResizeObserver = original
    },
  }
}

/**
 * happy-dom reports 0 for every box, so the geometry the coordinator reads is
 * injected. `scrollTop` stays a real read/write property, which is what lets a
 * test assert the position the coordinator actually wrote.
 */
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

let harness: DomTestHarness
let restoreSpies: Array<() => void> = []

beforeAll(async () => {
  harness = await createDomTestHarness()
})

afterEach(async () => {
  for (const restore of restoreSpies.reverse()) restore()
  restoreSpies = []
  await harness.unmountAll()
})

afterAll(async () => {
  if (domHarness.isRegistered()) await harness.teardown()
})

/** Mounts an empty pane, then instruments the real scroller before any body subscribes. */
async function mountInstrumentedPane(onFrame: (bodyIndex: number) => void) {
  const tree = await harness.mount(createElement(Pane, { bodyCount: 0, onFrame }))
  const scroller = tree.container.querySelector<HTMLElement>(`[data-testid="${SCROLLER_TEST_ID}"]`)
  if (!scroller) throw new Error('pane scroller did not mount')

  const listeners = watchScrollListeners(scroller)
  const observers = watchResizeObservers()
  restoreSpies.push(listeners.restore, observers.restore)

  return {
    scroller,
    listeners,
    observers,
    setBodyCount: (bodyCount: number) => tree.render(createElement(Pane, { bodyCount, onFrame })),
  }
}

describe('observePaneScroll in a real DOM', () => {
  test('twelve mounted bodies share one scroll listener and one ResizeObserver', async () => {
    const pane = await mountInstrumentedPane(() => {})

    await pane.setBodyCount(12)

    expect(coordinator.paneSubscriberCount(pane.scroller)).toBe(12)
    expect(pane.listeners.counts.added).toBe(1)
    expect(pane.listeners.counts.removed).toBe(0)
    expect(pane.observers.targets).toEqual([pane.scroller])
  })

  test('a real scroll event fans out to every subscriber in one animation frame', async () => {
    const calls: number[] = []
    const pane = await mountInstrumentedPane((bodyIndex) => calls.push(bodyIndex))

    await pane.setBodyCount(4)
    pane.scroller.dispatchEvent(new Event('scroll'))
    pane.scroller.dispatchEvent(new Event('scroll'))
    pane.scroller.dispatchEvent(new Event('scroll'))
    expect(calls).toEqual([])

    await harness.nextFrame()

    expect(calls.slice().sort()).toEqual([0, 1, 2, 3])
  })

  test('unmounting all but one body keeps the listener; the last unmount removes it', async () => {
    const calls: number[] = []
    const pane = await mountInstrumentedPane((bodyIndex) => calls.push(bodyIndex))

    await pane.setBodyCount(5)
    await pane.setBodyCount(1)

    expect(coordinator.isPaneAttached(pane.scroller)).toBe(true)
    expect(pane.listeners.counts.removed).toBe(0)

    pane.scroller.dispatchEvent(new Event('scroll'))
    await harness.nextFrame()
    expect(calls).toEqual([0])

    await pane.setBodyCount(0)

    expect(coordinator.isPaneAttached(pane.scroller)).toBe(false)
    expect(pane.listeners.counts.added).toBe(1)
    expect(pane.listeners.counts.removed).toBe(1)

    pane.scroller.dispatchEvent(new Event('scroll'))
    await harness.nextFrame()
    expect(calls).toEqual([0])
  })

  test('remounting bodies after a full release attaches exactly one listener again', async () => {
    const pane = await mountInstrumentedPane(() => {})

    await pane.setBodyCount(3)
    await pane.setBodyCount(0)
    await pane.setBodyCount(3)

    expect(coordinator.paneSubscriberCount(pane.scroller)).toBe(3)
    expect(pane.listeners.counts.added).toBe(2)
    expect(pane.listeners.counts.removed).toBe(1)
    expect(pane.observers.targets).toEqual([pane.scroller, pane.scroller])
  })

  test('reported corrections become ONE scroll write on the real scroller', async () => {
    const pane = await mountInstrumentedPane(() => {})
    await pane.setBodyCount(3)
    injectScrollGeometry(pane.scroller, {
      scrollTop: 5_000,
      clientHeight: 800,
      scrollHeight: 40_000,
    })

    reportPaneHeightCorrection(pane.scroller, { offset: 1_000, delta: 40 })
    reportPaneHeightCorrection(pane.scroller, { offset: 3_040, delta: 60 })
    reportPaneHeightCorrection(pane.scroller, { offset: 30_000, delta: 500 })
    expect(pane.scroller.scrollTop).toBe(5_000)

    await harness.nextFrame()

    expect(pane.scroller.scrollTop).toBe(5_100)
    // Correction did not cost the pane a second listener or observer.
    expect(pane.listeners.counts.added).toBe(1)
    expect(pane.observers.targets).toEqual([pane.scroller])
  })

  test('a correction below the visible anchor leaves the real scroller alone', async () => {
    const pane = await mountInstrumentedPane(() => {})
    await pane.setBodyCount(3)
    injectScrollGeometry(pane.scroller, {
      scrollTop: 5_000,
      clientHeight: 800,
      scrollHeight: 40_000,
    })

    reportPaneHeightCorrection(pane.scroller, { offset: 20_000, delta: 900 })
    await harness.nextFrame()

    expect(pane.scroller.scrollTop).toBe(5_000)
  })

  test('a registered bottom lock wins and pins the real scroller to the end', async () => {
    const pane = await mountInstrumentedPane(() => {})
    await pane.setBodyCount(1)
    injectScrollGeometry(pane.scroller, {
      scrollTop: 39_000,
      clientHeight: 800,
      scrollHeight: 40_500,
    })
    const releaseLock = observePaneBottomLock(pane.scroller, () => true)

    reportPaneHeightCorrection(pane.scroller, { offset: 40_000, delta: 500 })
    await harness.nextFrame()

    expect(pane.scroller.scrollTop).toBe(39_700)
    releaseLock()
  })

  test('a locked pane is not re-pinned by a scroll that corrected nothing', async () => {
    const pane = await mountInstrumentedPane(() => {})
    await pane.setBodyCount(1)
    injectScrollGeometry(pane.scroller, {
      scrollTop: 120,
      clientHeight: 800,
      scrollHeight: 40_000,
    })
    const releaseLock = observePaneBottomLock(pane.scroller, () => true)

    pane.scroller.dispatchEvent(new Event('scroll'))
    await harness.nextFrame()

    expect(pane.scroller.scrollTop).toBe(120)
    releaseLock()
  })

  test('the bottom-lock owner holds the pane open after the last body unmounts', async () => {
    const pane = await mountInstrumentedPane(() => {})
    const releaseLock = observePaneBottomLock(pane.scroller, () => false)
    await pane.setBodyCount(4)

    expect(pane.listeners.counts.added).toBe(1)

    await pane.setBodyCount(0)
    expect(coordinator.isPaneAttached(pane.scroller)).toBe(true)
    expect(pane.listeners.counts.removed).toBe(0)

    releaseLock()
    expect(coordinator.isPaneAttached(pane.scroller)).toBe(false)
    expect(pane.listeners.counts.removed).toBe(1)
  })

  // Last on purpose: `bun test app/` shares one process across all 215 files, so
  // a harness that failed to hand the globals back would give every later SSR
  // suite a `window` it was never written for.
  test('teardown hands the globals back, leaving later SSR suites DOM-free', async () => {
    await harness.teardown()

    expect(domHarness.isRegistered()).toBe(false)
    expect(typeof globalThis.window).toBe('undefined')
    expect(typeof globalThis.document).toBe('undefined')
    expect(typeof globalThis.ResizeObserver).toBe('undefined')
    expect(typeof globalThis.requestAnimationFrame).toBe('undefined')
  })
})
