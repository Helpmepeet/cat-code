/**
 * Owns the renderer-local fenced-code theme, publishes it, and paints it.
 *
 * Mounted at the composition root beside `ReasoningLayoutProvider` (`main.tsx`)
 * for the same reason: the preference is set in Settings and read by the
 * transcript, and belongs to neither subtree.
 *
 * The wrapper `<div>` is the paint mechanism, not decoration — `theme.css`
 * selects each palette with `[data-code-theme="…"] .hljs-…`, so the attribute
 * has to sit above every code block. `contents` (`display: contents`) keeps it
 * out of layout entirely, which is safe here because `App`'s root box is
 * viewport-sized (`h-screen`) rather than a percentage of its parent.
 *
 * `storage` is injectable so a test can drive the real read/write path without
 * touching globals; it defaults to the renderer's own `localStorage`
 * (`ReasoningLayoutProvider.tsx:26-33`).
 */

import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  CodeThemeContext,
  DEFAULT_CODE_THEME,
  readCodeThemeFromStorage,
  writeCodeThemeToStorage,
  type CodeThemeContextValue,
  type CodeThemeKey,
} from './codeTheme.js'

type CodeThemeStorage = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): CodeThemeStorage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function CodeThemeProvider({
  children,
  storage,
}: {
  children: ReactNode
  storage?: CodeThemeStorage | null
}) {
  const store = storage === undefined ? defaultStorage() : storage
  const [theme, setThemeState] = useState<CodeThemeKey>(
    () => readCodeThemeFromStorage(store) ?? DEFAULT_CODE_THEME,
  )
  const setTheme = useCallback(
    (next: CodeThemeKey) => {
      setThemeState(next)
      writeCodeThemeToStorage(store, next)
    },
    [store],
  )
  const value = useMemo<CodeThemeContextValue>(
    () => ({ theme, setTheme }),
    [theme, setTheme],
  )
  return (
    <CodeThemeContext.Provider value={value}>
      <div className="contents" data-code-theme={theme}>
        {children}
      </div>
    </CodeThemeContext.Provider>
  )
}
