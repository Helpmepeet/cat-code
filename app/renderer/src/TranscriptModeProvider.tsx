import { useMemo, type ReactNode } from 'react'
import {
  DEFAULT_TRANSCRIPT_MODE,
  TranscriptModeContext,
  readTranscriptModeFromStorage,
  writeTranscriptModeToStorage,
  type TranscriptModeContextValue,
} from './transcriptMode.js'
import { useViewPreference, type ViewPreferenceStorage } from './viewPreference.js'

export function TranscriptModeProvider({ children, storage }: {
  children: ReactNode
  storage?: ViewPreferenceStorage | null
}) {
  const [mode, setMode] = useViewPreference(
    storage,
    readTranscriptModeFromStorage,
    writeTranscriptModeToStorage,
    DEFAULT_TRANSCRIPT_MODE,
  )
  const value = useMemo<TranscriptModeContextValue>(() => ({ mode, setMode }), [mode, setMode])
  return <TranscriptModeContext.Provider value={value}>{children}</TranscriptModeContext.Provider>
}
