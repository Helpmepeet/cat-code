/**
 * Owns the renderer-local "how streamed prose arrives" preference and publishes it.
 *
 * Mounted at the composition root beside `ToolCardStyleProvider` (`main.tsx`)
 * for the same reason: it is set in the Settings pane and read by the transcript
 * inside `SessionPane`, and belongs to neither subtree. `storage` is injectable
 * so a test can drive the real read/write path without touching globals.
 */

import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  DEFAULT_PROSE_ARRIVAL,
  ProseArrivalContext,
  readProseArrivalFromStorage,
  writeProseArrivalToStorage,
  type ProseArrival,
  type ProseArrivalContextValue,
} from './proseArrival.js'

type ProseArrivalStorage = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): ProseArrivalStorage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function ProseArrivalProvider({
  children,
  storage,
}: {
  children: ReactNode
  storage?: ProseArrivalStorage | null
}) {
  const store = storage === undefined ? defaultStorage() : storage
  const [arrival, setArrivalState] = useState<ProseArrival>(
    () => readProseArrivalFromStorage(store) ?? DEFAULT_PROSE_ARRIVAL,
  )
  const setArrival = useCallback(
    (next: ProseArrival) => {
      setArrivalState(next)
      writeProseArrivalToStorage(store, next)
    },
    [store],
  )
  const value = useMemo<ProseArrivalContextValue>(
    () => ({ arrival, setArrival }),
    [arrival, setArrival],
  )
  return (
    <ProseArrivalContext.Provider value={value}>
      {children}
    </ProseArrivalContext.Provider>
  )
}
