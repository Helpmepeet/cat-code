/**
 * Owns the renderer-local reasoning-layout preference and publishes it.
 *
 * Mounted at the composition root beside `ToastHost` (`main.tsx`) rather than
 * inside `App`: the preference is read by two unrelated subtrees (the transcript
 * inside `SessionPane`, and the Settings "Theme & Output" pane), belongs to
 * neither, and hanging it off the root keeps `App` free of view-preference
 * state. `storage` is injectable so a test can drive the real read/write path
 * without touching globals; it defaults to the renderer's own `localStorage`,
 * the same best-effort store the workspace layout uses (`workspaceLayout.ts`).
 */

import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  DEFAULT_REASONING_LAYOUT,
  ReasoningLayoutContext,
  readReasoningLayoutFromStorage,
  writeReasoningLayoutToStorage,
  type ReasoningLayoutContextValue,
  type ReasoningLayoutMode,
} from './reasoningLayout.js'

type LayoutStorage = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): LayoutStorage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function ReasoningLayoutProvider({
  children,
  storage,
}: {
  children: ReactNode
  storage?: LayoutStorage | null
}) {
  const store = storage === undefined ? defaultStorage() : storage
  const [mode, setModeState] = useState<ReasoningLayoutMode>(
    () => readReasoningLayoutFromStorage(store) ?? DEFAULT_REASONING_LAYOUT,
  )
  const setMode = useCallback(
    (next: ReasoningLayoutMode) => {
      setModeState(next)
      writeReasoningLayoutToStorage(store, next)
    },
    [store],
  )
  const value = useMemo<ReasoningLayoutContextValue>(
    () => ({ mode, setMode }),
    [mode, setMode],
  )
  return (
    <ReasoningLayoutContext.Provider value={value}>
      {children}
    </ReasoningLayoutContext.Provider>
  )
}
