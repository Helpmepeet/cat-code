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

import { useCallback, useEffect, useMemo, useState } from 'react'
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

type GlassStorage = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): GlassStorage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

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
  storage?: GlassStorage | null
  root?: GlassRoot | null
}) {
  const store = storage === undefined ? defaultStorage() : storage
  const target = root === undefined ? defaultRoot() : root
  const [glass, setGlassState] = useState<boolean>(
    () => readGlassFromStorage(store) ?? DEFAULT_GLASS_ENABLED,
  )
  const setGlass = useCallback(
    (next: boolean) => {
      setGlassState(next)
      writeGlassToStorage(store, next)
    },
    [store],
  )
  // Runs on mount as well as on change, which is what restores a stored
  // preference: the stamp is on the document, so it does not survive a reload
  // the way React state inside the tree would not either.
  useEffect(() => {
    applyGlassMode(target, glass)
  }, [target, glass])
  const value = useMemo<GlassModeContextValue>(
    () => ({ glass, setGlass }),
    [glass, setGlass],
  )
  return (
    <GlassModeContext.Provider value={value}>{children}</GlassModeContext.Provider>
  )
}
