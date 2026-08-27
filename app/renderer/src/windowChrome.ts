/**
 * Whether the tab bar still has to hold the traffic-light well open.
 *
 * macOS hides the lights in fullscreen and re-reveals them on a drop-down
 * overlay when the pointer reaches the top edge, so the 84px the bar reserves
 * for them (`TabBar.tsx`) is dead chrome for as long as the window stays
 * fullscreen.
 *
 * `display-mode` is a renderer-local media feature, and that is the whole reason
 * this is worth doing: main never has to tell the renderer anything, so there is
 * no new preload channel and no new inbound frame kind to validate
 * (SECURITY-MINIMUM). The alternative — main observing `enter-full-screen` and
 * pushing it down — would cost both for a purely cosmetic gap.
 *
 * It fails CLOSED to "reserve the well": no `matchMedia`, a query this Chromium
 * will not answer, or a fullscreen mode it does not report as `display-mode`
 * all leave the bar exactly as it renders today. The worst case is the gap we
 * already have, never a well that collapses under the lights.
 *
 * `media` is injectable on the same terms as `ColorSchemeProvider`'s, and with
 * the same blind spot: a test that injects it never exercises the real query,
 * and the real query is the half only a live window can answer.
 */

import { useEffect, useState } from 'react'

export const FULLSCREEN_QUERY = '(display-mode: fullscreen)'

/** The narrow half of `MediaQueryList` this needs, so a test can supply a fake
 * without a DOM. `addEventListener` is the modern half; nothing in this renderer
 * runs anywhere the deprecated `addListener` would be needed. */
export type FullscreenMediaQuery = {
  matches: boolean
  addEventListener: (type: 'change', listener: () => void) => void
  removeEventListener: (type: 'change', listener: () => void) => void
}

function defaultFullscreenMedia(): FullscreenMediaQuery | null {
  if (typeof window === 'undefined' || !window.matchMedia) return null
  try {
    return window.matchMedia(FULLSCREEN_QUERY)
  } catch {
    return null
  }
}

export function useTrafficLightWell(
  media?: FullscreenMediaQuery | null,
): boolean {
  // Held in state because `defaultFullscreenMedia()` mints a NEW
  // `MediaQueryList` per call: in the render body it would give the effect below
  // a fresh dependency every render and re-subscribe on each one.
  const [defaultQuery] = useState<FullscreenMediaQuery | null>(() =>
    defaultFullscreenMedia(),
  )
  const query = media === undefined ? defaultQuery : media
  // Seeded from the query rather than defaulted, so a window that is ALREADY
  // fullscreen when the renderer mounts (a reload, an OOM restart) paints
  // correctly instead of showing the well for one frame and then dropping it.
  const [fullscreen, setFullscreen] = useState<boolean>(
    () => query?.matches ?? false,
  )

  useEffect(() => {
    if (!query) return
    const onChange = () => setFullscreen(query.matches)
    // Re-read on subscribe: the window can have entered fullscreen between the
    // state seed above and this effect running.
    onChange()
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [query])

  return !fullscreen
}
