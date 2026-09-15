/**
 * Owns the renderer-local "how a tool call is drawn" preference and publishes it.
 *
 * Mounted at the composition root beside `ToolsExpandedProvider` (`main.tsx`)
 * for the same reason: it is set in the Settings pane and read by the transcript
 * inside `SessionPane`, and belongs to neither subtree. `storage` is injectable
 * so a test can drive the real read/write path without touching globals.
 */

import { useMemo } from 'react'
import type { ReactNode } from 'react'
import {
  DEFAULT_TOOL_CARD_STYLE,
  ToolCardStyleContext,
  readToolCardStyleFromStorage,
  writeToolCardStyleToStorage,
  type ToolCardStyleContextValue,
} from './toolCardStyle.js'
import {
  useViewPreference,
  type ViewPreferenceStorage,
} from './viewPreference.js'

export function ToolCardStyleProvider({
  children,
  storage,
}: {
  children: ReactNode
  storage?: ViewPreferenceStorage | null
}) {
  const [style, setStyle] = useViewPreference(
    storage,
    readToolCardStyleFromStorage,
    writeToolCardStyleToStorage,
    DEFAULT_TOOL_CARD_STYLE,
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
