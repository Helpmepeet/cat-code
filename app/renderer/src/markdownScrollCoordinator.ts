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
 * Visible-character samples own correction when layout is available. Height
 * reports remain a fallback when no visible text can be resolved. In particular,
 * a report's aggregate delta does not locate movement within a long message.
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
import {
  capturePaneVisibleAnchor,
  readPaneVisibleAnchorAdjustment,
  type PaneVisibleAnchor,
} from './paneVisibleAnchor.js'

export type { PaneHeightCorrection } from './paneAnchorModel.js'

export type PaneHeightCorrectionReport = {
  delta: number
  /**
   * Read the affected boundary in the final DOM at flush time. A report-time
   * number cannot distinguish effects in one layout from separate commits.
   * Return null when that boundary no longer exists.
   */
  readOffset: () => number | null
}

type PaneRecord = {
  subscribers: Set<() => void>
  bottomLocks: Set<() => boolean>
  programmaticScrolls: Set<(scrollTop: number) => void>
  corrections: PaneHeightCorrectionReport[]
  anchor: PaneVisibleAnchor | null
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
 * with everything above the affected boundary left where it was. Called from
 * the commit that made the change. `readOffset` resolves every report in
 * the SAME final document, regardless of commit order or effect ordering.
 *
 * A report for a scroller with no live pane is dropped: the body is unmounting,
 * and there is no anchor left to preserve.
 */
export function reportPaneHeightCorrection(
  scroller: HTMLElement,
  correction: PaneHeightCorrectionReport,
): void {
  const pane = panes.get(scroller)
  if (pane === undefined) return
  if (correction.delta !== 0) {
    pane.corrections.push({ ...correction })
  }
  reportPaneLayoutChange(scroller)
}

/** A commit may move visible content without changing its owner's total height. */
export function reportPaneLayoutChange(scroller: HTMLElement): void {
  const pane = panes.get(scroller)
  if (pane === undefined) return
  // A distant explicit jump can leave no old mounted content to sample. Once
  // its new window exists, establish the reading position before measuring it.
  pane.anchor ??= capturePaneVisibleAnchor(scroller)
  pane.geometryDirty = true
  pane.schedule()
}

/** Compensate a keyed prefix edit without replacing the interior reading goal. */
export function compensatePanePrefix(scroller: HTMLElement, delta: number): void {
  if (delta === 0) return
  const pane = panes.get(scroller)
  if (pane?.anchor && pane.anchor.scrollTop !== scroller.scrollTop) {
    pane.anchor = capturePaneVisibleAnchor(scroller)
  }
  scroller.scrollTop += delta
  if (!pane) return
  // The prefix estimate is only part of this commit's movement. Keeping the
  // character's old viewport position lets the frame correct measurement error
  // or simultaneous interior reflow, rather than mistaking this write for a jump.
  if (pane.anchor) pane.anchor.scrollTop = scroller.scrollTop
  pane.selfScrollTop = scroller.scrollTop
  for (const onProgrammaticScroll of pane.programmaticScrolls) {
    onProgrammaticScroll(scroller.scrollTop)
  }
  pane.geometryDirty = true
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
  // React can replace the pane's className during a resize or chrome update.
  // Keep correction ownership on an independent attribute for the pane lifetime.
  const alreadyManual = scroller.hasAttribute?.('data-pane-scroll-owner') ?? false
  scroller.setAttribute?.('data-pane-scroll-owner', '')
  const pane: PaneRecord = {
    subscribers: new Set(),
    bottomLocks: new Set(),
    programmaticScrolls: new Set(),
    corrections: [],
    anchor: capturePaneVisibleAnchor(scroller),
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
      : new MutationObserver(records => {
          syncObservedChildren()
          // Hidden panes have no visible anchor. Keep root observation aligned,
          // but do not window them against absent geometry on nested mutations.
          if (scroller.clientHeight > 0 || records.some(record => record.target === scroller)) {
            markGeometryDirty()
          }
        })
  mutationObserver?.observe(scroller, {
    childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['class', 'style', 'hidden'],
  })
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
    // User scrolling and explicit navigation choose a new reading position.
    pane.anchor = capturePaneVisibleAnchor(scroller)
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
    if (!alreadyManual) scroller.removeAttribute?.('data-pane-scroll-owner')
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
  const layoutDirty = pane.geometryDirty
  const geometryChanged =
    pane.geometryDirty &&
    (metrics.viewportHeight !== pane.lastGeometry.viewportHeight ||
      metrics.contentHeight !== pane.lastGeometry.contentHeight)
  pane.geometryDirty = false
  pane.lastGeometry = {
    viewportHeight: metrics.viewportHeight,
    contentHeight: metrics.contentHeight,
  }
  if (pane.corrections.length === 0 && !geometryChanged && !layoutDirty) return
  const reports = pane.corrections
  pane.corrections = []
  const corrections: PaneHeightCorrection[] = []
  for (const report of reports) {
    const offset = report.readOffset()
    if (offset !== null) corrections.push({ offset, delta: report.delta })
  }

  let bottomLocked = false
  for (const isBottomLocked of pane.bottomLocks) {
    if (isBottomLocked()) bottomLocked = true
  }
  // Mutation invalidation is also used for net-zero interior movement. It is
  // not a new bottom-follow request when the document dimensions did not move.
  if (bottomLocked && corrections.length === 0 && !geometryChanged) {
    pane.anchor = capturePaneVisibleAnchor(scroller)
    return
  }

  const fallback = selectPaneScrollAdjustment({
    metrics,
    corrections,
    bottomLocked,
  })
  // A scroll written by restoration, navigation or prepend compensation must
  // not be undone, even when its scroll event has not been delivered yet.
  if (pane.anchor && metrics.scrollTop !== pane.anchor.scrollTop) {
    pane.anchor = capturePaneVisibleAnchor(scroller)
  }
  const visibleAdjustment = pane.anchor === null ? null
    : readPaneVisibleAnchorAdjustment(scroller, pane.anchor)
  const maxScrollTop = Math.max(0, metrics.contentHeight - metrics.viewportHeight)
  const adjustment = bottomLocked ? fallback
    : visibleAdjustment === null ? fallback
      : Math.min(maxScrollTop, Math.max(0, metrics.scrollTop + visibleAdjustment)) - metrics.scrollTop
  // Avoid subpixel writes, but retain the reading goal so skipped movement and
  // browser rounding can accumulate into a later correction rather than drift.
  if (Math.abs(adjustment) >= 1) {
    const next = scroller.scrollTop + adjustment
    scroller.scrollTop = next
    pane.selfScrollTop = scroller.scrollTop
    for (const onProgrammaticScroll of pane.programmaticScrolls) {
      onProgrammaticScroll(scroller.scrollTop)
    }
  }
  pane.anchor = capturePaneVisibleAnchor(scroller)
  if (!bottomLocked && pane.anchor && visibleAdjustment !== null) {
    // Reflow can change which character starts the visible line. Resample its
    // identity, but carry the uncorrected displacement into its reading goal.
    const remainder = visibleAdjustment - (scroller.scrollTop - metrics.scrollTop)
    for (const point of pane.anchor.points) point.top -= remainder
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
