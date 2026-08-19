/**
 * The layer that reads real boxes: a bind / read / rebind cycle driven through
 * `captureTranscriptScrollAnchor` and `restoreTranscriptScroll`, which is what
 * `SessionPane` calls.
 *
 * WHAT THIS CANNOT PROVE. happy-dom has no layout engine, so every
 * `getBoundingClientRect()` is zeros and `clientHeight` / `scrollHeight` are 0.
 * The scroller below therefore INJECTS its geometry: rows sit at declared
 * content offsets and report boxes derived from the live `scrollTop`, the way a
 * browser would. What is proven is that the two functions read the column's
 * rows, convert boxes to content offsets correctly, and write a position that
 * puts the remembered row back under the top of the viewport — including when
 * the heights changed in between. Real measurement, real re-measurement, and the
 * pane's own correction pass remain browser-only.
 *
 * No JSX here on purpose: keeping the file `.ts` keeps it outside the
 * `lint:fast-refresh` component-boundary rule that governs `renderer/src/**.tsx`.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createDomTestHarness } from './domTestHarness.js'
import type { DomTestHarness } from './domTestHarness.js'
import {
  captureTranscriptScrollAnchor,
  restoreTranscriptScroll,
  type TranscriptScrollAnchor,
} from './transcriptScrollMemory.js'

let harness: DomTestHarness

beforeAll(async () => {
  harness = await createDomTestHarness()
})

afterAll(async () => {
  await harness.teardown()
})

/** Where the scroller's own box sits on screen; any constant will do. */
const VIEWPORT_TOP = 64

type FakePane = {
  scroller: HTMLElement
  /** Replaces the rows' content offsets, as re-measurement would. */
  setRowOffsets: (offsets: readonly number[]) => void
  setContentHeight: (height: number) => void
}

function stubRect(element: Element, top: () => number): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    // `top` is asked ONCE per box: a test below counts the boxes this element is
    // asked for, and reading the position twice would count each one twice.
    value: () => {
      const edge = top()
      return { top: edge, bottom: edge, left: 0, right: 0, width: 0, height: 0 }
    },
  })
}

/**
 * A transcript pane: a scroller holding one row column, exactly the shape
 * `TranscriptView` renders.
 */
function createFakePane(input: {
  rowOffsets: readonly number[]
  viewportHeight: number
  contentHeight: number
}): FakePane {
  const document = harness.document
  const scroller = document.createElement('div')
  const column = document.createElement('div')
  scroller.appendChild(column)
  document.body.appendChild(scroller)

  let offsets = [...input.rowOffsets]
  let contentHeight = input.contentHeight

  stubRect(scroller, () => VIEWPORT_TOP)
  Object.defineProperty(scroller, 'clientHeight', {
    configurable: true,
    get: () => input.viewportHeight,
  })
  Object.defineProperty(scroller, 'scrollHeight', {
    configurable: true,
    get: () => contentHeight,
  })

  const syncRows = (): void => {
    while (column.children.length > offsets.length) {
      column.lastElementChild?.remove()
    }
    while (column.children.length < offsets.length) {
      column.appendChild(document.createElement('div'))
    }
    for (let index = 0; index < offsets.length; index += 1) {
      const row = column.children.item(index)
      if (row) stubRect(row, () => VIEWPORT_TOP + offsets[index] - scroller.scrollTop)
    }
  }
  syncRows()

  return {
    scroller,
    setRowOffsets: next => {
      offsets = [...next]
      syncRows()
    },
    setContentHeight: height => {
      contentHeight = height
    },
  }
}

const TOKEN = 'blocks:default:row-0'

test('a scroller reports its rows in content coordinates', () => {
  const pane = createFakePane({
    rowOffsets: [0, 400, 900, 1_500],
    viewportHeight: 600,
    contentHeight: 2_400,
  })
  pane.scroller.scrollTop = 950

  expect(
    captureTranscriptScrollAnchor(pane.scroller, {
      atBottom: false,
      rowsToken: TOKEN,
    }),
  ).toEqual({ kind: 'row', rowsToken: TOKEN, rowIndex: 2, offsetIntoRow: 50 })
})

test('a pane the reader left scrolled up comes back to the same row', () => {
  const away = createFakePane({
    rowOffsets: [0, 400, 900, 1_500],
    viewportHeight: 600,
    contentHeight: 2_400,
  })
  away.scroller.scrollTop = 950
  const anchor = captureTranscriptScrollAnchor(away.scroller, {
    atBottom: false,
    rowsToken: TOKEN,
  })
  away.scroller.remove()

  // The pane is rebuilt from scratch, the way remounting a `SessionPane` does.
  const back = createFakePane({
    rowOffsets: [0, 400, 900, 1_500],
    viewportHeight: 600,
    contentHeight: 2_400,
  })
  const restored = restoreTranscriptScroll(back.scroller, {
    anchor,
    rowsToken: TOKEN,
  })

  expect(restored).toEqual({ kind: 'offset', scrollTop: 950 })
  expect(back.scroller.scrollTop).toBe(950)
})

