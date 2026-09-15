/**
 * Owns the renderer-local glass preference, publishes it, and stamps it.
 *
 * Mounted at the composition root beside `AccentThemeProvider` (`main.tsx`) for
 * the same reason: glass repaints the shell itself, so it has to be applied
 * before Settings is ever opened.
 *
 * Renders no wrapper of its own, unlike the accent. Its paint target is the
 * document element, which is above `#root` and therefore out of reach of
 * anything React returns (`glassMode.ts`).
 *
 * `storage` and `root` are injectable so a test can drive the real read/write
 * and stamp paths without touching globals; they default to this renderer's own
 * `localStorage` and `document.documentElement`.
 */

import { useEffect, useLayoutEffect, useMemo } from 'react'
import type { ReactNode } from 'react'
import {
  applyGlassMode,
  DEFAULT_GLASS_ENABLED,
  GlassModeContext,
  readGlassFromStorage,
  writeGlassToStorage,
  type GlassModeContextValue,
  type GlassRoot,
} from './glassMode.js'
import {
  useViewPreference,
  type ViewPreferenceStorage,
} from './viewPreference.js'
import { getBridge } from './bridge.js'

function defaultRoot(): GlassRoot | null {
  if (typeof document === 'undefined') return null
  return document.documentElement
}

export function GlassModeProvider({
  children,
  storage,
  root,
}: {
  children: ReactNode
  storage?: ViewPreferenceStorage | null
  root?: GlassRoot | null
}) {
  const target = root === undefined ? defaultRoot() : root
  const [glass, setGlass] = useViewPreference(
    storage,
    readGlassFromStorage,
    writeGlassToStorage,
    DEFAULT_GLASS_ENABLED,
  )
  // BEFORE paint, not after. A passive effect runs once the browser has already
  // painted, so a glass-on launch showed one solid frame and then flipped, and
  // did it again on every renderer reload. The sibling this mirrors has no such
  // gap because `AccentThemeProvider` stamps a wrapper element during render;
  // this one's target is the document, above `#root`, so it needs the layout
  // phase instead. `useLayoutEffect` warns when there is no DOM to lay out, and
  // the renderer suites are `renderToStaticMarkup`, hence the swap.
  const useStampEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect
  useStampEffect(() => {
    applyGlassMode(target, glass)
    try {
      // Sync on mount as well as changes. Existing renderer-local glass=true
      // preferences predate main's fallback file and must migrate without
      // requiring the operator to toggle the setting.
      getBridge().setGlassMode(glass)
    } catch {
      // The renderer's stamp remains usable if the fixed preference channel fails.
    }
  }, [target, glass])
  const value = useMemo<GlassModeContextValue>(
    () => ({ glass, setGlass }),
    [glass, setGlass],
  )
  return (
    <GlassModeContext.Provider value={value}>{children}</GlassModeContext.Provider>
  )
}
