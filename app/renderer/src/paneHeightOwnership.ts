/** Heights already reported by nested virtualizers in the same pane. */
export function readNestedPaneHeights(root: HTMLElement): Map<Element, number> {
  const heights = new Map<Element, number>()
  for (const child of root.querySelectorAll<HTMLElement>('[data-pane-height-owner]')) {
    if (child.parentElement?.closest('[data-pane-height-owner]') !== root) continue
    // A nested scroll region owns a different pane's corrections.
    let cursor: HTMLElement | null = child.parentElement
    let separatePane = false
    while (cursor && cursor !== root) {
      if (/(auto|scroll)/.test(getComputedStyle(cursor).overflowY)) {
        separatePane = true
        break
      }
      cursor = cursor.parentElement
    }
    if (!separatePane) heights.set(child, child.getBoundingClientRect().height)
  }
  return heights
}

/** Count each retained body's movement once, even across separate commits. */
export function ownPaneHeightDelta(
  totalDelta: number,
  previous: ReadonlyMap<Element, number>,
  current: ReadonlyMap<Element, number>,
): number {
  let delta = totalDelta
  for (const [child, height] of current) {
    const oldHeight = previous.get(child)
    if (oldHeight !== undefined) delta -= height - oldHeight
  }
  return delta
}
