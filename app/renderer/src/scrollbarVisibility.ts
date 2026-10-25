/**
 * Auto-hide for the global scrollbar grammar in `theme.css`.
 *
 * Styling `::-webkit-scrollbar` at all opts Chromium out of macOS overlay
 * scrollbars, so the custom bar would otherwise sit on screen permanently. The
 * thumb is painted only while its scroller carries `SCROLLBAR_VISIBLE_ATTRIBUTE`,
 * which this module sets while the element scrolls or while the pointer is over
 * its scrollbar, and clears once both have been idle for the hide delay.
 *
 * One capture-phase listener per event type on the document covers every
 * scroller, including ones mounted later, without per-surface opt-in.
 */

export const SCROLLBAR_VISIBLE_ATTRIBUTE = 'data-scrollbar-visible'

const DEFAULT_HIDE_DELAY_MS = 1000

/** True when the pointer is over `el`'s own scrollbar rather than its content. */
function isOverScrollbar(el: Element, event: PointerEvent): boolean {
  // A pointer over content targets the deepest element under it; only a
  // scroller's own bar, or its padding, targets the scroller itself.
  if (!(el instanceof HTMLElement) || (el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth)) {
    return false
  }
  const bounds = el.getBoundingClientRect()
  const x = event.clientX - bounds.left
  const y = event.clientY - bounds.top
  const verticalBar = el.scrollHeight > el.clientHeight && x >= el.clientLeft + el.clientWidth
  const horizontalBar = el.scrollWidth > el.clientWidth && y >= el.clientTop + el.clientHeight
  return verticalBar || horizontalBar
}

export function installScrollbarVisibility(
  doc: Document = document,
  hideDelayMs: number = DEFAULT_HIDE_DELAY_MS,
): () => void {
  const view = doc.defaultView
  if (!view) return () => {}
  const hideTimers = new Map<Element, number>()
  let hovered: Element | null = null

  const show = (el: Element) => {
    const pending = hideTimers.get(el)
    if (pending !== undefined) {
      view.clearTimeout(pending)
      hideTimers.delete(el)
    }
    if (!el.hasAttribute(SCROLLBAR_VISIBLE_ATTRIBUTE)) el.setAttribute(SCROLLBAR_VISIBLE_ATTRIBUTE, '')
  }

  const hideLater = (el: Element) => {
    const pending = hideTimers.get(el)
    if (pending !== undefined) view.clearTimeout(pending)
    hideTimers.set(el, view.setTimeout(() => {
      hideTimers.delete(el)
      if (el !== hovered) el.removeAttribute(SCROLLBAR_VISIBLE_ATTRIBUTE)
    }, hideDelayMs))
  }

  const setHovered = (next: Element | null) => {
    if (next === hovered) return
    const previous = hovered
    hovered = next
    if (previous) hideLater(previous)
    if (next) show(next)
  }

  const onScroll = (event: Event) => {
    const target = event.target === doc ? doc.scrollingElement : event.target
    if (!(target instanceof Element)) return
    show(target)
    if (target !== hovered) hideLater(target)
  }

  const onPointerMove = (event: PointerEvent) => {
    const target = event.target
    setHovered(target instanceof Element && isOverScrollbar(target, event) ? target : null)
  }

  // A null `relatedTarget` means the pointer left the window, which sends no
  // further pointermove to clear a bar it was resting on.
  const onPointerOut = (event: PointerEvent) => {
    if (event.relatedTarget === null) setHovered(null)
  }

  doc.addEventListener('scroll', onScroll, { capture: true, passive: true })
  doc.addEventListener('pointermove', onPointerMove, { capture: true, passive: true })
  doc.addEventListener('pointerout', onPointerOut, { capture: true, passive: true })

  return () => {
    doc.removeEventListener('scroll', onScroll, { capture: true })
    doc.removeEventListener('pointermove', onPointerMove, { capture: true })
    doc.removeEventListener('pointerout', onPointerOut, { capture: true })
    for (const [el, pending] of hideTimers) {
      view.clearTimeout(pending)
      el.removeAttribute(SCROLLBAR_VISIBLE_ATTRIBUTE)
    }
    hideTimers.clear()
    hovered?.removeAttribute(SCROLLBAR_VISIBLE_ATTRIBUTE)
    hovered = null
  }
}
