/**
 * Owns the renderer-local "how streamed prose arrives" preference and publishes it.
 *
 * Mounted at the composition root beside `ToolCardStyleProvider` (`main.tsx`)
 * for the same reason: it is set in the Settings pane and read by the transcript
 * inside `SessionPane`, and belongs to neither subtree. `storage` is injectable
 * so a test can drive the real read/write path without touching globals.
 */

import { useMemo } from 'react'
import type { ReactNode } from 'react'
import {
  DEFAULT_PROSE_ARRIVAL,
  ProseArrivalContext,
  readProseArrivalFromStorage,
  writeProseArrivalToStorage,
  type ProseArrivalContextValue,
} from './proseArrival.js'
import {
  useViewPreference,
  type ViewPreferenceStorage,
} from './viewPreference.js'

export function ProseArrivalProvider({
  children,
  storage,
}: {
  children: ReactNode
  storage?: ViewPreferenceStorage | null
}) {
  const [arrival, setArrival] = useViewPreference(
    storage,
    readProseArrivalFromStorage,
    writeProseArrivalToStorage,
    DEFAULT_PROSE_ARRIVAL,
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
