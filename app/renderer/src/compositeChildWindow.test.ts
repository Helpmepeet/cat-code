import { describe, expect, test } from 'bun:test'
import {
  COMPOSITE_CHILD_OVERSCAN,
  MAX_MOUNTED_COMPOSITE_CHILDREN,
  MAX_RETAINED_CHILD_MEASUREMENTS,
  createCompositeChildState,
  reduceCompositeChildState,
  sameCompositeChildWindow,
  selectCompositeChildEntries,
  selectCompositeChildWindow,
  selectInitialCompositeChildWindow,
  type CompositeChildEntry,
} from './compositeChildWindow.js'

function keysOf(count: number, prefix = 'k'): string[] {
  return Array.from({ length: count }, (_unused, index) => `${prefix}${index}`)
}

function uniformEntries(count: number, height: number): CompositeChildEntry[] {
  return selectCompositeChildEntries(keysOf(count), height, createCompositeChildState())
}

function totalHeight(entries: readonly CompositeChildEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.height, 0)
}

describe('selectInitialCompositeChildWindow', () => {
  test('a container under the ceiling mounts all of its children', () => {
    const entries = uniformEntries(12, 120)
    const first = selectInitialCompositeChildWindow(entries)

    expect(first).toEqual({
      start: 0,
      end: 12,
      topSpacerHeight: 0,
      bottomSpacerHeight: 0,
    })
  })

  test('a container over the ceiling mounts the prefix and stands the rest off', () => {
    const entries = uniformEntries(5_000, 120)
    const first = selectInitialCompositeChildWindow(entries)

    expect(first.start).toBe(0)
    expect(first.end).toBe(MAX_MOUNTED_COMPOSITE_CHILDREN)
    expect(first.topSpacerHeight).toBe(0)
    // The unmounted remainder still occupies its full height, so the scroller
    // reports the size of the whole container, not of the mounted slice.
    expect(first.bottomSpacerHeight).toBe((5_000 - MAX_MOUNTED_COMPOSITE_CHILDREN) * 120)
  })

  test('an empty container has no window and no spacers', () => {
    expect(selectInitialCompositeChildWindow([])).toEqual({
      start: 0,
      end: 0,
      topSpacerHeight: 0,
      bottomSpacerHeight: 0,
    })
  })
})

describe('selectCompositeChildWindow', () => {
  test('at the top of the pane it mounts from the first child', () => {
    const window = selectCompositeChildWindow(uniformEntries(5_000, 120), 0, 800)

    expect(window.start).toBe(0)
    expect(window.topSpacerHeight).toBe(0)
    expect(window.end).toBeGreaterThan(0)
    expect(window.end).toBeLessThanOrEqual(MAX_MOUNTED_COMPOSITE_CHILDREN)
  })

  test('the mounted range tracks the scroll offset and the spacers follow it', () => {
    const entries = uniformEntries(5_000, 120)
    const window = selectCompositeChildWindow(entries, 60_000, 800)

    // The first child whose bottom edge reaches the overscan boundary.
    expect(window.start).toBe(Math.floor((60_000 - COMPOSITE_CHILD_OVERSCAN) / 120))
    expect(window.topSpacerHeight).toBe(window.start * 120)
    expect(window.bottomSpacerHeight).toBe((5_000 - window.end) * 120)
    // Nothing is lost: the mounted range plus both spacers is the whole thing.
    expect(
      window.topSpacerHeight +
        (window.end - window.start) * 120 +
        window.bottomSpacerHeight,
    ).toBe(totalHeight(entries))
  })

  test('the window covers the whole viewport for the shortest child kind', () => {
    // The tool-run member row is the smallest child any container has. The
    // ceiling must still reach past the bottom of an 800px viewport, or a run
    // scrolled into view would render blank below the fold.
    const entries = uniformEntries(5_000, 28)
    const window = selectCompositeChildWindow(entries, 10_000, 800)
    const mountedTop = window.topSpacerHeight
    const mountedBottom = mountedTop + (window.end - window.start) * 28

    expect(mountedTop).toBeLessThanOrEqual(10_000)
    expect(mountedBottom).toBeGreaterThanOrEqual(10_000 + 800)
  })

  test('a fixed viewport keeps a fixed bound as the child count grows ten times', () => {
    const small = selectCompositeChildWindow(uniformEntries(500, 120), 0, 800)
    const large = selectCompositeChildWindow(uniformEntries(5_000, 120), 0, 800)
    const huge = selectCompositeChildWindow(uniformEntries(50_000, 120), 0, 800)

    expect(large.end - large.start).toBe(small.end - small.start)
    expect(huge.end - huge.start).toBe(small.end - small.start)
    expect(huge.end - huge.start).toBeLessThanOrEqual(MAX_MOUNTED_COMPOSITE_CHILDREN)
  })

  test('a container scrolled entirely past keeps one child mounted', () => {
    const entries = uniformEntries(400, 120)
    const window = selectCompositeChildWindow(entries, 10_000_000, 800)

    expect(window.end - window.start).toBe(1)
    expect(window.end).toBeLessThanOrEqual(entries.length)
  })

  test('an empty container selects an empty window', () => {
    expect(selectCompositeChildWindow([], 0, 800)).toEqual({
      start: 0,
      end: 0,
      topSpacerHeight: 0,
      bottomSpacerHeight: 0,
    })
  })

  test('measured heights, not estimates, decide the range', () => {
    // A container whose children turned out to be four times the estimate must
    // mount a quarter as many for the same viewport.
    const estimated = selectCompositeChildWindow(uniformEntries(1_000, 100), 0, 800)
    const measured = selectCompositeChildWindow(uniformEntries(1_000, 400), 0, 800)

    expect(measured.end).toBeLessThan(estimated.end)
    expect(measured.bottomSpacerHeight).toBeGreaterThan(estimated.bottomSpacerHeight)
  })
})

