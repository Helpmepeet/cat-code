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
  createTranscriptScrollCapturePump,
  restoreTranscriptScroll,
  TRANSCRIPT_ROW_KEY_ATTRIBUTE,
  type TranscriptScrollAnchor,
  type TranscriptScrollFrames,
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

/**
 * The identity `TranscriptView` publishes on each row wrapper. A pane built
 * without an explicit list gets one key per row, in order.
 */
function defaultRowKeys(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `row-${index}`)
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
  rowKeys?: readonly string[]
}): FakePane {
  const document = harness.document
  const scroller = document.createElement('div')
  const column = document.createElement('div')
  scroller.appendChild(column)
  document.body.appendChild(scroller)

  let offsets = [...input.rowOffsets]
  const rowKeys = [...(input.rowKeys ?? defaultRowKeys(input.rowOffsets.length))]
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
      if (!row) continue
      const key = rowKeys[index]
      if (key !== undefined) row.setAttribute(TRANSCRIPT_ROW_KEY_ATTRIBUTE, key)
      stubRect(row, () => VIEWPORT_TOP + offsets[index] - scroller.scrollTop)
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

test('a scroller reports its rows in content coordinates', () => {
  const pane = createFakePane({
    rowOffsets: [0, 400, 900, 1_500],
    viewportHeight: 600,
    contentHeight: 2_400,
  })
  pane.scroller.scrollTop = 950

  expect(
    captureTranscriptScrollAnchor(pane.scroller, { atBottom: false }),
  ).toEqual({ kind: 'row', rowKey: 'row-2', offsetIntoRow: 50 })
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
  })
  away.scroller.remove()

  // The pane is rebuilt from scratch, the way remounting a `SessionPane` does.
  const back = createFakePane({
    rowOffsets: [0, 400, 900, 1_500],
    viewportHeight: 600,
    contentHeight: 2_400,
  })
  const restored = restoreTranscriptScroll(back.scroller, { anchor })

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
  })
  away.scroller.remove()

  // Rebound and re-measured: everything above the anchor row turned out taller
  // than the estimate it was captured against.
  const back = createFakePane({
    rowOffsets: [0, 700, 1_600, 2_600],
    viewportHeight: 600,
    contentHeight: 3_600,
  })
  restoreTranscriptScroll(back.scroller, { anchor })

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
  })
  expect(anchor).toEqual({ kind: 'bottom' })
  away.scroller.remove()

  const back = createFakePane({
    rowOffsets: [0, 400, 900, 1_400, 1_900],
    viewportHeight: 600,
    contentHeight: 2_400,
  })
  const restored = restoreTranscriptScroll(back.scroller, { anchor })

  expect(restored).toEqual({ kind: 'bottom' })
  expect(back.scroller.scrollTop).toBe(2_400)
})

test('a session this window has not shown opens at the end', () => {
  const pane = createFakePane({
    rowOffsets: [0, 400, 900],
    viewportHeight: 600,
    contentHeight: 1_400,
  })
  const restored = restoreTranscriptScroll(pane.scroller, { anchor: null })

  expect(restored).toEqual({ kind: 'bottom' })
  expect(pane.scroller.scrollTop).toBe(1_400)
})

test('earlier messages recovered above the reader keep the reader on their row', () => {
  // B5 through the DOM layer. The reader was on row 1; three earlier messages
  // and a boundary row are now above it, so the row that was second in the
  // column is fifth, and 400px further down the document.
  const away = createFakePane({
    rowOffsets: [0, 400, 900],
    viewportHeight: 600,
    contentHeight: 1_400,
  })
  away.scroller.scrollTop = 450
  const anchor = captureTranscriptScrollAnchor(away.scroller, { atBottom: false })
  expect(anchor).toEqual({ kind: 'row', rowKey: 'row-1', offsetIntoRow: 50 })
  away.scroller.remove()

  const back = createFakePane({
    rowOffsets: [0, 100, 200, 300, 700, 1_200],
    rowKeys: [
      'history-boundary',
      'older-0',
      'older-1',
      'row-0',
      'row-1',
      'row-2',
    ],
    viewportHeight: 600,
    contentHeight: 1_700,
  })
  const restored = restoreTranscriptScroll(back.scroller, { anchor })

  expect(restored).toEqual({ kind: 'offset', scrollTop: 750 })
  expect(back.scroller.scrollTop).toBe(750)
})

test('a row the pane no longer holds opens at the end', () => {
  const anchor: TranscriptScrollAnchor = {
    kind: 'row',
    rowKey: 'row-9',
    offsetIntoRow: 50,
  }
  const back = createFakePane({
    rowOffsets: [0, 400, 900],
    viewportHeight: 600,
    contentHeight: 1_400,
  })
  const restored = restoreTranscriptScroll(back.scroller, { anchor })

  expect(restored).toEqual({ kind: 'bottom' })
  expect(back.scroller.scrollTop).toBe(1_400)
})

