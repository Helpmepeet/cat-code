/**
 * Owns the renderer-local "tools open by default" preference and publishes it.
 *
 * Mounted at the composition root beside `ReasoningLayoutProvider` (`main.tsx`)
 * for the same reason: it is set in the Settings pane and read by the transcript
 * inside `SessionPane`, and belongs to neither subtree. `storage` is injectable
 * so a test can drive the real read/write path without touching globals.
 */

import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  DEFAULT_TOOLS_EXPANDED,
  ToolsExpandedContext,
  readToolsExpandedFromStorage,
  writeToolsExpandedToStorage,
  type ToolsExpandedContextValue,
} from './toolsExpanded.js'

type ToolsExpandedStorage = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): ToolsExpandedStorage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function ToolsExpandedProvider({
  children,
  storage,
}: {
  children: ReactNode
  storage?: ToolsExpandedStorage | null
}) {
  const store = storage === undefined ? defaultStorage() : storage
  const [expanded, setExpandedState] = useState<boolean>(
    () => readToolsExpandedFromStorage(store) ?? DEFAULT_TOOLS_EXPANDED,
  )
  const setExpanded = useCallback(
    (next: boolean) => {
      setExpandedState(next)
      writeToolsExpandedToStorage(store, next)
    },
    [store],
  )
  const value = useMemo<ToolsExpandedContextValue>(
    () => ({ expanded, setExpanded }),
    [expanded, setExpanded],
  )
  return (
    <ToolsExpandedContext.Provider value={value}>
      {children}
    </ToolsExpandedContext.Provider>
  )
}
