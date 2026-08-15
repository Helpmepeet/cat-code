import { describe, expect, test } from 'bun:test'
import {
  FIXED_ROW_HEIGHT_CLASS,
  MAX_MOUNTED_CHUNK_CHARS,
  MAX_MOUNTED_OUTPUT_LINES,
  OUTPUT_LINE_HEIGHT,
  createLineGeometryState,
  reduceLineGeometryState,
  selectCentredScrollTop,
  selectGeometryMode,
  selectIsMeasured,
  selectLineAtOffset,
  selectLineHeight,
  selectLineTop,
  selectLineWindow,
  selectTotalHeight,
  selectVisualChunk,
  type LineGeometryState,
} from './lineWindow.js'

function sourceLines(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`)
}

/** Measure at the state's own layout revision, the way the list does. */
function measure(
  state: LineGeometryState,
  entries: readonly { index: number; height: number; chromeHeight?: number }[],
): LineGeometryState {
  return reduceLineGeometryState(state, {
    kind: 'measure',
    entries: entries.map(entry => ({
      index: entry.index,
      height: entry.height,
      chromeHeight: entry.chromeHeight ?? 0,
      layoutRevision: state.layoutRevision,
    })),
  })
}

describe('fixed geometry (unwrapped output)', () => {
  test('every offset is an exact multiple of the 20px grid', () => {
    const state = createLineGeometryState(sourceLines(1_000))

    expect(selectGeometryMode(state)).toBe('fixed')
    expect(selectTotalHeight(state)).toBe(1_000 * OUTPUT_LINE_HEIGHT)
    expect(selectLineTop(state, 0)).toBe(0)
    expect(selectLineTop(state, 137)).toBe(137 * OUTPUT_LINE_HEIGHT)
    expect(selectLineHeight(state, 137)).toBe(OUTPUT_LINE_HEIGHT)
    expect(selectLineAtOffset(state, 137 * OUTPUT_LINE_HEIGHT)).toBe(137)
    expect(selectLineAtOffset(state, 137 * OUTPUT_LINE_HEIGHT - 1)).toBe(136)
  })

  test('the window and both spacers are exact around a later viewport', () => {
    const state = createLineGeometryState(sourceLines(1_000))
    const window = selectLineWindow(state, 500 * OUTPUT_LINE_HEIGHT, 600, 0, 20)

    expect(window.start).toBe(500)
    expect(window.end).toBe(520)
    expect(window.topSpacerHeight).toBe(500 * OUTPUT_LINE_HEIGHT)
    expect(window.bottomSpacerHeight).toBe(480 * OUTPUT_LINE_HEIGHT)
    expect(
      window.topSpacerHeight +
        (window.end - window.start) * OUTPUT_LINE_HEIGHT +
        window.bottomSpacerHeight,
    ).toBe(selectTotalHeight(state))
  })

  test('a row that measures exactly on the grid keeps the geometry fixed', () => {
    const state = measure(createLineGeometryState(sourceLines(50)), [
      { index: 3, height: OUTPUT_LINE_HEIGHT },
      { index: 4, height: OUTPUT_LINE_HEIGHT },
    ])

    expect(selectGeometryMode(state)).toBe('fixed')
    expect(selectTotalHeight(state)).toBe(50 * OUTPUT_LINE_HEIGHT)
  })

  test('the row class the list pins an unwrapped box to matches the constant', () => {
    // The CSS and the arithmetic are one number or the geometry is a guess.
    expect(FIXED_ROW_HEIGHT_CLASS).toBe(`h-[${OUTPUT_LINE_HEIGHT}px]`)
  })

  test('mounted rows stay bounded however long the output is', () => {
    const window = selectLineWindow(
      createLineGeometryState(sourceLines(100_000)),
      0,
      600,
    )

    expect(window.end - window.start).toBeLessThanOrEqual(
      MAX_MOUNTED_OUTPUT_LINES,
    )
    expect(window.bottomSpacerHeight).toBeGreaterThan(0)
  })
})

describe('measured geometry (wrapped output)', () => {
  test('a wrapped line measures taller than the grid and moves every offset below it', () => {
    const base = createLineGeometryState(sourceLines(100))
    const state = measure(base, [{ index: 10, height: 60 }])

    expect(selectGeometryMode(state)).toBe('measured')
    expect(selectLineHeight(state, 10)).toBe(60)
    expect(selectTotalHeight(state)).toBe(100 * OUTPUT_LINE_HEIGHT + 40)
    // Above the wrapped line nothing moved; below it everything moved by 40.
    expect(selectLineTop(state, 9)).toBe(180)
    expect(selectLineTop(state, 10)).toBe(200)
    expect(selectLineTop(state, 11)).toBe(260)
    expect(selectLineTop(state, 50)).toBe(50 * OUTPUT_LINE_HEIGHT + 40)
  })

  test('range lookup follows the measurements, not the grid', () => {
    const state = measure(createLineGeometryState(sourceLines(100)), [
      { index: 10, height: 60 },
    ])

    expect(selectLineAtOffset(state, 200)).toBe(10)
    expect(selectLineAtOffset(state, 259)).toBe(10)
    expect(selectLineAtOffset(state, 260)).toBe(11)
  })

  test('the window over a wrapped body still sums to the scroll extent', () => {
    const state = measure(createLineGeometryState(sourceLines(100)), [
      { index: 10, height: 60 },
    ])
    const window = selectLineWindow(state, 240, 40, 0)

    expect(window.start).toBe(10)
    expect(window.end).toBe(13)
    expect(window.topSpacerHeight).toBe(200)
    let mounted = 0
    for (let index = window.start; index < window.end; index++) {
      mounted += selectLineHeight(state, index)
    }
    expect(mounted).toBe(100)
    expect(
      window.topSpacerHeight + mounted + window.bottomSpacerHeight,
    ).toBe(selectTotalHeight(state))
  })

  test('unmeasured lines fall back to the grid, so a partly measured body is still ordered', () => {
    const state = measure(createLineGeometryState(sourceLines(100)), [
      { index: 10, height: 60 },
      { index: 40, height: 100 },
    ])

    let previous = -1
    for (let index = 0; index <= 100; index++) {
      const top = selectLineTop(state, index)
      expect(top).toBeGreaterThan(previous)
      previous = top
    }
    expect(selectLineTop(state, 100)).toBe(selectTotalHeight(state))
  })
})

describe('layout revisions', () => {
  test('a width change invalidates the wrapped measurements taken at the old width', () => {
    const wide = createLineGeometryState(sourceLines(100), {
      layoutRevision: '420|nowrap',
    })
    const measured = measure(wide, [
      { index: 10, height: 60 },
      { index: 20, height: 80 },
    ])
    expect(selectGeometryMode(measured)).toBe('measured')

    const narrow = reduceLineGeometryState(measured, {
      kind: 'layout',
      layoutRevision: '300|nowrap',
    })

    expect(selectGeometryMode(narrow)).toBe('fixed')
    expect(selectLineHeight(narrow, 10)).toBe(OUTPUT_LINE_HEIGHT)
    expect(selectTotalHeight(narrow)).toBe(100 * OUTPUT_LINE_HEIGHT)

    // Re-measured at the new width, and only that row deviates again.
    const remeasured = measure(narrow, [{ index: 10, height: 100 }])
    expect(selectLineHeight(remeasured, 10)).toBe(100)
    expect(selectLineHeight(remeasured, 20)).toBe(OUTPUT_LINE_HEIGHT)
    expect(selectTotalHeight(remeasured)).toBe(100 * OUTPUT_LINE_HEIGHT + 80)
  })

  test('a wrap toggle rides the same revision, since it changes every height and no text', () => {
    const unwrapped = createLineGeometryState(sourceLines(20), {
      layoutRevision: '420|whitespace-pre',
    })
    const wrapped = reduceLineGeometryState(
      measure(unwrapped, [{ index: 4, height: OUTPUT_LINE_HEIGHT }]),
      { kind: 'layout', layoutRevision: '420|whitespace-pre-wrap' },
    )

    expect(selectIsMeasured(wrapped, 4)).toBe(false)
    expect(selectGeometryMode(measure(wrapped, [{ index: 4, height: 80 }]))).toBe(
      'measured',
    )
  })

  test('a changed line loses only its own measurement; its neighbours survive', () => {
    const lines = sourceLines(10)
    const state = measure(createLineGeometryState(lines), [
      { index: 3, height: 60 },
      { index: 7, height: 80 },
    ])

    const edited = [...lines]
    edited[3] = 'line 4 grew a tail'
    const next = reduceLineGeometryState(state, { kind: 'lines', lines: edited })

    expect(selectIsMeasured(next, 3)).toBe(false)
    expect(selectLineHeight(next, 3)).toBe(OUTPUT_LINE_HEIGHT)
    expect(selectIsMeasured(next, 7)).toBe(true)
    expect(selectLineHeight(next, 7)).toBe(80)
  })

  test('measurements for lines that left the source are pruned', () => {
    const lines = sourceLines(10)
    const state = measure(createLineGeometryState(lines), [
      { index: 8, height: 60 },
    ])
    const shorter = reduceLineGeometryState(state, {
      kind: 'lines',
      lines: lines.slice(0, 5),
    })

    expect(shorter.measurements.size).toBe(0)
    expect(selectTotalHeight(shorter)).toBe(5 * OUTPUT_LINE_HEIGHT)
  })
})

describe('search centring', () => {
  test('the estimate mounts the target and the measurement lands it', () => {
    const wrapped = Array.from({ length: 100 }, (_, index) => ({
      index,
      height: 60,
    }))
    const estimated = measure(
      createLineGeometryState(sourceLines(1_000)),
      wrapped,
    )
    const viewport = 400

    // Pass one: the target has never been mounted, so its own height is a
    // guess. This is the scroll that mounts it.
    const requested = reduceLineGeometryState(estimated, {
      kind: 'centre',
      index: 500,
    })
    expect(requested.pendingCentreIndex).toBe(500)
    expect(selectIsMeasured(requested, 500)).toBe(false)
    const estimate = selectCentredScrollTop(requested, 500, viewport)
    expect(estimate).toBe(13_810)

    // Pass two: mounted and measured, so one correction is exact.
    const settled = measure(requested, [{ index: 500, height: 100 }])
    expect(selectIsMeasured(settled, 500)).toBe(true)
    const corrected = selectCentredScrollTop(settled, 500, viewport)
    expect(corrected).not.toBe(estimate)
    expect(corrected + viewport / 2).toBe(
      selectLineTop(settled, 500) + selectLineHeight(settled, 500) / 2,
    )

    // …and the request is spent, so nothing scrolls a third time.
    expect(
      reduceLineGeometryState(settled, { kind: 'centred' }).pendingCentreIndex,
    ).toBeNull()
  })

  test('centring clamps at both ends instead of scrolling past the body', () => {
    const state = createLineGeometryState(sourceLines(100))

    expect(selectCentredScrollTop(state, 0, 400)).toBe(0)
    expect(selectCentredScrollTop(state, 99, 400)).toBe(
      100 * OUTPUT_LINE_HEIGHT - 400,
    )
  })
})

describe('interstitial chrome', () => {
  // The reveal band sits between two logical rows. Before it was a prefix
  // entry, every offset below it was short by the band's height.
  const BAND = 36

  function withBand(): LineGeometryState {
    return measure(createLineGeometryState(sourceLines(100)), [
      { index: 30, height: OUTPUT_LINE_HEIGHT, chromeHeight: BAND },
    ])
  }

  test('the band is in the total height and in every offset below it', () => {
    const state = withBand()

    expect(selectTotalHeight(state)).toBe(100 * OUTPUT_LINE_HEIGHT + BAND)
    expect(selectLineTop(state, 29)).toBe(29 * OUTPUT_LINE_HEIGHT)
    expect(selectLineTop(state, 30)).toBe(30 * OUTPUT_LINE_HEIGHT + BAND)
    expect(selectLineTop(state, 31)).toBe(31 * OUTPUT_LINE_HEIGHT + BAND)
  })

  test('a window across the band still sums to the scroll extent', () => {
    const state = withBand()
    const window = selectLineWindow(state, 0, 800, 0)

    expect(window.start).toBe(0)
    expect(window.topSpacerHeight).toBe(0)
    let mounted = 0
    for (let index = window.start; index < window.end; index++) {
      mounted += selectLineHeight(state, index)
      if (index === 30) mounted += BAND
    }
    expect(window.end).toBeGreaterThan(30)
    expect(
      window.topSpacerHeight + mounted + window.bottomSpacerHeight,
    ).toBe(selectTotalHeight(state))
  })

  test('the window immediately before and immediately after the band is right', () => {
    const state = withBand()

    // Last row above the band.
    expect(selectLineAtOffset(state, 29 * OUTPUT_LINE_HEIGHT)).toBe(29)
    expect(selectLineAtOffset(state, 30 * OUTPUT_LINE_HEIGHT - 1)).toBe(29)
    // The band's own strip belongs to the block of the row it precedes.
    expect(selectLineAtOffset(state, 30 * OUTPUT_LINE_HEIGHT)).toBe(30)
    expect(selectLineAtOffset(state, 30 * OUTPUT_LINE_HEIGHT + BAND)).toBe(30)
    expect(
      selectLineAtOffset(state, 31 * OUTPUT_LINE_HEIGHT + BAND),
    ).toBe(31)
  })

  test('an active match after the band centres a band-height lower than one before it', () => {
    const state = withBand()
    const bandless = createLineGeometryState(sourceLines(100))

    expect(selectCentredScrollTop(state, 29, 400)).toBe(
      selectCentredScrollTop(bandless, 29, 400),
    )
    expect(selectCentredScrollTop(state, 30, 400)).toBe(
      selectCentredScrollTop(bandless, 30, 400) + BAND,
    )
  })
})

describe('the character budget for one logical line', () => {
  const HUGE = 4_000_000

  test('a multi-megabyte logical line mounts a bounded chunk and keeps the source', () => {
    const line = 'x'.repeat(HUGE)
    const state = createLineGeometryState([line])
    const chunk = selectVisualChunk(line)

    expect(chunk.text.length).toBe(MAX_MOUNTED_CHUNK_CHARS)
    expect(chunk.truncatedStart).toBe(false)
    expect(chunk.truncatedEnd).toBe(true)
    // Bounding is about mounted DOM. The model still holds every character.
    expect(state.lines[0].length).toBe(HUGE)
    // And it is still ONE row against the row budget.
    expect(selectLineWindow(state, 0, 600).end).toBe(1)
  })

  test('the chunk can be anchored so a match deep inside the line is reachable', () => {
    const line = `${'x'.repeat(HUGE)}needle${'x'.repeat(10_000)}`
    const chunk = selectVisualChunk(line, HUGE)

    expect(chunk.text.length).toBe(MAX_MOUNTED_CHUNK_CHARS)
    expect(chunk.text).toContain('needle')
    expect(chunk.truncatedStart).toBe(true)
    expect(chunk.truncatedEnd).toBe(true)
    expect(chunk.startOffset).toBe(HUGE - MAX_MOUNTED_CHUNK_CHARS / 2)
  })

  test('an anchor at the very end slides the chunk back rather than off the line', () => {
    const line = 'x'.repeat(10_000)
    const chunk = selectVisualChunk(line, 10_000)

    expect(chunk.text.length).toBe(MAX_MOUNTED_CHUNK_CHARS)
    expect(chunk.startOffset).toBe(10_000 - MAX_MOUNTED_CHUNK_CHARS)
    expect(chunk.truncatedEnd).toBe(false)
  })

  test('a line under the budget is mounted whole and unmarked', () => {
    const chunk = selectVisualChunk('const x = 1')

    expect(chunk.text).toBe('const x = 1')
    expect(chunk.truncatedStart).toBe(false)
    expect(chunk.truncatedEnd).toBe(false)
  })

  test('a cut never splits a surrogate pair', () => {
    const line = '😀'.repeat(4_000)
    const chunk = selectVisualChunk(line, 0, 101)

    expect(chunk.text.length).toBe(100)
    expect([...chunk.text]).toHaveLength(50)
  })
})
