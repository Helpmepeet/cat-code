/**
 * Owns the renderer-local "how a tool call is drawn" preference and publishes it.
 *
 * Mounted at the composition root beside `ToolsExpandedProvider` (`main.tsx`)
 * for the same reason: it is set in the Settings pane and read by the transcript
 * inside `SessionPane`, and belongs to neither subtree. `storage` is injectable
 * so a test can drive the real read/write path without touching globals.
 */

import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  DEFAULT_TOOL_CARD_STYLE,
  ToolCardStyleContext,
  readToolCardStyleFromStorage,
  writeToolCardStyleToStorage,
  type ToolCardStyle,
  type ToolCardStyleContextValue,
} from './toolCardStyle.js'

type ToolCardStyleStorage = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): ToolCardStyleStorage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function ToolCardStyleProvider({
  children,
  storage,
}: {
  children: ReactNode
  storage?: ToolCardStyleStorage | null
}) {
  const store = storage === undefined ? defaultStorage() : storage
  const [style, setStyleState] = useState<ToolCardStyle>(
    () => readToolCardStyleFromStorage(store) ?? DEFAULT_TOOL_CARD_STYLE,
  )
  const setStyle = useCallback(
    (next: ToolCardStyle) => {
      setStyleState(next)
      writeToolCardStyleToStorage(store, next)
    },
    [store],
  )
  const value = useMemo<ToolCardStyleContextValue>(
    () => ({ style, setStyle }),
    [style, setStyle],
  )
  return (
    <ToolCardStyleContext.Provider value={value}>
      {children}
    </ToolCardStyleContext.Provider>
  )
}
