/**
 * Owns the renderer-local accent colour, publishes it, and paints it.
 *
 * Mounted at the composition root beside `CodeThemeProvider` (`main.tsx`) for
 * the same reason, and for one more: the accent tints the shell itself, so it
 * has to be applied before Settings is ever opened. A picker that painted from
 * its own subtree would leave the app pink until you visited the page that
 * changes it.
 *
 * The wrapper `<div>` is the paint mechanism, not decoration — `theme.css`
 * redeclares `--accent` / `--accent-soft` under `[data-accent="…"]`, so the
 * attribute has to sit above everything that reads them. `contents`
 * (`display: contents`) keeps it out of layout entirely
 * (`CodeThemeProvider.tsx:10-13`).
 *
 * `storage` is injectable so a test can drive the real read/write path without
 * touching globals; it defaults to the renderer's own `localStorage`.
 */

import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  AccentThemeContext,
  DEFAULT_ACCENT,
  readAccentFromStorage,
  writeAccentToStorage,
  type AccentKey,
  type AccentThemeContextValue,
} from './accentTheme.js'

type AccentStorage = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): AccentStorage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function AccentThemeProvider({
  children,
  storage,
}: {
  children: ReactNode
  storage?: AccentStorage | null
}) {
  const store = storage === undefined ? defaultStorage() : storage
  const [accent, setAccentState] = useState<AccentKey>(
    () => readAccentFromStorage(store) ?? DEFAULT_ACCENT,
  )
  const setAccent = useCallback(
    (next: AccentKey) => {
      setAccentState(next)
      writeAccentToStorage(store, next)
    },
    [store],
  )
  const value = useMemo<AccentThemeContextValue>(
    () => ({ accent, setAccent }),
    [accent, setAccent],
  )
  return (
    <AccentThemeContext.Provider value={value}>
      <div className="contents" data-accent={accent}>
        {children}
      </div>
    </AccentThemeContext.Provider>
  )
}
