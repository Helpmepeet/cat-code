/**
 * Owns the appearance preference, publishes it, stamps it, and tells main.
 *
 * Mounted at the composition root beside `GlassModeProvider` (`main.tsx`). Both
 * stamp the document element rather than a wrapper, so neither renders anything
 * of its own, and both stamp in the LAYOUT phase — which is what makes their
 * relative order in the tree not matter. Every layout effect runs before the
 * browser paints, so no frame can show one stamp without the other, whichever
 * lands first. (An earlier version of this file put the appearance in a passive
 * effect and then claimed the nesting order fixed the resulting flash. It could
 * not: passive effects run after paint, so glass always won regardless.)
 *
 * TWO OUTPUTS, AND THEY CARRY DIFFERENT VALUES. The stored choice plus the OS's
 * current answer resolve to one appearance (`resolveAppearance`), and that
 * RESOLVED value is stamped on the document for the CSS. Main is told the CHOICE
 * instead — see the note on the notify effect for why sending it the resolved
 * value breaks "Match system" permanently.
 *
 * The OS half is a live subscription, not a one-time read: with `system` picked,
 * flipping macOS between light and dark has to repaint the window without a
 * relaunch. The subscription stays mounted under `light` and `dark` too; it costs
 * nothing, and dropping it would mean the app stops tracking the OS the moment
 * someone forces a mode and never starts again if they switch back.
 *
 * `storage`, `root`, `media` and `onScheme` are injectable so a test can drive
 * the real read/write, stamp and notify paths without touching globals; they
 * default to this renderer's own `localStorage`, `documentElement`,
 * `window.matchMedia` and the preload bridge.
 */

import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  applyAppearance,
  ColorSchemeContext,
  DARK_SCHEME_QUERY,
  DEFAULT_COLOR_SCHEME,
  readColorSchemeFromStorage,
  resolveAppearance,
  writeColorSchemeToStorage,
  type AppearanceRoot,
  type ColorSchemeContextValue,
  type ColorSchemeKey,
} from './colorScheme.js'
import {
  useViewPreference,
  type ViewPreferenceStorage,
} from './viewPreference.js'
import { getBridge } from './bridge.js'

/** The one query this needs, narrowed so a test can supply a fake without a DOM.
 * `addEventListener` is the modern half of `MediaQueryList`; nothing in this
 * renderer runs anywhere the deprecated `addListener` would be needed. */
export type SchemeMediaQuery = {
  matches: boolean
  addEventListener: (type: 'change', listener: () => void) => void
  removeEventListener: (type: 'change', listener: () => void) => void
}

function defaultRoot(): AppearanceRoot | null {
  if (typeof document === 'undefined') return null
  return document.documentElement
}

function defaultMedia(): SchemeMediaQuery | null {
  if (typeof window === 'undefined' || !window.matchMedia) return null
  try {
    return window.matchMedia(DARK_SCHEME_QUERY)
  } catch {
    return null
  }
}

function notifyMain(scheme: ColorSchemeKey): void {
  getBridge().setAppearance(scheme)
}

export function ColorSchemeProvider({
  children,
  storage,
  root,
  media,
  onScheme,
}: {
  children: ReactNode
  storage?: ViewPreferenceStorage | null
  root?: AppearanceRoot | null
  media?: SchemeMediaQuery | null
  onScheme?: (scheme: ColorSchemeKey) => void
}) {
  const target = root === undefined ? defaultRoot() : root
  // `defaultMedia()` mints a NEW `MediaQueryList` on every call, so calling it in
  // the render body would give `query` a fresh identity each render and make the
  // subscribing effect below tear down and re-subscribe every time. Held in state
  // so the subscription is created once.
  const [defaultQuery] = useState<SchemeMediaQuery | null>(() => defaultMedia())
  const query = media === undefined ? defaultQuery : media
  const notify = onScheme ?? notifyMain

  const [scheme, setScheme] = useViewPreference(
    storage,
    readColorSchemeFromStorage,
    writeColorSchemeToStorage,
    DEFAULT_COLOR_SCHEME,
  )
  // Seeded from the query rather than defaulted, so the very first paint is
  // already correct on a light system instead of flashing dark and correcting.
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(
    () => query?.matches ?? true,
  )

  useEffect(() => {
    if (!query) return
    const onChange = () => setSystemPrefersDark(query.matches)
    // Read once on subscribe as well: `themeSource` may have moved the query
    // between the initial render and this effect.
    onChange()
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [query])

  const appearance = resolveAppearance(scheme, systemPrefersDark)

  // BEFORE paint, not after, for the reason `GlassModeProvider` records: a
  // passive effect runs once the browser has already painted, so every launch
  // and every renderer reload would show one fully dark frame and then flip. The
  // whole page ground, the text ramp and every `light-dark()` move at once here,
  // so the flash is larger than the one that taught glass this. `useLayoutEffect`
  // warns when there is no DOM to lay out and the renderer suites are
  // `renderToStaticMarkup`, hence the swap.
  const useStampEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect
  useStampEffect(() => {
    applyAppearance(target, appearance)
  }, [target, appearance])

  // MAIN IS TOLD THE CHOICE, NOT THE RESOLVED APPEARANCE, and this is the whole
  // reason the preference works at all. `nativeTheme.themeSource` is an OVERRIDE:
  // assigning it `light` or `dark` supersedes the OS and pins the renderer's own
  // `prefers-color-scheme`, which is the query `system` resolves against. So
  // sending the resolved value would have main force `dark` the moment a user on
  // a dark Mac picks "Match system" — and from then on the query can never move,
  // the subscription above can never fire, and "Match system" is frozen to
  // whatever it happened to resolve to first. Measured, not reasoned: pick
  // Match system, then Light, then Match system again, and a dark Mac ends up
  // with a light window permanently (`nativeTheme.themeSource` reads `light`,
  // and so does `systemPreferences.getEffectiveAppearance()`).
  //
  // Passing the choice through gives Electron the three-state machine its own
  // docs describe (Follow OS / Light / Dark), and `system` RELEASES the override
  // rather than widening it. `resolveAppearance` still runs here, for the CSS
  // stamp above; it just never decides what main is told.
  //
  // Best-effort, and the guard is HERE rather than inside the default notifier so
  // it holds for whatever is passed in. Telling main only selects a native
  // material: the page has already painted by this point, the preload's own rate
  // guard can legitimately refuse a send, and a taste preference must never be
  // able to raise into the session.
  useEffect(() => {
    try {
      notify(scheme)
    } catch {
      // The window keeps the appearance it just painted either way.
    }
  }, [notify, scheme])

  const value = useMemo<ColorSchemeContextValue>(
    () => ({ scheme, appearance, setScheme }),
    [scheme, appearance, setScheme],
  )
  return (
    <ColorSchemeContext.Provider value={value}>
      {children}
    </ColorSchemeContext.Provider>
  )
}
