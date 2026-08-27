/**
 * Owns the appearance preference, publishes it, stamps it, and tells main.
 *
 * Mounted at the composition root beside `GlassModeProvider` (`main.tsx`) and
 * ABOVE it in the tree, for one reason that matters: glass reads its alphas out
 * of `light-dark()`, so the appearance has to be on the document before glass
 * can mean anything. Both stamp the document element rather than a wrapper, so
 * neither renders anything of its own.
 *
 * THREE INPUTS, ONE OUTPUT. The stored choice and the OS's current answer
 * resolve to a single appearance (`resolveAppearance`), and that appearance is
 * what reaches both the document and main. The OS half is a live subscription,
 * not a one-time read: with `system` picked, flipping macOS between light and
 * dark has to repaint the window without a relaunch.
 *
 * The `matchMedia` subscription stays mounted under `light` and `dark` too. It
 * costs nothing, and dropping it would mean the app stops tracking the OS the
 * moment someone forces a mode and never starts again if they switch back.
 *
 * `storage`, `root`, `media` and `setAppearance` are injectable so a test can
 * drive the real read/write, stamp and notify paths without touching globals;
 * they default to this renderer's own `localStorage`, `documentElement`,
 * `window.matchMedia` and the preload bridge.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
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
  type ResolvedAppearance,
} from './colorScheme.js'
import { getBridge } from './bridge.js'

type ColorSchemeStorage = Pick<Storage, 'getItem' | 'setItem'>

/** The one query this needs, narrowed so a test can supply a fake without a DOM.
 * `addEventListener` is the modern half of `MediaQueryList`; nothing in this
 * renderer runs anywhere the deprecated `addListener` would be needed. */
export type SchemeMediaQuery = {
  matches: boolean
  addEventListener: (type: 'change', listener: () => void) => void
  removeEventListener: (type: 'change', listener: () => void) => void
}

function defaultStorage(): ColorSchemeStorage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
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

function notifyMain(appearance: ResolvedAppearance): void {
  getBridge().setAppearance(appearance)
}

export function ColorSchemeProvider({
  children,
  storage,
  root,
  media,
  onAppearance,
}: {
  children: ReactNode
  storage?: ColorSchemeStorage | null
  root?: AppearanceRoot | null
  media?: SchemeMediaQuery | null
  onAppearance?: (appearance: ResolvedAppearance) => void
}) {
  const store = storage === undefined ? defaultStorage() : storage
  const target = root === undefined ? defaultRoot() : root
  const query = media === undefined ? defaultMedia() : media
  const notify = onAppearance ?? notifyMain

  const [scheme, setSchemeState] = useState<ColorSchemeKey>(
    () => readColorSchemeFromStorage(store) ?? DEFAULT_COLOR_SCHEME,
  )
  // Seeded from the query rather than defaulted, so the very first paint is
  // already correct on a light system instead of flashing dark and correcting.
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(
    () => query?.matches ?? true,
  )

  const setScheme = useCallback(
    (next: ColorSchemeKey) => {
      setSchemeState(next)
      writeColorSchemeToStorage(store, next)
    },
    [store],
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

  // Runs on mount as well as on change, which is what restores a stored choice:
  // the stamp is on the document, so a reload starts it over.
  useEffect(() => {
    applyAppearance(target, appearance)
  }, [target, appearance])

  // Separate from the stamp on purpose. The stamp is local and free; this one
  // crosses a process boundary and swaps a native material, so it fires only
  // when the resolved appearance actually changed, not on every render.
  //
  // Best-effort, and the guard is HERE rather than inside the default notifier
  // so that it holds for whatever is passed in. Telling main only selects a
  // native material: the page has already painted the appearance the user chose
  // by this point, the preload's own rate guard can legitimately refuse a send,
  // and a taste preference must never be able to raise into the session.
  useEffect(() => {
    try {
      notify(appearance)
    } catch {
      // The window keeps the appearance it just painted either way.
    }
  }, [notify, appearance])

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
