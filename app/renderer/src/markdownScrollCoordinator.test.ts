import { afterEach, describe, expect, test } from 'bun:test'
import {
  _forTest,
  observePaneBottomLock,
  observePaneScroll,
  reportPaneHeightCorrection,
} from './markdownScrollCoordinator.js'

type FakeScroller = HTMLElement & {
  listenerCount: number
  emitScroll: () => void
}

/** A pane scrolled to 5,000 px through a 40,000 px document, viewport 800 px. */
const READING_GEOMETRY = { scrollTop: 5_000, clientHeight: 800, scrollHeight: 40_000 }

const originalRaf = globalThis.requestAnimationFrame
const originalCancelRaf = globalThis.cancelAnimationFrame
const originalResizeObserver = globalThis.ResizeObserver

let pendingFrames: Array<() => void> = []
let nextFrameId = 0
let resizeObserverCount = 0

function installGlobals(): void {
  pendingFrames = []
  nextFrameId = 0
  resizeObserverCount = 0
  globalThis.requestAnimationFrame = ((callback: () => void) => {
    pendingFrames.push(callback)
    nextFrameId += 1
    return nextFrameId
  }) as typeof globalThis.requestAnimationFrame
  globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame
  globalThis.ResizeObserver = class {
    constructor() {
      resizeObserverCount += 1
    }
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof globalThis.ResizeObserver
}

function runFrames(): void {
  const frames = pendingFrames
  pendingFrames = []
  for (const frame of frames) frame()
}

function createScroller(
  geometry: { scrollTop: number; clientHeight: number; scrollHeight: number } = {
    scrollTop: 0,
    clientHeight: 0,
    scrollHeight: 0,
  },
): FakeScroller {
  const handlers = new Set<() => void>()
  const scroller = {
    scrollTop: geometry.scrollTop,
    clientHeight: geometry.clientHeight,
    scrollHeight: geometry.scrollHeight,
    get listenerCount() {
      return handlers.size
    },
    addEventListener: (_type: string, handler: () => void) => {
      handlers.add(handler)
    },
    removeEventListener: (_type: string, handler: () => void) => {
      handlers.delete(handler)
    },
    emitScroll: () => {
      for (const handler of [...handlers]) handler()
    },
  }
  return scroller as unknown as FakeScroller
}

afterEach(() => {
  globalThis.requestAnimationFrame = originalRaf
  globalThis.cancelAnimationFrame = originalCancelRaf
  globalThis.ResizeObserver = originalResizeObserver
})

describe('observePaneScroll', () => {
  test('many bodies in one pane share a single scroll listener and observer', () => {
    installGlobals()
    const scroller = createScroller()

    const releases = Array.from({ length: 50 }, () => observePaneScroll(scroller, () => {}))

    expect(scroller.listenerCount).toBe(1)
    expect(resizeObserverCount).toBe(1)
    expect(_forTest.paneSubscriberCount(scroller)).toBe(50)

    for (const release of releases) release()
  })

  test('one scroll event notifies every subscriber in a single frame', () => {
    installGlobals()
    const scroller = createScroller()
    let firstCalls = 0
    let secondCalls = 0
    const releaseFirst = observePaneScroll(scroller, () => {
      firstCalls += 1
    })
    const releaseSecond = observePaneScroll(scroller, () => {
      secondCalls += 1
    })

    scroller.emitScroll()
    scroller.emitScroll()
    scroller.emitScroll()
    expect(pendingFrames).toHaveLength(1)

    runFrames()
    expect(firstCalls).toBe(1)
    expect(secondCalls).toBe(1)

    releaseFirst()
    releaseSecond()
  })

  test('the shared listener is released only when the last body unmounts', () => {
    installGlobals()
    const scroller = createScroller()
    const releaseFirst = observePaneScroll(scroller, () => {})
    const releaseSecond = observePaneScroll(scroller, () => {})

    releaseFirst()
    expect(scroller.listenerCount).toBe(1)
    expect(_forTest.isPaneAttached(scroller)).toBe(true)

    releaseSecond()
    expect(scroller.listenerCount).toBe(0)
    expect(_forTest.isPaneAttached(scroller)).toBe(false)
  })

  test('re-registering after full release attaches exactly one listener again', () => {
    installGlobals()
    const scroller = createScroller()
    observePaneScroll(scroller, () => {})()

    const release = observePaneScroll(scroller, () => {})
    expect(scroller.listenerCount).toBe(1)
    expect(resizeObserverCount).toBe(2)

    release()
  })
})

describe('pane scroll correction', () => {
  test('every correction in a frame is applied as ONE scroll adjustment', () => {
    installGlobals()
    const scroller = createScroller(READING_GEOMETRY)
    const release = observePaneScroll(scroller, () => {})

    reportPaneHeightCorrection(scroller, { offset: 1_000, delta: 40 })
    reportPaneHeightCorrection(scroller, { offset: 3_040, delta: 60 })
    reportPaneHeightCorrection(scroller, { offset: 30_000, delta: 500 })
    // One frame for all three, and nothing has moved before it runs.
    expect(pendingFrames).toHaveLength(1)
    expect(_forTest.pendingCorrectionCount(scroller)).toBe(3)
    expect(scroller.scrollTop).toBe(5_000)

    runFrames()
    expect(scroller.scrollTop).toBe(5_100)
    expect(_forTest.pendingCorrectionCount(scroller)).toBe(0)

    release()
  })

  test('a correction below the visible anchor leaves the scroller alone', () => {
    installGlobals()
    const scroller = createScroller(READING_GEOMETRY)
    const release = observePaneScroll(scroller, () => {})

    reportPaneHeightCorrection(scroller, { offset: 20_000, delta: 900 })
    runFrames()

    expect(scroller.scrollTop).toBe(5_000)
    release()
  })

  test('subscribers see the corrected position, not the one they committed', () => {
    installGlobals()
    const scroller = createScroller(READING_GEOMETRY)
    const seen: number[] = []
    const release = observePaneScroll(scroller, () => seen.push(scroller.scrollTop))

    reportPaneHeightCorrection(scroller, { offset: 0, delta: 120 })
    runFrames()

    expect(seen).toEqual([5_120])
    release()
  })

  test('an active bottom lock wins and lands on the end of the document', () => {
    installGlobals()
    const scroller = createScroller({
      scrollTop: 39_000,
      clientHeight: 800,
      scrollHeight: 40_500,
    })
    const release = observePaneScroll(scroller, () => {})
    const releaseLock = observePaneBottomLock(scroller, () => true)

    // Below the anchor: without the lock this correction moves nothing.
    reportPaneHeightCorrection(scroller, { offset: 40_000, delta: 500 })
    runFrames()

    expect(scroller.scrollTop).toBe(39_700)
    releaseLock()
    release()
  })

  test('a locked pane with no correction is never re-pinned on its own', () => {
    installGlobals()
    const scroller = createScroller(READING_GEOMETRY)
    const release = observePaneScroll(scroller, () => {})
    const releaseLock = observePaneBottomLock(scroller, () => true)

    scroller.emitScroll()
    runFrames()

    expect(scroller.scrollTop).toBe(5_000)
    releaseLock()
    release()
  })

  test('a correction reported after the pane is released is dropped', () => {
    installGlobals()
    const scroller = createScroller(READING_GEOMETRY)
    observePaneScroll(scroller, () => {})()

    reportPaneHeightCorrection(scroller, { offset: 0, delta: 120 })

    expect(pendingFrames).toHaveLength(0)
    expect(scroller.scrollTop).toBe(5_000)
  })
})

describe('the stick-to-bottom owner shares the pane lifetime', () => {
  test('it holds the pane open after the last body leaves, and releases it', () => {
    installGlobals()
    const scroller = createScroller(READING_GEOMETRY)
    const releaseLock = observePaneBottomLock(scroller, () => false)
    const release = observePaneScroll(scroller, () => {})

    expect(scroller.listenerCount).toBe(1)
    expect(_forTest.paneBottomLockCount(scroller)).toBe(1)

    release()
    expect(_forTest.isPaneAttached(scroller)).toBe(true)
    expect(scroller.listenerCount).toBe(1)

    releaseLock()
    expect(_forTest.isPaneAttached(scroller)).toBe(false)
    expect(scroller.listenerCount).toBe(0)
  })

  test('one owner answering yes locks the pane', () => {
    installGlobals()
    const scroller = createScroller(READING_GEOMETRY)
    const release = observePaneScroll(scroller, () => {})
    const releaseFalse = observePaneBottomLock(scroller, () => false)
    const releaseTrue = observePaneBottomLock(scroller, () => true)

    reportPaneHeightCorrection(scroller, { offset: 30_000, delta: 500 })
    runFrames()

    expect(scroller.scrollTop).toBe(39_200)
    releaseTrue()
    releaseFalse()
    release()
  })
})