test('a column whose children publish no identity takes no anchor', () => {
  // The welcome and restore surfaces render where the row column would, and a
  // pane showing one has no row to come back to.
  const pane = createFakePane({
    rowOffsets: [0, 400, 900],
    viewportHeight: 600,
    contentHeight: 1_400,
  })
  const rows = pane.scroller.firstElementChild?.children
  for (let index = 0; index < (rows?.length ?? 0); index += 1) {
    rows?.item(index)?.removeAttribute(TRANSCRIPT_ROW_KEY_ATTRIBUTE)
  }
  pane.scroller.scrollTop = 450

  expect(
    captureTranscriptScrollAnchor(pane.scroller, { atBottom: false }),
  ).toEqual({ kind: 'bottom' })
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

  captureTranscriptScrollAnchor(pane.scroller, { atBottom: true })
  expect(measured).toBe(0)

  captureTranscriptScrollAnchor(pane.scroller, { atBottom: false })
  expect(measured).toBe(1)
})

test('an empty pane takes no anchor and opens at the end', () => {
  const pane = createFakePane({
    rowOffsets: [],
    viewportHeight: 600,
    contentHeight: 0,
  })
  expect(
    captureTranscriptScrollAnchor(pane.scroller, { atBottom: false }),
  ).toEqual({ kind: 'bottom' })
})

/**
 * A frame clock the test ticks itself. The pane's real handler lives in
 * `SessionPane` (`App.tsx`), which this SSR-only suite cannot mount or scroll —
 * what the two tests below mount is the same sequence that handler performs, so
 * what they prove is the mechanism and its cost, not App's wiring of it.
 */
function manualFrames(): TranscriptScrollFrames & { runFrame: () => void } {
  const callbacks = new Map<number, () => void>()
  let nextHandle = 1
  return {
    request: callback => {
      const handle = nextHandle
      nextHandle += 1
      callbacks.set(handle, callback)
      return handle
    },
    cancel: handle => {
      callbacks.delete(handle)
    },
    runFrame: () => {
      const due = [...callbacks.values()]
      callbacks.clear()
      for (const callback of due) callback()
    },
  }
}

/** Counts every box the pane is asked for, scroller and rows alike. */
function countBoxes(pane: FakePane): () => number {
  let boxes = 0
  const count = (element: Element): void => {
    const read = element.getBoundingClientRect.bind(element)
    Object.defineProperty(element, 'getBoundingClientRect', {
      configurable: true,
      value: () => {
        boxes += 1
        return read()
      },
    })
  }
  count(pane.scroller)
  const rows = pane.scroller.firstElementChild?.children
  for (let index = 0; index < (rows?.length ?? 0); index += 1) {
    const row = rows?.item(index)
    if (row) count(row)
  }
  return () => boxes
}

const LONG_ROW_COUNT = 2_000
const LONG_ROW_HEIGHT = 40

function longPane(): FakePane {
  return createFakePane({
    rowOffsets: Array.from(
      { length: LONG_ROW_COUNT },
      (_, index) => index * LONG_ROW_HEIGHT,
    ),
    viewportHeight: 600,
    contentHeight: LONG_ROW_COUNT * LONG_ROW_HEIGHT,
  })
}

test('a dragged pane measures once per frame, not once per scroll event', () => {
  const pane = longPane()
  const boxes = countBoxes(pane)
  const frames = manualFrames()
  const pump = createTranscriptScrollCapturePump(frames)
  const reported: TranscriptScrollAnchor[] = []

  // The scroll handler's work, at the rate a dragged scrollbar delivers it:
  // several events inside one frame, none of them at the bottom.
  for (let event = 0; event < 8; event += 1) {
    pane.scroller.scrollTop = 20_000 + event * 37
    pump.request(() => {
      reported.push(
        captureTranscriptScrollAnchor(pane.scroller, { atBottom: false }),
      )
    })
  }
  expect(boxes()).toBe(0)

  frames.runFrame()
  const burst = boxes()
  expect(reported).toEqual([
    { kind: 'row', rowKey: 'row-506', offsetIntoRow: 19 },
  ])

  // What one capture costs on a transcript this long: a binary search over
  // 2,000 rows, plus the row it lands on, plus the scroller's own origin. The
  // burst of eight events paid that ONCE. Unthrottled it was paid eight times,
  // while the reader dragged.
  const before = boxes()
  captureTranscriptScrollAnchor(pane.scroller, { atBottom: false })
  const oneCapture = boxes() - before
  expect(oneCapture).toBe(13)
  expect(burst).toBe(oneCapture)
})

test('the position of the last event before an unbind survives the unbind', () => {
  const pane = longPane()
  const frames = manualFrames()
  const pump = createTranscriptScrollCapturePump(frames)
  const reported: TranscriptScrollAnchor[] = []
  const scroll = (scrollTop: number): void => {
    pane.scroller.scrollTop = scrollTop
    pump.request(() => {
      if (!pane.scroller.isConnected) return
      reported.push(
        captureTranscriptScrollAnchor(pane.scroller, { atBottom: false }),
      )
    })
  }

  scroll(20_000)
  frames.runFrame()
  // The frame this one is waiting for never arrives: the pane unbinds first.
  scroll(30_000)
  pump.flush()

  expect(reported).toEqual([
    { kind: 'row', rowKey: 'row-500', offsetIntoRow: 0 },
    { kind: 'row', rowKey: 'row-750', offsetIntoRow: 0 },
  ])

  // And the pane that has already lost its rows reports nothing rather than the
  // zeros a detached box measures, leaving the frame-old position standing.
  scroll(10_000)
  pane.scroller.remove()
  frames.runFrame()
  expect(reported).toHaveLength(2)
})
