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

import { useMemo } from 'react'
import type { ReactNode } from 'react'
import {
  AccentThemeContext,
  DEFAULT_ACCENT,
  readAccentFromStorage,
  writeAccentToStorage,
  type AccentThemeContextValue,
} from './accentTheme.js'
import {
  useViewPreference,
  type ViewPreferenceStorage,
} from './viewPreference.js'

export function AccentThemeProvider({
  children,
  storage,
}: {
  children: ReactNode
  storage?: ViewPreferenceStorage | null
}) {
  const [accent, setAccent] = useViewPreference(
    storage,
    readAccentFromStorage,
    writeAccentToStorage,
    DEFAULT_ACCENT,
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
