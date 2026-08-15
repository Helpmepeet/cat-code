/**
 * The anchor arithmetic itself. happy-dom has no layout engine, so this is the
 * only layer where a measured-height correction can be proven at all: every
 * number below is absolute, never a comparison against the rule under test.
 */
import { describe, expect, test } from 'bun:test'
import { selectPaneScrollAdjustment } from './paneAnchorModel.js'

/** A pane scrolled to 5,000 px through a 40,000 px document. */
const READING = { scrollTop: 5_000, viewportHeight: 800, contentHeight: 40_000 }

describe('a correction relative to the visible anchor', () => {
  test('a change above the anchor moves the scroller by exactly its delta', () => {
    expect(
      selectPaneScrollAdjustment({
        metrics: READING,
        corrections: [{ offset: 1_200, delta: 60 }],
        bottomLocked: false,
      }),
    ).toBe(60)
  })

  test('a shrinkage above the anchor moves the scroller back by exactly its delta', () => {
    expect(
      selectPaneScrollAdjustment({
        metrics: READING,
        corrections: [{ offset: 1_200, delta: -45 }],
        bottomLocked: false,
      }),
    ).toBe(-45)
  })

  test('a change below the anchor leaves the scroller alone', () => {
    expect(
      selectPaneScrollAdjustment({
        metrics: READING,
        corrections: [{ offset: 5_001, delta: 600 }],
        bottomLocked: false,
      }),
    ).toBe(0)
  })

  test('a change starting exactly at the anchor leaves the scroller alone', () => {
    expect(
      selectPaneScrollAdjustment({
        metrics: READING,
        corrections: [{ offset: 5_000, delta: 600 }],
        bottomLocked: false,
      }),
    ).toBe(0)
  })

  test('nothing to correct is not a reason to move', () => {
    expect(
      selectPaneScrollAdjustment({
        metrics: READING,
        corrections: [],
        bottomLocked: false,
      }),
    ).toBe(0)
  })
})

describe('several corrections in one frame', () => {
  test('only the ones above the anchor are summed', () => {
    // 1,000 and 3,040 are above 5,000; 12,000 is below it.
    expect(
      selectPaneScrollAdjustment({
        metrics: READING,
        corrections: [
          { offset: 12_000, delta: 500 },
          { offset: 1_000, delta: 40 },
          { offset: 3_040, delta: 60 },
        ],
        bottomLocked: false,
      }),
    ).toBe(100)
  })

  test('an offset is discounted by the corrections already found above it', () => {
    // Reported offsets are post-change. 5,100 arrives after 100 px of growth
    // above it, so the content it names started at exactly 5,000: the anchor
    // itself, which does not move the scroller.
    expect(
      selectPaneScrollAdjustment({
        metrics: READING,
        corrections: [
          { offset: 1_000, delta: 40 },
          { offset: 3_040, delta: 60 },
          { offset: 5_100, delta: 30 },
        ],
        bottomLocked: false,
      }),
    ).toBe(100)
  })

  test('reported order does not change the answer', () => {
    const corrections = [
      { offset: 3_040, delta: 60 },
      { offset: 5_100, delta: 30 },
      { offset: 1_000, delta: 40 },
    ]
    expect(
      selectPaneScrollAdjustment({ metrics: READING, corrections, bottomLocked: false }),
    ).toBe(100)
  })
})

describe('bottom lock', () => {
  const FOLLOWING = { scrollTop: 39_000, viewportHeight: 800, contentHeight: 40_500 }

  test('an active lock lands on the end of the document', () => {
    expect(
      selectPaneScrollAdjustment({
        metrics: FOLLOWING,
        corrections: [{ offset: 40_000, delta: 500 }],
        bottomLocked: true,
      }),
    ).toBe(700)
  })

  test('an active lock wins over a correction the anchor rule would ignore', () => {
    const corrections = [{ offset: 40_000, delta: 500 }]
    expect(
      selectPaneScrollAdjustment({ metrics: FOLLOWING, corrections, bottomLocked: false }),
    ).toBe(0)
    expect(
      selectPaneScrollAdjustment({ metrics: FOLLOWING, corrections, bottomLocked: true }),
    ).toBe(700)
  })

  test('an active lock on a document shorter than the viewport asks for the top', () => {
    expect(
      selectPaneScrollAdjustment({
        metrics: { scrollTop: 40, viewportHeight: 800, contentHeight: 300 },
        corrections: [{ offset: 0, delta: -120 }],
        bottomLocked: true,
      }),
    ).toBe(-40)
  })
})

describe('the answer stays inside the scrollable range', () => {
  test('a shrinkage larger than the scroll position stops at the top', () => {
    expect(
      selectPaneScrollAdjustment({
        metrics: { scrollTop: 300, viewportHeight: 800, contentHeight: 4_000 },
        corrections: [{ offset: 0, delta: -900 }],
        bottomLocked: false,
      }),
    ).toBe(-300)
  })

  test('growth larger than the document stops at the end', () => {
    expect(
      selectPaneScrollAdjustment({
        metrics: { scrollTop: 3_000, viewportHeight: 800, contentHeight: 4_000 },
        corrections: [{ offset: 0, delta: 900 }],
        bottomLocked: false,
      }),
    ).toBe(200)
  })
})

describe('cumulative error over a long run of corrections', () => {
  test('a hundred corrections above the anchor drift by 0 px', () => {
    let scrollTop = 5_000
    let contentHeight = 40_000
    // Content offset of the pixel the reader is looking at, tracked
    // independently of the model so the two can be compared at the end.
    let anchorContent = 5_000

    for (let step = 0; step < 100; step += 1) {
      contentHeight += 7
      anchorContent += 7
      scrollTop += selectPaneScrollAdjustment({
        metrics: { scrollTop, viewportHeight: 800, contentHeight },
        corrections: [{ offset: 1_000, delta: 7 }],
        bottomLocked: false,
      })
    }

    expect(scrollTop).toBe(5_700)
    expect(anchorContent).toBe(5_700)
    expect(anchorContent - scrollTop).toBe(0)
  })

  test('a hundred mixed corrections drift by 0 px', () => {
    let scrollTop = 5_000
    let contentHeight = 40_000
    let anchorContent = 5_000

    for (let step = 0; step < 100; step += 1) {
      const above = step % 2 === 0
      contentHeight += 11
      if (above) anchorContent += 11
      scrollTop += selectPaneScrollAdjustment({
        metrics: { scrollTop, viewportHeight: 800, contentHeight },
        corrections: [{ offset: above ? 900 : 20_000, delta: 11 }],
        bottomLocked: false,
      })
    }

    expect(scrollTop).toBe(5_550)
    expect(anchorContent).toBe(5_550)
    expect(anchorContent - scrollTop).toBe(0)
  })
})
