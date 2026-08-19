/**
 * Where the reader was in each session's transcript, and how to put them back.
 *
 * A pane exists only while its session is on screen: `WorkspacePanels` keys each
 * panel by session id, so switching tabs unmounts the pane and mounts a new one.
 * The reading position therefore has to be held above the panes, the same way
 * `turnStarts` is. It lives for the window's lifetime and is deliberately not
 * persisted; this restores a place within one sitting, not across restarts.
 *
 * WHY NOT A PIXEL OFFSET. The pane's bodies commit with ESTIMATED heights and
 * replace them with measured ones one or more frames later
 * (`markdownScrollCoordinator` feeding `paneAnchorModel`). A `scrollTop`
 * recorded before that names a different place in the document afterwards,
 * which is the drift the anchor model exists to cancel. What is recorded here is
 * a ROW instead: which top-level row sat under the top of the viewport, and how
 * far into it. That row's offset is re-read from the live DOM at restore time,
 * so the position is built from whatever the heights are worth at that moment,
 * and every correction landing after it is the pane's own job again.
 *
 * The row is addressed by INDEX, not by id: the pane's DOM rows are grouped
 * display items (delegate groups, reasoning runs, tool runs) that carry no id
 * outside `TranscriptView`. An index is exact under the one thing that happens
 * to a transcript while its pane is away — rows appended at the end — and wrong
 * under anything that changes what the list starts with. So an anchor carries a
 * token naming the head of the list, and a token that no longer matches
 * (history truncated behind a boundary row, the hidden-row reveal toggled, the
 * reasoning layout changed) discards the anchor and opens the pane at the end,
 * which is where it opened before any of this existed.
 */

import type { SessionId } from '../../shared/protocol.js'

export type TranscriptScrollAnchor =
  | { kind: 'bottom' }
  | {
      kind: 'row'
      /** Identity of the head of the row list when the anchor was taken. */
      rowsToken: string
      /** Index, from the top, of the row under the top of the viewport. */
      rowIndex: number
      /** Pixels of that row already scrolled past the top of the viewport. */
      offsetIntoRow: number
    }

export type TranscriptScrollMemoryState = {
  anchors: Record<SessionId, TranscriptScrollAnchor>
}

export type TranscriptScrollMemoryAction = {
  type: 'remember'
  sessionId: SessionId
  anchor: TranscriptScrollAnchor
}

export function createTranscriptScrollMemoryState(): TranscriptScrollMemoryState {
  return { anchors: {} }
}

export function reduceTranscriptScrollMemoryState(
  state: TranscriptScrollMemoryState,
  action: TranscriptScrollMemoryAction,
): TranscriptScrollMemoryState {
  return {
    ...state,
    anchors: { ...state.anchors, [action.sessionId]: action.anchor },
  }
}

export function selectTranscriptScrollAnchor(
  state: TranscriptScrollMemoryState,
  sessionId: SessionId | null,
): TranscriptScrollAnchor | null {
  const anchor = sessionId ? state.anchors[sessionId] : undefined
  return anchor ?? null
}

/**
 * The pane's rows as boxes, in document order. No DOM in the arithmetic below
 * it, for the reason `paneAnchorModel` states: happy-dom has no layout engine,
 * so the geometry is the only part that has to be injected to be provable.
 */
export type TranscriptRowGeometry = {
  /** Top-level rows currently rendered in the pane. */
  rowCount: number
  /**
   * Content-space top offset of one row, in the scroller's scroll coordinates.
   * A live one is good for one synchronous layout pass: it holds the origin it
   * measured its first row against, so nothing may move the scroller between
   * two reads of the same geometry.
   */
  readRowOffset: (index: number) => number
}

export type TranscriptScrollRestore =
  | { kind: 'bottom' }
  | { kind: 'offset'; scrollTop: number }

/**
 * The anchor to remember for a pane in this state. A pane still following the
 * end of its document remembers exactly that, so whatever streamed in while it
 * was away is what it comes back to.
 */