test('rows that measured taller in between still put the same row under the top', () => {
  const away = createFakePane({
    rowOffsets: [0, 400, 900, 1_500],
    viewportHeight: 600,
    contentHeight: 2_400,
  })
  away.scroller.scrollTop = 950
  const anchor = captureTranscriptScrollAnchor(away.scroller, {
    atBottom: false,
    rowsToken: TOKEN,
  })
  away.scroller.remove()

  // Rebound and re-measured: everything above the anchor row turned out taller
  // than the estimate it was captured against.
  const back = createFakePane({
    rowOffsets: [0, 700, 1_600, 2_600],
    viewportHeight: 600,
    contentHeight: 3_600,
  })
  restoreTranscriptScroll(back.scroller, { anchor, rowsToken: TOKEN })

  // A remembered pixel offset would have landed at 950, which is now inside the
  // SECOND row. The anchor row is back under the top of the viewport instead.
  expect(back.scroller.scrollTop).toBe(1_650)
  const rowTop = back.scroller.firstElementChild?.children
    .item(2)
    ?.getBoundingClientRect().top
  expect(rowTop).toBe(VIEWPORT_TOP - 50)
})

test('a pane left at the end comes back to the end of what streamed in', () => {
  const away = createFakePane({
    rowOffsets: [0, 400, 900],
    viewportHeight: 600,
    contentHeight: 1_400,
  })
  away.scroller.scrollTop = 800
  const anchor = captureTranscriptScrollAnchor(away.scroller, {
    atBottom: true,
    rowsToken: TOKEN,
  })
  expect(anchor).toEqual({ kind: 'bottom' })
  away.scroller.remove()

  const back = createFakePane({
    rowOffsets: [0, 400, 900, 1_400, 1_900],
    viewportHeight: 600,
    contentHeight: 2_400,
  })
  const restored = restoreTranscriptScroll(back.scroller, {
    anchor,
    rowsToken: TOKEN,
  })

  expect(restored).toEqual({ kind: 'bottom' })
  expect(back.scroller.scrollTop).toBe(2_400)
})

test('a session this window has not shown opens at the end', () => {
  const pane = createFakePane({
    rowOffsets: [0, 400, 900],
    viewportHeight: 600,
    contentHeight: 1_400,
  })
  const restored = restoreTranscriptScroll(pane.scroller, {
    anchor: null,
    rowsToken: TOKEN,
  })

  expect(restored).toEqual({ kind: 'bottom' })
  expect(pane.scroller.scrollTop).toBe(1_400)
})

test('a transcript truncated while the pane was away opens at the end', () => {
  const anchor: TranscriptScrollAnchor = {
    kind: 'row',
    rowsToken: TOKEN,
    rowIndex: 2,
    offsetIntoRow: 50,
  }
  const back = createFakePane({
    rowOffsets: [0, 400, 900],
    viewportHeight: 600,
    contentHeight: 1_400,
  })
  const restored = restoreTranscriptScroll(back.scroller, {
    anchor,
    // A boundary row now heads the list, so the remembered index counts from a
    // row that is no longer there.
    rowsToken: 'blocks:default:history-boundary',
  })

  expect(restored).toEqual({ kind: 'bottom' })
  expect(back.scroller.scrollTop).toBe(1_400)
})

test('a pane following the end measures nothing to say so', () => {
  const pane = createFakePane({
    rowOffsets: [0, 400, 900, 1_500],
    viewportHeight: 600,
    contentHeight: 2_400,
  })
  // This runs on every scroll event of a streaming turn, so it must not force a
  // layout pass to report a position it already knows.
  let measured = 0
  stubRect(pane.scroller, () => {
    measured += 1
    return VIEWPORT_TOP
  })

  captureTranscriptScrollAnchor(pane.scroller, {
    atBottom: true,
    rowsToken: TOKEN,
  })
  expect(measured).toBe(0)

  captureTranscriptScrollAnchor(pane.scroller, {
    atBottom: false,
    rowsToken: TOKEN,
  })
  expect(measured).toBe(1)
})

test('an empty pane takes no anchor and opens at the end', () => {
  const pane = createFakePane({
    rowOffsets: [],
    viewportHeight: 600,
    contentHeight: 0,
  })
  expect(
    captureTranscriptScrollAnchor(pane.scroller, {
      atBottom: false,
      rowsToken: null,
    }),
  ).toEqual({ kind: 'bottom' })
})
