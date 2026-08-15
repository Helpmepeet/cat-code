/**
 * One scroll listener, one scroller ResizeObserver, and one animation-frame
 * batch per pane scroller, shared by every virtualized body mounted inside it.
 * Bodies register here instead of attaching their own listeners to the shared
 * scroller, so pane-level attachment counts stay fixed as transcript history
 * grows. Each body keeps its own observer for its own root element; only the
 * shared scroller is pooled.
 *
 * The pane also owns SCROLL CORRECTION (CC-59 hard constraint 13). A body that
 * replaces an estimated height with a measured one reports the change through
 * `reportPaneHeightCorrection`; the pane collects every such report, asks
 * `paneAnchorModel` once per frame what the scroller must do about all of them
 * together, and applies that one answer before the frame's subscribers run, so
 * each body then recomputes its window against the corrected position.
 *
 * Three consumers register here: the Markdown body (`BoundedMarkdown`), the
 * line virtualizer (`VirtualLineList`), and the composite child container
 * (`BoundedChildList`). A fourth registers only as the pane's stick-to-bottom
 * owner (`App`), which is a different role: it reports no heights and instead
 * answers, at flush time, whether the pane is still pinned to the end.
 */

import {
  selectPaneScrollAdjustment,
  type PaneHeightCorrection,
  type PaneScrollMetrics,
} from './paneAnchorModel.js'

export type { PaneHeightCorrection } from './paneAnchorModel.js'

type PaneRecord = {
  subscribers: Set<() => void>
  bottomLocks: Set<() => boolean>
  corrections: PaneHeightCorrection[]
  frame: number
  schedule: () => void
  detach: () => void
}

const panes = new WeakMap<EventTarget, PaneRecord>()

/**
 * Registers a callback invoked at most once per animation frame when the pane
 * scroller scrolls or resizes. Returns a release function; the shared listener
 * is torn down when the last participant releases it.
 */
export function observePaneScroll(scroller: HTMLElement, onFrame: () => void): () => void {
  const pane = panes.get(scroller) ?? createPane(scroller)
  panes.set(scroller, pane)
  pane.subscribers.add(onFrame)

  return () => {
    pane.subscribers.delete(onFrame)
    releaseWhenEmpty(scroller, pane)
  }
}

/**
 * Reports that a registered body's rendered height changed by `delta` pixels,
 * with everything above `offset` left where it was. Called from the commit that
 * made the change, so the pane can correct the scroll position the previous
 * commit chose against the estimate this one replaced.
 *
 * A report for a scroller with no live pane is dropped: the body is unmounting,
 * and there is no anchor left to preserve.
 */
export function reportPaneHeightCorrection(
  scroller: HTMLElement,
  correction: PaneHeightCorrection,
): void {
  const pane = panes.get(scroller)
  if (pane === undefined || correction.delta === 0) return
  pane.corrections.push(correction)
  pane.schedule()
}

/**
 * Declares a participant that knows whether the pane is still following the end
 * of its document. The pane asks at flush time rather than storing a flag,
 * because the answer changes on the scroll event that precedes the flush.
 *
 * Bottom lock is consulted only when a correction is pending. A pane that is
 * merely locked is never re-pinned on its own, so a reader scrolling up is not
 * pulled back by a frame that happened to be scheduled.
 */
export function observePaneBottomLock(
  scroller: HTMLElement,
  isBottomLocked: () => boolean,
): () => void {
  const pane = panes.get(scroller) ?? createPane(scroller)
  panes.set(scroller, pane)
  pane.bottomLocks.add(isBottomLocked)

  return () => {
    pane.bottomLocks.delete(isBottomLocked)
    releaseWhenEmpty(scroller, pane)
  }
}

function createPane(scroller: HTMLElement): PaneRecord {
  const pane: PaneRecord = {
    subscribers: new Set(),
    bottomLocks: new Set(),
    corrections: [],
    frame: 0,
    schedule: () => {},
    detach: () => {},
  }

  const flush = () => {
    pane.frame = 0
    applyPendingCorrections(scroller, pane)
    for (const subscriber of [...pane.subscribers]) subscriber()
  }
  const schedule = () => {
    if (pane.frame === 0) pane.frame = globalThis.requestAnimationFrame(flush)
  }
  pane.schedule = schedule

  // A document-level scroller reports its scroll events on the window, not on
  // the element itself.
  const scrollTarget: EventTarget =
    scroller === globalThis.document?.documentElement ? globalThis.window : scroller
  scrollTarget.addEventListener('scroll', schedule, { passive: true })

  const observer =
    typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
  observer?.observe(scroller)

  pane.detach = () => {
    scrollTarget.removeEventListener('scroll', schedule)
    observer?.disconnect()
  }
  return pane
}

/**
 * One scroll decision for every correction the frame collected. Deliberately a
 * no-op without corrections: this is the pane's answer to a height change, not
 * a periodic re-pin.
 */
function applyPendingCorrections(scroller: HTMLElement, pane: PaneRecord): void {
  if (pane.corrections.length === 0) return
  const corrections = pane.corrections
  pane.corrections = []

  let bottomLocked = false
  for (const isBottomLocked of pane.bottomLocks) {
    if (isBottomLocked()) bottomLocked = true
  }

  const adjustment = selectPaneScrollAdjustment({
    metrics: readPaneMetrics(scroller),
    corrections,
    bottomLocked,
  })
  // Sub-pixel answers are noise from rounded box metrics, and writing scrollTop
  // costs a layout plus a scroll event.
  if (Math.abs(adjustment) < 1) return
  scroller.scrollTop += adjustment
}

function readPaneMetrics(scroller: HTMLElement): PaneScrollMetrics {
  return {
    scrollTop: scroller.scrollTop,
    viewportHeight: scroller.clientHeight,
    contentHeight: scroller.scrollHeight,
  }
}

function releaseWhenEmpty(scroller: HTMLElement, pane: PaneRecord): void {
  if (pane.subscribers.size > 0 || pane.bottomLocks.size > 0) return
  if (pane.frame !== 0) globalThis.cancelAnimationFrame(pane.frame)
  pane.frame = 0
  pane.corrections = []
  pane.detach()
  panes.delete(scroller)
}

export const _forTest = {
  paneSubscriberCount(scroller: HTMLElement): number {
    return panes.get(scroller)?.subscribers.size ?? 0
  },
  paneBottomLockCount(scroller: HTMLElement): number {
    return panes.get(scroller)?.bottomLocks.size ?? 0
  },
  pendingCorrectionCount(scroller: HTMLElement): number {
    return panes.get(scroller)?.corrections.length ?? 0
  },
  isPaneAttached(scroller: HTMLElement): boolean {
    return panes.has(scroller)
  },
}
