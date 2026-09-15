/**
 * One scroll listener, one pooled ResizeObserver, and one animation-frame batch
 * per pane scroller, shared by every virtualized body mounted inside it.
 * Bodies register here instead of attaching their own listeners to the shared
 * scroller, so pane-level attachment counts stay fixed as transcript history
 * grows. The pooled observer watches the scroller and its direct document
 * children, while a mutation observer keeps those targets aligned with root
 * replacement.
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
  programmaticScrolls: Set<(scrollTop: number) => void>
  corrections: PaneHeightCorrection[]
  /** `scrollTop` this pane wrote itself, pending its own scroll event. */
  selfScrollTop: number | null
  observedChildren: Set<Element>
  lastGeometry: { viewportHeight: number; contentHeight: number }
  geometryDirty: boolean
  resizeObserver: ResizeObserver | null
  mutationObserver: MutationObserver | null
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
 * Bottom lock is consulted when a correction or document-geometry change is
 * pending. A pane that is merely locked is never re-pinned on its own, so a
 * reader scrolling up is not pulled back by a frame that happened to be
 * scheduled.
 */
export function observePaneBottomLock(
  scroller: HTMLElement,
  isBottomLocked: () => boolean,
  onProgrammaticScroll?: (scrollTop: number) => void,
): () => void {
  const pane = panes.get(scroller) ?? createPane(scroller)
  panes.set(scroller, pane)
  pane.bottomLocks.add(isBottomLocked)
  if (onProgrammaticScroll) pane.programmaticScrolls.add(onProgrammaticScroll)

  return () => {
    pane.bottomLocks.delete(isBottomLocked)
    if (onProgrammaticScroll) pane.programmaticScrolls.delete(onProgrammaticScroll)
    releaseWhenEmpty(scroller, pane)
  }
}

function createPane(scroller: HTMLElement): PaneRecord {
  const pane: PaneRecord = {
    subscribers: new Set(),
    bottomLocks: new Set(),
    programmaticScrolls: new Set(),
    corrections: [],
    selfScrollTop: null,
    observedChildren: new Set(),
    lastGeometry: readPaneMetrics(scroller),
    geometryDirty: false,
    resizeObserver: null,
    mutationObserver: null,
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
  const markGeometryDirty = () => {
    pane.geometryDirty = true
    schedule()
  }
  const syncObservedChildren = () => {
    const nextChildren = new Set<Element>(Array.from(scroller.children ?? []))
    for (const child of pane.observedChildren) {
      if (!nextChildren.has(child)) pane.resizeObserver?.unobserve(child)
    }
    for (const child of nextChildren) {
      if (!pane.observedChildren.has(child)) pane.resizeObserver?.observe(child)
    }
    pane.observedChildren = nextChildren
  }
  const resizeObserver =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(markGeometryDirty)
  resizeObserver?.observe(scroller)
  pane.resizeObserver = resizeObserver
  syncObservedChildren()
  const mutationObserver =
    typeof MutationObserver === 'undefined' || globalThis.document === undefined
      ? null
      : new MutationObserver(() => {
          syncObservedChildren()
          markGeometryDirty()
        })
  mutationObserver?.observe(scroller, { childList: true })
  pane.mutationObserver = mutationObserver
  // The scroll event our OWN correction causes must not schedule another frame.
  // Without this the pane feeds itself: correcting writes `scrollTop`, the
  // browser reports a scroll, subscribers recompute their windows, the mounted
  // content changes height, and that reports the next correction. While a
  // message is streaming the cycle never settles, which reads on screen as
  // content blinking and the viewport drifting under the reader.
  const onScroll = () => {
    if (pane.selfScrollTop !== null && scroller.scrollTop === pane.selfScrollTop) {
      pane.selfScrollTop = null
      return
    }
    pane.selfScrollTop = null
    schedule()
  }
  pane.schedule = schedule

  // A document-level scroller reports its scroll events on the window, not on
  // the element itself.
  const scrollTarget: EventTarget =
    scroller === globalThis.document?.documentElement ? globalThis.window : scroller
  scrollTarget.addEventListener('scroll', onScroll, { passive: true })

  pane.detach = () => {
    scrollTarget.removeEventListener('scroll', onScroll)
    pane.resizeObserver?.disconnect()
    pane.mutationObserver?.disconnect()
  }
  return pane
}

/**
 * One scroll decision for every correction or document-geometry change the
 * frame collected. Without either, this is deliberately a no-op rather than a
 * periodic re-pin.
 */
function applyPendingCorrections(scroller: HTMLElement, pane: PaneRecord): void {
  if (pane.corrections.length === 0 && !pane.geometryDirty) return
  const metrics = readPaneMetrics(scroller)
  const geometryChanged =
    pane.geometryDirty &&
    (metrics.viewportHeight !== pane.lastGeometry.viewportHeight ||
      metrics.contentHeight !== pane.lastGeometry.contentHeight)
  pane.geometryDirty = false
  pane.lastGeometry = {
    viewportHeight: metrics.viewportHeight,
    contentHeight: metrics.contentHeight,
  }
  if (pane.corrections.length === 0 && !geometryChanged) return
  const corrections = pane.corrections
  pane.corrections = []

  let bottomLocked = false
  for (const isBottomLocked of pane.bottomLocks) {
    if (isBottomLocked()) bottomLocked = true
  }

  const adjustment = selectPaneScrollAdjustment({
    metrics,
    corrections,
    bottomLocked,
  })
  // Sub-pixel answers are noise from rounded box metrics, and writing scrollTop
  // costs a layout plus a scroll event.
  if (Math.abs(adjustment) < 1) return
  const next = scroller.scrollTop + adjustment
  scroller.scrollTop = next
  pane.selfScrollTop = scroller.scrollTop
  for (const onProgrammaticScroll of pane.programmaticScrolls) {
    onProgrammaticScroll(scroller.scrollTop)
  }
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
  pane.programmaticScrolls.clear()
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
