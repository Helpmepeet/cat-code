/**
 * The arithmetic of putting a reader back where they were.
 *
 * Geometry is injected here for the reason `paneAnchorModel`'s tests state:
 * happy-dom has no layout engine, so this is the only layer at which the
 * decisions can be proven at all. The layer that reads the real boxes is proven
 * separately, in `transcriptScrollMemory.dom.test.ts`.
 */

import { expect, test } from 'bun:test'
import {
  createTranscriptScrollCapturePump,
  createTranscriptScrollMemoryState,
  reduceTranscriptScrollMemoryState,
  selectTranscriptRowAnchor,
  selectTranscriptScrollAnchor,
  selectTranscriptScrollRestore,
  type TranscriptRowGeometry,
  type TranscriptScrollFrames,
} from './transcriptScrollMemory.js'

/**
 * Rows at known content offsets, counting the reads the callers make. Each row
 * also reports an identity, the way a rendered row wrapper does; a row given a
 * null identity is one of the pane's non-row children (the welcome or restore
 * surface).
 */
function geometry(
  offsets: readonly number[],
  keys?: readonly (string | null)[],
): TranscriptRowGeometry & { reads: () => number } {
  let reads = 0
  const rowKeys: readonly (string | null)[] =
    keys ?? offsets.map((_, index) => `row-${index}`)
  const readRowKey = (index: number): string | null => rowKeys[index] ?? null
  return {
    rowCount: offsets.length,
    readRowOffset: index => {
      reads += 1
      return offsets[index]
    },
    readRowKey,
    findRowIndex: key => rowKeys.indexOf(key),
    reads: () => reads,
  }
}

test('a fresh memory answers null for every session', () => {
  const state = createTranscriptScrollMemoryState()
  expect(selectTranscriptScrollAnchor(state, 'never-opened')).toBeNull()
  expect(selectTranscriptScrollAnchor(state, null)).toBeNull()
})

test('remembering one session leaves the others alone', () => {
  const first = reduceTranscriptScrollMemoryState(
    createTranscriptScrollMemoryState(),
    {
      type: 'remember',
      sessionId: 'a',
      anchor: { kind: 'row', rowKey: 'row-3', offsetIntoRow: 12 },
    },
  )
  const second = reduceTranscriptScrollMemoryState(first, {
    type: 'remember',
    sessionId: 'b',
    anchor: { kind: 'bottom' },
  })

  expect(selectTranscriptScrollAnchor(second, 'a')).toEqual({
    kind: 'row',
    rowKey: 'row-3',
    offsetIntoRow: 12,
  })
  expect(selectTranscriptScrollAnchor(second, 'b')).toEqual({ kind: 'bottom' })
  // The earlier state is untouched, so nothing reads a half-applied update.
  expect(selectTranscriptScrollAnchor(first, 'b')).toBeNull()
})

test('a later anchor for the same session replaces the earlier one', () => {
  let state = reduceTranscriptScrollMemoryState(
    createTranscriptScrollMemoryState(),
    {
      type: 'remember',
      sessionId: 'a',
      anchor: { kind: 'row', rowKey: 'row-3', offsetIntoRow: 12 },
    },
  )
  state = reduceTranscriptScrollMemoryState(state, {
    type: 'remember',
    sessionId: 'a',
    anchor: { kind: 'bottom' },
  })
  expect(selectTranscriptScrollAnchor(state, 'a')).toEqual({ kind: 'bottom' })
})

test('a pane following the end remembers the end, not a row', () => {
  expect(
    selectTranscriptRowAnchor({
      scrollTop: 4_000,
      atBottom: true,
      geometry: geometry([0, 100, 200]),
    }),
  ).toEqual({ kind: 'bottom' })
})

test('a pane with no rows remembers the end', () => {
  expect(
    selectTranscriptRowAnchor({
      scrollTop: 0,
      atBottom: false,
      geometry: geometry([]),
    }),
  ).toEqual({ kind: 'bottom' })
})

test('a scrolled pane remembers the row under the top of the viewport', () => {
  expect(
    selectTranscriptRowAnchor({
      scrollTop: 250,
      atBottom: false,
      geometry: geometry([0, 100, 200, 300, 400]),
    }),
  ).toEqual({ kind: 'row', rowKey: 'row-2', offsetIntoRow: 50 })
})

