/**
 * One scroll listener, one scroller ResizeObserver, and one animation-frame
 * batch per pane scroller, shared by every Markdown body mounted inside it.
 * Bodies register here instead of attaching their own listeners to the shared
 * scroller, so pane-level attachment counts stay fixed as transcript history
 * grows. Each body keeps its own observer for its own root element; only the
 * shared scroller is pooled.
 */

type PaneRecord = {
  subscribers: Set<() => void>
  frame: number
  detach: () => void
}

const panes = new WeakMap<EventTarget, PaneRecord>()

/**
 * Registers a callback invoked at most once per animation frame when the pane
 * scroller scrolls or resizes. Returns a release function; the shared listener
 * is torn down when the last subscriber releases it.
 */
export function observePaneScroll(scroller: HTMLElement, onFrame: () => void): () => void {
  const pane = panes.get(scroller) ?? createPane(scroller)
  panes.set(scroller, pane)
  pane.subscribers.add(onFrame)

  return () => {
    pane.subscribers.delete(onFrame)
    if (pane.subscribers.size > 0) return
    if (pane.frame !== 0) globalThis.cancelAnimationFrame(pane.frame)
    pane.frame = 0
    pane.detach()
    panes.delete(scroller)
  }
}

function createPane(scroller: HTMLElement): PaneRecord {
  const pane: PaneRecord = { subscribers: new Set(), frame: 0, detach: () => {} }

  const flush = () => {
    pane.frame = 0
    for (const subscriber of [...pane.subscribers]) subscriber()
  }
  const schedule = () => {
    if (pane.frame === 0) pane.frame = globalThis.requestAnimationFrame(flush)
  }

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

export const _forTest = {
  paneSubscriberCount(scroller: HTMLElement): number {
    return panes.get(scroller)?.subscribers.size ?? 0
  },
  isPaneAttached(scroller: HTMLElement): boolean {
    return panes.has(scroller)
  },
}