describe('reduceCompositeChildState', () => {
  test('a measurement replaces the estimate for that child only', () => {
    const state = reduceCompositeChildState(createCompositeChildState(), {
      kind: 'measured',
      measurements: [{ key: 'k1', height: 640 }],
    })
    const entries = selectCompositeChildEntries(keysOf(3), 120, state)

    expect(entries).toEqual([
      { key: 'k0', height: 120 },
      { key: 'k1', height: 640 },
      { key: 'k2', height: 120 },
    ])
  })

  test('re-reporting a height a child already had returns the same state object', () => {
    const first = reduceCompositeChildState(createCompositeChildState(), {
      kind: 'measured',
      measurements: [{ key: 'k0', height: 200 }],
    })
    const again = reduceCompositeChildState(first, {
      kind: 'measured',
      measurements: [{ key: 'k0', height: 200 }],
    })

    expect(again).toBe(first)
  })

  test('a zero or negative measurement is ignored', () => {
    const state = createCompositeChildState()
    const next = reduceCompositeChildState(state, {
      kind: 'measured',
      measurements: [
        { key: 'k0', height: 0 },
        { key: 'k1', height: -12 },
        { key: 'k2', height: Number.NaN },
      ],
    })

    expect(next).toBe(state)
  })

  test('retained measurements are capped, evicting the least recently measured', () => {
    // Scrolling through a very large container measures every child it passes.
    // Without the cap the measurement map becomes the unbounded structure the
    // mounted DOM stopped being.
    let state = createCompositeChildState()
    for (let index = 0; index < MAX_RETAINED_CHILD_MEASUREMENTS + 500; index += 1) {
      state = reduceCompositeChildState(state, {
        kind: 'measured',
        measurements: [{ key: `k${index}`, height: 100 + index }],
      })
    }

    expect(state.heights.size).toBe(MAX_RETAINED_CHILD_MEASUREMENTS)
    expect(state.heights.has('k0')).toBe(false)
    expect(state.heights.has(`k${MAX_RETAINED_CHILD_MEASUREMENTS + 499}`)).toBe(true)
  })

  test('re-measuring an old child renews it against eviction', () => {
    let state = reduceCompositeChildState(createCompositeChildState(), {
      kind: 'measured',
      measurements: [{ key: 'oldest', height: 100 }],
    })
    for (let index = 0; index < MAX_RETAINED_CHILD_MEASUREMENTS - 1; index += 1) {
      state = reduceCompositeChildState(state, {
        kind: 'measured',
        measurements: [{ key: `k${index}`, height: 100 }],
      })
    }
    // Touching it again moves it to the end of the eviction order.
    state = reduceCompositeChildState(state, {
      kind: 'measured',
      measurements: [{ key: 'oldest', height: 101 }],
    })
    state = reduceCompositeChildState(state, {
      kind: 'measured',
      measurements: [{ key: 'newcomer', height: 100 }],
    })

    expect(state.heights.has('oldest')).toBe(true)
    expect(state.heights.has('k0')).toBe(false)
  })

  test('a height retained for a departed child is never read back', () => {
    const state = reduceCompositeChildState(createCompositeChildState(), {
      kind: 'measured',
      measurements: [{ key: 'gone', height: 900 }],
    })

    expect(selectCompositeChildEntries(['k0'], 120, state)).toEqual([
      { key: 'k0', height: 120 },
    ])
  })
})

describe('sameCompositeChildWindow', () => {
  test('distinguishes a moved range from an unchanged one', () => {
    const entries = uniformEntries(5_000, 120)
    const top = selectCompositeChildWindow(entries, 0, 800)

    expect(sameCompositeChildWindow(top, selectCompositeChildWindow(entries, 0, 800))).toBe(
      true,
    )
    expect(
      sameCompositeChildWindow(top, selectCompositeChildWindow(entries, 9_000, 800)),
    ).toBe(false)
  })
})
