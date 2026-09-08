/**
 * Pure anchor arithmetic for one pane scroller.
 *
 * The pane's virtualizers commit with ESTIMATED heights and replace them with
 * measured ones one or more animation frames later. Each replacement changes
 * the document height underneath a scroll position that was already chosen, so
 * something has to decide where the scroller must land instead. Without that
 * decision the scroller keeps its old offset and the reader's content slides.
 *
 * The rule (CC-59 execution plan, hard constraint 13 and Phase 2 item 10):
 * bottom lock wins while it is active; otherwise only a height change landing
 * BEFORE the visible anchor moves the scroll position, because a change at or
 * after the anchor happens at or below the first pixel the reader can see.
 *
 * No DOM here on purpose. happy-dom has no layout engine, so this module is the
 * only layer at which the arithmetic can be proven at all; the coordinator that
 * feeds it is proven separately with injected geometry.
 */

/**
 * Scroller geometry, read AFTER the corrections it accompanies already landed
 * in the DOM. The corrections describe how the document got to this height;
 * they are not applied to it a second time.
 */
export type PaneScrollMetrics = {
  scrollTop: number
  viewportHeight: number
  contentHeight: number
}

/** One reported replacement of an estimated height by a measured one. */
export type PaneHeightCorrection = {
  /**
   * Content offset of the first pixel the change moved, in the POST-change
   * document. Everything above it occupies the same place it did before.
   */
  offset: number
  /** Post-change height minus pre-change height. Positive grows the document. */
  delta: number
}

export type PaneAnchorInput = {
  metrics: PaneScrollMetrics
  corrections: readonly PaneHeightCorrection[]
  /** Whether the pane's stick-to-bottom owner still considers itself pinned. */
  bottomLocked: boolean
}

/**
 * Chooses the next logical follow state from one scroll event. A document can
 * grow while `scrollTop` stays unchanged, so a non-bottom gap is not by itself
 * evidence that the reader moved. An actual upward movement is the signal that
 * releases follow; reaching the end or moving down does not release it.
 */
export function selectPaneFollowIntent(input: {
  following: boolean
  previousScrollTop: number
  scrollTop: number
  gap: number
}): boolean {
  if (input.scrollTop < input.previousScrollTop) return false
  if (input.gap <= 1) return true
  return input.following
}

/**
 * Pixels to add to the scroller's `scrollTop`; 0 when the scroller must not
 * move. The result is clamped to the scrollable range, so a caller can add it
 * without re-clamping.
 */
export function selectPaneScrollAdjustment(input: PaneAnchorInput): number {
  const { contentHeight, scrollTop, viewportHeight } = input.metrics
  const maxScrollTop = Math.max(0, contentHeight - viewportHeight)

  // Bottom lock wins outright: the reader asked to follow the end of the
  // document, so where the changes landed relative to the anchor is moot.
  if (input.bottomLocked) return maxScrollTop - scrollTop

  // Offsets are post-change and the anchor is pre-change, so a correction
  // carries every correction above it inside its own offset. Walking them in
  // document order and discounting what has already been classified as above
  // converts each one back into the anchor's coordinate system, which is what
  // makes a frame carrying several corrections exact rather than approximate.
  const ordered = [...input.corrections].sort((left, right) => left.offset - right.offset)
  let adjustment = 0
  for (const correction of ordered) {
    if (correction.offset - adjustment >= scrollTop) continue
    adjustment += correction.delta
  }
  if (adjustment === 0) return 0

  const target = Math.min(maxScrollTop, Math.max(0, scrollTop + adjustment))
  return target - scrollTop
}
