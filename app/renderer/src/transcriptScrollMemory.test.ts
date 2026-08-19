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
  createTranscriptScrollMemoryState,
  reduceTranscriptScrollMemoryState,
  selectTranscriptRowAnchor,
  selectTranscriptScrollAnchor,
  selectTranscriptScrollRestore,
  type TranscriptRowGeometry,
} from './transcriptScrollMemory.js'

/** Rows at known content offsets, counting the reads the callers make. */
function geometry(offsets: readonly number[]): TranscriptRowGeometry & {
  reads: () => number
} {
  let reads = 0
  return {
    rowCount: offsets.length,
    readRowOffset: index => {
      reads += 1
      return offsets[index]
    },
    reads: () => reads,
  }
}

const TOKEN = 'blocks:default:row-0'

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
      anchor: { kind: 'row', rowsToken: TOKEN, rowIndex: 3, offsetIntoRow: 12 },
    },
  )
  const second = reduceTranscriptScrollMemoryState(first, {
    type: 'remember',
    sessionId: 'b',
    anchor: { kind: 'bottom' },
  })

  expect(selectTranscriptScrollAnchor(second, 'a')).toEqual({
    kind: 'row',
    rowsToken: TOKEN,
    rowIndex: 3,
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
      anchor: { kind: 'row', rowsToken: TOKEN, rowIndex: 3, offsetIntoRow: 12 },
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
      rowsToken: TOKEN,
      geometry: geometry([0, 100, 200]),
    }),
  ).toEqual({ kind: 'bottom' })
})

test('a pane with no rows remembers the end', () => {
  expect(
    selectTranscriptRowAnchor({
      scrollTop: 0,
      atBottom: false,
      rowsToken: null,
      geometry: geometry([]),
    }),
  ).toEqual({ kind: 'bottom' })
})

test('a scrolled pane remembers the row under the top of the viewport', () => {
  expect(
    selectTranscriptRowAnchor({
      scrollTop: 250,
      atBottom: false,
      rowsToken: TOKEN,
      geometry: geometry([0, 100, 200, 300, 400]),
    }),
  ).toEqual({ kind: 'row', rowsToken: TOKEN, rowIndex: 2, offsetIntoRow: 50 })
})

test('a row boundary exactly at the viewport top belongs to the lower row', () => {
  expect(
    selectTranscriptRowAnchor({
      scrollTop: 200,
      atBottom: false,
      rowsToken: TOKEN,
      geometry: geometry([0, 100, 200, 300]),
    }),
  ).toEqual({ kind: 'row', rowsToken: TOKEN, rowIndex: 2, offsetIntoRow: 0 })
})

test('a pane scrolled above its first row anchors on that first row', () => {
  expect(
    selectTranscriptRowAnchor({
      scrollTop: 0,
      atBottom: false,
      rowsToken: TOKEN,
      geometry: geometry([24, 124, 224]),
    }),
  ).toEqual({ kind: 'row', rowsToken: TOKEN, rowIndex: 0, offsetIntoRow: 0 })
})

test('finding the anchor row does not measure every row', () => {
  const offsets = Array.from({ length: 1_024 }, (_, index) => index * 100)
  const probe = geometry(offsets)
  const anchor = selectTranscriptRowAnchor({
    scrollTop: 77_777,
    atBottom: false,
    rowsToken: TOKEN,
    geometry: probe,
  })

  expect(anchor).toEqual({
    kind: 'row',
    rowsToken: TOKEN,
    rowIndex: 777,
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
      rowsToken: TOKEN,
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
      rowsToken: TOKEN,
      geometry: geometry([0, 100, 200]),
      viewportHeight: 500,
      contentHeight: 9_000,
    }),
  ).toEqual({ kind: 'bottom' })
})

test('a remembered row is restored to the same place in the viewport', () => {
  expect(
    selectTranscriptScrollRestore({
      anchor: { kind: 'row', rowsToken: TOKEN, rowIndex: 2, offsetIntoRow: 50 },
      rowsToken: TOKEN,
      geometry: geometry([0, 100, 200, 300, 400]),
      viewportHeight: 200,
      contentHeight: 3_000,
    }),
  ).toEqual({ kind: 'offset', scrollTop: 250 })
})

test('restoring measures only the anchor row', () => {
  const probe = geometry(Array.from({ length: 1_024 }, (_, index) => index * 100))
  selectTranscriptScrollRestore({
    anchor: { kind: 'row', rowsToken: TOKEN, rowIndex: 777, offsetIntoRow: 77 },
    rowsToken: TOKEN,
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
    rowsToken: TOKEN,
    geometry: geometry([0, 100, 200, 300, 400]),
  })
  expect(anchor).toEqual({
    kind: 'row',
    rowsToken: TOKEN,
    rowIndex: 3,
    offsetIntoRow: 20,
  })

  expect(
    selectTranscriptScrollRestore({
      anchor,
      rowsToken: TOKEN,
      geometry: geometry([0, 180, 360, 540, 720]),
      viewportHeight: 200,
      contentHeight: 3_000,
    }),
  ).toEqual({ kind: 'offset', scrollTop: 560 })
})

test('a transcript truncated behind a boundary row opens at the end', () => {
  // The head of the list changed, so the remembered index counts from somewhere
  // that no longer exists. The end is the honest answer.
  expect(
    selectTranscriptScrollRestore({
      anchor: { kind: 'row', rowsToken: TOKEN, rowIndex: 2, offsetIntoRow: 50 },
      rowsToken: 'blocks:default:history-boundary',
      geometry: geometry([0, 100, 200, 300]),
      viewportHeight: 200,
      contentHeight: 3_000,
    }),
  ).toEqual({ kind: 'bottom' })
})

test('a pane whose rows have not arrived yet opens at the end', () => {
  expect(
    selectTranscriptScrollRestore({
      anchor: { kind: 'row', rowsToken: TOKEN, rowIndex: 2, offsetIntoRow: 50 },
      rowsToken: null,
      geometry: geometry([]),
      viewportHeight: 200,
      contentHeight: 0,
    }),
  ).toEqual({ kind: 'bottom' })
})

test('a remembered row that is no longer rendered opens at the end', () => {
  expect(
    selectTranscriptScrollRestore({
      anchor: { kind: 'row', rowsToken: TOKEN, rowIndex: 9, offsetIntoRow: 0 },
      rowsToken: TOKEN,
      geometry: geometry([0, 100, 200]),
      viewportHeight: 200,
      contentHeight: 300,
    }),
  ).toEqual({ kind: 'bottom' })
})

test('a restore is clamped to the scrollable range', () => {
  expect(
    selectTranscriptScrollRestore({
      anchor: { kind: 'row', rowsToken: TOKEN, rowIndex: 2, offsetIntoRow: 50 },
      rowsToken: TOKEN,
      geometry: geometry([0, 100, 200]),
      viewportHeight: 200,
      contentHeight: 300,
    }),
  ).toEqual({ kind: 'offset', scrollTop: 100 })
})