export function selectTranscriptRowAnchor(input: {
  scrollTop: number
  atBottom: boolean
  rowsToken: string | null
  geometry: TranscriptRowGeometry
}): TranscriptScrollAnchor {
  const { geometry, rowsToken } = input
  if (input.atBottom || rowsToken === null || geometry.rowCount <= 0) {
    return { kind: 'bottom' }
  }
  const rowIndex = findTopRowIndex(geometry, input.scrollTop)
  return {
    kind: 'row',
    rowsToken,
    rowIndex,
    offsetIntoRow: Math.max(0, input.scrollTop - geometry.readRowOffset(rowIndex)),
  }
}

/**
 * Where a rebinding pane must land. Every case that cannot be answered exactly
 * answers with the end of the document rather than with an approximation: a
 * reader who is put back in the wrong place has no way to tell that from the
 * right one, and the end is both the old behaviour and a place they can read
 * from.
 */
export function selectTranscriptScrollRestore(input: {
  anchor: TranscriptScrollAnchor | null
  rowsToken: string | null
  geometry: TranscriptRowGeometry
  viewportHeight: number
  contentHeight: number
}): TranscriptScrollRestore {
  const { anchor, geometry } = input
  if (anchor === null || anchor.kind === 'bottom') return { kind: 'bottom' }
  if (input.rowsToken === null || input.rowsToken !== anchor.rowsToken) {
    return { kind: 'bottom' }
  }
  if (anchor.rowIndex >= geometry.rowCount) return { kind: 'bottom' }

  const maxScrollTop = Math.max(0, input.contentHeight - input.viewportHeight)
  const target = geometry.readRowOffset(anchor.rowIndex) + anchor.offsetIntoRow
  return { kind: 'offset', scrollTop: Math.min(maxScrollTop, Math.max(0, target)) }
}

/** Greatest index whose row starts at or above `scrollTop`; 0 when none does. */
function findTopRowIndex(geometry: TranscriptRowGeometry, scrollTop: number): number {
  let low = 0
  let high = geometry.rowCount - 1
  let found = 0
  while (low <= high) {
    const middle = (low + high) >> 1
    if (geometry.readRowOffset(middle) <= scrollTop) {
      found = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return found
}

/**
 * Measures the live pane. `TranscriptView` renders its row column as the
 * scroller's only element child, so the rows are that column's children. An
 * empty session renders the welcome or restore surface there instead, whose
 * children are not rows — the caller's token is null in that case, and neither
 * function above will build an anchor out of it.
 */
export function readTranscriptRowGeometry(scroller: HTMLElement): TranscriptRowGeometry {
  const rows = scroller.firstElementChild?.children ?? null
  // Content origin in viewport coordinates, measured on the first row read and
  // reused, so every offset comes from one layout pass and a pane that needs no
  // row at all — one still following the end of its document, which is the case
  // that runs on every frame of a streaming turn — forces no layout.
  let originTop: number | null = null
  return {
    rowCount: rows?.length ?? 0,
    readRowOffset: index => {
      const row = rows?.item(index)
      if (!row) return 0
      originTop ??= scroller.getBoundingClientRect().top - scroller.scrollTop
      return row.getBoundingClientRect().top - originTop
    },
  }
}

/** The anchor to remember for the pane as it currently stands. */
export function captureTranscriptScrollAnchor(
  scroller: HTMLElement,
  input: { atBottom: boolean; rowsToken: string | null },
): TranscriptScrollAnchor {
  return selectTranscriptRowAnchor({
    scrollTop: scroller.scrollTop,
    atBottom: input.atBottom,
    rowsToken: input.rowsToken,
    geometry: readTranscriptRowGeometry(scroller),
  })
}

/**
 * Puts a rebinding pane back and reports what it did, so its caller sets the
 * stick-to-bottom flag from the same decision rather than a second one.
 */
export function restoreTranscriptScroll(
  scroller: HTMLElement,
  input: { anchor: TranscriptScrollAnchor | null; rowsToken: string | null },
): TranscriptScrollRestore {
  const restore = selectTranscriptScrollRestore({
    anchor: input.anchor,
    rowsToken: input.rowsToken,
    geometry: readTranscriptRowGeometry(scroller),
    viewportHeight: scroller.clientHeight,
    contentHeight: scroller.scrollHeight,
  })
  // The end of the document stays an overshoot, the way this pane has always
  // jumped to it: the browser clamps, while a difference computed against a box
  // that has not settled lands short of the last row.
  scroller.scrollTop =
    restore.kind === 'bottom' ? scroller.scrollHeight : restore.scrollTop
  return restore
}
