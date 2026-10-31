import { createContext } from 'react'
import { readViewPreference, writeViewPreference, type ViewPreferenceStorage } from './viewPreference.js'

export const TRANSCRIPT_MODE_STORAGE_KEY = 'catcode.transcriptMode.v1'
export const TRANSCRIPT_MODES = ['full', 'focused'] as const
export type TranscriptMode = (typeof TRANSCRIPT_MODES)[number]
export const DEFAULT_TRANSCRIPT_MODE: TranscriptMode = 'full'
export const TRANSCRIPT_MODE_LABELS: Readonly<Record<TranscriptMode, string>> = {
  full: 'Full',
  focused: 'Focused',
}

export function isTranscriptMode(value: unknown): value is TranscriptMode {
  return (TRANSCRIPT_MODES as readonly unknown[]).includes(value)
}

export function readTranscriptModeFromStorage(storage: ViewPreferenceStorage | null): TranscriptMode | null {
  return readViewPreference(storage, TRANSCRIPT_MODE_STORAGE_KEY, 'mode', value => isTranscriptMode(value) ? value : null)
}

export function writeTranscriptModeToStorage(storage: ViewPreferenceStorage | null, mode: TranscriptMode): void {
  writeViewPreference(storage, TRANSCRIPT_MODE_STORAGE_KEY, 'mode', mode)
}

export type TranscriptModeContextValue = {
  mode: TranscriptMode
  setMode: (next: TranscriptMode) => void
}

/** The `toolUseId` a Focused step head already names, so its own card leaves the header out. */
export const FocusedNamedCallContext = createContext<string | null>(null)

export const TranscriptModeContext = createContext<TranscriptModeContextValue>({
  mode: DEFAULT_TRANSCRIPT_MODE,
  setMode: () => {},
})