test('a row boundary exactly at the viewport top belongs to the lower row', () => {
  expect(
    selectTranscriptRowAnchor({
      scrollTop: 200,
      atBottom: false,
      geometry: geometry([0, 100, 200, 300]),
    }),
  ).toEqual({ kind: 'row', rowKey: 'row-2', offsetIntoRow: 0 })
})

test('a pane scrolled above its first row anchors on that first row', () => {
  expect(
    selectTranscriptRowAnchor({
      scrollTop: 0,
      atBottom: false,
      geometry: geometry([24, 124, 224]),
    }),
  ).toEqual({ kind: 'row', rowKey: 'row-0', offsetIntoRow: 0 })
})

test('finding the anchor row does not measure every row', () => {
  const offsets = Array.from({ length: 1_024 }, (_, index) => index * 100)
  const probe = geometry(offsets)
  const anchor = selectTranscriptRowAnchor({
    scrollTop: 77_777,
    atBottom: false,
    geometry: probe,
  })

  expect(anchor).toEqual({
    kind: 'row',
    rowKey: 'row-777',
    offsetIntoRow: 77,
  })
  // Binary search plus the one read that turns the row into an offset. A linear
  // walk would be 778 reads, each one a forced layout on the real pane.
  expect(probe.reads()).toBeLessThanOrEqual(12)
})

test('a session with no remembered place opens at the end', () => {
  expect(
    selectTranscriptScrollRestore({
      anchor: null,
      geometry: geometry([0, 100, 200]),
      viewportHeight: 500,
      contentHeight: 3_000,
    }),
  ).toEqual({ kind: 'bottom' })
})

test('a session left at the end opens at the end', () => {
  expect(
    selectTranscriptScrollRestore({
      anchor: { kind: 'bottom' },
      geometry: geometry([0, 100, 200]),
      viewportHeight: 500,
      contentHeight: 9_000,
    }),
  ).toEqual({ kind: 'bottom' })
})

test('a remembered row is restored to the same place in the viewport', () => {
  expect(
    selectTranscriptScrollRestore({
      anchor: { kind: 'row', rowKey: 'row-2', offsetIntoRow: 50 },
      geometry: geometry([0, 100, 200, 300, 400]),
      viewportHeight: 200,
      contentHeight: 3_000,
    }),
  ).toEqual({ kind: 'offset', scrollTop: 250 })
})

test('restoring measures only the anchor row', () => {
  const probe = geometry(Array.from({ length: 1_024 }, (_, index) => index * 100))
  selectTranscriptScrollRestore({
    anchor: { kind: 'row', rowKey: 'row-777', offsetIntoRow: 77 },
    geometry: probe,
    viewportHeight: 500,
    contentHeight: 102_400,
  })
  expect(probe.reads()).toBe(1)
})

test('rows that measured taller while the pane was away move the anchor with them', () => {
  // Captured against estimates: row 3 started at 300. Every row above it then
  // measured 80px taller than the estimate, so the same row now starts at 540.
  // A remembered `scrollTop` of 320 would land inside row 1; the row anchor
  // follows the row.
  const anchor = selectTranscriptRowAnchor({
    scrollTop: 320,
    atBottom: false,
    geometry: geometry([0, 100, 200, 300, 400]),
  })
  expect(anchor).toEqual({
    kind: 'row',
    rowKey: 'row-3',
    offsetIntoRow: 20,
  })

  expect(
    selectTranscriptScrollRestore({
      anchor,
      geometry: geometry([0, 180, 360, 540, 720]),
      viewportHeight: 200,
      contentHeight: 3_000,
    }),
  ).toEqual({ kind: 'offset', scrollTop: 560 })
})

test('rows recovered above the reader leave the reader where they were', () => {
  // B5, the case index anchoring got wrong: three earlier messages arrive ABOVE
  // the row under the top of the viewport. Every surviving row is renumbered —
  // the anchored one was 1, and is now 4 — and it is still the row the reader
  // was on, now 300px further down the document.
  const anchor = selectTranscriptRowAnchor({
    scrollTop: 150,
    atBottom: false,
    geometry: geometry([0, 100, 200], ['row-0', 'row-1', 'row-2']),
  })
  expect(anchor).toEqual({ kind: 'row', rowKey: 'row-1', offsetIntoRow: 50 })

  expect(
    selectTranscriptScrollRestore({
      anchor,
      geometry: geometry(
        [0, 100, 200, 300, 400, 500],
        ['history-boundary', 'older-0', 'older-1', 'row-0', 'row-1', 'row-2'],
      ),
      viewportHeight: 200,
      contentHeight: 3_000,
    }),
  ).toEqual({ kind: 'offset', scrollTop: 450 })
})

