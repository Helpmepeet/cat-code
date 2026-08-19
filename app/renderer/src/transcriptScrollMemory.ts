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
 * The row is addressed by IDENTITY, not by position. It was a position once, and
 * that was exact under the one thing that used to happen to a transcript while
 * its pane was away — rows appended at the end — but wrong under anything that
 * renumbers the head of the list. Loading earlier messages does exactly that
 * (`docs/migration/decisions/HISTORY-LOAD-EARLIER.md` B5): every surviving row
 * moves down by however many were recovered, so an index would name a different
 * row and the guard that caught it would throw the reader to the bottom at the
 * precise moment they asked to read further back. An identity does not move.
 *
 * The identity is the key `TranscriptView` already gives each row, published on
 * the row wrapper as `data-row-key` — the display items are grouped (delegate
 * groups, reasoning runs, tool runs) and carry no id the pane could otherwise
 * reach. A key that is no longer in the list (the reasoning layout changed, the
 * hidden-row reveal toggled, the session was pruned) opens the pane at the end,
 * which is where it opened before any of this existed.
 */

import type { SessionId } from '../../shared/protocol.js'

/**
 * The attribute each row wrapper publishes its identity under. Written by
 * `TranscriptView`, read by `readTranscriptRowGeometry` below; the two halves
 * are useless apart, so the name is stated once here.
 */
export const TRANSCRIPT_ROW_KEY_ATTRIBUTE = 'data-row-key'

export type TranscriptScrollAnchor =
  | { kind: 'bottom' }
  | {
      kind: 'row'
      /** Identity of the row under the top of the viewport. */
      rowKey: string
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
  /**
   * Identity of the row at `index`, or null when it carries none — the welcome
   * and restore surfaces render children that are not rows, and a pane showing
   * one takes no anchor.
   */
  readRowKey: (index: number) => string | null
  /** Index of the row with this identity, or -1 when it is no longer here. */
  findRowIndex: (key: string) => number
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
  geometry: TranscriptRowGeometry
}): TranscriptScrollAnchor {
  const { geometry } = input
  if (input.atBottom || geometry.rowCount <= 0) return { kind: 'bottom' }
  const rowIndex = findTopRowIndex(geometry, input.scrollTop)
  const rowKey = geometry.readRowKey(rowIndex)
  // A pane whose children are not rows has nothing to come back to.
  if (rowKey === null) return { kind: 'bottom' }
  return {
    kind: 'row',
    rowKey,
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
  geometry: TranscriptRowGeometry
  viewportHeight: number
  contentHeight: number
}): TranscriptScrollRestore {
  const { anchor, geometry } = input
  if (anchor === null || anchor.kind === 'bottom') return { kind: 'bottom' }
  // Rows that arrived ABOVE this one since it was remembered move it down the
  // list, and it is still the row the reader was on: the search is for the key,
  // never for the place it used to hold.
  const rowIndex = geometry.findRowIndex(anchor.rowKey)
  if (rowIndex < 0) return { kind: 'bottom' }

  const maxScrollTop = Math.max(0, input.contentHeight - input.viewportHeight)
  const target = geometry.readRowOffset(rowIndex) + anchor.offsetIntoRow
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
 * children carry no `data-row-key` — so they report no identity, and neither
 * function above will build an anchor out of them.
 */
export function readTranscriptRowGeometry(scroller: HTMLElement): TranscriptRowGeometry {
  const rows = scroller.firstElementChild?.children ?? null
  const rowCount = rows?.length ?? 0
  // Reading an attribute costs no layout, which is what lets the key lookup be a
  // plain walk while the offset lookup stays a binary search.
  const readRowKey = (index: number): string | null =>
    rows?.item(index)?.getAttribute(TRANSCRIPT_ROW_KEY_ATTRIBUTE) ?? null
  // Content origin in viewport coordinates, measured on the first row read and
  // reused, so every offset comes from one layout pass and a pane that needs no
  // row at all — one still following the end of its document, which is the case
  // that runs on every frame of a streaming turn — forces no layout.
  let originTop: number | null = null
  return {
    rowCount,
    readRowOffset: index => {
      const row = rows?.item(index)
      if (!row) return 0
      originTop ??= scroller.getBoundingClientRect().top - scroller.scrollTop
      return row.getBoundingClientRect().top - originTop
    },
    readRowKey,
    findRowIndex: key => {
      for (let index = 0; index < rowCount; index += 1) {
        if (readRowKey(index) === key) return index
      }
      return -1
    },
  }
}

/** The anchor to remember for the pane as it currently stands. */
export function captureTranscriptScrollAnchor(
  scroller: HTMLElement,
  input: { atBottom: boolean },
): TranscriptScrollAnchor {
  return selectTranscriptRowAnchor({
    scrollTop: scroller.scrollTop,
    atBottom: input.atBottom,
    geometry: readTranscriptRowGeometry(scroller),
  })
}

/** The frame clock, injected so the coalescing below is provable without one. */
export type TranscriptScrollFrames = {
  request: (callback: () => void) => number
  cancel: (handle: number) => void
}

/**
 * Holds a pane's pending capture, so a drag of the scrollbar measures the pane
 * once per FRAME instead of once per scroll event.
 *
 * WHY. A pane that is not at the end is measured by binary search
 * (`findTopRowIndex`), so one capture costs about `log2(rowCount) + 1` forced
 * layout reads — a dozen on a long transcript. Scroll events arrive at the
 * native scroll rate, several per frame while a reader drags, and every one of
 * them was paying that. Nothing consumes the anchor between frames: it is read
 * when the pane unbinds, so a capture that a later event supersedes inside the
 * same frame was work no one could see.
 *
 * WHAT IT RETAINS. One handle and one closure per pane, and the closure is
 * dropped the moment it runs. There is deliberately no queue, no history and no
 * per-frame allocation held past the frame (CC-59: the renderer's last memory
 * incident was an unbounded per-frame structure, so a fix for a per-event cost
 * must not introduce one).
 */
export type TranscriptScrollCapturePump = {
  /**
   * Note that the pane moved. `capture` runs on the next frame, unless a later
   * event replaces it first — the last position of the frame is the true one.
   */
  request: (capture: () => void) => void
  /**
   * Run the pending capture NOW and stop the frame it was waiting for. For a
   * pane about to lose its DOM: the frame would land after the rows are gone,
   * and the position of the last event before an unbind is exactly the one
   * worth keeping.
   */
  flush: () => void
}

const browserFrames: TranscriptScrollFrames = {
  request: callback => globalThis.requestAnimationFrame(callback),
  cancel: handle => {
    globalThis.cancelAnimationFrame(handle)
  },
}

export function createTranscriptScrollCapturePump(
  frames: TranscriptScrollFrames = browserFrames,
): TranscriptScrollCapturePump {
  let handle: number | null = null
  let pending: (() => void) | null = null
  const run = (): void => {
    const capture = pending
    handle = null
    pending = null
    capture?.()
  }
  return {
    request: capture => {
      pending = capture
      if (handle !== null) return
      handle = frames.request(run)
    },
    flush: () => {
      if (handle === null) return
      frames.cancel(handle)
      run()
    },
  }
}

/**
 * Puts a rebinding pane back and reports what it did, so its caller sets the
 * stick-to-bottom flag from the same decision rather than a second one.
 */
export function restoreTranscriptScroll(
  scroller: HTMLElement,
  input: { anchor: TranscriptScrollAnchor | null },
): TranscriptScrollRestore {
  const restore = selectTranscriptScrollRestore({
    anchor: input.anchor,
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
