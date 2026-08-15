import { afterEach, describe, expect, test } from 'bun:test'
import { _forTest, observePaneScroll } from './markdownScrollCoordinator.js'

type FakeScroller = HTMLElement & {
  listenerCount: number
  emitScroll: () => void
}

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

function createScroller(): FakeScroller {
  const handlers = new Set<() => void>()
  const scroller = {
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