test('a boundary row appearing at the head does not throw the reader to the end', () => {
  // The same insertion, at the smallest scale that used to break: ONE row at the
  // head. An index-based anchor read row 2 as the row it remembered; the reader
  // was thrown to the bottom instead, at the moment they asked to read further
  // back.
  expect(
    selectTranscriptScrollRestore({
      anchor: { kind: 'row', rowKey: 'row-2', offsetIntoRow: 50 },
      geometry: geometry(
        [0, 100, 200, 300],
        ['history-boundary', 'row-0', 'row-1', 'row-2'],
      ),
      viewportHeight: 200,
      contentHeight: 3_000,
    }),
  ).toEqual({ kind: 'offset', scrollTop: 350 })
})

test('a pane whose children are not rows takes no anchor', () => {
  // The welcome and restore surfaces render in the same place the row column
  // does. They carry no identity, so there is nothing to come back to.
  expect(
    selectTranscriptRowAnchor({
      scrollTop: 150,
      atBottom: false,
      geometry: geometry([0, 100, 200], [null, null, null]),
    }),
  ).toEqual({ kind: 'bottom' })
})

test('a pane whose rows have not arrived yet opens at the end', () => {
  expect(
    selectTranscriptScrollRestore({
      anchor: { kind: 'row', rowKey: 'row-2', offsetIntoRow: 50 },
      geometry: geometry([]),
      viewportHeight: 200,
      contentHeight: 0,
    }),
  ).toEqual({ kind: 'bottom' })
})

test('a remembered row that is no longer rendered opens at the end', () => {
  expect(
    selectTranscriptScrollRestore({
      anchor: { kind: 'row', rowKey: 'row-9', offsetIntoRow: 0 },
      geometry: geometry([0, 100, 200]),
      viewportHeight: 200,
      contentHeight: 300,
    }),
  ).toEqual({ kind: 'bottom' })
})

test('a restore is clamped to the scrollable range', () => {
  expect(
    selectTranscriptScrollRestore({
      anchor: { kind: 'row', rowKey: 'row-2', offsetIntoRow: 50 },
      geometry: geometry([0, 100, 200]),
      viewportHeight: 200,
      contentHeight: 300,
    }),
  ).toEqual({ kind: 'offset', scrollTop: 100 })
})

/**
 * A frame clock with the tick under the test's control, so "one capture per
 * frame" is stated as a fact about the pump rather than about a real display.
 */
function manualFrames(): TranscriptScrollFrames & {
  runFrame: () => void
  pendingFrames: () => number
} {
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
    pendingFrames: () => callbacks.size,
  }
}

test('a burst of scroll events inside one frame captures once, at the last position', () => {
  const frames = manualFrames()
  const pump = createTranscriptScrollCapturePump(frames)
  const captured: number[] = []

  for (const scrollTop of [100, 240, 900, 1_500, 1_512]) {
    pump.request(() => captured.push(scrollTop))
  }
  // Nothing has been measured yet: the frame is what pays, not the event.
  expect(captured).toEqual([])
  expect(frames.pendingFrames()).toBe(1)

  frames.runFrame()
  expect(captured).toEqual([1_512])
})

test('each new frame captures again', () => {
  const frames = manualFrames()
  const pump = createTranscriptScrollCapturePump(frames)
  const captured: number[] = []

  pump.request(() => captured.push(1))
  frames.runFrame()
  pump.request(() => captured.push(2))
  frames.runFrame()

  expect(captured).toEqual([1, 2])
  expect(frames.pendingFrames()).toBe(0)
})

test('an unbind captures the position the pending frame was holding', () => {
  const frames = manualFrames()
  const pump = createTranscriptScrollCapturePump(frames)
  const captured: number[] = []

  pump.request(() => captured.push(1_512))
  pump.flush()

  // Taken now, and the frame that would have taken it is off the clock: a pane
  // whose rows are about to go cannot be measured a frame later.
  expect(captured).toEqual([1_512])
  expect(frames.pendingFrames()).toBe(0)
  frames.runFrame()
  expect(captured).toEqual([1_512])
})

test('an unbind with nothing pending captures nothing', () => {
  const frames = manualFrames()
  const pump = createTranscriptScrollCapturePump(frames)
  const captured: number[] = []

  pump.flush()
  pump.request(() => captured.push(1))
  frames.runFrame()
  pump.flush()

  expect(captured).toEqual([1])
})
