/**
 * Owns the renderer-local "tools open by default" preference and publishes it.
 *
 * Mounted at the composition root beside `ReasoningLayoutProvider` (`main.tsx`)
 * for the same reason: it is set in the Settings pane and read by the transcript
 * inside `SessionPane`, and belongs to neither subtree. `storage` is injectable
 * so a test can drive the real read/write path without touching globals.
 */

import { useMemo } from 'react'
import type { ReactNode } from 'react'
import {
  DEFAULT_TOOLS_EXPANDED,
  ToolsExpandedContext,
  readToolsExpandedFromStorage,
  writeToolsExpandedToStorage,
  type ToolsExpandedContextValue,
} from './toolsExpanded.js'
import {
  useViewPreference,
  type ViewPreferenceStorage,
} from './viewPreference.js'

export function ToolsExpandedProvider({
  children,
  storage,
}: {
  children: ReactNode
  storage?: ViewPreferenceStorage | null
}) {
  const [expanded, setExpanded] = useViewPreference(
    storage,
    readToolsExpandedFromStorage,
    writeToolsExpandedToStorage,
    DEFAULT_TOOLS_EXPANDED,
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
